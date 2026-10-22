/**
 * Minimal ACP agent for tests: it connects to the MCP servers the client gives
 * it, searches the knowledge base for the user's message, stores a memory and
 * answers. It exercises the real host path (ACP client, stdio MCP bridge, tool
 * tokens, run events) without a model.
 */
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, type McpServer } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sessions = new Map<string, McpServer[]>();
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
        agentCapabilities: { mcpCapabilities: { http: false }, sessionCapabilities: threadMode ? { resume: {} } : undefined },
        agentInfo: { name: "fake-agent", version: "1" },
      } as never;
    },
    async newSession(p) {
      const id = `s${process.pid}-${sessions.size + 1}`;
      sessions.set(id, p.mcpServers);
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
      return { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] } };
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
    async cancel() {},
    async prompt(p) {
      const prompt = p.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      const say = (text: string) => conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
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
