import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { App } from "./app.ts";
import { all, one } from "./db.ts";
import { codeVersion, listPeers, nodeId } from "./peers.ts";
import { listSchedules, nextRuns, triggerSchedule } from "./scheduler.ts";
import { roleNames } from "./config.ts";
import { desktopControl } from "./tools.ts";
import { HttpError } from "./util.ts";
import { memoryHistory, memoryNow } from "./memory-watch.ts";
import { vectorIndex } from "../search/vectors.ts";

/**
 * What another device may ask this instance to do (`POST /api/peer/exec`, owner only):
 * a fixed list of diagnostic and maintenance commands with checked arguments — no
 * shell. Enough to verify behaviour on the machine that runs capture (read lark-cli
 * output, look at runs and logs, query the database read-only, trigger a capture) and to
 * deploy a fix (git pull, install, build, restart).
 */

const packageRoot = async () => (await import("../setup.ts")).packageRoot();

/** Health and state in one call. */
export async function diag(app: App) {
  const root = await packageRoot();
  const count = (sql: string) => one<{ n: number }>(app.db, sql)?.n ?? 0;
  const next = nextRuns(app);
  const kv = (k: string) => one<{ value: string }>(app.db, "select value from kv where key = ?", k)?.value ?? null;
  return {
    node: nodeId(app),
    version: codeVersion(root),
    runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, pid: process.pid, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    // RSS minus V8 heap and buffers is native memory (the local embedding model's arena, SQLite).
    memory: { now: memoryNow(), vectorIndex: vectorIndex().stats(), history: memoryHistory() },
    now: new Date().toISOString(),
    home: app.home,
    baseUrl: app.baseUrl,
    counts: {
      sources: count("select count(*) n from sources where deleted_at is null"),
      chatMessages: count("select count(*) n from lark_messages"),
      memories: count("select count(*) n from memories where status = 'active'"),
      memoriesPendingReview: count("select count(*) n from memories where status = 'active' and created_by = 'agent' and reviewed_at is null"),
      items: count("select count(*) n from items where status in ('open','waiting','snoozed')"),
      runsQueued: count("select count(*) n from runs where status = 'queued'"),
      runsRunning: count("select count(*) n from runs where status = 'running'"),
    },
    schedules: listSchedules(app).map((s) => ({ id: s.id, enabled: s.enabled, cron: s.cron, lastRunAt: s.lastRunAt, next: next[s.id] })),
    recentFailures: all<{ id: string; kind: string; title: string; error: string | null; finished_at: string | null }>(
      app.db,
      "select id, kind, title, error, finished_at from runs where status = 'failed' order by created_at desc limit 10",
    ),
    lark: {
      enabled: app.config.lark.enabled,
      capture: { mode: app.config.lark.capture.mode, policies: app.config.lark.capture.policies, backfill: app.config.lark.capture.backfill },
      chats: count("select count(*) n from lark_cursors where chat_id not like 'thread:%'"),
      backfilling: count("select count(*) n from lark_cursors where backfill_to_ms is not null and oldest_ms > backfill_to_ms"),
      lastMentionsCheck: kv("lark_mentions_since_ms") ? new Date(Number(kv("lark_mentions_since_ms"))).toISOString() : null,
      lastHeartbeat: kv("heartbeat_at"),
    },
    // Optional local tools; aad is desktop and browser control (skill desktop-control).
    tools: { aad: desktopControl.status() },
    agents: { default: app.config.agents.default ?? null, roles: app.config.agents.roles, review: app.config.memory.review, compare: app.config.memory.compare },
    peers: listPeers(app).map((p) => ({ id: p.id, url: p.url, via: p.via ?? null })),
  };
}

function tail(file: string, lines: number) {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const buf = readFileSync(file);
  const text = buf.subarray(Math.max(0, size - 2_000_000)).toString("utf8");
  return text.split("\n").slice(-lines).join("\n");
}

function sh(cmd: string, args: string[], cwd: string, timeoutMs = 120_000) {
  // .cmd shims (pnpm, npm) need a shell on Windows; an absolute path (node itself) must not
  // go through one, since it may contain spaces.
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 50_000_000, shell: process.platform === "win32" && !isAbsolute(cmd) });
  return { code: r.status, stdout: (r.stdout ?? "").slice(-200_000), stderr: (r.stderr ?? "").slice(-50_000) };
}

