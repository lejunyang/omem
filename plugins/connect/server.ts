import { z } from "zod";
import type { PluginApi, PluginContext } from "../../src/plugins/types.ts";
import { CHINA } from "./china.ts";
import { connector, type Def } from "./engine.ts";
import { IDENTITIES } from "./identities.ts";
import { nangoDefs } from "./nango.ts";

/**
 * Connecting other platforms (docs/v2/connectors.md). Two kinds of connector come out of the same
 * descriptions: identities (the platform says who someone is, so it can log in or be bound) and
 * capabilities (a token or key to read with). Agents read through a connection with connect_request
 * and keep what matters as sources with connect_save; the token never reaches them.
 */
const POST_READS: Record<string, RegExp> = {
  notion: /^\/v1\/(search|databases\/[^/]+\/query|data_sources\/[^/]+\/query)$/,
  dropbox: /^\/2\/(files\/(list_folder(\/continue)?|get_metadata|search_v2(\/continue)?)|users\/get_current_account|sharing\/list_[a-z_]+)$/,
};
/** A POST that only reads: a GraphQL query (not a mutation), or a search / query endpoint. */
function readOnlyPost(d: Def, path: string, body: unknown) {
  const p = path.split("?")[0];
  if ((d.readPost ?? POST_READS[d.id])?.test(p)) return true;
  const last = p.split("/").filter(Boolean).pop() ?? "";
  const q = body && typeof body === "object" ? (body as { query?: unknown }).query : undefined;
  if (/graphql/i.test(last) || (typeof q === "string" && /^\s*(query\b|\{)/.test(q))) return typeof q === "string" && !/^\s*mutation\b/.test(q) && !/\bmutation\s*[({]/.test(q);
  return /search|query|listrecords/i.test(last);
}

/**
 * Read-only scopes asked for by default where a platform needs some to read anything (the owner can
 * add more in the platform's settings). Write scopes are never asked for: the tools only read.
 */
const READ_SCOPES: Record<string, string[]> = {
  "google-drive": ["https://www.googleapis.com/auth/drive.readonly"],
  "google-docs": ["https://www.googleapis.com/auth/documents.readonly", "https://www.googleapis.com/auth/drive.readonly"],
  "google-sheet": ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  "google-mail": ["https://www.googleapis.com/auth/gmail.readonly"],
  "google-calendar": ["https://www.googleapis.com/auth/calendar.readonly"],
  gitlab: ["read_api"],
  jira: ["read:jira-work", "read:jira-user", "offline_access"],
  linear: ["read"],
  dropbox: ["account_info.read", "files.metadata.read", "files.content.read"],
  slack: ["channels:read", "channels:history", "groups:read", "groups:history", "im:history", "mpim:history", "users:read"],
};
/** Where a platform's catalog entry needs a correction for reading as the person. */
const OVERRIDES: Record<string, Partial<Def>> = {
  // Slack's user token (reading as the person) comes from user_scope; `scope` would give a bot token.
  slack: { authNames: { scope: "user_scope" } },
};

export default function register(api: PluginApi) {
  const { defs: catalog, skipped } = nangoDefs();
  const own = new Set(CHINA.map((d) => d.id));
  const defs = new Map<string, Def>();
  for (const d of [...CHINA, ...catalog.filter((d) => !own.has(d.id))]) {
    const extra = READ_SCOPES[d.id] ?? [];
    defs.set(d.id, { ...d, ...OVERRIDES[d.id], defaultScopes: [...new Set([...(d.defaultScopes ?? []), ...extra])], who: d.who ?? IDENTITIES[d.id] });
  }
  for (const d of defs.values()) api.connector(connector(api, d, { identity: !!d.who }));
  if (!catalog.length) console.warn("[omem] 连接平台：读不到 @nangohq/providers，只有内置的国内平台");
  else if (skipped) console.log(`[omem] 连接平台：${defs.size} 个平台可连接（目录里另有 ${skipped} 个用了这里不支持的写法）`);

  const platform = (name: string) => {
    const id = name.replace(new RegExp(`^${api.id}-`), "");
    const d = defs.get(id);
    if (!d) throw new Error(`没有平台 ${name}：用 connect_list 看已经连接的平台`);
    return d;
  };
  const packOf = (d: Def) => api.platforms().find((p) => p.provider === `${api.id}-${d.id}`) ?? null;
  const connected = async (ctx: PluginContext, d: Def) => {
    const c = await ctx.connection(`${api.id}-${d.id}`);
    if (!c) throw new Error(`本人还没有连接${d.label}：请本人在 omem 的账号页“已连接的应用”里连接（主人要先在 设置 → 连接 → 其他平台 打开它）`);
    return c;
  };

  api.tool({
    name: "connect_list",
    whenConnected: true,
    description: "列出本人已经连接的平台（Notion、GitHub、Google Drive、钉钉……）：每个平台的 id、账号、接口地址和接口文档。读平台内容前先用它确认连了哪些。",
    schema: z.object({ query: z.string().max(60).optional().describe("按名字筛选，如 notion、日历") }),
    handler: async (ctx, a) => {
      const q = a.query?.toLowerCase();
      const lines: string[] = [];
      for (const d of defs.values()) {
        if (q && !d.id.includes(q) && !d.label.toLowerCase().includes(q) && !d.group.includes(q)) continue;
        const c = await ctx.connection(`${api.id}-${d.id}`);
        if (!c) continue;
        lines.push(`- ${d.id}（${d.label}，${d.group}）账号 ${c.account || "—"}；接口 ${c.base ?? "未设置"}${d.docs ? `；文档 ${d.docs}` : ""}`);
        const pack = packOf(d);
        if (pack) {
          lines.push(`  能直接读（connect_read / connect_watch）：${pack.readers.map((r) => `${r.kind}（${r.label}；id：${r.id}${r.changes ? "；可盯着同步" : ""}）`).join("；")}`);
          if (pack.guide) lines.push(`  ${pack.guide.replace(/\n/g, "\n  ")}`);
        }
        for (const w of ctx.watches?.list(`${api.id}-${d.id}`) ?? []) lines.push(`  正在盯着 ${w.id}：${w.kind} ${w.target}${w.title ? `（${w.title}）` : ""} → 空间 ${w.spaceId}；上次 ${w.lastRunAt ?? "还没同步"}${w.lastError ? `，出错：${w.lastError}` : ""}`);
      }
      return lines.length ? lines.join("\n") : `本人还没有连接${q ? `和“${a.query}”有关的` : "任何"}平台。连接在 omem 的账号页“已连接的应用”里做。`;
    },
  });

  api.tool({
    name: "connect_request",
    whenConnected: true,
    description:
      "以本人的身份读一个已连接平台的接口：路径相对该平台的接口地址（connect_list 里的），宿主带上本人的令牌。只能读：GET；POST 只用于搜索、查询和 GraphQL query（不能 mutation）。翻页按平台文档带游标或页码，响应头里的 link 会一并返回。",
    schema: z.object({
      provider: z.string().describe("平台 id，如 notion、github、google-drive"),
      path: z.string().min(1).max(2000).describe("接口路径，如 /v1/search、/repos/acme/app/issues"),
      method: z.enum(["GET", "POST", "HEAD"]).default("GET"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("查询参数"),
      body: z.unknown().optional().describe("POST 的 JSON 请求体"),
      max_chars: z.number().int().min(500).max(60000).default(20000).describe("最多返回多少字符"),
    }),
    handler: async (ctx, a) => {
      const d = platform(a.provider);
      if (a.method === "POST" && !readOnlyPost(d, a.path, a.body)) throw new Error(`${d.label}的 ${a.path} 可能会改动内容：这里只能读（GET，或搜索、查询、GraphQL query 的 POST）`);
      const c = await connected(ctx, d);
      const path = a.path.startsWith("/") || /^https?:\/\//.test(a.path) ? a.path : `/${a.path}`;
      const url = new URL(/^https?:\/\//.test(path) ? path : `${(c.base ?? "").replace(/\/+$/, "")}${path}`);
      for (const [k, v] of Object.entries(a.query ?? {})) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9, */*;q=0.5" };
      if (a.body !== undefined) headers["content-type"] = "application/json";
      const res = await c.fetch(url.toString(), { method: a.method, headers, body: a.method === "POST" && a.body !== undefined ? JSON.stringify(a.body) : undefined });
      const type = res.headers.get("content-type") ?? "";
      const meta = [`HTTP ${res.status}`, type && `content-type: ${type}`, res.headers.get("link") && `link: ${res.headers.get("link")}`, res.headers.get("location") && `location: ${res.headers.get("location")}`].filter(Boolean).join("\n");
      if (a.method === "HEAD") return meta;
      if (type && !/json|text|xml|html|javascript|csv|markdown|yaml/i.test(type)) {
        const size = res.headers.get("content-length");
        await res.body?.cancel();
        return `${meta}\n（二进制内容${size ? ` ${size} 字节` : ""}，不能直接读；找这个平台导出文本或 Markdown 的接口）`;
      }
      let text = await res.text();
      if (/json/i.test(type) || /^[[{]/.test(text.trim())) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 1);
        } catch {}
      }
      const cut = text.length > a.max_chars;
      return `${meta}\n\n${cut ? text.slice(0, a.max_chars) : text}${cut ? `\n\n（已截断：共 ${text.length} 字符，只返回前 ${a.max_chars}；缩小范围或翻页）` : ""}`;
    },
  });

  api.tool({
    name: "connect_read",
    whenConnected: true,
    description:
      "用平台包读一项内容（Figma 文件、Notion 页面、GitHub issue、Slack 一天的频道消息……），平台包已经把它整理成 Markdown；save 为 true 时同时存成原件。哪些平台、哪些类型能读看 connect_list。没有平台包的平台用 connect_request。",
    schema: z.object({
      provider: z.string().describe("平台 id，如 figma、notion"),
      kind: z.string().describe("内容类型，如 file、page、issue（connect_list 里列出）"),
      id: z.string().min(1).max(500).describe("这项内容的 id，写法见 connect_list"),
      save: z.boolean().default(false).describe("同时存成原件（同一项再存是更新）"),
      space: z.string().optional().describe("存进哪个空间，默认当前空间"),
      max_chars: z.number().int().min(500).max(60000).default(20000),
    }),
    write: true,
    handler: async (ctx, a) => {
      const d = platform(a.provider);
      const pack = packOf(d);
      const reader = pack?.readers.find((r) => r.kind === a.kind);
      if (!reader?.read) throw new Error(pack ? `${d.label}能读的类型：${pack.readers.filter((r) => r.read).map((r) => r.kind).join("、")}` : `${d.label}没有平台包：用 connect_request 读接口`);
      const c = await connected(ctx, d);
      const doc = await reader.read(c, a.id.trim());
      if (!doc) return `没有读到 ${a.kind} ${a.id}`;
      let saved = "";
      if (a.save) {
        if (!ctx.saveSource) throw new Error("这里不能保存原件");
        const r = ctx.saveSource({ space: a.space, kind: doc.kind ?? "doc", uri: `${d.id}:${a.kind}/${doc.id ?? a.id.trim()}`, title: doc.title, text: doc.text, meta: { provider: d.id, url: doc.url, platformUpdatedAt: doc.updatedAt } });
        saved = `（${r.created ? "已新建" : r.changed ? "已更新" : "没有变化"}原件 ${r.id}，空间 ${r.space}）`;
      }
      const cut = doc.text.length > a.max_chars;
      const head = [`# ${doc.title}`, doc.url, doc.updatedAt && `最后修改 ${doc.updatedAt}`, saved].filter(Boolean).join("\n");
      return `${head}\n\n${cut ? `${doc.text.slice(0, a.max_chars)}\n\n（已截断：共 ${doc.text.length} 字符）` : doc.text}`;
    },
  });

  api.tool({
    name: "connect_watch",
    whenConnected: true,
    description:
      "盯着平台上的一项内容或一个范围（Figma 项目、Notion 数据库、GitHub 仓库的 issue、Slack 频道……）：之后定时把改过的读成原件，存进指定空间，以本人的连接读。马上会先同步一次。能盯的类型看 connect_list 里标“可盯着同步”的，单项内容也能盯（改了就重读）。remove 给盯着的 id 时取消。",
    schema: z.object({
      provider: z.string().optional(),
      kind: z.string().optional(),
      target: z.string().max(500).optional().describe("要盯的东西的 id"),
      title: z.string().max(200).optional().describe("给本人看的名字，如“设计系统项目”"),
      space: z.string().optional().describe("存进哪个空间，默认当前空间"),
      remove: z.string().optional().describe("取消这个盯着（connect_list 里的 pw… id）"),
    }),
    write: true,
    handler: async (ctx, a) => {
      if (!ctx.watches) throw new Error("这里不能设置盯着");
      if (a.remove) return ctx.watches.remove(a.remove) ? `已取消 ${a.remove}` : `没有 ${a.remove}`;
      if (!a.provider || !a.kind || !a.target) throw new Error("要给 provider、kind 和 target");
      const d = platform(a.provider);
      await connected(ctx, d);
      const w = ctx.watches.add({ provider: `${api.id}-${d.id}`, kind: a.kind, target: a.target, title: a.title, space: a.space });
      return `已盯着 ${d.label} 的 ${w.kind} ${w.target}（${w.id}），存进空间 ${w.spaceId}；正在后台做第一次同步，之后定时更新。用 connect_list 看同步情况。`;
    },
  });

  api.tool({
    name: "connect_save",
    whenConnected: true,
    description:
      "把从已连接平台读到的一项内容（一篇文档、一个 issue、一段对话、一封邮件）存成原件。id 写平台上不会变的编号（如 Notion 页面 id、issue 的 owner/repo#12），同一个 id 再存是更新同一份原件。正文写整理好的纯文本或 Markdown，保留原文，不要改写成摘要。",
    schema: z.object({
      provider: z.string().describe("平台 id"),
      id: z.string().min(1).max(400).describe("这项内容在平台上的编号"),
      title: z.string().min(1).max(300),
      text: z.string().min(1).max(2_000_000).describe("正文"),
      kind: z.enum(["doc", "chat", "note"]).default("doc").describe("doc：文档、工单、邮件；chat：聊天记录"),
      url: z.string().max(2000).optional().describe("在平台上打开它的链接"),
      updated_at: z.string().max(40).optional().describe("平台上的最后修改时间，下次采集时用来判断有没有变"),
      space: z.string().optional().describe("存进哪个空间，默认当前空间"),
    }),
    write: true,
    handler: async (ctx, a) => {
      const d = platform(a.provider);
      if (!ctx.saveSource) throw new Error("这里不能保存原件");
      const r = ctx.saveSource({ space: a.space, kind: a.kind, uri: `${d.id}:${a.id}`, title: a.title, text: a.text, meta: { provider: d.id, url: a.url, platformUpdatedAt: a.updated_at } });
      return `${r.created ? "已新建" : r.changed ? "已更新" : "没有变化"}：${a.title}（原件 ${r.id}，空间 ${r.space}）`;
    },
  });
}
