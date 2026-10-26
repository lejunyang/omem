/**
 * Minimal ACP agent for tests: it connects to the MCP servers the client gives
 * it, searches the knowledge base for the user's message, stores a memory and
 * answers. It exercises the real host path (ACP client, stdio MCP bridge, tool
 * tokens, run events) without a model.
 */
import { Readable, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSideConnection, ndJsonStream, type McpServer } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sessions = new Map<string, McpServer[]>();
const cwds = new Map<string, string>();
const turns = new Map<string, number>();
const resumed = new Set<string>();
// FAKE_MODE=thread: no tools, answer with what the host sent (for session/thread tests).
const threadMode = process.env.FAKE_MODE === "thread";
const delay = Number(process.env.FAKE_DELAY ?? 0);
// FAKE_LEGACY=1: models via session.models + session/set_model, gemini-style mode ids.
const legacy = process.env.FAKE_LEGACY === "1";
// FAKE_STALL=before: print the traex skills notice, then never answer (provider not starting).
// FAKE_STALL=after: answer one chunk, then hang (a stalled turn).
const stall = process.env.FAKE_STALL;
// FAKE_QUEUE=ms: report provider queue_begin, wait, queue_end, then answer.
const queueMs = Number(process.env.FAKE_QUEUE ?? 0);
// FAKE_TRAE=1: traex-style queue status (session_info_update._meta.trae.queueStatus) and a
// reasoning_effort option that only exists while a model that has it is selected.
const trae = process.env.FAKE_TRAE === "1";
/** A fixed answer for every prompt (a judge that always says the same thing). */
const fixed = process.env.FAKE_SAY;
const TRAE_EFFORTS: Record<string, string[]> = { m1: [], m2: ["low", "medium", "high"], m3: ["low", "xhigh"] };
const traeOptions = (model: string) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: Object.keys(TRAE_EFFORTS).map((v) => ({ value: v, name: v })) },
  ...(TRAE_EFFORTS[model].length ? [{ id: "reasoning_effort", name: "Effort", category: "thought_level", type: "select", currentValue: TRAE_EFFORTS[model][0], options: TRAE_EFFORTS[model].map((v) => ({ value: v, name: v })) }] : []),
];
const state = { model: "m1", mode: "default" };
new AgentSideConnection(
  (conn) => ({
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: false }, sessionCapabilities: { ...(threadMode ? { resume: {} } : {}), ...(process.env.FAKE_DELETE_LOG ? { delete: {} } : {}) } },
        agentInfo: { name: "fake-agent", version: "1" },
      } as never;
    },
    async newSession(p) {
      const id = `s${process.pid}-${sessions.size + 1}`;
      sessions.set(id, p.mcpServers);
      cwds.set(id, p.cwd);
      if (legacy)
        return {
          sessionId: id,
          modes: { currentModeId: "default", availableModes: ["default", "autoEdit", "yolo"].map((m) => ({ id: m, name: m })) },
          models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M1" }, { modelId: "m2", name: "M2" }] },
        } as never;
      if (trae) return { sessionId: id, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] }, configOptions: traeOptions("m1") } as never;
      return { sessionId: id, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }, { id: "read-only", name: "ro" }] } };
    },
    async setSessionConfigOption(p: { configId: string; value: unknown }) {
      if (p.configId === "model") state.model = String(p.value);
      return { configOptions: traeOptions(state.model) } as never;
    },
    async resumeSession(p: { sessionId: string; mcpServers?: McpServer[] }) {
      sessions.set(p.sessionId, p.mcpServers ?? []);
      resumed.add(p.sessionId);
      return { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] }, ...(trae ? { configOptions: traeOptions(state.model) } : {}) } as never;
    },
    async setSessionMode(p: { modeId: string }) {
      state.mode = p.modeId;
      return {};
    },
    async extMethod(method: string, params: Record<string, unknown>) {
      if (method === "session/set_model") state.model = String(params.modelId);
      return {};
    },
    async authenticate() {
      return {};
    },
    async deleteSession(p: { sessionId: string }) {
      if (process.env.FAKE_DELETE_LOG) appendFileSync(process.env.FAKE_DELETE_LOG, p.sessionId + "\n");
      return {};
    },
    async cancel() {},
    async prompt(p) {
      const prompt = p.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      const say = (text: string) => conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
      if (process.env.FAKE_USAGE) {
        const values = process.env.FAKE_USAGE.split(",").map(Number);
        const used = values[Math.min(turns.get(p.sessionId) ?? 0, values.length - 1)];
        if (Number.isFinite(used)) await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "usage_update", used, size: 1000 } });
        if (process.env.FAKE_OTHER_USAGE) await conn.sessionUpdate({ sessionId: "unrelated-session", update: { sessionUpdate: "usage_update", used: 950, size: 1000 } });
      }
      if (process.env.FAKE_MODE === "wiki") {
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-wiki", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map(e => [e.name, e.value])) } as Record<string, string> }));
        try {
          const names = (await client.listTools()).tools.map(t => t.name);
          const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
          const read = await call("list_sources", { space: "materials" });
          const blockedRead = await call("list_sources", { space: "excluded" });
          const blockedWrite = await call("write_page", { space: "materials", page: "forbidden", title: "禁止", summary: "禁止", body: "禁止" });
          const planner = names.includes("submit_plan");
          if (planner) await call("submit_plan", { pages: [{ slug: "overview", title: "概览", kind: "guide", question: "如何开始？", outline: "以示例说明", entry_points: ["materials:README.md"] }] });
          const written = await call("write_page", { page: planner ? "index" : "overview", title: planner ? "目录" : "概览", kind: planner ? "index" : "guide", summary: "示例说明", body: planner ? "- [[overview|概览]]" : "示例正文" });
          await say(JSON.stringify({ prompt, read, blockedRead, blockedWrite, written }));
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      // FAKE_MODE=review: the coder edits a file in its worktree; a review check reports with
      // submit_review — the "业务" check asks for a change, the others approve.
      if (process.env.FAKE_MODE === "review") {
        const check = /你负责的评审项：(\S+)/.exec(prompt)?.[1];
        // Host one-shot judgements (tier estimate, triage): keep the conditions' choice.
        if (prompt.includes("只输出一个 JSON")) {
          await say("{}");
          return { stopReason: "end_turn" as const };
        }
        // review-lead: accept the business finding, reject the rest, ask for one more round of business only.
        const leadRound = /你在裁决第 (\d+) 轮/.exec(prompt)?.[1];
        if (leadRound) {
          const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
          const client = new Client({ name: "fake-lead", version: "1" });
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
          try {
            const tools = (await client.listTools()).tools.map((t) => t.name);
            const ids = [...prompt.matchAll(/- #(\d+) \[([^\]]+)\]/g)].map((m) => ({ id: Number(m[1]), tag: m[2] }));
            const rulings = ids.map((x) => (x.tag.startsWith("业务") && x.tag.includes("严重") ? { id: x.id, decision: "accept" } : { id: x.id, decision: "reject", note: "不影响这次需求" }));
            const res = await client.callTool({ name: "rule_review", arguments: { rulings, verdict: rulings.some((r) => r.decision === "accept") ? "revise" : "approve", summary: `第 ${leadRound} 轮：业务问题要改`, change_request: "1. refund.ts:1 已发货行不能退：过滤已发货行", rerun: ["review-business"] } });
            await say(`负责人结论
${JSON.stringify({ tools, error: res.isError ? res.content : null })}`);
          } finally { await client.close(); }
          return { stopReason: "end_turn" as const };
        }
        // The requirement split: one change point, with one made-up source id corrected after the tool refuses it.
        if (prompt.includes("你这次只做需求拆分")) {
          const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
          const client = new Client({ name: "fake-split", version: "1" });
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
          try {
            const point = { id: "C1", title: "只退未发货的行", status: "done", locations: [{ file: "refund.ts", start: 1, end: 3 }] };
            const bad = await client.callTool({ name: "submit_change_points", arguments: { change_points: [{ ...point, refs: ["src:s0nothere00000000"] }] } });
            await client.callTool({ name: "submit_change_points", arguments: { change_points: [point] } });
            await say(`拆分完成 ${JSON.stringify(bad.isError ?? false)}`);
          } finally { await client.close(); }
          return { stopReason: "end_turn" as const };
        }
        // Git conflicts the host hands over: keep both sides and stage them (FAKE_CONFLICT=giveup leaves them).
        if (prompt.includes("# 解决 Git 冲突")) {
          const cwd = cwds.get(p.sessionId)!;
          const files = [...prompt.matchAll(/^- (\S+)$/gm)].map((m) => m[1]).filter((f) => existsSync(join(cwd, f)));
          if (process.env.FAKE_CONFLICT !== "giveup") for (const f of files) {
            writeFileSync(join(cwd, f), readFileSync(join(cwd, f), "utf8").replace(/^(<{7}|={7}|>{7}).*\r?\n/gm, ""));
            execFileSync("git", ["add", f], { cwd });
          }
          await say(process.env.FAKE_CONFLICT === "giveup" ? "解决不了" : `合并了两边：${files.join("、")}`);
          return { stopReason: "end_turn" as const };
        }
        if (!check) {
          appendFileSync(join(cwds.get(p.sessionId)!, "refund.ts"), `export const round = ${prompt.includes("上一轮评审要求修改") ? 2 : 1};
`);
          await say("已实现退款金额计算。");
          return { stopReason: "end_turn" as const };
        }
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-review", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        try {
          const tools = (await client.listTools()).tools.map((t) => t.name);
          const asks = check === "业务";
          // The business check also maps the requirement to the code; a review of an item says it read the materials.
          const changePoints = asks ? [{ id: "C1", title: "只退未发货的行", status: "partial", requirement: "退款只按未发货的行计算", locations: [{ file: "refund.ts", start: 1, end: 3 }] }] : undefined;
          await client.callTool({ name: "submit_review", arguments: { verdict: asks ? "changes_requested" : "approved", summary: `${check}评审${prompt.includes("## 所属事项") ? "（读了事项材料）" : ""}`, findings: asks ? [{ severity: "major", file: "refund.ts", line: 1, title: "已发货行不能退", suggestion: "过滤已发货行" }, { severity: "nit", title: "命名可以更具体" }] : [{ severity: "minor", title: "可以补一条测试" }], change_points: changePoints } });
          await say(`结论：${asks ? "需要修改" : "通过"}
${JSON.stringify({ check, tools })}`);
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      if (process.env.FAKE_MODE === "background") {
        const n = (turns.get(p.sessionId) ?? 0) + 1;
        turns.set(p.sessionId, n);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        const result = await client.callTool({ name: "search", arguments: { query: "虚构测试材料" } });
        // An ingest fact without evidence is rejected and records the owning run.
        await client.callTool({ name: "remember", arguments: { kind: "fact", content: "项目 A 每周二执行检查。" } });
        await client.close();
        if (result.isError) throw new Error("MCP search failed");
        await say(JSON.stringify({ session: p.sessionId, turn: n, prompt }));
        return { stopReason: "end_turn" };
      }
      if (fixed !== undefined) {
        await say(fixed);
        return { stopReason: "end_turn" };
      }
      if (stall === "before") {
        await say("Skill descriptions were shortened to fit the 2% skills context budget. TRAE can still see every skill.");
        await new Promise(() => {});
      }
      if (stall === "after") {
        await say("我先看一下材料。");
        await new Promise(() => {});
      }
      if (queueMs && trae) {
        const status = (state: string, position?: number) => conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "session_info_update", _meta: { trae: { queueStatus: { state, position, message: state === "ready" ? undefined : `排在第 ${position} 位` } } } } as never });
        await status("queued", 3);
        await new Promise((r) => setTimeout(r, queueMs / 2));
        await status("waiting", 1);
        await new Promise((r) => setTimeout(r, queueMs / 2));
        await status("ready");
        await say(`queued-ok ${state.model}`);
        return { stopReason: "end_turn" };
      }
      if (queueMs) {
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "queue_begin", position: 3 } as never });
        await new Promise((r) => setTimeout(r, queueMs));
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "queue_end" } as never });
        await say("queued-ok");
        return { stopReason: "end_turn" };
      }
      if (threadMode) {
        const n = (turns.get(p.sessionId) ?? 0) + 1;
        turns.set(p.sessionId, n);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const part = prompt.slice(prompt.lastIndexOf("# 本人新消息"));
        const msgs = [...part.matchAll(/本人（[^）]*）：([^\n]*)/g)].map((m) => m[1]);
        const role = /# 角色：([^\n]*)/.exec(prompt)?.[1] ?? "";
        const text = JSON.stringify({ session: p.sessionId, turn: n, resumed: resumed.has(p.sessionId), cold: prompt.includes("# 会话背景"), msgs, role, summary: /## 本会话到目前为止的摘要\n\n([^\n]*)/.exec(prompt)?.[1] ?? null, context: prompt.includes("的上下文，"), memories: [...part.matchAll(/- mem:(\w+)/g)].map((m) => m[1]), woken: prompt.includes("# 唤醒\n"), ...(legacy ? state : {}) });
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
        return { stopReason: "end_turn" };
      }
      const message = /本人（[^）]*）：([^\n]*)/.exec(prompt.slice(prompt.lastIndexOf("# 本人新消息")))?.[1] ?? /# 任务\n\n([^\n]*)/.exec(prompt)?.[1] ?? "hello";
      const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
      const client = new Client({ name: "fake", version: "1" });
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
      const tools = (await client.listTools()).tools.map((t) => t.name);
      await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "mcp__omem__search", kind: "search", status: "in_progress" } });
      const found = (await client.callTool({ name: "search", arguments: { query: message } })) as { content: { text: string }[] };
      await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
      await client.callTool({ name: "remember", arguments: { content: `FAKE: ${message}`, kind: "fact" } });
      await client.close();
      const text = `tools=${tools.length}; search=${found.content[0].text.slice(0, 40).replace(/\n/g, " ")}`;
      await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
      return { stopReason: "end_turn" };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);
