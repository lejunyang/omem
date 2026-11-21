// Runs as the parent of the backend inside its private network namespace. The only upstream
// socket is the run-specific Unix socket mounted by bubblewrap. Keep ACP stdio untouched.
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";

const [, , callback, command, ...args] = process.argv;
async function relay(port: number) {
  const server = createServer(client => {
    const peer = connect("/tmp/omem-egress.sock");
    client.on("error", () => peer.destroy()).on("close", () => peer.destroy());
    peer.on("error", () => client.destroy()).on("close", () => client.destroy());
    client.pipe(peer).pipe(client);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
if (Number(callback)) await relay(Number(callback));
const proxy = "http://127.0.0.1:" + await relay(0);
const env = { ...process.env };
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
  env[name] = env[name.toLowerCase()] = name === "NO_PROXY" ? "127.0.0.1,localhost" : proxy;
}
const child = spawn(command!, args, { env, stdio: "inherit" });
child.once("exit", code => process.exit(code ?? 1));
