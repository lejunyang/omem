import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { backendCapabilities } from "./capabilities.ts";
import { publicName } from "./network-diagnostics.ts";
import type { runBackend } from "./dispatch.ts";

export type CloudHttp = "header" | "url" | false;
type Probe = { id: string; url: string; fingerprint: string; at: string; mode: CloudHttp; reason: string; confirmed: boolean };

function publicIp(ip: string) {
  if (isIP(ip) === 6) return /^[23]/i.test(ip) && !/^(2001:(db8|0):|2002:)/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0,168].includes(b)) && !(a === 198 && [18,19].includes(b));
}

/**
 * The address a cloud backend calls back on: `webUrl`, public HTTPS. With `agents.cloudTools.privateAddress`
 * the owner allows an internal one over http too (a cloud that runs inside the same network, as the probe
 * then shows); credentials, query and fragment are refused either way.
 */
export function cloudAddress(app: App) {
  const internal = app.config.agents.cloudTools.privateAddress;
  try {
    const u = new URL(app.config.webUrl ?? "");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (u.username || u.password || u.search || u.hash) return null;
    if (internal ? ["http:", "https:"].includes(u.protocol) && !!host
      : u.protocol === "https:" && (isIP(host) ? publicIp(host) : publicName(host))) return u.href.replace(/\/$/, "");
  } catch { /* Report the same configuration guidance for an absent or invalid URL. */ }
  return null;
}
export const cloudAddressHint = (app: App) => app.config.agents.cloudTools.privateAddress ? "请配置 webUrl（http 或 https）" : "请配置公网 HTTPS webUrl";

export async function checkCloudAddress(app: App, url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map(r => r.address);
  if (!ips.length) throw new HttpError(400, "webUrl 解析不到地址");
  if (!app.config.agents.cloudTools.privateAddress && !ips.every(publicIp)) throw new HttpError(400, "webUrl 没有解析到可用的公网地址");
}

