import { once } from "node:events";
import { closeSync, constants, existsSync, fstatSync, openSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { packageRoot } from "../setup.ts";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { OWNER } from "../core/users.ts";
import { runBrowserProfilesRoot } from "./accounts.ts";
import { canonical, under } from "./own-sandbox.ts";
import { launchRun } from "./egress-run.ts";
import { stop } from "./spawn.ts";
import { onToolTokenRevoked, type ToolContext } from "./tools.ts";
import { accountOf, egressRelayPath, type SandboxNetwork } from "./sandbox.ts";

type Mounts = { home: string; ro: string[]; rw: string[]; file: string; env: NodeJS.ProcessEnv; masked: string[]; links: { path: string; target: string }[] };
type Start = (mounts: Mounts, network: SandboxNetwork, args: string[], pointers: { source: string; path: string }[]) => ChildProcessWithoutNullStreams;
type Call = { cwd: string; args: string[]; desktopPort?: number };
export type DesktopViewer = { signal: AbortSignal; endpoint(port: number): Promise<string>; assist(args: string[]): ReturnType<typeof spawn> };
type Session = { ready: Promise<string>; viewer: DesktopViewer; close(): void };
export function desktopViewer(token: string) { return sessions.get(token)?.viewer; }
const sessions = new Map<string, Session>();
export function closeDesktopExecutor(token: string) { sessions.get(token)?.close(); }

function openDesktop(ctx: ToolContext, token: string, mounts: Mounts, start: Start): Session {
  const { app, commandSandbox: scope, browserProfilesRoot } = ctx;
  const userId = ctx.userId ?? OWNER;
  const owner = userId === OWNER;
  const profiles = runBrowserProfilesRoot(app, userId, !!accountOf(scope!.profile));
  const state = join(mounts.home, ".ai-auto-desktop");
  const writable = scope!.own?.plan.rw ?? [...scope!.workspace.rw, mounts.home];
  // Resolve only the host HOME alias, never a profile or state directory through a symlink.
  if (browserProfilesRoot !== profiles || canonical(profiles) !== profiles || canonical(state) !== state)
    throw new Error("桌面状态路径已改变");
  for (const path of [profiles, state]) mkdirSync(path, { recursive: true, mode: 0o700 });
  mounts.rw.push(profiles, state);
  for (const rel of [".config/google-chrome", ".config/chromium", ".config/microsoft-edge", ".config/BraveSoftware", ".mozilla", ".config/mozilla"])
    mounts.masked.push(join(mounts.home, rel));
  for (const dir of ["/opt/google/chrome", "/opt/microsoft/msedge", "/opt/brave.com/brave"]) {
    if (existsSync(dir) && !writable.some(root => under(dir, root) || under(root, dir))) mounts.ro.push(realpathSync(dir));
  }
  const helper = join(dirname(realpathSync(mounts.file)), "aad-browser");
  if (existsSync(helper)) {
    if (writable.some(dir => under(canonical(helper), dir))) throw new Error("桌面辅助程序位于 Agent 可写目录");
    mounts.ro.push(realpathSync(helper));
  }
  const origin = new URL(app.baseUrl!);
  origin.hostname = "127.0.0.1";
  Object.assign(mounts.env, { OMEM_BROWSER_PROFILES: profiles, OMEM_URL: origin.origin, OMEM_TOKEN: token });
  const pointers: { source: string; path: string }[] = [];
  const socketMount = (source: string | undefined, path: string) => {
    if (!source || !isAbsolute(source) || !statSync(source, { throwIfNoEntry: false })?.isSocket()) return false;
    pointers.push({ source: realpathSync(source), path });
    return true;
  };
  if (owner) {
    const display = process.env.DISPLAY ?? "";
    const number = /^:(\d+)(?:\.\d+)?$/.exec(display)?.[1];
    if (number && socketMount("/tmp/.X11-unix/X" + number, "/tmp/.X11-unix/X" + number)) {
      mounts.env.DISPLAY = display;
      const auth = process.env.XAUTHORITY || join(mounts.home, ".Xauthority");
      if (statSync(auth, { throwIfNoEntry: false })?.isFile()) {
        pointers.push({ source: realpathSync(auth), path: "/tmp/.omem-xauthority" });
        mounts.env.XAUTHORITY = "/tmp/.omem-xauthority";
      }
    }
    const runtime = process.env.XDG_RUNTIME_DIR;
    const wayland = process.env.WAYLAND_DISPLAY;
    if (runtime && wayland && socketMount(isAbsolute(wayland) ? wayland : join(runtime, wayland), "/tmp/.omem-wayland"))
      mounts.env.WAYLAND_DISPLAY = "/tmp/.omem-wayland";
    const bus = process.env.AT_SPI_BUS_ADDRESS?.match(/^unix:path=([^,;]+)$/)?.[1] ??
      (runtime && number ? join(runtime, "at-spi", "bus_" + display.slice(1)) : undefined);
    if (socketMount(bus, "/tmp/.omem-at-spi")) mounts.env.AT_SPI_BUS_ADDRESS = "unix:path=/tmp/.omem-at-spi";
  }
  const dir = mkdtempSync("/tmp/omem-aad-");
  const socket = join(dir, "control");
  const descriptors = new Set<number>();
  function pinSocket(path: string) {
    const fd = openSync(path, 0x200000 | constants.O_NOFOLLOW); // O_PATH, including Unix sockets.
    if (!fstatSync(fd).isSocket()) { closeSync(fd); throw new Error("桌面执行器套接字无效"); }
    descriptors.add(fd);
    return "/proc/self/fd/" + fd;
  }
  const controller = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined;
  const unsubscribe = onToolTokenRevoked(token, close);
  function close() {
    if (controller.signal.aborted) return;
    controller.abort(); unsubscribe();
    if (child) stop(child);
    for (const fd of descriptors) closeSync(fd);
    sessions.delete(token);
    rmSync(dir, { recursive: true, force: true });
  }
  const ready = (async () => {
    controller.signal.throwIfAborted();
    const worker = realpathSync(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./desktop-worker.ts" : "./desktop-worker.js", import.meta.url)));
    const aad = mounts.file;
    mounts.ro.push(worker, realpathSync(egressRelayPath));
    mounts.rw.push(dir);
    mounts.file = process.execPath;
    const script = canonical(join(packageRoot(), "skills/library/desktop-control/scripts/browser.mjs"));
    if (writable.some(root => under(script, root) || under(worker, root))) throw new Error("桌面执行器程序位于 Agent 可写目录");
    pointers.push({ source: script, path: "/tmp/.omem-browser.mjs" });
    const args = [worker, socket, aad];
    const mcp = { token, baseUrl: origin.origin, url: origin.origin + "/mcp", stdio: { command: "", args: [] } };
    child = await launchRun(scope!.profile, { app, ownSandbox: scope!.own, mcp, runId: ctx.runId, source: "executor", desktop: true, signal: controller.signal },
      (account, own) => start(mounts, (own?.network ?? account?.network)!, args, pointers));
    let diagnostics = "";
    child.stderr.on("data", part => diagnostics = (diagnostics + part).slice(-1000));
    const closed = once(child, "close").then(() => { close(); throw new Error("桌面执行器已结束 " + diagnostics); });
    await Promise.race([once(child.stdout, "data"), closed]);
    return pinSocket(socket);
  })().catch(e => { close(); throw e; });
  const endpoints = new Map<number, Promise<string>>();
  const viewer: DesktopViewer = {
    signal: controller.signal,
    endpoint(port) {
      controller.signal.throwIfAborted();
      const existing = endpoints.get(port);
      if (existing) return existing;
      const opened = ready.then(async socketPath => {
        const req = request({ socketPath, method: "POST", path: "/endpoint/" + port, signal: controller.signal });
        const response = once(req, "response"); req.end();
        const [res] = await response as [IncomingMessage]; res.resume();
        if (res.statusCode !== 200) throw new Error("桌面查看器连接失败");
        return pinSocket(join(dir, String(port)));
      }).catch(e => { endpoints.delete(port); throw e; });
      endpoints.set(port, opened);
      return opened;
    },
    assist(args) {
      controller.signal.throwIfAborted();
      const script = join(app.home, "bin/sandbox/bin/command-gate.mjs");
      return spawn(process.execPath, [script, "aad", "assist", ...args], { cwd: "/", stdio: "pipe",
        env: { OMEM_TOKEN: token, OMEM_URL: app.baseUrl, PATH: process.env.PATH } });
    }
  };
  return { ready, viewer, close };
}

export async function runDesktop(ctx: ToolContext, token: string, mounts: Mounts, call: Call, start: Start,
  input: IncomingMessage, output: ServerResponse, signal: AbortSignal) {
  let session = sessions.get(token);
  if (!session) { session = openDesktop(ctx, token, mounts, start); sessions.set(token, session); }
  const socketPath = await session.ready;
  signal.throwIfAborted();
  const header = Buffer.from(JSON.stringify({ args: call.args, cwd: call.cwd, port: call.desktopPort })).toString("base64");
  const req = request({ socketPath, method: "POST", path: "/", signal, headers: { "x-omem-call": header } });
  const response = once(req, "response");
  req.flushHeaders(); input.pipe(req);
  try {
    const [res] = await response as [IncomingMessage];
    if (res.statusCode !== 200) throw new Error("桌面执行器拒绝调用");
    output.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    output.flushHeaders();
    for await (const chunk of res) {
      if (!output.write(chunk)) await once(output, "drain", { signal });
    }
    output.end();
  } finally { input.unpipe(req); req.destroy(); }
}
