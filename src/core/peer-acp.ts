import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { App } from "./app.ts";
import { allProfiles } from "./config.ts";
import { nodeId } from "./peers.ts";
import { peerRoute } from "./peer-tunnel.ts";

/**
 * A device's ACP agents, used from this one (agent profiles with `peer`).
 *
 * The agent runs on the device, with its login and quota; the tools stay here. This machine
 * launches `omem peer acp <device> <agent>` as the agent command, which opens an upgraded
 * connection to the device's `/api/peer/acp` (through middle nodes like the other tunnels) and
 * carries the ACP messages both ways as JSON lines. The MCP servers a session asks for never
 * leave this machine: the bridge sends only their names, the device gives its agent a local
 * stand-in for each (HTTP `/mcp` or the stdio bridge, with a token good for this connection
 * only), and every list or call on a stand-in comes back here to the real server.
 *
 * The device runs the agent in its own scratch folder (`peer-acp/<this node>`), so it reads
 * none of this machine's files: fine for chat, research and writing, not for coding delegations.
 *
 * Frames: `{acp}` an ACP message, `{mcp}` / `{mcpReply}` a tool request and its answer,
 * `{stderr}` and `{exit}` from the agent process.
 */

type Frame = {
  acp?: Record<string, unknown>;
  mcp?: { id: number; server: string; op: "list" | "call"; name?: string; args?: unknown };
  mcpReply?: { id: number; result?: unknown; error?: string };
  stderr?: string;
  exit?: number | null;
};

const SESSION_METHODS = /^session\/(new|load|resume|fork)$/;
export const ACP_PATH = /^\/api\/peer\/acp(\?|$)/;

function lines(stream: Duplex | NodeJS.ReadableStream, onLine: (line: string) => void, head?: Buffer) {
  let buf = head?.length ? head.toString("utf8") : "";
  const flush = () => {
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
  flush();
  stream.on("data", (d: Buffer | string) => {
    buf += d.toString();
    flush();
  });
}

const parse = (line: string): Frame | null => {
  try {
    return JSON.parse(line) as Frame;
  } catch {
    return null;
  }
};

// ------------------------------------------------------------- on the device

type ToolRelay = { list(): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]>; call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> };
const relays = new Map<string, ToolRelay>();
const serving = new Set<Duplex>();

/** The service stops: the agents it runs for other devices stop with it. */
export function closeAcpServing() {
  for (const s of serving) s.destroy();
  serving.clear();
}

/** A stand-in MCP server's token (`/mcp`, `/api/tools`): its calls go back over the connection. */
export function toolRelay(token: string) {
  return relays.get(token) ?? null;
}

/** An agent of this device the other end may run: an ACP profile of its own, not another device's. */
export function servableAgent(app: App, id: string) {
  return allProfiles(app.config).find((p) => p.id === id && p.transport === "acp" && !p.peer) ?? null;
}

