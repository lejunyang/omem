/**
 * An agent host: a small process that owns one ACP agent's stdin and stdout, so the agent lives on
 * while omem restarts (docs/v2/restart-hold.md). omem talks ACP to the agent through it over a local
 * socket (agents/hosted.ts). When omem goes away in the middle of a turn, the host keeps the agent
 * running: it records what the agent says during the turn, holds what the agent asks of omem (a
 * permission) and the tool calls it makes, and gives all of it to the omem that comes back. If none
 * comes back within the hold, it cancels the turn, stops the agent and exits; the run then starts
 * over the way a restart always made it.
 *
 * It understands just enough JSON-RPC for that: which request is the turn in flight (`session/prompt`),
 * which requests came from the agent and are still unanswered, and omem's two own methods
 * (`_omem/await_turn`; the reattach handshake is a control frame). Everything else passes through.
 *
 * Run as `node agent-host.js launch <spec>`: that starts the host itself detached and returns at once,
 * so the host is not a child of omem (a supervisor stopping omem's process tree leaves it alone).
 * Node builtins only, so it starts fast and does not load omem.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as netServer, type Socket } from "node:net";
import { createServer as httpServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { FRAME, frame, frameReader, lineReader } from "./host-frames.ts";

export type HostSpec = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Unix socket path or Windows pipe name omem connects to. */
  socket: string;
  /** What omem's first control message must carry. */
  key: string;
  /** How long a turn is held for omem to come back (ms). */
  graceMs: number;
  /** omem's HTTP base: the agent's calls to it go through the host's proxy, which holds them while omem is away. */
  upstream?: string;
  /** The tool token the agent was launched with, given to the omem that takes the turn back. */
  token?: string;
  /** How many descriptors after stdio the host was given and passes on at the same numbers (sandbox config, pinned mounts). */
  fds: number;
  /** The host's own log (what it did, why it stopped). */
  log?: string;
};

/** What the agent said during the turn in flight, for an omem that comes back. */
const MAX_LOG_BYTES = 16 * 1024 * 1024;
/** How long a newly started host waits for omem to connect at all. */
const FIRST_CONNECT_MS = 30_000;

type Turn = { id: unknown; sessionId?: string; log: string[]; bytes: number; total: number; delivered: number; response?: string };

const idKey = (id: unknown) => JSON.stringify(id);
const win = process.platform === "win32";
const say = (text: string) => { try { writeSync(2, `${new Date().toISOString()} ${text}\n`); } catch { /* no log */ } };