function fingerprint(p: AgentProfile) {
  return createHash("sha256").update(JSON.stringify(["http-probe-v3", p.transport, p.command, p.args, p.env])).digest("hex");
}
const key = (id: string) => "cloud-tools:probe:" + id;
export function lastProbe(app: App, id: string): Probe | null {
  const row = one<{ value: string }>(app.db, "select value from kv where key=?", key(id));
  return row ? JSON.parse(row.value) : null;
}
export function cloudBackendStatus(app: App) {
  const profiles = allProfiles(app.config).filter(p => backendCapabilities(p).where === "cloud");
  const rows = all<{ key: string; value: string }>(app.db, "select key,value from kv where key in (select value from json_each(?))",
    JSON.stringify(profiles.map(p => key(p.id))));
  const probes = new Map(rows.map(r => [r.key, JSON.parse(r.value) as Probe]));
  return profiles.map(p => {
    const probe = probes.get(key(p.id)) ?? null;
    return { backend: p.id, probe, reason: cloudAccess(app, p, probe).reason };
  });
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
type ProbeMode = Exclude<CloudHttp, false>;
type Challenge = {
  app: App; url: string; nonce: string; next: Record<ProbeMode, string>; receipts: Record<ProbeMode, string>;
  failure: string;
};
const challenges = new Map<string, Challenge>();

export function probeReceipt(app: App, key: string, method: string, authorization?: string, args?: unknown) {
  const entry = challenges.get(key);
  if (!entry || entry.app !== app) throw new HttpError(404, "探测已结束");
  const header = authorization === "Bearer probe-" + entry.nonce;
  if (key === entry.nonce && method === "GET") {
    if (authorization !== undefined && !header) {
      entry.failure = "首个 GET 的 Authorization 测试值不匹配";
      throw new HttpError(400, entry.failure);
    }
    entry.failure = "未完成带 Authorization 的 POST JSON 或无头 GET 参数调用";
    return { next: entry.url + "/api/cloud-tools/challenge/" + entry.next[header ? "header" : "url"] };
  }
  const mode = key === entry.next.header ? "header" : "url";
  if (key !== entry.next[mode] || (mode === "header" ? method !== "POST" || !header : method !== "GET" || authorization !== undefined)
      || (args as { probe?: unknown } | null)?.probe !== entry.nonce) {
    entry.failure = mode === "header" ? "缺少 Authorization 测试头或有效的 POST JSON 参数" : "未能用无头 GET 传入 JSON 参数";
    throw new HttpError(400, entry.failure);
  }
  entry.failure = "后端没有读回工具响应中的回执";
  return { receipt: entry.receipts[mode] };
}

export async function probeCloud(app: App, backend: string, execute?: typeof runBackend) {
  const p = cloudProfile(app, backend);
  const url = cloudAddress(app);
  if (!url) throw new HttpError(400, cloudAddressHint(app));
  await checkCloudAddress(app, url);
  const nonce = randomUUID();
  const entry: Challenge = { app, url, nonce, next: { header: randomUUID(), url: randomUUID() },
    receipts: { header: randomUUID(), url: randomUUID() }, failure: "没有收到探测请求" };
  const keys = [nonce, ...Object.values(entry.next)];
  for (const key of keys) challenges.set(key, entry);
  let mode: CloudHttp = false;
  let reason = "没有收到探测请求";
  try {
    const turn = execute ?? (await import("./dispatch.ts")).runBackend;
    const result = await turn(app, p, { cwd: app.home, signal: AbortSignal.timeout(90_000),
      prompt: `GET ${url}/api/cloud-tools/challenge/${nonce}，带 Authorization: Bearer probe-${nonce}（无权限的测试值）。` +
        `向响应中的 next 地址带相同头 POST JSON {"probe":"${nonce}"}。如果做不到，从原地址重新无头 GET，` +
        `再无头 GET 新的 next 地址，查询参数 args 为 URL 编码的 {"probe":"${nonce}"}。回复最终响应的 receipt。` }, () => {});
    mode = result.text.includes(entry.receipts.header) ? "header" : result.text.includes(entry.receipts.url) ? "url" : false;
    reason = mode === "header" ? "带 Authorization 的 GET、POST JSON 和回执均已验证"
      : mode === "url" ? "无头 GET、后续地址的 JSON 参数和回执均已验证" : entry.failure;
  } catch (error) {
    reason = "探测会话失败：" + (error as Error).message.slice(0, 240);
  } finally { for (const key of keys) challenges.delete(key); }
  return save(app, backend, { id: nonce, url, fingerprint: fingerprint(p), at: new Date().toISOString(), mode, reason, confirmed: false });
}

export function confirmProbe(app: App, backend: string, id: string) {
  const p = cloudProfile(app, backend);
  const r = lastProbe(app, p.id);
  if (!r?.mode || r.id !== id || r.url !== cloudAddress(app) || r.fingerprint !== fingerprint(p)) throw new HttpError(409, "请重新探测后确认");
  return save(app, backend, { ...r, confirmed: true });
}

export function cloudAccess(app: App, p: AgentProfile, probe?: Probe | null) {
  const cfg = app.config.agents.cloudTools;
  const caps = backendCapabilities(p);
  const url = cloudAddress(app);
  if (!cfg.enabled || caps.where !== "cloud" || caps.omemAccess !== "none") return { reason: "云端工具未启用" };
  if (!cfg.backends.includes(p.id)) return { reason: "未选中这个后端" };
  if (!url) return { reason: app.config.agents.cloudTools.privateAddress ? "需要 webUrl" : "需要公网 HTTPS webUrl" };
  const r = probe === undefined ? lastProbe(app, p.id) : probe;
  if (!r?.mode || !r.confirmed || r.url !== url || r.fingerprint !== fingerprint(p)) return { reason: "需要本人确认当前地址的成功探测" };
  if (cfg.credentialIn === "channel" && !caps.credentialChannel) return { reason: "后端没有安全凭据通道" };
  return { mode: r.mode, url };
}
