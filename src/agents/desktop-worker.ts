// Runs inside one desktop executor's PID, mount and network namespaces. Only
// the host sees its control socket. Every invocation uses the fixed aad binary.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createServer as listener, connect } from "node:net";
import { mkdirSync } from "node:fs";

const [, , socket, program] = process.argv;
mkdirSync("/tmp/.omem-executor-tmp", { recursive: true });
const server = createServer({ maxHeaderSize: 4 << 20 }, (req, res) => {
  void (async () => {
    const endpoint = /^\/endpoint\/(\d{1,5})$/.exec(req.url ?? "");
    if (endpoint) {
      const port = Number(endpoint[1]);
      if (port < 1 || port > 65535) throw new Error("端口无效");
      const forward = listener(client => {
        const peer = connect(port, "127.0.0.1");
        client.on("error", () => peer.destroy()).on("close", () => peer.destroy());
        peer.on("error", () => client.destroy()).on("close", () => client.destroy());
        client.pipe(peer).pipe(client);
      });
      forward.listen(join(dirname(socket!), String(port)));
      await once(forward, "listening"); res.writeHead(200).end(); return;
    }
    const { args, cwd, port } = JSON.parse(Buffer.from(String(req.headers["x-omem-call"]), "base64").toString());
    const managed = args[0] === "omem-browser";
    if (managed && args.includes("--chrome")) throw new Error("浏览器由宿主选择");
    const env = { ...process.env, ...(port && { AAD_CDP_PORT: String(port) }) };
    if (managed) Object.assign(env, { OMEM_BROWSER_EXECUTOR: "1", OMEM_BROWSER_PROXY: process.env.HTTPS_PROXY });
    const child = spawn(managed ? process.execPath : program!, managed ? ["/tmp/.omem-browser.mjs", ...args.slice(1)] : args,
      { cwd, env, detached: true });
    const stop = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    };
    res.once("close", stop);
    try {
      const closed = once(child, "close");
      child.stdin.on("error", () => req.unpipe(child.stdin));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
      req.pipe(child.stdin);
      async function forward(stream: NodeJS.ReadableStream, fd: number) {
        for await (const chunk of stream) {
          if (!res.write(JSON.stringify([fd, Buffer.from(chunk).toString("base64")]) + "\n"))
            await once(res, "drain");
        }
      }
      const [[code]] = await Promise.all([closed, forward(child.stdout, 1), forward(child.stderr, 2)]);
      res.end(JSON.stringify([0, code ?? 1]) + "\n");
    } finally { stop(); }
  })().catch(e => {
    if (res.headersSent) res.end(JSON.stringify([2, Buffer.from(String(e)).toString("base64")]) + "\n" + JSON.stringify([0, 126]) + "\n");
    else res.writeHead(500).end(String(e));
  });
});
server.listen(socket, () => process.stdout.write("ready\n"));
