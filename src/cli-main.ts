import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import "./agents/jobs.ts";
import { ask, scheduleIngest, scheduleSpaceSync, type PageBrief } from "./agents/jobs.ts";
import { createMcpServer } from "./agents/mcp-server.ts";
import { listAgentProfiles } from "./agents/runner.ts";
import { createRun, getRun, waitForRun, type Run } from "./agents/runs.ts";
import { callTool, toolSchemas } from "./agents/tools.ts";
import { App, type AppEvent } from "./core/app.ts";
import { configPath, omemHome } from "./core/config.ts";
import { createSpace, ensurePersonalSpace, getSpace, kindLabel, listSpaces, relatedIds, relateSpaces, spaceForDir, unrelateSpaces, updateSpace } from "./core/spaces.ts";
import { listItems, upsertItem } from "./items/store.ts";
import { listMemories } from "./memory/store.ts";
import { memoriesCommand } from "./cli-memories.ts";
import { boot } from "./main.ts";
import { search } from "./search/search.ts";
import { importDirectory, importFile, importText, importUrl, syncDirectorySpace } from "./sources/import.ts";
import { listPages, readPage, syncWiki } from "./wiki/store.ts";

const program = new Command();
program.name("omem").description("个人记忆与助理：理解材料、带依据地回答、跟进事项、交办 Agent。").version("0.2.0");
program.option("--home <dir>", "数据目录（默认 ~/.omem，或环境变量 OMEM_HOME）");

const home = () => (program.opts().home ? resolve(program.opts().home) : omemHome());
const open = () => {
  const app = App.open(home());
  ensurePersonalSpace(app);
  return app;
};

/** Is an omem service already running on this library? Then let it run the job. */
async function runningServer(app: App) {
  try {
    const res = await fetch(`http://127.0.0.1:${app.config.port}/api/settings`, { signal: AbortSignal.timeout(800), headers: app.config.token ? { authorization: `Bearer ${app.config.token}` } : {} });
    if (!res.ok) return null;
    const body = (await res.json()) as { home?: string };
    return body.home && resolve(body.home) === resolve(app.home) ? `http://127.0.0.1:${app.config.port}` : null;
  } catch {
    return null;
  }
}

function printEvent(ev: { type: string; data: { text?: string; title?: string; status?: string } }, stream: boolean, state: { last: string }) {
  if (stream && ev.type === "text-delta") process.stdout.write(ev.data.text ?? "");
  else if (ev.type === "tool" && ev.data.status !== "completed") process.stderr.write(`\x1b[2m· ${ev.data.title}\x1b[0m\n`);
  else if (ev.type === "status" && ev.data.text !== state.last) process.stderr.write(`\x1b[2m${(state.last = ev.data.text ?? "")}\x1b[0m\n`);
}

/**
 * Run one job and stream its progress. Uses the running service when there is
 * one (it holds the agent tools); otherwise starts a temporary in-process one.
 */
function abortQuiet(booted: { server: { close(): unknown } } | null) {
  try {
    booted?.server.close();
  } catch {}
}

