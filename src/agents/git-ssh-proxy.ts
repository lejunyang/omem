// OpenSSH's ProxyCommand in the owner's isolated Git executor. The local relay
// applies the executor's CONNECT policy and resolves the host outside the namespace.
import { request } from "node:http";
import { isIP } from "node:net";
import { once } from "node:events";

const [host, port] = process.argv.slice(2);
if (!host || !/^\d{1,5}$/.test(port ?? "")) throw new Error("缺少 SSH 主机或端口");
const authority = (isIP(host) === 6 ? "[" + host + "]" : host) + ":" + port;
const req = request(new URL(process.env.HTTPS_PROXY ?? ""), { method: "CONNECT", path: authority, headers: { host: authority } });
const connected = once(req, "connect");
req.end();
const [res, socket, head] = await connected;
if (res.statusCode !== 200) {
  socket.destroy();
  throw new Error("SSH 目标未获准连接（HTTP " + res.statusCode + "）");
}
if (head.length) socket.unshift(head);
process.stdin.pipe(socket).pipe(process.stdout);
socket.once("close", () => process.stdin.destroy());
