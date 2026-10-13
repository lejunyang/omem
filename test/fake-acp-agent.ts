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
      return { sessionId: id, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }, { id: "read-only", name: "ro" }] } };
    },
    async resumeSession(p: { sessionId: string; mcpServers?: McpServer[] }) {
      sessions.set(p.sessionId, p.mcpServers ?? []);
      resumed.add(p.sessionId);
      return { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] } };
    },
    async setSessionMode() {
      return {};
    },
    async authenticate() {
      return {};
    },
    async cancel() {},
    async prompt(p) {
      const prompt = p.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      if (threadMode) {
        const n = (turns.get(p.sessionId) ?? 0) + 1;
        turns.set(p.sessionId, n);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const part = prompt.slice(prompt.lastIndexOf("# 本人新消息"));
        const msgs = [...part.matchAll(/本人（[^）]*）：([^\n]*)/g)].map((m) => m[1]);
        const role = /# 角色：([^\n]*)/.exec(prompt)?.[1] ?? "";
        const text = JSON.stringify({ session: p.sessionId, turn: n, resumed: resumed.has(p.sessionId), cold: prompt.includes("# 会话背景"), msgs, role, summary: /## 本会话到目前为止的摘要\n\n([^\n]*)/.exec(prompt)?.[1] ?? null, context: prompt.includes("的上下文，") });
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