/** The upgraded `/api/peer/acp?agent=<id>&node=<caller>` (the caller is already checked as the owner). */
export async function serveAcp(app: App, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const { launch, stop } = await import("../agents/spawn.ts");
  const { backendAvailable } = await import("../agents/availability.ts");
  const { mcpBridge } = await import("../agents/runner.ts");
  const url = new URL(req.url ?? "/", "http://x");
  const profile = servableAgent(app, url.searchParams.get("agent") ?? "");
  if (!profile || !backendAvailable(profile, app.home)) return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
  const caller = (url.searchParams.get("node") ?? "peer").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || "peer";
  const cwd = join(app.home, "peer-acp", caller);
  mkdirSync(cwd, { recursive: true });
  let child;
  try {
    child = launch(profile.command, profile.args, { cwd, env: profile.env });
  } catch (e) {
    return void socket.end(`HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${(e as Error).message}`);
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: omem-acp\r\nconnection: Upgrade\r\n\r\n");
  const send = (f: Frame) => socket.writable && socket.write(JSON.stringify(f) + "\n");
  const tokens: string[] = [];
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let next = 0;
  let initId: unknown;
  let httpMcp = false;
  const ask = (m: Omit<NonNullable<Frame["mcp"]>, "id">) =>
    new Promise<unknown>((ok, fail) => {
      const id = ++next;
      pending.set(id, { ok, fail });
      send({ mcp: { id, ...m } });
    });
  const standIn = (name: string) => {
    const token = "ot_" + randomBytes(18).toString("base64url");
    tokens.push(token);
    relays.set(token, {
      list: async () => (await ask({ server: name, op: "list" })) as Awaited<ReturnType<ToolRelay["list"]>>,
      call: async (tool, args) => (await ask({ server: name, op: "call", name: tool, args })) as { text: string; isError: boolean },
    });
    if (httpMcp) return { type: "http", name, url: `${app.baseUrl}/mcp`, headers: [{ name: "authorization", value: `Bearer ${token}` }] };
    const b = mcpBridge();
    return { name, command: b.command, args: b.args, env: [{ name: "OMEM_URL", value: app.baseUrl }, { name: "OMEM_TOKEN", value: token }] };
  };
  lines(child.stdout, (line) => {
    const msg = parse(line) as Record<string, unknown> | null;
    if (!msg) return void send({ stderr: line + "\n" });
    if (initId !== undefined && msg.id === initId) {
      const caps = (msg.result as { agentCapabilities?: { mcpCapabilities?: { http?: boolean } } } | undefined)?.agentCapabilities;
      httpMcp = !!caps?.mcpCapabilities?.http;
    }
    send({ acp: msg });
  });
  child.stderr.on("data", (d: Buffer) => send({ stderr: d.toString() }));
  child.once("exit", (code) => {
    send({ exit: code });
    socket.end();
  });
  child.once("error", (e) => {
    send({ stderr: e.message + "\n" });
    send({ exit: 1 });
    socket.end();
  });
  lines(socket, (line) => {
    const f = parse(line);
    if (f?.acp) {
      const msg = f.acp;
      if (msg.method === "initialize") initId = msg.id;
      if (typeof msg.method === "string" && SESSION_METHODS.test(msg.method) && msg.params) {
        const p = msg.params as { cwd?: string; mcpServers?: { name: string }[] };
        p.cwd = cwd;
        p.mcpServers = (p.mcpServers ?? []).map((s) => standIn(s.name));
      }
      child.stdin.write(JSON.stringify(msg) + "\n");
    } else if (f?.mcpReply) {
      const w = pending.get(f.mcpReply.id);
      pending.delete(f.mcpReply.id);
      if (f.mcpReply.error !== undefined) w?.fail(new Error(f.mcpReply.error));
      else w?.ok(f.mcpReply.result);
    }
  }, head);
  serving.add(socket);
  const done = () => {
    serving.delete(socket);
    stop(child);
    for (const t of tokens) relays.delete(t);
    for (const w of pending.values()) w.fail(new Error("与发起设备的连接已断开"));
    pending.clear();
  };
  socket.on("close", done).on("error", done);
}

// ---------------------------------------------------------- on this machine

type McpSpec = { name: string; type?: string; url?: string; headers?: { name: string; value: string }[]; command?: string; args?: string[]; env?: { name: string; value: string }[] };

/** Open the upgraded connection to `agent` on device `id` (through its `via` chain). */
export function connectAcp(app: App, id: string, agent: string): Promise<{ socket: Duplex; head: Buffer }> {
  const r = peerRoute(app, id, `/api/peer/acp?agent=${encodeURIComponent(agent)}&node=${encodeURIComponent(nodeId(app))}`, 0);
  const target = new URL(r.path, r.url);
  return new Promise((ok, fail) => {
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      headers: { connection: "Upgrade", upgrade: "omem-acp", authorization: `Bearer ${r.token}`, "x-omem-hops": String(r.hops) },
      agent: false,
    });
    req.on("upgrade", (_res, socket, head) => ok({ socket, head }));
    req.on("response", (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => {
        const hint = res.statusCode === 404 ? `设备 ${id} 上没有可用的 Agent ${agent}，或它的 omem 还不支持远程 Agent（更新它和中间的设备）` : `设备 ${id} 拒绝连接（HTTP ${res.statusCode}）`;
        fail(new Error(body.trim() ? `${hint}：${body.trim().slice(0, 300)}` : hint));
      });
    });
    req.on("error", (e) => fail(new Error(`连不上设备 ${id}：${e.message}`)));
    req.end();
  });
}

