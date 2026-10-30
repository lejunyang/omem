import type { IncomingMessage } from "node:http";

/**
 * Checks for requests that are trusted because they come from this machine (no token configured).
 *
 * A web page the owner opens elsewhere can still reach 127.0.0.1: a form or an image posts to it
 * (CSRF), a WebSocket opens to it (no CORS for upgrades), or its own host name is pointed at
 * 127.0.0.1 (DNS rebinding) so the browser treats omem as that site. Loopback trust therefore
 * needs a loopback `Host` and, when the browser sends one, an `Origin` of the same host.
 */
const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/i;

export const loopbackIp = (ip: string) => /^(127\.|::1$|::ffff:127\.)/.test(ip);

function header(req: Pick<IncomingMessage, "headers">, name: string) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The browser's Origin, when present, names the host the request went to. */
export function sameOrigin(req: Pick<IncomingMessage, "headers">) {
  const origin = header(req, "origin");
  if (!origin || origin === "null") return !origin;
  try {
    const o = new URL(origin);
    const host = header(req, "x-forwarded-host") ?? header(req, "host") ?? "";
    // A dev server or `omem peer open` in front: both ends on this machine.
    return o.host === host || (LOOPBACK_HOST.test(o.host) && LOOPBACK_HOST.test(host));
  } catch {
    return false;
  }
}

/** Loopback trust: from this machine, addressed by a loopback name, not sent by another site. */
export function trustedLocal(req: Pick<IncomingMessage, "headers">, ip: string) {
  return loopbackIp(ip) && LOOPBACK_HOST.test(header(req, "host") ?? "") && sameOrigin(req);
}
