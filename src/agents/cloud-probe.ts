import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { one, run } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { backendCapabilities } from "./capabilities.ts";
import { publicName } from "./network-diagnostics.ts";
import type { runBackend } from "./dispatch.ts";

export type CloudHttp = "header" | "url" | false;
type Probe = { id: string; url: string; transport: string; at: string; mode: CloudHttp; reason: string; confirmed: boolean };

function publicIp(ip: string) {
  if (isIP(ip) === 6) return /^[23]/i.test(ip) && !/^(2001:(db8|0):|2002:)/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0,168].includes(b)) && !(a === 198 && [18,19].includes(b));
}

export function cloudAddress(app: App) {
  try {
    const u = new URL(app.config.webUrl ?? "");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && (isIP(host) ? publicIp(host) : publicName(host))) return u.href.replace(/\/$/, "");
  } catch { /* Report the same configuration guidance for an absent or invalid URL. */ }
  return null;
}

export async function checkCloudAddress(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map(r => r.address);
  if (!ips.length || !ips.every(publicIp)) throw new HttpError(400, "webUrl 没有解析到可用的公网地址");
}

const key = (id: string) => "cloud-tools:probe:" + id;
export function lastProbe(app: App, id: string): Probe | null {
  const row = one<{ value: string }>(app.db, "select value from kv where key=?", key(id));
  return row ? JSON.parse(row.value) : null;
}
function save(app: App, backend: string, result: Probe) {
  run(app.db, "insert or replace into kv(key,value) values(?,?)", key(backend), JSON.stringify(result));
  return result;
}
function cloudProfile(app: App, id: string) {
  const p = allProfiles(app.config).find(p => p.id === id);
  if (!p || backendCapabilities(p).where !== "cloud") throw new HttpError(400, "请选择一个云端后端");
  return p;
}
const challenges = new Map<string, { app: App; receipt: string; arrived: boolean; header: boolean }>();
export function probeReceipt(app: App, nonce: string, header: unknown) {
  const entry = challenges.get(nonce);
  if (!entry || entry.app !== app) throw new HttpError(404, "探测已结束");
  entry.arrived = true;
  entry.header ||= header === nonce;
  return entry.receipt;
}

export async function probeCloud(app: App, backend: string, execute?: typeof runBackend) {
  const p = cloudProfile(app, backend);
  const url = cloudAddress(app);
  if (!url) throw new HttpError(400, "请配置公网 HTTPS webUrl");
  await checkCloudAddress(url);
  const nonce = randomUUID();
  const entry = { app, receipt: "回执 " + randomUUID(), arrived: false, header: false };
  challenges.set(nonce, entry);
  let mode: CloudHttp = false;
  let reason = "没有收到探测请求";
  try {
    const turn = execute ?? (await import("./dispatch.ts")).runBackend;
    const result = await turn(app, p, { cwd: app.home, signal: AbortSignal.timeout(90_000),
      prompt: `读取 ${url}/api/cloud-tools/challenge/${nonce}，能设置请求头时带 X-Omem-Probe: ${nonce}。原样回复响应正文。` }, () => {});
    if (entry.arrived && result.text.includes(entry.receipt)) {
      mode = entry.header ? "header" : "url";
      reason = entry.header ? "读回了回执并带了指定请求头" : "读回了回执，请求未带指定头";
    } else if (entry.arrived) reason = "请求到了，后端没有读回回执";
  } catch (error) {
    reason = "探测会话失败：" + (error as Error).message.slice(0, 240);
  } finally { challenges.delete(nonce); }
  return save(app, backend, { id: nonce, url, transport: p.transport, at: new Date().toISOString(), mode, reason, confirmed: false });
}

export function confirmProbe(app: App, backend: string, id: string) {
  const p = cloudProfile(app, backend);
  const r = lastProbe(app, p.id);
  if (!r?.mode || r.id !== id || r.url !== cloudAddress(app) || r.transport !== p.transport) throw new HttpError(409, "请重新探测后确认");
  return save(app, backend, { ...r, confirmed: true });
}

export function cloudAccess(app: App, p: AgentProfile) {
  const cfg = app.config.agents.cloudTools;
  const caps = backendCapabilities(p);
  const url = cloudAddress(app);
  if (!cfg.enabled || caps.where !== "cloud" || caps.omemAccess !== "none") return { reason: "云端工具未启用" };
  if (!cfg.backends.includes(p.id)) return { reason: "未选中这个后端" };
  if (!url) return { reason: "需要公网 HTTPS webUrl" };
  const r = lastProbe(app, p.id);
  if (!r?.mode || !r.confirmed || r.url !== url || r.transport !== p.transport) return { reason: "需要本人确认当前地址的成功探测" };
  if (cfg.credentialIn === "channel" && !caps.credentialChannel) return { reason: "后端没有安全凭据通道" };
  return { mode: r.mode, url };
}