function launcher(specPath: string) {
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as HostSpec;
  const log = spec.log ? openSync(spec.log, "a", 0o600) : "ignore";
  const extra = Array.from({ length: spec.fds }, (_, i) => 3 + i);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "host", specPath], {
    cwd: dirname(specPath), stdio: ["ignore", log, log, ...extra], detached: true, windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

async function host(specPath: string) {
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as HostSpec;
  rmSync(specPath, { force: true });
  let client: Socket | null = null;
  let hadClient = false;
  /** live: omem is attached and the agent's output goes to it; attaching: omem is taking the turn back; detached: no omem. */
  let mode: "live" | "attaching" | "detached" = "detached";
  let turn: Turn | null = null;
  /** The id of the reattached omem's `_omem/await_turn`, answered with the turn's result. */
  let awaitId: unknown = null;
  /** How much of the turn's log the reattached omem already got in the handshake. */
  let snapshot = 0;
  /** Requests of the omem attached now, so their answers go to it and not to one that left. */
  const fromClient = new Set<string>();
  /** Requests from the agent no omem answered yet (a permission), sent again to the next one. */
  const agentAsks = new Map<string, string>();
  let stderrTail = "";
  let grace: NodeJS.Timeout | undefined;
  /** Until omem first connects. */
  let first: NodeJS.Timeout | undefined;
  let exiting = false;
  let liveWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  const sendOut = (line: string) => { client?.write(frame(FRAME.stdout, line + "\n")); };
  const goLive = () => {
    mode = "live";
    for (const w of liveWaiters.splice(0)) w.resolve();
  };
  const whenLive = () => mode === "live" && client ? Promise.resolve() : exiting ? Promise.reject(new Error("gone")) : new Promise<void>((resolve, reject) => liveWaiters.push({ resolve, reject }));

  // ---- the proxy the agent's calls to omem go through
  let proxyBase: string | undefined;
  let proxy: ReturnType<typeof httpServer> | undefined;
  if (spec.upstream) {
    const upstream = new URL(spec.upstream);
    proxy = httpServer((req, res) => void proxied(upstream, req, res, whenLive).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); }));
    proxy.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => proxy!.once("error", reject).listen(0, "127.0.0.1", () => resolve()));
    proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  }
  const env = { ...spec.env };
  if (proxyBase && env.OMEM_URL === spec.upstream) env.OMEM_URL = proxyBase;
  const rewrite = (m: { params?: { mcpServers?: { url?: unknown; env?: { name?: unknown; value?: unknown }[] }[] } }) => {
    for (const s of m.params?.mcpServers ?? []) {
      if (typeof s.url === "string" && spec.upstream && s.url.startsWith(spec.upstream)) s.url = proxyBase + s.url.slice(spec.upstream.length);
      for (const e of Array.isArray(s.env) ? s.env : []) if (e?.name === "OMEM_URL" && e.value === spec.upstream) e.value = proxyBase;
    }
    return m;
  };

  // ---- the agent
  const agent: ChildProcess = spawn(spec.file, spec.args, {
    cwd: spec.cwd, env, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", ...Array.from({ length: spec.fds }, (_, i) => 3 + i)],
    // Its own process group, so stopping it stops what it started and not the host.
    detached: !win,
  });
  agent.stdin!.on("error", () => {});
  const writeAgent = (line: string) => { if (agent.stdin!.writable) agent.stdin!.write(line + "\n"); };
  let agentGone = false;
  const killAgent = () => {
    if (agentGone || !agent.pid) return;
    try {
      if (win) spawn("taskkill", ["/pid", String(agent.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      else process.kill(-agent.pid, "SIGTERM");
    } catch { try { agent.kill("SIGTERM"); } catch { /* gone */ } }
    setTimeout(() => { try { if (!win && !agentGone) process.kill(-agent.pid!, "SIGKILL"); } catch { /* gone */ } }, 2000).unref();
  };
  const finish = (why: string) => {
    if (exiting) return;
    exiting = true;
    say(`结束：${why}`);
    clearTimeout(grace);
    for (const w of liveWaiters.splice(0)) w.reject(new Error("gone"));
    killAgent();
    const done = () => {
      client?.end();
      server.close();
      proxy?.close();
      if (!win) rmSync(spec.socket, { force: true });
      setTimeout(() => process.exit(0), 200).unref();
    };
    if (agentGone) done();
    else {
      agent.once("exit", done);
      setTimeout(done, 3000).unref();
    }
  };
  const exited = (info: { code?: number | null; signal?: string | null; error?: string }) => {
    if (agentGone) return;
    agentGone = true;
    client?.write(frame(FRAME.exit, JSON.stringify(info)));
    finish(`Agent 退出 ${JSON.stringify(info)}`);
  };
  agent.once("exit", (code, signal) => exited({ code, signal }));
  agent.once("error", (e) => exited({ error: e.message }));
  agent.stderr!.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString("utf8")).slice(-4000);
    client?.write(frame(FRAME.stderr, d));
  });

  const pushLog = (t: Turn, line: string) => {
    t.log.push(line);
    t.bytes += line.length;
    t.total++;
    while (t.bytes > MAX_LOG_BYTES && t.log.length > 1) t.bytes -= t.log.shift()!.length;
  };
  const finishTurn = () => {
    const t = turn!;
    if (awaitId !== null) {
      const r = JSON.parse(t.response!) as { result?: unknown; error?: unknown };
      sendOut(JSON.stringify({ jsonrpc: "2.0", id: awaitId, ...(r.error !== undefined ? { error: r.error } : { result: r.result ?? null }) }));
    } else sendOut(t.response!);
    turn = null;
    awaitId = null;
  };
  agent.stdout!.on("data", lineReader((line) => {
    let m: { id?: unknown; method?: unknown } | null = null;
    try { m = JSON.parse(line); } catch { /* passed on as it is */ }
    if (m && typeof m.method === "string" && m.id !== undefined) {
      agentAsks.set(idKey(m.id), line);
      if (mode === "live") sendOut(line);
      return;
    }
    if (m && m.id !== undefined && m.method === undefined) {
      if (turn && idKey(m.id) === idKey(turn.id)) {
        turn.response = line;
        if (mode === "live") finishTurn();
        return;
      }
      if (mode === "live" && fromClient.delete(idKey(m.id))) sendOut(line);
      return;
    }
    if (turn) {
      pushLog(turn, line);
      if (mode === "live") { sendOut(line); turn.delivered = turn.total; }
      return;
    }
    if (mode === "live") sendOut(line);
  }));

  // ---- omem
  const fromService = (line: string) => {
    let m: { id?: unknown; method?: unknown; params?: { sessionId?: string } } | null = null;
    try { m = JSON.parse(line); } catch { writeAgent(line); return; }
    if (!m) return writeAgent(line);
    if (m.method === "_omem/await_turn" && m.id !== undefined) {
      if (!turn) {
        sendOut(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Agent 宿主上没有进行中的一轮" } }));
        return;
      }
      awaitId = m.id;
      for (const ask of agentAsks.values()) sendOut(ask);
      const t = turn;
      for (const later of t.log.slice(Math.max(0, snapshot - (t.total - t.log.length)))) sendOut(later);
      t.delivered = t.total;
      goLive();
      if (t.response) finishTurn();
      return;
    }
    if (typeof m.method === "string" && m.id !== undefined) {
      if (m.method === "session/prompt") turn = { id: m.id, sessionId: m.params?.sessionId, log: [], bytes: 0, total: 0, delivered: 0 };
      else fromClient.add(idKey(m.id));
      if (proxyBase && (m.method === "session/new" || m.method === "session/resume" || m.method === "session/load")) line = JSON.stringify(rewrite(m as never));
    } else if (m.id !== undefined && m.method === undefined) agentAsks.delete(idKey(m.id));
    writeAgent(line);
  };
  const lost = (sock: Socket) => {
    if (sock !== client) return;
    client = null;
    mode = "detached";
    awaitId = null;
    fromClient.clear();
    if (exiting) return;
    if (!turn) return finish("omem 断开，没有进行中的一轮");
    say(`omem 断开，保留这一轮 ${Math.round(spec.graceMs / 1000)} 秒`);
    clearTimeout(grace);
    grace = setTimeout(() => {
      say("omem 没有在限定时间内回来");
      for (const w of liveWaiters.splice(0)) w.reject(new Error("gone"));
      if (turn && !turn.response && turn.sessionId) writeAgent(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: turn.sessionId } }));
      setTimeout(() => finish("omem 没有回来"), 2000).unref();
    }, spec.graceMs);
  };
  const adopt = (sock: Socket, attach: boolean) => {
    client = sock;
    hadClient = true;
    clearTimeout(grace);
    clearTimeout(first);
    const t = turn as Turn | null;
    const hello = { ok: true, hostPid: process.pid, agentPid: agent.pid ?? null, proxy: proxyBase ?? null,
      ...(attach ? { token: spec.token ?? null, stderr: stderrTail, turn: t ? { sessionId: t.sessionId ?? null, log: t.log, first: t.total - t.log.length, delivered: t.delivered, done: !!t.response } : null } : {}) };
    sock.write(frame(FRAME.hello, JSON.stringify(hello)));
    if (attach) {
      mode = "attaching";
      snapshot = t?.total ?? 0;
      say(t ? `omem 回来接这一轮（已有 ${t.total} 条输出${t.response ? "，这一轮已经做完" : ""}）` : "omem 回来了，但没有进行中的一轮");
    } else goLive();
  };
  const server = netServer((sock) => {
    let authed = false;
    sock.on("error", () => {});
    sock.on("close", () => lost(sock));
    const stdin = lineReader(fromService);
    const read = frameReader((type, payload) => {
      if (!authed) {
        let m: { op?: string; key?: string; attach?: boolean } = {};
        try { m = JSON.parse(payload.toString("utf8")); } catch { /* refused below */ }
        if (type !== FRAME.control || m.op !== "hello" || m.key !== spec.key) return void sock.destroy();
        // One omem at a time; a fresh one only while none had connected yet.
        if (client || exiting || (!m.attach && hadClient)) {
          sock.write(frame(FRAME.hello, JSON.stringify({ ok: false, error: client ? "已有 omem 连接" : "这个宿主已经接过 omem" })));
          return void sock.end();
        }
        authed = true;
        adopt(sock, !!m.attach);
        return;
      }
      if (sock !== client) return;
      if (type === FRAME.stdin) stdin(payload);
      else if (type === FRAME.control) {
        let m: { op?: string } = {};
        try { m = JSON.parse(payload.toString("utf8")); } catch { /* ignored */ }
        if (m.op === "kill") finish("omem 要求停止");
        // omem is going away on purpose (a restart): hold the turn from now on.
        else if (m.op === "detach") { lost(sock); sock.destroy(); }
      }
    });
    sock.on("data", (chunk: Buffer) => {
      try { read(chunk); } catch { sock.destroy(); }
    });
  });
  if (!win) rmSync(spec.socket, { force: true });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(spec.socket, () => resolve()));
  first = setTimeout(() => { if (!hadClient) finish("omem 没有连上来"); }, FIRST_CONNECT_MS);
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, () => finish(s));
  say(`已启动 Agent（pid ${agent.pid}）${proxyBase ? `，工具调用经 ${proxyBase}` : ""}`);
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);
function forwardHeaders(headers: IncomingMessage["headers"]) {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
  return out;
}