async function runJob(make: (app: App) => Run | { runId: string | null; reply?: string | null } | Promise<{ runId: string | null; reply?: string | null }>, opts: { stream?: boolean; children?: boolean } = {}) {
  const local = open();
  const remote = await runningServer(local);
  const booted = remote ? null : await boot(home(), { port: 0, quiet: true, background: false });
  const app = booted?.app ?? local;
  const created = await make(app);
  if ("reply" in created && created.reply) {
    console.log(created.reply);
    abortQuiet(booted);
    return { status: "done", output: { answer: created.reply } } as unknown as Run;
  }
  const runId = ("runId" in created ? created.runId : created.id)!;
  const state = { last: "" };
  const stream = opts.stream !== false;
  let abortSse: AbortController | undefined;
  if (remote) {
    abortSse = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${remote}/api/events?run=${runId}${app.config.token ? `&token=${app.config.token}` : ""}`, { signal: abortSse!.signal });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (line.startsWith("data: ")) {
              const e = JSON.parse(line.slice(6)) as AppEvent;
              if (e.type === "run-event") printEvent(e.event as never, stream, state);
            }
          }
        }
      } catch {}
    })();
  } else
    app.events.on("event", (e: AppEvent) => {
      if (e.type === "run-event" && e.runId === runId) printEvent(e.event as never, stream, state);
    });
  process.on("SIGINT", () => {
    import("./agents/runs.ts").then((m) => m.cancelRun(app, runId));
  });
  const r = await waitForRun(app, runId);
  if (opts.children) {
    const { listRuns } = await import("./agents/runs.ts");
    for (const child of listRuns(app, { parentId: runId, limit: 200 }).reverse()) {
      process.stderr.write(`\x1b[2m等待：${child.title}\x1b[0m\n`);
      const c = await waitForRun(app, child.id);
      process.stderr.write(`${c.status === "done" ? "✓" : "✗"} ${c.title}${c.error ? "：" + c.error : ""}\n`);
    }
  }
  process.stdout.write("\n");
  if (r.status === "failed") console.error(`\n运行失败：${r.error}`);
  abortSse?.abort();
  await booted?.server.close();
  return r;
}

program
  .command("serve")
  .description("启动服务（网页、API、后台任务）")
  .option("-p, --port <port>", "端口", (v) => Number(v))
  .option("--host <host>", "监听地址")
  .action(async (o) => {
    await boot(home(), { port: o.port, host: o.host });
  });

program
  .command("service [action]")
  .description("后台常驻服务（自带 PM2，崩溃自动重启、日志轮换）：start | stop | restart | status | logs | enable | disable（开机自启）")
  .option("-n, --lines <n>", "logs：显示最近多少行", (v) => Number(v), 80)
  .action(async (action: string | undefined, o) => {
    const { manageService, formatService } = await import("./core/service.ts");
    const a = action ?? "status";
    if (a === "logs") {
      const s = await manageService(home(), "status");
      for (const f of s.logs) {
        if (!existsSync(f)) continue;
        console.log(`\x1b[2m==> ${f}\x1b[0m`);
        console.log(readFileSync(f, "utf8").split("\n").slice(-o.lines).join("\n"));
      }
      return;
    }
    if (a === "enable" || a === "disable") {
      const auto = await import("./core/autostart.ts");
      if (a === "disable") {
        const r = auto.disableAutostart(home());
        console.log(r.removed.length ? `已取消开机自启（删除 ${r.removed.join("、")}）。服务本身没有停，需要的话 omem service stop。` : "没有设置过开机自启。");
        return;
      }
      const { entry } = await import("./core/service.ts");
      const r = auto.enableAutostart(home(), process.execPath, entry());
      console.log(`已设置开机自启：${r.where}\n登录（Linux 开了 linger 时是开机）后会运行 omem service start；PATH 用的是现在这个终端的，之后装了新的 Agent 或换了 Node 版本，再运行一次 omem service enable。`);
      for (const n of r.notes) console.log(`注意：${n}`);
      const s = await manageService(home(), "start");
      console.log(formatService(s));
      return;
    }
    if (!["start", "stop", "restart", "status"].includes(a)) throw new Error("用法：omem service start | stop | restart | status | logs | enable | disable");
    const s = await manageService(home(), a as "start");
    console.log(formatService(s));
    if ((a === "start" || a === "restart") && !s.healthy) process.exitCode = 1;
  });

program
  .command("pull <host>")
  .description("从另一台机器拉取 omem 数据（已配对的同伴走 HTTP，其他按 ssh 主机）：默认合并进本地，--overwrite 整体替换（旧数据留备份）")
  .option("--remote-home <dir>", "远端数据目录", "~/.omem")
  .option("--overwrite", "用远端数据替换本地（原件、记忆、事项、会话、知识库），本地配置和密钥保留")
  .option("--dry-run", "只统计合并结果，不写入")
  .action(async (host: string, o) => {
    const { fetchRemote, mergeLibrary, overwriteLocal, cleanupFetched } = await import("./core/pull.ts");
    const log = (s: string) => console.error(s);
    const local = open();
    if (await runningServer(local)) {
      if (o.overwrite) throw new Error("本地服务正在运行；先 omem service stop（或停掉 omem serve）再覆盖。");
      log("本地服务正在运行：合并照常进行，完成后建议 omem service restart。");
    }
    const { findPeer } = await import("./core/peers.ts");
    // A paired peer is fetched over HTTP (also through another peer); anything else is an ssh host.
    const fetched = findPeer(local, host) ? await (await import("./core/pull.ts")).fetchPeer(local, host, log) : fetchRemote(local, host, o.remoteHome, log);
    try {
      if (o.overwrite) {
        local.db.close();
        const backup = overwriteLocal(home(), fetched);
        console.log(`已用 ${host} 的数据替换本地。原数据在 ${backup}；配置与密钥未改动。`);
        return;
      }
      const r = mergeLibrary(local, fetched, { dryRun: o.dryRun, log });
      const names: Record<string, string> = { spaces: "空间", sources: "原件", memories: "记忆", items: "事项", item_events: "事项时间线", conversations: "会话", messages: "消息", runs: "运行", run_events: "运行事件", cards: "卡片", card_reviews: "复习记录", notifications: "通知", files: "原件文件" };
      for (const [k, v] of Object.entries(r))
        if (k !== "wiki" && "added" in v && (v.added || v.updated)) console.log(`${(names[k] ?? k).padEnd(8)} 新增 ${v.added}${v.updated ? `，更新 ${v.updated}` : ""}${v.kept ? `，保留本地 ${v.kept}` : ""}`);
      if (r.wiki?.conflicts.length) console.log(`知识库冲突 ${r.wiki.conflicts.length} 处：保留本地版本，远端版本存为同名 .remote.md：\n  ${r.wiki.conflicts.join("\n  ")}`);
      console.log(o.dryRun ? "（预览，未写入）" : "合并完成。新原件的向量会由服务在后台补齐。");
    } finally {
      cleanupFetched(fetched);
    }
  });

// ------------------------------------------------------------------- peers
const peer = program.command("peer").description("同伴：其他运行 omem 的设备（配对、诊断、远程执行检查命令）");
peer
  .command("invite")
  .description("在本机生成配对码，交给另一台设备的 omem peer add（服务不必正在运行）")
  .option("--url <url>", "对方访问本机 omem 的地址（默认列出本机所有网卡地址，对方自动挑能连上的）")
  .option("--label <name>", "给这个配对起个名字（令牌标签）", "device")
  .action(async (o) => {
    const { invite, serviceRunning } = await import("./core/peers.ts");
    const app = open();
    const r = invite(app, { url: o.url, label: o.label });
    console.log(`本机：${r.id}\n地址：${r.urls.join("  ") || "（无）"}\n\n在另一台设备上运行：\n\n  omem peer add ${r.code}\n`);
    if (!o.url && !r.urls.length) console.log(`注意：配置里 host 是 ${app.config.host}，只有本机能访问。删掉这一项（默认监听所有网卡）或改成 "0.0.0.0" 后 omem service restart，再重新 invite。`);
    if (!(await serviceRunning(app))) console.log("注意：本机 omem 服务现在没在运行；配对码照样有效，对方 add 之前先 omem service start。");
    console.log(`撤销：omem user revoke owner peer:${o.label}`);
  });
peer
  .command("add <code>")
  .description("用配对码添加同伴（重复 add 同一个同伴会更新它）；--via 表示要经另一个同伴转发才能访问")
  .option("--via <peer>", "经由哪个同伴转发")
  .option("--url <url>", "覆盖配对码里的地址")
  .action(async (code: string, o) => {
    const { addPeer, peerJson } = await import("./core/peers.ts");
    const app = open();
    const p = await addPeer(app, code, { via: o.via, url: o.url });
    try {
      const d = await peerJson<{ node: string; version: string | null }>(app, p.id, "/api/diag", undefined, 20_000);
      console.log(`已添加同伴 ${p.id}${p.via ? `（经 ${p.via}）` : `（${p.url}）`}，连接正常：${d.node} · ${d.version ?? "版本未知"}`);
    } catch (e) {
      console.log(`已添加同伴 ${p.id}，但现在连不上：${(e as Error).message}\n对方上线后直接用即可，不用重新配对；地址变了用 omem peer url ${p.id} <新地址>。`);
    }
  });
peer
  .command("name [id]")
  .description("查看或设置本机在同伴中的名字（默认是主机名）")
  .action(async (id?: string) => {
    const { nodeId } = await import("./core/peers.ts");
    const { saveConfig } = await import("./core/config.ts");
    const app = open();
    if (!id) return console.log(nodeId(app));
    const clean = id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!clean) throw new Error("名字只能用字母、数字和连字符");
    app.config.node = { ...app.config.node, id: clean };
    saveConfig(app.config, app.home);
    console.log(`本机名字：${clean}。服务在运行的话 omem service restart 后生效。`);
    console.log("已经和别的设备配对过的：它们那边还记着旧名字，照常可用；想统一就在本机重新 invite、对方重新 add（--via 的链路两端名字需一致）。");
  });
peer
  .command("open <id>")
  .description("在本机打开同伴的网页（经本机转发，--via 的同伴也行；浏览器不用令牌）")
  .option("-p, --port <port>", "本机端口（默认 4318 起找空闲的）", (v) => Number(v))
  .option("--no-browser", "只打印地址，不打开浏览器")
  .action(async (id: string, o) => {
    const { openPeerUi } = await import("./core/peers.ts");
    const app = open();
    let ui: Awaited<ReturnType<typeof openPeerUi>> | null = null;
    for (let p = o.port ?? 4318; !ui && p < (o.port ?? 4318) + 20; p++) ui = await openPeerUi(app, id, p).catch(() => null);
    if (!ui) throw new Error("找不到空闲端口，用 --port 指定");
    console.log(`${id} 的网页：${ui.url}\n（按 Ctrl+C 结束；请求经本机转发到 ${id}，只有本机能打开这个地址）`);
    if (o.browser) {
      const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", ui.url]] : process.platform === "darwin" ? ["open", [ui.url]] : ["xdg-open", [ui.url]];
      const { spawn } = await import("node:child_process");
      spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    }
    await new Promise(() => {});
  });
peer
  .command("url <id> <url>")
  .description("同伴换了地址、原来的都连不上时，指定新地址（不用重新配对）")
  .action(async (id: string, url: string) => {
    const { setPeerUrl } = await import("./core/peers.ts");
    console.log(`已更新：${setPeerUrl(open(), id, url).url}`);
  });
program
  .command("link")
  .description("从其他设备用浏览器打开本机网页的链接（带一个新令牌；本机打开不需要）")
  .option("--label <name>", "令牌标签", "web")
  .action(async (o) => {
    const { localUrls, serviceRunning } = await import("./core/peers.ts");
    const { createApiToken, OWNER } = await import("./core/users.ts");
    const app = open();
    const urls = localUrls(app);
    if (!urls.length) {
      console.log(`配置里 host 是 ${app.config.host}，只有本机能访问：直接打开 http://127.0.0.1:${app.config.port}。要从其他设备打开，删掉配置里的 host（默认监听所有网卡）后 omem service restart。`);
      return;
    }
    const t = createApiToken(app, OWNER, o.label);
    for (const u of urls) console.log(`${u}/?token=${t}`);
    console.log("\n任选一个对方能访问的地址；打开一次后令牌存在那个浏览器里，之后直接访问地址即可。");
    if (!(await serviceRunning(app))) console.log("注意：服务现在没在运行（omem service start）。");
  });
peer
  .command("list")
  .description("已添加的同伴")
  .action(async () => {
    const { listPeers, nodeId } = await import("./core/peers.ts");
    const app = open();
    console.log(`本机：${nodeId(app)}`);
    for (const p of listPeers(app)) console.log(`- ${p.id}  ${p.via ? `经 ${p.via}` : p.url}${!p.via && (p.urls?.length ?? 0) > 1 ? `（备用 ${p.urls!.length - 1} 个地址）` : ""}  （${p.addedAt.slice(0, 10)} 添加）`);
  });
peer
  .command("remove <id>")
  .action(async (id: string) => {
    const { removePeer } = await import("./core/peers.ts");
    console.log(removePeer(open(), id) ? `已移除 ${id}` : `没有 ${id}`);
  });
peer
  .command("commands [id]")
  .description("同伴（或本机）能执行的检查命令")
  .action(async (id?: string) => {
    if (!id) {
      const { peerCommands } = await import("./core/peer-exec.ts");
      for (const [k, c] of Object.entries(peerCommands)) console.log(`${k.padEnd(16)} ${c.description}`);
      return;
    }
    const { peerJson } = await import("./core/peers.ts");
    const r = await peerJson<Record<string, string>>(open(), id, "/api/peer/commands");
    for (const [k, d] of Object.entries(r)) console.log(`${k.padEnd(16)} ${d}`);
  });
peer
  .command("call <id> <command> [args]")
  .description("在同伴上执行一条检查命令；args 是 JSON，如 '{\"lines\":100}'。id 写 local 表示本机")
  .action(async (id: string, command: string, args?: string) => {
    const parsed = args ? JSON.parse(args) : {};
    const app = open();
    if (id === "local") {
      const { runPeerCommand } = await import("./core/peer-exec.ts");
      console.log(JSON.stringify(await runPeerCommand(app, command, parsed), null, 2));
      return;
    }
    const { peerJson } = await import("./core/peers.ts");
    const r = await peerJson<{ result: unknown }>(app, id, "/api/peer/exec", { command, args: parsed }, 15 * 60_000);
    const out = r.result as { text?: string };
    console.log(command === "logs" && typeof out?.text === "string" ? out.text : JSON.stringify(r.result, null, 2));
  });

program
  .command("diag [peer]")
  .description("健康状态：本机，或某个同伴")
  .action(async (peerId?: string) => {
    const app = open();
    if (!peerId) {
      const { diag } = await import("./core/peer-exec.ts");
      console.log(JSON.stringify(await diag(app), null, 2));
      return;
    }
    const { peerJson } = await import("./core/peers.ts");
    console.log(JSON.stringify(await peerJson(app, peerId, "/api/diag"), null, 2));
  });

const lark = program.command("lark").description("飞书个人采集（只读）：文档");
lark
  .command("docs-refresh")
  .description("重新读取已保存的飞书文档：下载图片、画板、视频等素材，读内嵌表格，导入链接的文档")
  .option("--space <id>", "只处理这个空间")
  .option("--limit <n>", "最多处理几篇（最近更新的优先）")
  .action(async (o) => {
    const app = open();
    const { refreshLarkDocs } = await import("./channels/lark-docs.ts");
    const r = await refreshLarkDocs(app, { space: o.space, limit: o.limit ? Number(o.limit) : undefined, log: (s) => console.log(s) });
    console.log(`完成 ${r.done}/${r.total}，失败 ${r.failed}；有新内容或新导入 ${r.changed.reduce((n, c) => n + c.ids.length, 0)} 篇`);
    for (const c of r.changed) {
      const done = await runJob((a) => scheduleIngest(a, c.spaceId, c.ids, "飞书文档有新内容或新链接的文档") ?? { runId: "" }, { stream: false });
      console.log((done.output as { summary?: string }).summary ?? "");
    }
  });
lark
  .command("docs-missing")
  .description("链接里读不到的飞书文档（多半是没有权限）")
  .option("--retry", "立即重试")
  .action(async (o) => {
    const app = open();
    const m = await import("./channels/lark-docs.ts");
    if (o.retry) {
      const r = await m.retryMissingDocs(app, { force: true });
      console.log(`重试 ${r.tried} 篇，读到 ${r.imported.length} 篇`);
      for (const d of r.imported) await runJob((a) => scheduleIngest(a, d.spaceId, [d.id], "原先读不到的飞书文档") ?? { runId: "" }, { stream: false });
    }
    for (const d of m.missingDocs(app)) console.log(`${d.title || "（无标题）"}  ${d.url}  ${d.error}`);
  });

const space = program.command("space").description("管理空间（领域隔离：个人 / 项目 / 代码仓库 / 学习 / 通用）");
space
  .command("list")
  .description("列出空间")
  .action(() => {
    const app = open();
    for (const s of listSpaces(app)) {
      const rel = relatedIds(app, s.id);
      console.log(`${s.id.padEnd(20)} ${kindLabel(s.kind).padEnd(6)} ${s.name}${s.rootPath ? `  ${s.rootPath}` : ""}${rel.length ? `  相关：${rel.join(", ")}` : ""}`);
    }
  });
space
  .command("relate <a> <b>")
  .description("关联两个空间：在其中一个里工作时会一起查另一个（--remove 取消）")
  .option("-n, --note <text>", "是什么关系，如“调用 b 的订单接口”")
  .option("--remove", "取消关联（之后 Agent 不会再自动加回）")
  .action((a, b, o) => {
    const app = open();
    if (o.remove) unrelateSpaces(app, a, b, "owner");
    else relateSpaces(app, a, b, { note: o.note, origin: "owner" });
    console.log(o.remove ? `已取消 ${a} 与 ${b} 的关联` : `已关联 ${a} 与 ${b}`);
  });
space
  .command("add <name>")
  .description("新建空间；--path 关联代码仓库或目录")
  .option("--id <id>", "空间 id（默认由名称生成）")
  .option("--path <dir>", "关联目录（代码仓库）")
  .option("--kind <kind>", "personal | project | repo | learning | topic（通用）")
  .option("-d, --description <text>", "说明")
  .option("--exclude <patterns...>", "不导入的路径（前缀或 glob，如 docs/archive '**/*.lock'）")
  .action(async (name, o) => {
    const app = open();
    const s = createSpace(app, { id: o.id, name, kind: o.kind, rootPath: o.path, description: o.description });
    if (o.exclude?.length) updateSpace(app, s.id, { settings: { ...s.settings, exclude: o.exclude } });
    console.log(`已创建空间 ${s.id}`);
    if (s.rootPath) {
      const r = await syncDirectorySpace(app, s.id);
      console.log(`已导入 ${r.created} 个文件（跳过 ${r.skipped.length}）`);
    }
  });
space
  .command("sync <id>")
  .description("同步空间关联目录的最新内容")
  .option("--exclude <patterns...>", "设置不导入的路径（替换原有设置；已导入的会被移除）")
  .action(async (id, o) => {
    const app = open();
    if (o.exclude) updateSpace(app, id, { settings: { ...getSpace(app, id).settings, exclude: o.exclude } });
    const r = await syncDirectorySpace(app, id);
    console.log(`新增 ${r.created}，更新 ${r.updated}，移除 ${r.removed}，未变 ${r.unchanged}`);
  });

program
  .command("add <input>")
  .description("保存材料：文件、目录、网址（含飞书文档），或用 - 从标准输入读文本")
  .option("-s, --space <id>", "空间", "personal")
  .option("-t, --title <title>", "标题（文本）")
  .option("--no-ingest", "只保存，不让助理整理")
  .action(async (input, o) => {
    const app = open();
    let ids: string[] = [];
    if (input === "-") {
      const text = readFileSync(0, "utf8");
      const r = importText(app, o.space, { title: o.title, text });
      ids = [r.id];
      console.log(`已保存 ${r.id}`);
    } else if (/^https?:\/\//.test(input)) {
      const r = await importUrl(app, o.space, input);
      ids = [...(r.status === "unchanged" ? [] : [r.id]), ...(r.related ?? [])];
      console.log(`${r.status} ${r.id}`);
      if (r.related?.length) console.log(`链接的文档：新增或更新 ${r.related.length} 篇`);
      for (const m of r.missing ?? []) console.log(`读不到：${m.title || m.url}（${m.error}）`);
    } else if (existsSync(input) && statSync(input).isDirectory()) {
      const r = await importDirectory(app, o.space, input);
      ids = r.sourceIds;
      console.log(`新增 ${r.created}，更新 ${r.updated}，未变 ${r.unchanged}，跳过 ${r.skipped.length}`);
    } else if (existsSync(input)) {
      const r = await importFile(app, o.space, input);
      if (!r) return console.error("不支持的文件类型");
      ids = r.status === "unchanged" ? [] : [r.id];
      console.log(`${r.status} ${r.id}`);
    } else {
      const r = importText(app, o.space, { title: o.title, text: input });
      ids = [r.id];
      console.log(`已保存 ${r.id}`);
    }
    if (o.ingest && ids.length) {
      const r = await runJob((a) => scheduleIngest(a, o.space, ids) ?? { runId: "" }, { stream: false });
      console.log((r.output as { summary?: string }).summary ?? "");
    }
  });

program
  .command("search <query...>")
  .description("检索原件、页面与记忆")
  .option("-s, --space <id>", "空间（默认全部）")
  .option("-n, --limit <n>", "数量", (v) => Number(v), 10)
  .action(async (query: string[], o) => {
    const hits = await search(open(), query.join(" "), { spaces: o.space ? [o.space] : undefined, limit: o.limit });
    for (const h of hits) {
      const where = h.type === "page" ? `[页面] ${h.spaceId}/${h.path}` : h.type === "memory" ? `[记忆] ${h.id}` : `[${h.sourceKind}] ${h.spaceId}:${h.uri}:${h.lineStart}`;
      console.log(`\x1b[1m${where}\x1b[0m ${h.path && h.type !== "page" ? h.path : ""} \x1b[2m${h.via.join("+")}\x1b[0m\n  ${h.snippet.replace(/\n/g, "\n  ").slice(0, 300)}\n`);
    }
  });

program
  .command("ask <question...>")
  .description("向助理提问或交代事情（会调查知识库、按需记录）")
  .option("-s, --space <id>", "空间", "personal")
  .option("-c, --conversation <id>", "延续对话")
  .action(async (question: string[], o) => {
    await runJob((app) => ask(app, { text: question.join(" "), spaceId: o.space, conversationId: o.conversation, channel: "cli" }));
  });

const user = program.command("user").description("用户与身份（omem 默认只有主人；给同事开放时在这里登记）");
user
  .command("list")
  .description("列出用户、渠道身份和可访问的空间")
  .action(async () => {
    const { listUsers, identitiesOf, accessibleSpaces } = await import("./core/users.ts");
    const app = open();
    for (const u of listUsers(app))
      console.log(`${u.id.padEnd(14)} ${u.role.padEnd(7)} ${u.name}${u.disabledAt ? "（已停用）" : ""}\n  身份：${identitiesOf(app, u.id).map((i) => `${i.channel}:${i.external_id}`).join(", ") || "（配置中的主人身份）"}\n  空间：${accessibleSpaces(app, u.id)?.join(", ") ?? "全部"}`);
  });
user
  .command("add <name>")
  .description("登记一个用户（会建好 personal-<id> 个人空间）；用渠道 id 绑定他在飞书/Telegram/QQ 的身份")
  .option("--id <id>", "用户 id（默认由名称生成）")
  .option("--lark <openId>", "飞书 open_id")
  .option("--telegram <userId>", "Telegram 用户 id")
  .option("--onebot <userId>", "QQ / 微信桥账号")
  .option("--space <ids...>", "可以读的空间")
  .option("--edit <ids...>", "可以写的空间")
  .action(async (name, o) => {
    const { createUser, linkIdentity, addMember } = await import("./core/users.ts");
    const app = open();
    const u = createUser(app, { name, id: o.id });
    for (const [ch, v] of [["lark", o.lark], ["telegram", o.telegram], ["onebot", o.onebot]] as const) if (v) linkIdentity(app, u.id, ch, String(v));
    for (const sp of o.space ?? []) addMember(app, sp, u.id, "reader");
    for (const sp of o.edit ?? []) addMember(app, sp, u.id, "editor");
    console.log(`已登记 ${u.id}（${u.name}），个人空间 personal-${u.id}`);
  });
user
  .command("link <userId> <channel> <externalId>")
  .description("绑定渠道身份（channel: lark | telegram | onebot）")
  .action(async (userId, channel, externalId) => {
    const { linkIdentity } = await import("./core/users.ts");
    linkIdentity(open(), userId, channel, externalId);
    console.log("已绑定");
  });
user
  .command("token <userId> [label]")
  .description("为用户生成 API 令牌（只显示一次）")
  .action(async (userId, label) => {
    const { createApiToken } = await import("./core/users.ts");
    console.log(createApiToken(open(), userId, label ?? ""));
  });
user
  .command("tokens [userId]")
  .description("列出 API 令牌（标签、创建与最近使用时间）")
  .action(async (userId?: string) => {
    const { listApiTokens } = await import("./core/users.ts");
    for (const t of listApiTokens(open(), userId)) console.log(`${t.user_id}  ${t.label || "（无标签）"}  创建 ${t.created_at.slice(0, 16)}  最近使用 ${t.last_used_at?.slice(0, 16) ?? "-"}`);
  });
user
  .command("revoke <userId> <label>")
  .description("按标签撤销令牌（配对是 peer:<名字>，网页链接是 web）")
  .action(async (userId: string, label: string) => {
    const { revokeApiTokens } = await import("./core/users.ts");
    console.log(`已撤销 ${revokeApiTokens(open(), userId, label)} 个令牌`);
  });
space
  .command("share <spaceId> <userId>")
  .description("让用户访问一个空间")
  .option("--edit", "允许写入（记忆、事项、页面）")
  .option("--remove", "取消访问")
  .action(async (spaceId, userId, o) => {
    const { addMember, removeMember } = await import("./core/users.ts");
    const app = open();
    if (o.remove) removeMember(app, spaceId, userId);
    else addMember(app, spaceId, userId, o.edit ? "editor" : "reader");
    console.log("已更新");
  });

const wiki = program.command("wiki").description("Wiki：规划、写作、检查");
wiki
  .command("plan <space>")
  .description("调查空间并规划目录，随后逐页写作")
  .option("-f, --focus <text>", "重点或读者")
  .option("--no-write", "只规划不写")
  .action(async (sp, o) => {
    const r = await runJob((app) => createRun(app, { kind: "wiki-plan", spaceId: sp, title: "规划 Wiki 目录", input: { focus: o.focus, autoWrite: o.write } }), { stream: false, children: true });
    console.log((r.output as { summary?: string }).summary ?? "");
  });
wiki
  .command("write <space> <slug>")
  .description("写/重写一页")
  .requiredOption("--title <title>")
  .requiredOption("-q, --question <text>", "读者问题")
  .option("--outline <text>", "讲解路线", "")
  .option("--entry <paths...>", "调查入口")
  .action(async (sp, slug, o) => {
    const brief: PageBrief = { slug, title: o.title, kind: "guide", question: o.question, outline: o.outline, entry_points: o.entry ?? [] };
    const r = await runJob((app) => createRun(app, { kind: "wiki-write", spaceId: sp, title: `写作：${o.title}`, input: { brief } }), { stream: false });
    console.log((r.output as { summary?: string }).summary ?? "");
  });
wiki
  .command("lint <space>")
  .description("检查并修正引用原件已变化的页面")
  .action(async (sp) => {
    const r = await runJob((app) => createRun(app, { kind: "wiki-lint", spaceId: sp, title: "检查受影响页面" }), { stream: false });
    console.log((r.output as { summary?: string }).summary ?? "");
  });
wiki
  .command("export <space> <dir>")
  .description("把 Wiki 导出成普通 Markdown 目录（页面互链、原件引用改成仓库内相对链接，适合提交到仓库或在 GitHub 上看）")
  .option("--repo-root <dir>", "引用原件所在的仓库根目录（默认是空间关联的目录）")
  .action(async (sp, dir, o) => {
    const { exportWiki } = await import("./wiki/store.ts");
    const r = exportWiki(open(), sp, dir, { repoRoot: o.repoRoot });
    console.log(`已导出 ${r.pages} 页到 ${r.outDir}，${r.links} 处原件引用改成了相对链接。`);
  });
wiki
  .command("show <space> [slug]")
  .description("列出页面或打印一页")
  .action((sp, slug) => {
    const app = open();
    syncWiki(app, sp);
    if (!slug) for (const p of listPages(app, sp)) console.log(`${p.slug.padEnd(32)} ${p.title}${p.staleSources ? `  (${p.staleSources} 个引用原件已变化)` : ""}`);
    else {
      const p = readPage(app, sp, slug);
      console.log(`# ${p.meta.title}\n\n${p.body}`);
    }
  });

program
  .command("items")
  .description("查看事项")
  .option("-a, --all", "包括已完成")
  .action(() => {
    for (const i of listItems(open(), { status: program.commands.find((c) => c.name() === "items")!.opts().all ? "all" : "active" }))
      console.log(`${i.id}  [${i.kind}/${i.status}] ${i.title}${i.dueAt ? `  截止 ${i.dueAt}` : ""}${i.remindAt ? `  提醒 ${i.remindAt}` : ""}${i.waitingOn ? `  等待 ${i.waitingOn}` : ""}`);
  });
program
  .command("todo <title...>")
  .description("新建待办/提醒")
  .option("--remind <iso>", "提醒时间（ISO）")
  .option("--due <iso>", "截止时间（ISO）")
  .option("--kind <kind>", "todo | waiting | reminder | watch | decision", "todo")
  .action((title: string[], o) => {
    const i = upsertItem(open(), undefined, { title: title.join(" "), kind: o.kind, remindAt: o.remind, dueAt: o.due }, "user");
    console.log(`已创建 ${i.id}`);
  });

program
  .command("memory")
  .description("列出当前有效的记忆")
  .option("-s, --space <id>")
  .action((o) => {
    for (const m of listMemories(open(), { spaceId: o.space, status: "active" })) console.log(`${m.id}  [${m.kind}] ${m.subject ? m.subject + "：" : ""}${m.content}`);
  });

program
  .command("delegate <space> <task...>")
  .description("交办编码：独立 worktree 实现 → 检查 → 独立评审")
  .option("--check <command>", "检查命令")
  .action(async (sp, task: string[], o) => {
    const r = await runJob((app) => createRun(app, { kind: "code", spaceId: sp, title: task.join(" ").slice(0, 80), input: { task: task.join(" "), checkCommand: o.check } }), { stream: false });
    const out = r.output as { diffStat?: string; review?: string; verdict?: string };
    console.log(`${out.diffStat ?? ""}\n\n${out.review ?? ""}\n\n结论：${out.verdict ?? r.status}\n运行 id：${r.id}`);
  });

const agents = program.command("agents").description("Agent 后端：列出、从 ACP 注册表添加");
agents
  .command("list", { isDefault: true })
  .description("列出 Agent 配置（✓ 已安装）")
  .option("--all", "也列出未安装的")
  .action(async (o) => {
    const app = open();
    const { catalogEntry, installHint } = await import("./agents/catalog.ts");
    const all = listAgentProfiles(app);
    for (const p of all.filter((p) => p.installed)) console.log(`✓ ${p.id.padEnd(12)} ${p.transport.padEnd(10)} ${p.command} ${p.args.join(" ")}${p.model ? `  model=${p.model}` : ""}${p.effort ? ` effort=${p.effort}` : ""}`);
    const missing = all.filter((p) => !p.installed);
    if (o.all) for (const p of missing) {
      const e = catalogEntry(p.id);
      console.log(`· ${p.id.padEnd(12)} ${p.command} ${p.args.join(" ")}${e ? `  安装：${installHint(e) || "见官网"}` : ""}`);
    }
    else if (missing.length) console.log(`\n另有 ${missing.length} 个未安装（${missing.map((p) => p.id).join("、")}），--all 查看安装方式；ACP 注册表里更多：omem agents registry`);
    console.log(`\n配置文件：${configPath(app.home)}（agents.default / agents.roles / agents.profiles）`);
  });
agents
  .command("registry")
  .description("列出官方 ACP 注册表中的 Agent 及本机可用的运行方式")
  .action(async () => {
    const { fetchRegistry, registryOptions, platformKey } = await import("./agents/catalog.ts");
    const list = await fetchRegistry();
    for (const a of list) {
      const ways = registryOptions(a).map((o) => `${o.kind}${o.available ? "" : "(缺)"}`).join(" / ") || `无 ${platformKey()} 版本`;
      console.log(`${a.id.padEnd(22)} ${a.name.padEnd(22)} v${a.version.padEnd(12)} ${ways}`);
    }
    console.log("\n添加：omem agents add <id> [--via npx|uvx|binary]");
  });
agents
  .command("add <id>")
  .description("添加 Agent：内置目录里的 id（npm 全局安装或 npx），或 ACP 注册表里的 id（npx / uvx / 下载二进制）")
  .option("--via <how>", "global | npx | uvx | binary")
  .option("--default", "设为默认 Agent")
  .action(async (id: string, o) => {
    const app = open();
    const { catalogEntry, catalogProfile, npxProfile, fetchRegistry } = await import("./agents/catalog.ts");
    const { addRegistryAgent } = await import("./setup.ts");
    const { saveConfig } = await import("./core/config.ts");
    const { commandExists } = await import("./agents/spawn.ts");
    const { spawnSync } = await import("node:child_process");
    const e = catalogEntry(id);
    let p;
    if (e && commandExists(e.command) && !o.via) p = catalogProfile(e);
    else if (e?.npm && (o.via === "npx" || (!o.via && !commandExists("npm")))) {
      p = npxProfile(e);
      app.config.agents.profiles = [...app.config.agents.profiles.filter((x) => x.id !== p!.id), p];
    } else if (e?.npm && (!o.via || o.via === "global")) {
      if (spawnSync("npm", ["i", "-g", e.npm], { stdio: "inherit", shell: process.platform === "win32" }).status !== 0) throw new Error("npm 安装失败");
      p = catalogProfile(e);
    } else {
      const agent = (await fetchRegistry()).find((a) => a.id === id);
      if (!agent) throw new Error(e ? `${e.name}：${e.install ?? "请按官方说明安装"}` : `内置目录和 ACP 注册表里都没有 ${id}（omem agents registry 查看）`);
      p = await addRegistryAgent(agent, app.config, app.home, o.via);
    }
    if (o.default) app.config.agents.default = p.id;
    saveConfig(app.config, app.home);
    console.log(`✓ ${p.id} → ${p.command} ${p.args.join(" ")}\n第一次使用前，先在终端直接运行该 Agent 登录一次。`);
  });

program
  .command("mcp")
  .description("以 stdio MCP 服务暴露 omem 工具（供 Claude Code、Codex 等直接使用个人库）")
  .option("--read-only", "只开放读取类工具")
  .option("--space <id>", "默认空间（不填时按当前目录找关联了它的空间，找不到用 personal）")
  .action(async (o) => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const app = open();
    const readOnly = new Set(["list_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "list_pages", "read_page", "recall", "list_items", "list_runs", "read_run"]);
    // An agent working inside a repository gets that repository's space (and its related ones) by default.
    const spaceId = o.space ? getSpace(app, o.space).id : (spaceForDir(app, process.cwd()) ?? "personal");
    const ctx = { app, runId: null, spaceId, spaces: null, tools: o.readOnly ? readOnly : null, actor: "agent" as const };
    const tools = new Set(toolSchemas(ctx.tools).map((t) => t.name).filter((n) => n !== "submit_plan" && n !== "delegate_code"));
    const server = createMcpServer({ list: async () => toolSchemas(tools), call: (name, args) => callTool({ ...ctx, tools }, name, args) });
    await server.connect(new StdioServerTransport());
  });

program
  .command("sync")
  .description("同步所有关联目录的空间")
  .action(async () => {
    const app = open();
    for (const s of listSpaces(app))
      if (s.rootPath) {
        const r = await syncDirectorySpace(app, s.id);
        console.log(`${s.id}: 新增 ${r.created}，更新 ${r.updated}，移除 ${r.removed}`);
      }
  });

program
  .command("hook <agent> [payload]")
  .description("记录编码 Agent 的会话：claude（Stop 钩子，从标准输入读 JSON）或 codex（notify，JSON 作为参数）")
  .action(async (agent, payload) => {
    const { captureClaudeHook, captureCodexNotify } = await import("./hooks.ts");
    const app = open();
    try {
      if (agent === "claude") captureClaudeHook(app, JSON.parse(readFileSync(0, "utf8") || "{}"));
      else if (agent === "codex") captureCodexNotify(app, JSON.parse(payload ?? "{}"));
      else throw new Error("agent 只能是 claude 或 codex");
    } catch (e) {
      // Hooks must never break the agent that calls them.
      console.error(`[omem hook] ${(e as Error).message}`);
    }
  });

program
  .command("setup [component]")
  .description("设置向导：Agent、向量模型、文档解析、渠道、会话、定时任务。也可直接 setup embeddings | documents")
  .option("--model <id-or-dir>", "embeddings：模型 id、本地目录，或 bge-small-zh / bge-base-zh / bge-m3（经 osdk 下载）")
  .option("--no-osdk", "不经 osdk，直接从 Hugging Face 下载")
  .action(async (component: string | undefined, o) => {
    const app = open();
    const { saveConfig } = await import("./core/config.ts");
    const setup = await import("./setup.ts");
    if (!component) {
      try {
        await setup.setupInteractive(app);
      } catch (e) {
        if ((e as Error).name === "ExitPromptError") return console.error("\n已退出，未保存的部分没有改动。");
        throw e;
      }
      return;
    }
    if (component === "embeddings") {
      const { embedPending } = await import("./search/embeddings.ts");
      const named = setup.EMBEDDINGS.find((e) => e.id === (o.model ?? "bge-small-zh"));
      let model = o.model ?? named!.repo;
      if (named) model = o.osdk !== false && setup.osdkAvailable() ? setup.osdkEmbedding(named) : named.repo;
      app.config.embeddings = { ...app.config.embeddings, provider: "local", model, family: named?.id === "bge-m3" ? "bge-m3" : named ? "bge-zh" : undefined };
      let n = 0;
      for (let k = await embedPending(app, 64); k; k = await embedPending(app, 64)) {
        n += k;
        process.stderr.write(`\r已生成 ${n} 个片段的向量…`);
      }
      saveConfig(app.config, app.home);
      console.log(`\n向量检索已开启（${model}）。之后新增的材料由服务在后台补齐向量。`);
      return;
    }
    if (component === "documents" || component === "document-models") {
      if (!setup.osdkAvailable()) throw new Error("需要 osdk 来下载 Docling 模型；或运行 omem setup 选择 pdftotext / pandoc。");
      app.config.documents.doclingArtifacts = setup.prepareDoclingModels(app.home);
      app.config.documents.engines = ["docling", "pdftotext", "pandoc"];
      saveConfig(app.config, app.home);
      console.log(`Docling 模型已就绪：${app.config.documents.doclingArtifacts}`);
      return;
    }
    throw new Error("用法：omem setup（交互式）| omem setup embeddings [--model …] | omem setup documents");
  });

program.addCommand(memoriesCommand);

program
  .command("import-v1 <db>")
  .description("从 v1 的 omem.db 导入原件、有效记忆和未完成事项（只读旧库）")
  .option("-s, --space <id>", "导入到哪个空间", "personal")
  .option("--dry-run", "只统计不写入")
  .action(async (db, o) => {
    const { importV1 } = await import("./migrate-v1.ts");
    console.log(importV1(open(), db, { spaceId: o.space, dryRun: o.dryRun }));
  });

program
  .command("run <runId>")
  .description("查看一次运行")
  .action((id) => {
    const r = getRun(open(), id);
    console.log(JSON.stringify(r, null, 2));
  });

void scheduleSpaceSync;
program.parseAsync().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
