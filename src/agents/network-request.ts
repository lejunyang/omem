import { isIP } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import type { NetworkPolicy } from "../core/config.ts";

export class NetworkHttpError extends Error {
  status: number;
  retryAt: number;
  constructor(status: number, retryAfter?: string) {
    super(`出口检测返回 HTTP ${status}`);
    this.status = status;
    const seconds = Number(retryAfter);
    this.retryAt = retryAfter && Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter ?? "") || Date.now() + 60000;
  }
}

/** Open a tunnel through a configured HTTP proxy. The authority may be a pinned IP. */
export function proxyTunnel(proxy: URL, authority: string, signal?: AbortSignal) {
  return new Promise<import("node:net").Socket>((resolve, reject) => {
    const endpoint = new URL(proxy);
    const headers: http.OutgoingHttpHeaders = { host: authority };
    if (endpoint.username || endpoint.password) {
      const credentials = decodeURIComponent(endpoint.username) + ":" + decodeURIComponent(endpoint.password);
      headers["proxy-authorization"] = "Basic " + Buffer.from(credentials).toString("base64");
      endpoint.username = "";
      endpoint.password = "";
    }
    const req = (endpoint.protocol === "https:" ? https : http).request(endpoint, { method: "CONNECT", path: authority, signal, headers, rejectUnauthorized: true });
    req.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`代理连接失败：HTTP ${res.statusCode}`)); }
      else { if (head.length) socket.unshift(head); resolve(socket); }
    });
    req.once("error", reject);
    req.end();
  });
}

/** Native HTTP(S) on every platform. An address override keeps the original Host and TLS identity. */
export async function networkRequest(connection: NetworkPolicy["connection"], href: string, signal: AbortSignal, options: { address?: string; accept?: string } = {}): Promise<string> {
  const url = new URL(href);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const address = options.address;
  const authority = address ? `${isIP(address) === 6 ? `[${address}]` : address}:${url.port || (url.protocol === "https:" ? 443 : 80)}` : url.host + (url.port ? "" : `:${url.protocol === "https:" ? 443 : 80}`);
  let agent: https.Agent | undefined;
  let tunnel: import("node:net").Socket | undefined;
  try {
    if (connection.type === "proxy" && url.protocol === "https:") {
      const proxy = new URL(connection.url);
      tunnel = await proxyTunnel(proxy, authority, signal);
      agent = new https.Agent({ keepAlive: false });
      const socket = tunnel;
      agent.createConnection = () => tls.connect({ socket, host, servername: isIP(host) ? undefined : host });
    }
    return await new Promise<string>((resolve, reject) => {
      const proxy = connection.type === "proxy" && url.protocol === "http:" ? new URL(connection.url) : null;
      const target = proxy ?? url;
      const overridden = new URL(url);
      if (address) overridden.hostname = isIP(address) === 6 ? `[${address}]` : address;
      const req = (target.protocol === "https:" ? https : http).request(target, {
        method: "GET", signal, agent,
        ...(proxy ? { path: overridden.href } : address ? {
          hostname: address, family: isIP(address), autoSelectFamily: false,
          ...(url.protocol === "https:" && !isIP(host) ? { servername: host } : {}),
        } : {}),
        headers: { host: url.host, "user-agent": "omem-network-check", "accept-encoding": "identity", ...(options.accept ? { accept: options.accept } : {}) },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new NetworkHttpError(res.statusCode ?? 0, res.headers["retry-after"])); return; }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 65536) req.destroy(new Error("出口检测响应超过 64 KB"));
        });
        res.once("end", () => resolve(body));
        res.once("error", reject);
      });
      req.once("error", reject);
      req.end();
    });
  } finally { agent?.destroy(); tunnel?.destroy(); }
}