/**
 * One call of the agent to omem. While omem is away (or taking the turn back) the call waits; once
 * it is back the call goes on, and a refused connection (omem still starting) is tried again. A call
 * omem received and then lost in the middle is not sent twice: it fails as it would have.
 */
async function proxied(upstream: URL, req: IncomingMessage, res: ServerResponse, whenLive: () => Promise<void>) {
  // A command's stdin stream cannot be sent twice: it goes through as it comes.
  const stream = /x-omem-stdin/i.test(String(req.headers["content-type"] ?? ""));
  let body: Buffer | undefined;
  if (!stream) {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 64 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
      parts.push(chunk as Buffer);
    }
    body = Buffer.concat(parts);
  }
  for (let attempt = 0; ; attempt++) {
    try { await whenLive(); }
    catch { res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }); res.end("omem 重启后没有在限定时间内回来"); return; }
    const outcome = await new Promise<"done" | "retry">((resolve) => {
      const headers = forwardHeaders(req.headers);
      headers.host = upstream.host;
      if (body) headers["content-length"] = body.length;
      const up = httpRequest({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, (r) => {
        const back = forwardHeaders(r.headers);
        res.writeHead(r.statusCode ?? 502, back);
        r.pipe(res);
        r.on("error", () => res.destroy());
        resolve("done");
      });
      up.on("error", (e: NodeJS.ErrnoException) => {
        if (body && (e.code === "ECONNREFUSED" || e.code === "ENOENT") && attempt < 120) return resolve("retry");
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`omem 连接中断：${e.message}`);
        resolve("done");
      });
      if (body) up.end(body);
      else req.pipe(up);
    });
    if (outcome === "done") return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const [mode, specPath] = process.argv.slice(2);
if (mode === "launch" && specPath) launcher(specPath);
else if (mode === "host" && specPath) host(specPath).catch((e) => { say(`启动失败：${(e as Error).stack ?? e}`); process.exit(1); });
