import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { previewCommands } from "../src/agents/previews.ts";
import { descendants, parseLsof, parseNetstat, parseProcNetTcp, scanPorts } from "../src/core/listening.ts";
import { addPeer, openPeerUi } from "../src/core/peers.ts";
import { tunnelConnect } from "../src/core/peer-tunnel.ts";
import { createSpace, updateSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error("等不到");
    await sleep(300);
  }
}
const freePort = (host: string) =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail).listen(0, host, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
const ipv6 = await freePort("::1").then(() => true, () => false);

describe("preview parsing", () => {
  it("reads listening and open sockets from /proc/net/tcp, netstat and lsof", () => {
    const proc = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:15BE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000:15BF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4343 1 0000000000000000 100 0 0 10 0",
      "   2: 0100007F:15BE 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 5151 1 0000000000000000 20 4 30 10 -1",
      "   3: 0100007F:15BE 0100007F:D432 06 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 20 4 30 10 -1",
    ].join("\n");
    expect(parseProcNetTcp(proc)).toEqual([
      { host: "127.0.0.1", port: 5566, listening: true, inode: 4242 },
      { host: "0.0.0.0", port: 5567, listening: true, inode: 4343 },
      { host: "127.0.0.1", port: 5566, listening: false, inode: 5151 },
    ]);
    const v6 = "header\n   0: 00000000000000000000000001000000:15B3 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 77 1\n   1: 0000000000000000FFFF00000100007F:15B4 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 78 1";
    expect(parseProcNetTcp(v6).map((s) => [s.host, s.port])).toEqual([["::1", 5555], ["127.0.0.1", 5556]]);

    const netstat = [
      "活动连接",
      "  协议  本地地址          外部地址        状态           PID",
      "  TCP    127.0.0.1:5566         0.0.0.0:0              LISTENING       1200",
      "  TCP    [::1]:5567             [::]:0                 LISTENING       1300",
      "  TCP    127.0.0.1:5566         127.0.0.1:54001        ESTABLISHED     1200",
      "  TCP    127.0.0.1:5566         127.0.0.1:54002        TIME_WAIT       0",
      "  UDP    0.0.0.0:5353           *:*                                    900",
    ].join("\r\n");
    expect(parseNetstat(netstat)).toEqual([
      { host: "127.0.0.1", port: 5566, listening: true, pid: 1200 },
      { host: "::1", port: 5567, listening: true, pid: 1300 },
      { host: "127.0.0.1", port: 5566, listening: false, pid: 1200 },
    ]);

    const lsof = ["p501", "f23", "n*:5555", "TST=LISTEN", "TQR=0", "f24", "n[::1]:5556", "TST=LISTEN", "p777", "f9", "n127.0.0.1:61000->127.0.0.1:5555", "TST=ESTABLISHED", "f10", "n127.0.0.1:61001->127.0.0.1:5555", "TST=CLOSE_WAIT"].join("\n");
    expect(parseLsof(lsof)).toEqual([
      { host: "0.0.0.0", port: 5555, listening: true, pid: 501 },
      { host: "::1", port: 5556, listening: true, pid: 501 },
      { host: "127.0.0.1", port: 61000, listening: false, pid: 777 },
    ]);
    expect([...descendants(1, [[1, 0], [2, 1], [3, 2], [4, 9], [5, 3]])].sort()).toEqual([1, 2, 3, 5]);
  });

  it("reads preview commands: named lines, or one unnamed command", () => {
    expect(previewCommands({ previewCommands: "主站: pnpm --dir apps/main dev & pnpm --dir apps/sub dev & wait\n# 注释\nH5：pnpm --dir wap/h5 dev\n" })).toEqual([
      { name: "主站", command: "pnpm --dir apps/main dev & pnpm --dir apps/sub dev & wait" },
      { name: "H5", command: "pnpm --dir wap/h5 dev" },
    ]);
    // Colons inside a command (PATH=/a:/b, URLs) do not make a name.
    expect(previewCommands({ previewCommands: "PATH=/opt/node/bin:$PATH pnpm dev" })).toEqual([{ name: "预览", command: "PATH=/opt/node/bin:$PATH pnpm dev" }]);
    expect(previewCommands({})).toEqual([]);
  });
});

