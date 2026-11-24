import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { startProxy, type Destination } from "../agents/egress-proxy.ts";
import { HttpError } from "../core/util.ts";

/**
 * A browser that someone other than the owner works in (remote/sessions.ts `guarded`) must not reach
 * this machine: omem's own API trusts requests from loopback, and other local services (databases,
 * debug ports, the AI agents' bridges) have no login at all. Chromium on Linux takes its proxy from the
 * environment when no desktop's proxy settings apply, and `no_proxy=<-loopback>` drops its built-in
 * exception for loopback: so every request of such a browser — pages, frames, workers, WebSockets,
 * names that resolve to 127.0.0.1 — goes through one proxy here, which resolves the name itself,
 * connects to exactly the address it checked (agents/egress-proxy.ts) and refuses this machine's own
 * addresses and link-local ones (cloud metadata services live at 169.254.169.254). Other private
 * networks stay reachable: a company's own sites and its single sign-on usually resolve to them.
 */
const linkLocal = new BlockList();
linkLocal.addSubnet("169.254.0.0", 16);
linkLocal.addSubnet("fe80::", 10, "ipv6");

export const GUARD_REFUSAL = "这个浏览器不能访问运行 omem 的这台机器上的地址";

export function refusedAddress(d: Pick<Destination, "local" | "ip">) {
  const ip = d.ip ?? "";
  return !!d.local || (isIP(ip) ? linkLocal.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4") : false);
}

let proxy: Promise<{ port: number; close(): void }> | null = null;
/** Its port once it listens: a run being prepared (synchronously) reads it, see guardUrlNow. */
let listening: number | null = null;
/** Started with omem (main.ts) so a run can be given the address at once; a browser session starts it too. */
export function startBrowserGuard() {
  if (process.platform === "linux") void guardProxy().catch((e) => console.warn(`[omem] 浏览器的本机地址守卫没能启动：${(e as Error).message}`));
}
/** The guard's address if it is running (null before it listens, or off Linux). */
export const guardUrlNow = () => (listening ? `http://127.0.0.1:${listening}` : null);
function guardProxy() {
  proxy ??= startProxy({ host: "127.0.0.1", port: 0 }, {
    check: async (d) => (refusedAddress(d) ? { allowed: false, reason: GUARD_REFUSAL } : { allowed: true }),
    needsBody: () => false,
    limits: { connections: 512, hosts: 100_000 },
    unref: true,
  }).then((p) => {
    listening = p.port;
    return p;
  }).catch((e) => {
    proxy = null;
    throw e;
  });
  return proxy;
}
export async function stopBrowserGuard() {
  const p = proxy;
  proxy = null;
  listening = null;
  (await p?.catch(() => null))?.close();
}

/** The guard proxy's address, for a browser launched with flags (the desktop-control skill's browser.mjs in someone else's run). */
export async function guardProxyUrl() {
  if (process.platform !== "linux") return null;
  return `http://127.0.0.1:${(await guardProxy()).port}`;
}
/** Chromium's command line says it goes through this guard, loopback included. */
export async function launchedGuarded(args: string[]) {
  const url = await guardProxyUrl().catch(() => null);
  return !!url && args.includes(`--proxy-server=${url}`) && args.includes("--proxy-bypass-list=<-loopback>");
}

/** What makes Chromium pick a desktop's proxy settings over the environment's. */
const DESKTOP = ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION", "KDE_FULL_SESSION", "KDE_SESSION_VERSION", "GNOME_DESKTOP_SESSION_ID"];
const PROXY_KEYS = ["all_proxy", "http_proxy", "https_proxy", "ftp_proxy", "no_proxy", "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY", "auto_proxy", "AUTO_PROXY"];

/** The environment `aad mcp` starts a guarded browser with (Linux only: elsewhere the browser is refused). */
export async function guardedBrowserEnv(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== "linux") throw new HttpError(409, "这台机器上还不能给成员开浏览器：只在 Linux 上能挡住对本机地址的访问");
  const { port } = await guardProxy();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!DESKTOP.includes(k) && !PROXY_KEYS.includes(k)) env[k] = v;
  const url = `http://127.0.0.1:${port}`;
  for (const k of ["all_proxy", "http_proxy", "https_proxy", "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"]) env[k] = url;
  env.no_proxy = env.NO_PROXY = "<-loopback>";
  return env;
}

/** This machine's own addresses, for refusing a typed address before the browser even tries it. */
function ownAddresses() {
  const own = new BlockList();
  own.addSubnet("127.0.0.0", 8);
  own.addAddress("0.0.0.0");
  own.addAddress("::", "ipv6");
  own.addAddress("::1", "ipv6");
  for (const nic of Object.values(networkInterfaces()).flat()) if (nic) own.addAddress(nic.address, isIP(nic.address) === 6 ? "ipv6" : "ipv4");
  return own;
}

/** A quick check of an address typed into a guarded session; the proxy decides every request anyway. */
export async function checkGuardedUrl(url: string) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new HttpError(403, GUARD_REFUSAL);
  const ips = isIP(host) ? [host] : await lookup(host, { all: true }).then((r) => r.map((a) => a.address)).catch(() => [] as string[]);
  const own = ownAddresses();
  if (ips.some((ip) => own.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4") || refusedAddress({ ip }))) throw new HttpError(403, GUARD_REFUSAL);
}
