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
import { createSpace, ensurePersonalSpace, listSpaces } from "./core/spaces.ts";
import { listItems, upsertItem } from "./items/store.ts";
import { listMemories } from "./memory/store.ts";
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
async function runJob(make: (app: App) => Run | { runId: string }, opts: { stream?: boolean; children?: boolean } = {}) {
  const local = open();
  const remote = await runningServer(local);
  const booted = remote ? null : await boot(home(), { port: 0, quiet: true, background: false });
  const app = booted?.app ?? local;
  const created = make(app);
  const runId = "runId" in created ? created.runId : created.id;
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

const space = program.command("space").description("管理空间（领域隔离：个人 / 项目 / 代码仓库 / 学习）");
space
  .command("list")
  .description("列出空间")
  .action(() => {
    for (const s of listSpaces(open())) console.log(`${s.id.padEnd(20)} ${s.kind.padEnd(9)} ${s.name}${s.rootPath ? `  ${s.rootPath}` : ""}`);
  });
space
  .command("add <name>")
  .description("新建空间；--path 关联代码仓库或目录")
  .option("--id <id>", "空间 id（默认由名称生成）")
  .option("--path <dir>", "关联目录（代码仓库）")
  .option("--kind <kind>", "personal | project | repo | learning | topic")
  .option("-d, --description <text>", "说明")
  .action((name, o) => {
    const app = open();
    const s = createSpace(app, { id: o.id, name, kind: o.kind, rootPath: o.path, description: o.description });
    console.log(`已创建空间 ${s.id}`);
    if (s.rootPath) {
      const r = syncDirectorySpace(app, s.id);
      console.log(`已导入 ${r.created} 个文件（跳过 ${r.skipped.length}）`);
    }
  });
space
  .command("sync <id>")
  .description("同步空间关联目录的最新内容")
  .action((id) => {
    const r = syncDirectorySpace(open(), id);
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
      ids = r.status === "unchanged" ? [] : [r.id];
      console.log(`${r.status} ${r.id}`);
    } else if (existsSync(input) && statSync(input).isDirectory()) {
      const r = importDirectory(app, o.space, input);
      ids = r.sourceIds;
      console.log(`新增 ${r.created}，更新 ${r.updated}，未变 ${r.unchanged}，跳过 ${r.skipped.length}`);
    } else if (existsSync(input)) {
      const r = importFile(app, o.space, input);
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

program
  .command("agents")
  .description("列出可用的 Agent 配置")
  .action(() => {
    const app = open();
    for (const p of listAgentProfiles(app)) console.log(`${p.installed ? "✓" : "✗"} ${p.id.padEnd(12)} ${p.transport.padEnd(10)} ${p.command} ${p.args.join(" ")}${p.model ? `  model=${p.model}` : ""}${p.effort ? ` effort=${p.effort}` : ""}`);
    console.log(`\n配置文件：${configPath(app.home)}（agents.default / agents.roles / agents.profiles）`);
  });

program
  .command("mcp")
  .description("以 stdio MCP 服务暴露 omem 工具（供 Claude Code、Codex 等直接使用个人库）")
  .option("--read-only", "只开放读取类工具")
  .action(async (o) => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const app = open();
    const readOnly = new Set(["list_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "list_pages", "read_page", "recall", "list_items", "list_runs", "read_run"]);
    const ctx = { app, runId: null, spaceId: "personal", spaces: null, tools: o.readOnly ? readOnly : null, actor: "agent" as const };
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
        const r = syncDirectorySpace(app, s.id);
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
  .command("setup <component>")
  .description("准备可选组件：embeddings（本地中文向量模型，首次会下载约 25MB）")
  .option("--model <id-or-dir>", "模型 id 或本地目录", "Xenova/bge-small-zh-v1.5")
  .action(async (component, o) => {
    if (component !== "embeddings") throw new Error("目前只支持：omem setup embeddings");
    const app = open();
    const { saveConfig } = await import("./core/config.ts");
    const { embedPending } = await import("./search/embeddings.ts");
    app.config.embeddings = { ...app.config.embeddings, provider: "local", model: o.model };
    let n = 0;
    for (let k = await embedPending(app, 64); k; k = await embedPending(app, 64)) {
      n += k;
      process.stderr.write(`\r已生成 ${n} 个片段的向量…`);
    }
    saveConfig(app.config, app.home);
    console.log(`\n向量检索已开启（${o.model}）。之后新增的材料由服务在后台补齐向量。`);
  });

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