/** Restart the background service a moment after replying, so the caller gets the answer. */
function restartSoon(app: App) {
  setTimeout(() => {
    // The same entry this server was started with (src/cli.ts or dist/src/cli.js).
    spawn(process.execPath, [process.argv[1], "--home", app.home, "service", "restart"], { detached: true, stdio: "ignore" }).unref();
  }, 800);
}

const id = z.string().regex(/^[\w-]{1,80}$/);
const LARK_READ = ["+chat-list", "+chat-messages-list", "+threads-messages-list", "+messages-mget", "+messages-search", "+chat-search", "+messages-read-status"] as const;

type Command = { description: string; schema: z.ZodTypeAny; run: (app: App, args: any) => Promise<unknown> | unknown };

export const peerCommands: Record<string, Command> = {
  diag: { description: "健康状态：版本、计数、定时任务、最近失败、飞书采集状态", schema: z.object({}), run: (app) => diag(app) },
  logs: {
    description: "服务日志最后几行（stream=out|err）",
    schema: z.object({ lines: z.number().int().min(1).max(5000).default(200), stream: z.enum(["out", "err"]).default("out") }),
    run: (app, a) => ({ text: tail(join(app.home, "service", "logs", `omem.${a.stream}.log`), a.lines) }),
  },
  config: {
    description: "当前配置（不含密钥）",
    schema: z.object({}),
    run: (app) => ({ ...app.config, token: app.config.token ? "(已设置)" : undefined }),
  },
  "lark-auth": { description: "lark-cli 登录状态", schema: z.object({}), run: async () => (await import("../channels/lark-cli.ts")).larkCli(["auth", "status", "--json", "--verify"]) },
  "lark-chats": {
    description: "本人的飞书会话（类型、免打扰、采集方式）",
    schema: z.object({ pages: z.number().int().min(1).max(10).default(1) }),
    run: async (app, a) => {
      const m = await import("../channels/lark-personal.ts");
      return (await m.listLarkChats(app, a.pages)).map((c) => ({ ...c, policy: m.capturePolicyFor(app, c) }));
    },
  },
  "lark-captured": { description: "采集过的会话及状态", schema: z.object({}), run: async (app) => (await import("../channels/lark-personal.ts")).capturedChats(app) },
  "lark-recent-docs": {
    description: "本人最近打开的飞书文档（drive +search 的原始返回，只读，用来核对字段）",
    schema: z.object({ days: z.number().int().min(1).max(90).default(3), page_size: z.number().int().min(1).max(20).default(5) }),
    run: async (_app, a) =>
      (await import("../channels/lark-cli.ts")).larkCli(["drive", "+search", "--as", "user", "--query", "", "--opened-since", `${a.days}d`, "--sort", "open_time", "--page-size", String(a.page_size), "--format", "json"]),
  },
  "lark-raw": {
    description: "只读调用 lark-cli 的消息/会话查询，返回原始 JSON（用来核对字段）",
    schema: z.object({
      command: z.enum(LARK_READ),
      chat_id: z.string().regex(/^oc_[\w-]+$/).optional(),
      /** +chat-list lists only groups unless asked for p2p. */
      types: z.enum(["p2p", "group", "p2p,group"]).optional(),
      thread: z.string().regex(/^om[t_][\w-]+$/).optional(),
      message_ids: z.array(z.string().regex(/^om_[\w-]+$/)).max(50).optional(),
      query: z.string().max(64).optional(),
      start: z.string().max(40).optional(),
      end: z.string().max(40).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page_size: z.number().int().min(1).max(50).default(10),
      reactions: z.boolean().default(false),
    }),
    run: async (_app, a) => {
      const args = ["im", a.command];
      if (a.chat_id) args.push("--chat-id", a.chat_id);
      if (a.types && a.command === "+chat-list") args.push("--types", a.types);
      if (a.thread) args.push("--thread", a.thread);
      if (a.message_ids?.length) args.push("--message-ids", a.message_ids.join(","));
      if (a.query) args.push("--query", a.query);
      if (a.start) args.push("--start", a.start);
      if (a.end) args.push("--end", a.end);
      if (a.order) args.push("--order", a.order);
      const rawOnly = a.command === "+messages-read-status";
      if (a.command !== "+messages-mget" && !rawOnly) args.push("--page-size", String(a.page_size));
      if (!a.reactions && a.command !== "+chat-list" && a.command !== "+chat-search" && !rawOnly) args.push("--no-reactions");
      args.push("--as", "user", "--format", "json");
      return (await import("../channels/lark-cli.ts")).larkCli(args);
    },
  },
  "lark-wiki-node": {
    description: "只读查询飞书文档所属的知识库、节点和父节点；names 返回中文知识库名称和完整目录路径",
    schema: z.object({ token: z.string().min(1).max(1000), names: z.boolean().default(false) }),
    run: async (app, a) => {
      const wiki = await import("../channels/lark-wiki.ts");
      return a.names ? wiki.wikiLocation(app, a.token) : wiki.wikiNode(app, a.token);
    },
  },
  "lark-doc-raw": {
    description: "只读调用 lark-cli 的文档读取（fetch：文档内容；media / preview：下载或预览一个素材到临时目录后删除，返回输出和文件名，失败时返回错误；csv：读内嵌表格；meta：文档的最后修改时间等元数据，doc 为链接），返回原始 JSON（用来核对字段）",
    schema: z.object({
      action: z.enum(["fetch", "media", "preview", "csv", "meta"]),
      doc: z.string().url().optional(),
      token: z.string().regex(/^[A-Za-z0-9]+$/).optional(),
      type: z.enum(["media", "whiteboard"]).default("media"),
      sheet_id: z.string().regex(/^[\w-]+$/).optional(),
      max_chars: z.number().int().min(100).max(200_000).default(4000),
    }),
    run: async (_app, a) => {
      const { larkCli } = await import("../channels/lark-cli.ts");
      const clip = (v: unknown) => JSON.stringify(v).slice(0, a.max_chars);
      if (a.action === "fetch") {
        if (!a.doc || !/feishu\.cn|larksuite\.com|larkoffice\.com/.test(a.doc)) throw new Error("需要飞书文档链接 doc");
        return clip(await larkCli(["docs", "+fetch", "--doc", a.doc, "--as", "user", "--doc-format", "markdown"], 60_000));
      }
      if (a.action === "meta") {
        if (!a.doc) throw new Error("需要飞书文档链接 doc");
        const { normalizeDocUrl } = await import("../channels/lark-docs.ts");
        const d = normalizeDocUrl(a.doc);
        return clip(await larkCli(["drive", "metas", "batch_query", "--data", JSON.stringify({ request_docs: [{ doc_token: d.token, doc_type: d.type === "docs" ? "doc" : d.type }] }), "--as", "user"], 60_000));
      }
      if (!a.token) throw new Error("需要 token");
      if (a.action === "csv") {
        if (!a.sheet_id) throw new Error("需要 sheet_id");
        return clip(await larkCli(["sheets", "+csv-get", "--spreadsheet-token", a.token, "--sheet-id", a.sheet_id, "--include-row-prefix=false", "--max-chars", "4000", "--as", "user"], 60_000));
      }
      const dir = mkdtempSync(join(tmpdir(), "omem-doc-raw-"));
      try {
        const args = a.action === "preview" ? ["docs", "+media-preview", "--token", a.token] : ["docs", "+media-download", "--token", a.token, "--type", a.type];
        const out = await larkCli([...args, "--output", `./${a.token}`, "--as", "user"], 180_000, dir).catch((e) => ({ error: (e as Error).message }));
        return { output: out, files: readdirSync(dir).map((n) => ({ name: n, bytes: statSync(join(dir, n)).size })) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  "lark-whois": {
    description: "只读：一个人在 lark-cli（本人身份，id 为它的 open_id）和机器人（id 为机器人的 open_id / user_id / union_id 或 email）眼里的 id、名字和邮箱，用来核对 id 能否互通、权限是否够；id 为 om_ 开头的消息时，返回 lark-cli 按 union_id 读到的发送人和被 @ 的人",
    schema: z.object({
      id: z.string().regex(/^[\w@.+-]{1,120}$/),
      id_type: z.enum(["open_id", "union_id", "user_id", "email"]).default("open_id"),
      as: z.enum(["cli", "bot", "both"]).default("both"),
    }),
    run: async (_app, a) => {
      const out: Record<string, unknown> = {};
      const { larkCli } = await import("../channels/lark-cli.ts");
      if (a.id.startsWith("om_")) {
        const v = await larkCli(["api", "GET", `/open-apis/im/v1/messages/${a.id}`, "--params", JSON.stringify({ user_id_type: "union_id" }), "--as", "user"], 30_000).catch((e) => ({ error: (e as Error).message }));
        const item = (v as any).data?.items?.[0];
        return item ? { sender: item.sender, mentions: item.mentions } : v;
      }
      const pick = (u: any) => (u ? { name: u.name, open_id: u.open_id, union_id: u.union_id, user_id: u.user_id, email: u.email || u.enterprise_email } : null);
      if (a.as !== "bot" && a.id_type === "open_id") {
        try {
          const v = await larkCli(["contact", "+search-user", "--user-ids", a.id, "--as", "user"], 30_000);
          out.cli = v.data?.users ?? v.data;
        } catch (e) {
          out.cli = { error: (e as Error).message };
        }
      }
      if (a.as !== "cli") {
        const err = (e: unknown) => {
          const x = e as { response?: { data?: { code?: number; msg?: string } }; message: string };
          return { error: x.response?.data ? `${x.response.data.code} ${x.response.data.msg}` : x.message };
        };
        try {
          const { larkClient } = await import("../channels/lark-send.ts");
          const c = larkClient();
          if (a.id_type === "email") {
            const r = await c.contact.user.batchGetId({ data: { emails: [a.id], include_resigned: false }, params: { user_id_type: "user_id" } });
            out.botByEmail = r.code ? { error: `${r.code} ${r.msg}` } : r.data?.user_list;
          } else {
            const r = await c.contact.user.get({ path: { user_id: a.id }, params: { user_id_type: a.id_type } });
            out.bot = r.code ? { error: `${r.code} ${r.msg}` } : pick(r.data?.user);
          }
        } catch (e) {
          out[a.id_type === "email" ? "botByEmail" : "bot"] = err(e);
        }
      }
      return out;
    },
  },
  "lark-bot-permissions": {
    description: "飞书机器人缺哪些权限（含 @ 人要用的 user_id、邮箱），返回一键申请的链接；scan: true 时在后台发起扫码补齐，返回二维码链接（在飞书里打开确认）",
    schema: z.object({ scan: z.boolean().default(false) }),
    run: async (app, a) => {
      const { checkLarkApp, larkAppSecret, larkScopeLink, LARK_BOT_ADDONS, registerLarkBot, saveLarkSecret } = await import("../channels/lark-setup.ts");
      const cfg = app.config.lark;
      const secret = larkAppSecret(app.home, cfg.appId, cfg.appSecretEnv);
      if (!cfg.appId || !secret) throw new Error("还没有绑定飞书机器人");
      const check = await checkLarkApp(cfg.appId, secret);
      if (check.error) throw new Error(check.error);
      const missing = check.scopesUnknown ? LARK_BOT_ADDONS.scopes.tenant : check.missingScopes;
      const out: Record<string, unknown> = { bot: check.botName, scopesUnknown: !!check.scopesUnknown, missing, link: missing.length ? larkScopeLink(cfg.appId, missing) : null };
      if (a.scan) {
        out.scan = await new Promise((resolve) => {
          registerLarkBot({ appId: cfg.appId, onQr: (url, expires) => resolve({ url, expiresInMinutes: Math.round(expires / 60) }) })
            .then(async (creds) => {
              saveLarkSecret(app.home, { ...creds, name: check.botName });
              const { notify } = await import("./notify.ts");
              const after = await checkLarkApp(creds.appId, creds.appSecret);
              notify(app, { title: "飞书机器人权限已更新", body: after.missingScopes.length ? `仍缺：${after.missingScopes.join("、")}（可能在等管理员审批）` : "权限已补齐" });
            })
            .catch((e) => resolve({ error: (e as Error).message }));
        });
      }
      return out;
    },
  },
  "doubao-status": {
    description: "豆包 OpenAPI：各飞书应用的豆包权限与本机授权状态",
    schema: z.object({}),
    run: async (app) => (await import("../agents/doubao.ts")).doubaoStatus(app.home, app.config),
  },
  "doubao-login": {
    description: "豆包 OpenAPI：以本人身份发起授权（返回设备码链接，在飞书里打开确认；授权在后台完成后通知）",
    schema: z.object({ app: z.string().regex(/^cli_[A-Za-z0-9]+$/).optional() }),
    run: async (app, a) => {
      const { authorizeDoubao, doubaoApps } = await import("../agents/doubao.ts");
      const apps = await doubaoApps(app.home, app.config);
      const target = a.app ? apps.find((x) => x.appId === a.app) : apps[0];
      if (!target) throw new HttpError(400, "omem 没有这个飞书应用的 App Secret");
      return await new Promise((resolve) => {
        authorizeDoubao(app.home, target, (url, userCode, expiresIn) => resolve({ appId: target.appId, url, userCode, expiresInMinutes: Math.round(expiresIn / 60) }))
          .then(async () => {
            const { notify } = await import("./notify.ts");
            notify(app, { title: "豆包已授权", body: `应用 ${target.name ?? target.appId} 的豆包授权已保存，可以把后端设为 doubao` });
          })
          .catch((e) => resolve({ error: (e as Error).message }));
      });
    },
  },
  "lark-docs-refresh": {
    description: "重新读取已保存的飞书文档（下载图片、画板等素材，导入链接的文档），在后台运行，完成后发通知；metadataOnly 只更新中文知识库和目录（同时写进知识库目录树），unchecked 只挑从没读过目录位置的文档，ids 可限于指定原件；stop: true 在当前这篇读完后停下",
    schema: z.object({ space: z.string().max(64).optional(), limit: z.number().int().min(1).max(10_000).optional(), metadataOnly: z.boolean().default(false), unchecked: z.boolean().optional(), ids: z.array(id).min(1).max(100).optional(), stop: z.boolean().optional() }),
    run: async (app, a) => {
      const { refreshInBackground } = await import("../channels/lark-docs.ts");
      return refreshInBackground(app, a);
    },
  },
  "lark-doc-import": {
    description: "立即读取一篇飞书文档成原件（含素材和链接的文档），返回结果；不交给整理，除非 ingest",
    schema: z.object({ url: z.string().url(), space: z.string().max(64).default("personal"), depth: z.number().int().min(0).max(5).optional(), force: z.boolean().default(true), ingest: z.boolean().default(false) }),
    run: async (app, a) => {
      if (!/feishu\.cn|larksuite\.com|larkoffice\.com/.test(a.url)) throw new Error("需要飞书文档链接");
      const { importLarkDocument } = await import("../channels/lark-docs.ts");
      const r = await importLarkDocument(app, a.space, a.url, { depth: a.depth, force: a.force });
      const src = one<{ title: string; text: string; meta: string }>(app.db, "select title, text, meta from sources where id = ?", r.id);
      const media = Object.values(JSON.parse(src?.meta ?? "{}").media ?? {}) as string[];
      if (a.ingest) {
        const ids = [...(r.status !== "unchanged" ? [r.id] : []), ...r.related];
        if (ids.length) (await import("../agents/jobs.ts")).scheduleIngest(app, a.space, ids, "远程导入的飞书文档");
      }
      // What still points at Feishu: file links and DocxXML media tags (local images are <img src="omem-file:…">).
      const leftover = /\]\(https?:\/\/[\w.-]+\/file\/[^)]*\)|<img\s(?![^>]*omem-file:)[^>]*>|<(?:whiteboard|source|sheet|cite|synced_reference)\s[^>]*>/g;
      return { ...r, title: src?.title, media: { downloaded: media.filter(Boolean).length, failed: media.filter((m) => !m).length }, remaining: src?.text.match(leftover)?.slice(0, 20) ?? [] };
    },
  },
  "lark-docs-status": {
    description: "飞书文档的状态：后台刷新进度、还引用飞书素材的文档数、本地素材数、读不到的链接数",
    schema: z.object({}),
    run: async (app) => (await import("../channels/lark-docs.ts")).larkDocsStatus(app),
  },
  "lark-docs-missing": {
    description: "链接里读不到的飞书文档（多半是没有权限）：retry 立即重试，ignore 不再重试（链接列表或 \"all\"），all 连已放弃的也列出",
    schema: z.object({ retry: z.boolean().default(false), ignore: z.union([z.literal("all"), z.array(z.string().url()).max(500)]).optional(), all: z.boolean().default(false) }),
    run: async (app, a) => {
      const m = await import("../channels/lark-docs.ts");
      const ignored = a.ignore ? m.ignoreMissingDocs(app, a.ignore) : 0;
      const retried = a.retry ? await m.retryMissingDocs(app, { force: true }) : null;
      return { ignored, retried, missing: m.missingDocs(app, { all: a.all }) };
    },
  },
  "lark-docs-check": {
    description: "检查飞书文档有没有更新（按上次修改后的天数到期的那些；force 全部检查），有修改的重新读并交给整理；在后台运行，进度看 lark-docs-status",
    schema: z.object({ force: z.boolean().default(false) }),
    run: async (app, a) => (await import("../channels/lark-docs.ts")).checkInBackground(app, { force: a.force }),
  },
  "lark-poll": { description: "立即采集一次飞书", schema: z.object({}), run: async (app) => (await import("../channels/lark-personal.ts")).pollLark(app) },
  backfill: {
    description: "回溯一个飞书会话的历史",
    schema: z.object({ chat_id: z.string().regex(/^oc_[\w-]+$/), days: z.number().int().min(0).max(3650), ingest: z.boolean().default(false) }),
    run: async (app, a) => {
      const m = await import("../channels/lark-personal.ts");
      const r = m.requestBackfill(app, a.chat_id, a.days, a.ingest);
      m.startBackfill(app);
      return r;
    },
  },
  "backfill-status": { description: "飞书历史回溯的总体进度（已完成、进行中、未开始、失败、速度）", schema: z.object({}), run: async (app) => (await import("../channels/lark-personal.ts")).backfillOverview(app) },
  "lark-fill-files": {
    description: "补拉已保存的飞书消息里缺的图片和附件（chat_ids 限定会话，不给则全部），在后台运行，完成后发通知；status: true 只看进度",
    schema: z.object({ chat_ids: z.array(z.string().regex(/^oc_[\w-]+$/)).max(500).optional(), status: z.boolean().default(false) }),
    run: async (app, a) => {
      const m = await import("../channels/lark-messages.ts");
      return a.status ? m.fillResourcesStatus() : m.fillResourcesInBackground(app, a.chat_ids);
    },
  },
  "digest-status": {
    description: "存量整理任务的进度（分级 / 精读，每个任务做了多少、当前批次）",
    schema: z.object({ all: z.boolean().default(false) }),
    run: async (app, a) => {
      const d = await import("../agents/digest.ts");
      return d.digestStatusText(app, d.listDigestJobs(app, { all: a.all }));
    },
  },
  "source-levels": {
    description: "原件按关注程度（重点 / 一般 / 仅检索 / 忽略）的数量，space 可限定空间",
    schema: z.object({ space: z.string().max(200).optional() }),
    run: async (app, a) => (await import("../sources/attention.ts")).levelCounts(app, null, a.space),
  },
  "memories-stats": {
    description: "按模型的记忆质量统计",
    schema: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    run: async (app, a) => (await import("../memory/quality.ts")).memoryQualityStats(app, a.days),
  },
  rejections: {
    description: "最近被写入检查拒绝的记忆",
    schema: z.object({ limit: z.number().int().min(1).max(200).default(30) }),
    run: async (app, a) => (await import("../memory/quality.ts")).recentRejections(app, a.limit),
  },
  runs: {
    description: "最近的运行",
    schema: z.object({ kind: z.string().max(40).optional(), status: z.string().max(20).optional(), limit: z.number().int().min(1).max(200).default(30) }),
    run: async (app, a) => (await import("../agents/runs.ts")).listRuns(app, { kind: a.kind, status: a.status, limit: a.limit, includeQuiet: true }),
  },
  run: {
    description: "一次运行的详情和最后的事件",
    schema: z.object({ id, events: z.number().int().min(0).max(500).default(60) }),
    run: async (app, a) => {
      const m = await import("../agents/runs.ts");
      const events = m.runEvents(app, a.id);
      return { run: m.getRun(app, a.id), events: events.slice(-a.events) };
    },
  },
  "schedule-run": { description: "立即触发一个定时任务", schema: z.object({ id }), run: (app, a) => ({ ok: triggerSchedule(app, a.id) }) },
  agents: {
    description: "这台机器上的 AI 后端：命令、是否装好、ACP 适配器（npm 包）的已装版本、配置的模型和强度、缓存的探测结果（不启动 Agent）",
    schema: z.object({}),
    run: async (app) => (await import("./peer-inspect.ts")).agentsReport(app),
  },
  "agent-upgrade": {
    description: "更新：把一个已经装好的 ACP 适配器（目录里有 npm 包的后端，如 codex、claude）升级到 npm 上的最新版（npm i -g <包>@latest）；新会话起生效",
    schema: z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) }),
    run: async (app, a) => {
      const { catalogEntry } = await import("../agents/catalog.ts");
      const { listAgentProfiles } = await import("../agents/runner.ts");
      const { adapterPackage } = await import("./peer-inspect.ts");
      // Only a catalog package already installed globally here: nothing new gets onto the machine.
      const entry = catalogEntry(a.id);
      const profile = listAgentProfiles(app).find((p) => p.id === a.id);
      if (!entry?.npm || !profile || profile.command !== entry.command) throw new HttpError(400, `${a.id} 不是目录里带 npm 包的后端`);
      const before = adapterPackage(profile);
      if (before?.via !== "installed" || before.name !== entry.npm) throw new HttpError(400, `${a.id} 的适配器不是全局安装的 ${entry.npm}，不在这里升级`);
      const r = sh("npm", ["i", "-g", `${entry.npm}@latest`], app.home, 600_000);
      const after = adapterPackage(profile);
      return { ok: r.code === 0, package: entry.npm, before: before.version, after: after?.version ?? null, output: (r.stdout + r.stderr).split("\n").slice(-15).join("\n") };
    },
  },
  search: {
    description: "只读：用 Agent 的 search 工具同一套检索（本人身份）查一个问题，返回命中的原件 id、标题、uri、类型、空间、分数和工具会给出的片段；space 缺省为所有空间",
    schema: z.object({ query: z.string().min(1).max(500), space: z.string().max(200).optional(), limit: z.number().int().min(1).max(30).default(12) }),
    run: async (app, a) => (await import("./peer-inspect.ts")).searchPreview(app, a),
  },
  prompt: {
    description: "只读：预览一次运行会收到的常驻说明（共同约定、角色或档案、环境、偏好与经验、技能目录）；给 task 时偏好与经验按任务取最接近的；不含工具令牌，system 最多 30000 字",
    schema: z.object({ role: z.enum(roleNames).optional(), agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/).optional(), space: z.string().min(1).max(200), task: z.string().max(4000).optional() }),
    run: async (app, a) => (await import("./peer-inspect.ts")).promptPreview(app, a),
  },
  ide: {
    description: "只读：网页版 VS Code 的状态（CLI、serve-web 下载的服务端版本和提交、数据和扩展目录、已装扩展与语言包、语言和终端相关设置、服务端日志、运行中的进程；不含令牌）",
    schema: z.object({}),
    run: async (app) => (await import("../server/ide-web.ts")).ideWebReport(app),
  },
  sql: {
    description: "只读查询数据库（select / with / pragma，最多 500 行）",
    schema: z.object({ query: z.string().min(1).max(5000) }),
    run: (app, a) => {
      if (!/^\s*(select|with|pragma\s+table_info|pragma\s+index_list|explain)\b/i.test(a.query) || /;\s*\S/.test(a.query)) throw new HttpError(400, "只允许单条 select / with / pragma table_info 查询");
      const db = new DatabaseSync(join(app.home, "omem.db"), { readOnly: true });
      try {
        return db.prepare(a.query).all().slice(0, 500);
      } finally {
        db.close();
      }
    },
  },
  git: {
    description: "代码仓库：status / log / pull（只快进）",
    schema: z.object({ action: z.enum(["status", "log", "pull", "fetch"]), n: z.number().int().min(1).max(50).default(10) }),
    run: async (_app, a) => {
      const root = await packageRoot();
      const args = a.action === "status" ? ["status", "-sb"] : a.action === "log" ? ["log", `-${a.n}`, "--format=%h %an %cI %s"] : a.action === "fetch" ? ["fetch", "--quiet"] : ["pull", "--ff-only"];
      return sh("git", ["-C", root, ...args], root);
    },
  },
  "library-file": {
    description: "只读查看知识库 Git（library）里的档案/技能文件，或列出目录；用来核对 Agent 学到了什么",
    schema: z.object({
      /** Relative path inside library, e.g. _agents/issue-investigator.md */
      path: z.string().max(300),
      /** Read git history for the file instead of its content. */
      log: z.boolean().default(false),
      n: z.number().int().min(1).max(50).default(10),
    }),
    run: async (app, a) => {
      if (a.path.includes("..") || isAbsolute(a.path)) throw new HttpError(400, "path 必须是 library 内的相对路径");
      const file = join(app.libraryDir, a.path);
      if (!file.startsWith(app.libraryDir)) throw new HttpError(400, "路径越界");
      if (a.log) return sh("git", ["-C", app.libraryDir, "log", `-${a.n}`, "--format=%h %an %cI %s", "--", a.path], app.libraryDir);
      const st = statSync(file, { throwIfNoEntry: false });
      if (!st) throw new HttpError(404, `library 里没有 ${a.path}`);
      if (st.isDirectory()) return readdirSync(file).sort();
      return readFileSync(file, "utf8");
    },
  },
  "library-save": {
    description: "写知识库 Git 里的档案/技能文件（只允许 _agents/<name>.md 和 _skills/<name>/ 下），自动提交。用于本人在网页之外整理 Agent 学到的内容",
    schema: z.object({
      path: z.string().max(300),
      content: z.string().max(2_000_000),
      message: z.string().max(200).default("update via peer"),
    }),
    run: async (app, a) => {
      if (a.path.includes("..") || isAbsolute(a.path)) throw new HttpError(400, "path 必须是 library 内的相对路径");
      const allowed = /^_agents\/[a-z0-9][a-z0-9-]{0,63}\.md$|^_skills\/[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9._/-]{1,200}$/;
      if (!allowed.test(a.path)) throw new HttpError(400, "只允许写 _agents/<名称>.md 或 _skills/<名称>/ 下的文件");
      const file = join(app.libraryDir, a.path);
      if (!file.startsWith(app.libraryDir)) throw new HttpError(400, "路径越界");
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, a.content, "utf8");
      return sh("git", ["-C", app.libraryDir, "add", a.path], app.libraryDir).code === 0
        ? sh("git", ["-C", app.libraryDir, "commit", "-m", `owner: ${a.message}`, "--", a.path], app.libraryDir)
        : { error: "git add failed" };
    },
  },
  update: {
    description: "部署：scripts/upgrade.ts（git pull --ff-only、pnpm install、构建），然后重启服务",
    schema: z.object({ restart: z.boolean().default(true), global: z.boolean().default(false) }),
    run: async (app, a) => {
      const root = await packageRoot();
      const script = join(root, "scripts", "upgrade.ts");
      if (!existsSync(script)) throw new HttpError(400, "这台机器上的 omem 不是源码仓库（没有 scripts/upgrade.ts），不能远程更新");
      const r = sh(process.execPath, [script, ...(a.global ? [] : ["--no-global"])], root, 900_000);
      const tail = (r.stdout + r.stderr).split("\n").slice(-40).join("\n");
      if (r.code !== 0) return { ok: false, code: r.code, output: tail };
      if (a.restart) restartSoon(app);
      return { ok: true, output: tail, restarting: a.restart };
    },
  },
  // Re-sync a repository/directory space (checks out submodules of omem's own clones first).
  syncSpace: {
    description: "立即同步一个关联目录的空间（会先拉取 omem 克隆仓库的子模块，可能很久）",
    schema: z.object({ space: z.string() }),
    run: async (app, a) => {
      const { scheduleSpaceSync } = await import("../agents/jobs.ts");
      const { getSpace } = await import("./spaces.ts");
      const s = getSpace(app, a.space);
      if (!s.rootPath) throw new HttpError(400, "这个空间没有关联目录");
      const run = scheduleSpaceSync(app, s.id);
      return { runId: run.id, title: run.title };
    },
  },
  restart: {
    description: "重启后台服务（omem service restart）",
    schema: z.object({}),
    run: (app) => {
      restartSoon(app);
      return { restarting: true };
    },
  },
};

export async function runPeerCommand(app: App, name: string, args: unknown) {
  const c = peerCommands[name];
  if (!c) throw new HttpError(400, `没有命令 ${name}。可用：${Object.keys(peerCommands).join(", ")}`);
  const parsed = c.schema.safeParse(args ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return c.run(app, parsed.data);
}
