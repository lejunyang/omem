/**
 * A plugin service's side (docs/v2/plugins.md), without dependencies: a plugin in the data directory
 * cannot install packages, so its service imports this through OMEM_SERVICE_SDK:
 *
 *   const { serve } = await import(process.env.OMEM_SERVICE_SDK);
 *   serve({
 *     http: (req, res) => { res.end("ok"); },
 *     socket: (ws) => { ws.on("message", (data, binary) => ws.send(data)); },
 *   });
 *
 * It listens on 127.0.0.1:OMEM_SERVICE_PORT and refuses anything that does not carry omem's token,
 * so only omem (which checked the owner) reaches it. WebSocket: text and binary messages, ping,
 * close; messages up to 16 MB.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";

const MAX = 16 * 1024 * 1024;

export function serve({ http, socket } = {}) {
  const port = Number(process.env.OMEM_SERVICE_PORT);
  const token = process.env.OMEM_SERVICE_TOKEN;
  if (!port || !token) throw new Error("not started by omem: OMEM_SERVICE_PORT / OMEM_SERVICE_TOKEN missing");
  const authed = (req) => req.headers.authorization === `Bearer ${token}`;
  const server = createServer((req, res) => {
    if (!authed(req)) return void (res.writeHead(401), res.end());
    if (http) return http(req, res);
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, sock, head) => {
    if (!authed(req) || !socket || String(req.headers.upgrade).toLowerCase() !== "websocket" || !req.headers["sec-websocket-key"]) return void sock.destroy();
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket(wrap(sock, head), req);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

function wrap(sock, head) {
  const ws = new EventEmitter();
  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [];
  let partOp = 0;
  let open = true;
  ws.send = (data) => {
    if (!open) return;
    const binary = typeof data !== "string";
    sock.write(frame(binary ? 2 : 1, binary ? Buffer.from(data) : Buffer.from(data, "utf8")));
  };
  ws.close = () => {
    if (!open) return;
    open = false;
    sock.end(frame(8, Buffer.alloc(0)));
  };
  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (len > MAX) return void sock.destroy();
      const maskAt = at;
      if (masked) at += 4;
      if (buf.length < at + len) return;
      let payload = buf.subarray(at, at + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i % 4)];
      }
      buf = buf.subarray(at + len);
      if (op === 8) return ws.close();
      if (op === 9) { sock.write(frame(10, payload)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) partOp = op;
      parts.push(payload);
      if (fin) {
        const data = Buffer.concat(parts);
        parts = [];
        ws.emit("message", partOp === 1 ? data.toString("utf8") : data, partOp === 2);
      }
    }
  };
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    parse();
  });
  const gone = () => {
    if (!open && ws.closed) return;
    open = false;
    ws.closed = true;
    ws.emit("close");
  };
  sock.on("close", gone);
  sock.on("error", gone);
  if (buf.length) setImmediate(parse);
  return ws;
}