describe("preview of a delegation's workspace", () => {
  const closers: (() => Promise<unknown> | void)[] = [];
  afterAll(async () => {
    for (const c of closers.reverse()) await c();
  });

  it("finds the ports a child of a child listens on, with open connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-ports-"));
    writeFileSync(join(dir, "server.mjs"), `import { createServer } from "node:net"; const s = createServer(() => {}); s.listen(0, "127.0.0.1", () => console.log(s.address().port));`);
    writeFileSync(join(dir, "launch.mjs"), `import { spawn } from "node:child_process"; spawn(process.execPath, ["server.mjs"], { stdio: "inherit" });`);
    const root = spawn(process.execPath, ["launch.mjs"], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
    closers.push(() => void spawn(process.platform === "win32" ? "taskkill" : "kill", process.platform === "win32" ? ["/pid", String(root.pid), "/T", "/F"] : [String(root.pid)]));
    const port = Number(await new Promise<string>((ok) => root.stdout!.once("data", (d) => ok(String(d).trim()))));
    const scan = await until(async () => {
      const s = await scanPorts(root.pid!);
      return s.listening.some((l) => l.port === port) ? s : null;
    });
    expect(scan.listening.find((l) => l.port === port)!.hosts).toEqual(["127.0.0.1"]);
    const sock = connect(port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    const withConn = await until(async () => ((await scanPorts(root.pid!)).connections.get(port) ? true : null));
    expect(withConn).toBe(true);
    sock.destroy();
  }, 60_000);

  it.skipIf(!ipv6)("starts the command in the workspace and forwards its port through `omem peer open`", async () => {
    // The dev server listens on ::1 only, so this machine's 127.0.0.1 port is free for the forward.
    const port = await freePort("::1");
    const work = mkdtempSync(join(tmpdir(), "omem-preview-"));
    writeFileSync(join(work, "server.mjs"), `
      import { createServer } from "node:http";
      const s = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("page " + req.headers.host + " " + req.url); });
      s.on("upgrade", (req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: echo\\r\\n\\r\\n"); socket.on("data", (d) => socket.write("echo:" + d)); });
      s.listen(${port}, "::1", () => console.log("dev server ready"));
    `);
    writeFileSync(join(work, "launch.mjs"), `import { spawn } from "node:child_process"; spawn(process.execPath, ["server.mjs"], { stdio: "inherit" });`);
    // A Git checkout that never ran the repository's setup command: the preview runs it first.
    execFileSync("git", ["init", "-q"], { cwd: work });

    const box = testApp();
    box.config.token = "owner-secret";
    const repo = createSpace(box, { name: "示例商城前端", kind: "repo" });
    updateSpace(box, repo.id, { settings: { previewCommands: `商城: "${process.execPath}" launch.mjs`, setupCommand: `"${process.execPath}" -e "require('fs').writeFileSync('setup.txt','ok')"` } });
    const r = createRun(box, { kind: "code", spaceId: repo.id, title: "退款页改版", input: { task: "退款页改版" } });
    setRunOutput(box, r.id, { appliedTo: [{ space: repo.id, path: work, branch: "feat/refund" }] });
    const server = await startServer(box, { port: 0, host: "127.0.0.1", quiet: true });
    closers.push(() => server.close());
    const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;

    const laptop = testApp();
    await addPeer(laptop, "omem1." + Buffer.from(JSON.stringify({ id: "box", urls: [base], token: "owner-secret" })).toString("base64url"));
    const ui = await openPeerUi(laptop, "box");
    closers.push(() => ui.close());
    const api = async <T>(path: string, init?: RequestInit) => {
      const res = await fetch(`${ui.url}${path}`, { ...init, headers: init?.body ? { "content-type": "application/json" } : {} });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    };

    // Only the owner; a page behind `omem peer open` is not on that machine.
    expect((await fetch(`${base}/api/runs/${r.id}/previews`)).status).toBe(401);
    const targets = await api<{ local: boolean; targets: { space: string; commands: { name: string }[] }[] }>(`/api/runs/${r.id}/previews`);
    expect(targets.local).toBe(false);
    expect(targets.targets).toMatchObject([{ space: repo.id, commands: [{ name: "商城" }] }]);
    expect(await api<{ forwarder: boolean; peer: string }>("/api/local/forwards")).toMatchObject({ forwarder: true, peer: "box" });
    expect(await (await fetch(`${base}/api/local/forwards`, { headers: { authorization: "Bearer owner-secret" } })).json()).toEqual({ forwarder: false });

    const started = await api<{ id: string; status: string }>("/api/previews", { method: "POST", body: JSON.stringify({ run: r.id, space: repo.id }) });
    expect(started.status).toBe("preparing");
    const running = await until(async () => {
      const p = await api<{ status: string; ports: { port: number; hosts: string[]; page: boolean | null }[]; log: string }>(`/api/previews/${started.id}`);
      return p.status === "running" && p.ports[0]?.page !== null ? p : null;
    });
    expect(running.ports).toEqual([{ port, hosts: ["::1"], page: true, connections: 0 }]);
    expect(running.log).toMatch(/依赖已准备[^]*launch.mjs[^]*dev server ready/);
    expect(existsSync(join(work, "setup.txt"))).toBe(true);

    // A port that is not the preview's own is refused.
    await expect(tunnelConnect(laptop, "box", `/api/previews/${started.id}/tcp?port=${port + 1}`)).rejects.toMatchObject({ status: 404 });

    const fwd = await api<{ ports: { port: number; ok: boolean }[] }>("/api/local/forwards", { method: "POST", body: JSON.stringify({ preview: started.id, ports: [port] }) });
    expect(fwd.ports).toEqual([{ port, ok: true, error: null }]);
    // Same port number here, the Host header as the browser sent it.
    expect(await (await fetch(`http://127.0.0.1:${port}/refund?id=7`)).text()).toBe(`page 127.0.0.1:${port} /refund?id=7`);
    const echo = await new Promise<string>((ok, fail) => {
      const req = request(`http://127.0.0.1:${port}/hmr`, { headers: { connection: "Upgrade", upgrade: "echo" } });
      req.on("upgrade", (_res, socket) => {
        socket.once("data", (d) => (ok(String(d)), socket.destroy()));
        socket.write("ping");
      });
      req.on("response", (res) => fail(new Error(`status ${res.statusCode}`)));
      req.on("error", fail);
      req.end();
    });
    expect(echo).toBe("echo:ping");

    // Stopped over there: the next connection here finds it gone and the forward closes.
    await api(`/api/previews/${started.id}`, { method: "DELETE" });
    expect((await api<{ status: string; reason: string }>(`/api/previews/${started.id}`)).status).toBe("stopped");
    await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    await until(async () => ((await api<{ forwards: unknown[] }>("/api/local/forwards")).forwards.length === 0 ? true : null), 10_000);
    // The process tree is gone: nothing listens on the port any more.
    await until(() => new Promise<boolean>((ok) => {
      const s = connect(port, "::1");
      s.once("connect", () => (s.destroy(), ok(false)));
      s.once("error", () => ok(true));
    }), 15_000);

    // The workspace goes away (applied elsewhere, reclaimed): the preview stops by itself.
    // Prepared once: the next preview starts right away.
    const again = await api<{ id: string; status: string }>("/api/previews", { method: "POST", body: JSON.stringify({ run: r.id, space: repo.id }) });
    expect(again.status).toBe("starting");
    await until(async () => ((await api<{ status: string }>(`/api/previews/${again.id}`)).status === "running" ? true : null));
    setRunOutput(box, r.id, { appliedTo: [] });
    const gone = await until(async () => {
      const p = await api<{ status: string; reason: string }>(`/api/previews/${again.id}`);
      return p.status === "stopped" ? p : null;
    });
    expect(gone.reason).toMatch(/工作区已经收回/);
    await expect(api("/api/previews", { method: "POST", body: JSON.stringify({ run: r.id, space: repo.id }) })).rejects.toThrow(/409/);
    box.db.close();
    laptop.db.close();
  }, 90_000);
});