async function mcpClient(spec: McpSpec) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "omem-peer-acp", version: "0.2.0" });
  const pairs = (xs?: { name: string; value: string }[]) => Object.fromEntries((xs ?? []).map((x) => [x.name, x.value]));
  if (spec.url) {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: pairs(spec.headers) } }));
  } else {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const env = { ...(process.env as Record<string, string>), ...pairs(spec.env) };
    await client.connect(new StdioClientTransport({ command: spec.command!, args: spec.args ?? [], env, stderr: "ignore" }));
  }
  return client;
}

/**
 * `omem peer acp <device> <agent>`: the agent command of a device's agent. Speaks ACP on stdio
 * to this machine's runner and relays to the device; answers the device's tool requests from
 * the MCP servers each session named.
 */
export async function runAcpBridge(app: App, id: string, agent: string) {
  const { socket, head } = await connectAcp(app, id, agent);
  const specs = new Map<string, McpSpec>();
  const clients = new Map<string, ReturnType<typeof mcpClient>>();
  const send = (f: Frame) => socket.writable && socket.write(JSON.stringify(f) + "\n");
  const quit = (code: number) => {
    for (const c of clients.values()) void c.then((x) => x.close()).catch(() => {});
    // What the agent said last still has to reach the runner.
    process.stdout.write("", () => process.exit(code));
  };
  const answer = async (m: NonNullable<Frame["mcp"]>) => {
    const spec = specs.get(m.server);
    if (!spec) throw new Error(`没有名为 ${m.server} 的 MCP 服务`);
    if (!clients.has(m.server)) clients.set(m.server, mcpClient(spec));
    const client = await clients.get(m.server)!;
    if (m.op === "list") {
      const tools: unknown[] = [];
      let cursor: string | undefined;
      do {
        const r = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...r.tools);
        cursor = r.nextCursor;
      } while (cursor);
      return tools;
    }
    const r = (await client.callTool({ name: m.name ?? "", arguments: (m.args ?? {}) as Record<string, unknown> })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    return { text: (r.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n"), isError: !!r.isError };
  };
  lines(process.stdin, (line) => {
    const msg = parse(line) as Record<string, unknown> | null;
    if (!msg) return;
    // The servers stay here; the device only learns their names.
    if (typeof msg.method === "string" && SESSION_METHODS.test(msg.method) && msg.params) {
      const p = msg.params as { mcpServers?: McpSpec[] };
      for (const s of p.mcpServers ?? []) specs.set(s.name, s);
      p.mcpServers = (p.mcpServers ?? []).map((s) => ({ name: s.name, command: "", args: [], env: [] }));
    }
    send({ acp: msg });
  });
  process.stdin.on("end", () => socket.end());
  lines(socket, (line) => {
    const f = parse(line);
    if (!f) return;
    if (f.acp) process.stdout.write(JSON.stringify(f.acp) + "\n");
    if (f.stderr) process.stderr.write(f.stderr);
    if (f.mcp) {
      const m = f.mcp;
      answer(m).then(
        (result) => send({ mcpReply: { id: m.id, result } }),
        (e: Error) => send({ mcpReply: { id: m.id, error: e.message } }),
      );
    }
    if (f.exit !== undefined) quit(f.exit ?? 1);
  }, head);
  socket.on("close", () => {
    process.stderr.write(`与设备 ${id} 的连接已断开\n`);
    quit(1);
  });
  socket.on("error", (e) => process.stderr.write(`与设备 ${id} 的连接出错：${e.message}\n`));
}
