import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { isIP, connect } from "node:net";
import { networkRequest } from "./network-request.ts";
import { dnsConfigurationKey, inspectDns, inspectIpv6, type DnsDiagnostic, type Ipv6Diagnostic } from "./network-diagnostics.ts";
import type { App } from "../core/app.ts";
import type { AgentProfile, NetworkPolicy } from "../core/config.ts";

export class NetworkUnavailableError extends Error {
  constructor(message: string) { super(`网络条件不满足：${message}`); this.name = "NetworkUnavailableError"; }
}
type Attempt = { controller: AbortController; runId?: string | null; stop?: () => void };
type Entry = {
  policy: NetworkPolicy; signature: string; version: number;
  status: "unchecked" | "checking" | "ready" | "unavailable" | "recovering";
  reason: string | null; localReason: string | null; localCheckedAt?: string;
  ip?: string; country?: string; checkedAt?: string; validUntil: number;
  ipv6?: Ipv6Diagnostic; dns?: DnsDiagnostic; dnsKey?: string;
  retryAt: number; recoverUntil: number; successes: number;
  pending?: Promise<void>; probeAbort?: AbortController; active: Set<Attempt>;
  /** The interfaces this policy depends on, as last seen (fingerprintFor). */
  interfaces: string;
  /** Proxy port / exit probe failures in a row: one alone (a stalled event loop, a dropped packet) does not stop work. */
  portStrikes: number; probeStrikes: number;
};
type State = { entries: Map<string, Entry>; timer?: NodeJS.Timeout; ticking: boolean; closed: boolean };
const states = new WeakMap<App, State>();
export function stopNetworkPolicies(app: App) {
  const s = states.get(app);
  if (!s) return;
  s.closed = true;
  clearInterval(s.timer);
  for (const e of s.entries.values()) { e.probeAbort?.abort(); for (const a of e.active) { a.controller.abort(); a.stop?.(); } }
}
const fingerprint = () => JSON.stringify(Object.entries(networkInterfaces()).sort(([a], [b]) => a.localeCompare(b)).map(([name, addresses]) => [name, addresses?.map((a) => `${a.family}:${a.address}`).sort()]));
/** Container, VM and overlay interfaces come and go without changing where traffic leaves. */
const VIRTUAL = /^(lo\d*|docker|veth|br-|virbr|vmnet|vboxnet|vEthernet|cni|flannel|cali|tailscale|zt|ham)/i;
/**
 * What a policy's network looks like: the watched interface (all its addresses but link-local), or else
 * the IPv4 addresses of the machine's real interfaces. Rotating IPv6 temporary addresses, loopback and
 * a container starting no longer count as “the network changed” and stop running work.
 */
function fingerprintFor(p: NetworkPolicy) {
  const all = networkInterfaces();
  const names = p.watch.interface ? [p.watch.interface] : Object.keys(all).filter((n) => !VIRTUAL.test(n));
  return JSON.stringify(names.sort().map((n) => [n, (all[n] ?? []).filter((a) => !a.internal && !/^fe80:/i.test(a.address) && (p.watch.interface || a.family === "IPv4")).map((a) => a.address).sort()]));
}

export function networkInterfacesView() {
  return Object.entries(networkInterfaces()).filter(([, a]) => a?.some((x) => !x.internal)).map(([name, a]) => ({ name, addresses: a!.map((x) => x.address) }));
}
function interfaceReason(name: string) {
  if (!networkInterfaces()[name]?.length) return `网络接口 ${name} 已消失或没有地址`;
  if (process.platform === "linux") {
    try {
      // IFF_UP is meaningful for TUN; operstate is commonly "unknown" even on a healthy tunnel.
      if (/^[\w.:-]+$/.test(name) && !(parseInt(readFileSync(`/sys/class/net/${name}/flags`, "utf8"), 16) & 1)) return `网络接口 ${name} 已关闭`;
    } catch { /* Address presence remains the portable check. */ }
  }
  return null;
}
async function portReason(url: string) {
  const u = new URL(url);
  return new Promise<string | null>((resolve) => {
    const socket = connect({ host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || (u.protocol === "https:" ? 443 : 80)) });
    const timer = setTimeout(() => finish(`代理端口 ${u.host} 无响应`), 2000);
    const finish = (reason: string | null) => { clearTimeout(timer); socket.destroy(); resolve(reason); };
    socket.once("connect", () => finish(null));
    socket.once("error", () => finish(`代理端口 ${u.host} 不可用`));
  });
}
async function localReason(p: NetworkPolicy) {
  const reason = p.watch.interface ? interfaceReason(p.watch.interface) : null;
  return reason ?? (p.connection.type === "proxy" ? await portReason(p.connection.url) : null);
}

function field(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
const normalizeIp = (s: string) => isIP(s) === 6 ? new URL(`http://[${s}]/`).hostname : s;
export function parseNetworkIdentity(body: string, p: NetworkPolicy) {
  const data: unknown = p.probe.format === "json" ? JSON.parse(body) : Object.fromEntries(body.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
  const ip = field(data, p.probe.format === "json" ? p.probe.ipField : "ip");
  const country = field(data, p.probe.format === "json" ? p.probe.countryField : "loc");
  if (typeof ip !== "string" || !isIP(ip.trim())) throw new Error("出口检测没有返回有效 IP");
  const code = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (code && !/^[A-Z]{2}$/.test(code)) throw new Error("出口检测返回的地区代码无效");
  return { ip: ip.trim(), country: code };
}
/** Node's connection errors as the settings page shows them. */
function readable(message: string) {
  const m = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNABORTED)\b\s*([^\s,]*)/.exec(message);
  if (!m) return message;
  const what = { ECONNREFUSED: "连接被拒绝", ECONNRESET: "连接被重置", ETIMEDOUT: "连接超时", ENOTFOUND: "域名解析失败", EAI_AGAIN: "域名暂时解析不了", EHOSTUNREACH: "主机不可达", ENETUNREACH: "网络不可达", ECONNABORTED: "连接中断" }[m[1]];
  return `出口检测失败：${what}${m[2] ? `（${m[2]}）` : ""}`;
}
function notify(app: App, e: Entry) { app.emit({ type: "network", policyId: e.policy.id }); }
function block(app: App, e: Entry, reason: string) {
  const changed = e.reason !== reason || e.status === "ready";
  if (changed) { e.version++; e.probeAbort?.abort(); }
  e.validUntil = 0;
  e.status = "unavailable";
  e.reason = reason;
  e.successes = 0;
  if (e.active.size) e.recoverUntil = Date.now() + 60000;
  else e.recoverUntil ||= 1; // Remember a failure without starting idle remote polling.
  if (e.policy.onFailure === "stop-and-fallback") for (const a of e.active) {
    if (!a.controller.signal.aborted) {
      a.controller.abort(new NetworkUnavailableError(`${e.policy.name}：${reason}`));
      a.stop?.();
    }
  }
  if (changed) notify(app, e);
}
function state(app: App): State {
  let s = states.get(app);
  if (!s) {
    s = { entries: new Map(), ticking: false, closed: false };
    states.set(app, s);
    app.events.once("close", () => {
      stopNetworkPolicies(app);
    });
  }
  const policies = app.config.agents.networkPolicies ?? [];
  for (const p of policies) {
    const signature = JSON.stringify(p);
    const old = s.entries.get(p.id);
    if (old?.signature === signature) continue;
    // Edited (a rename too): checked again, and the work running under it carries on unless the new
    // check fails; saving the form no longer stops it.
    if (old) { old.version++; old.probeAbort?.abort(); }
    s.entries.set(p.id, { policy: p, signature, version: 0, status: "unchecked", reason: null, localReason: null, validUntil: 0, retryAt: 0, recoverUntil: 0, successes: 0, active: old?.active ?? new Set(), interfaces: fingerprintFor(p), portStrikes: 0, probeStrikes: 0 });
    if (old) notify(app, s.entries.get(p.id)!);
  }
  for (const [id, e] of s.entries) if (!policies.some((p) => p.id === id)) { e.version++; e.probeAbort?.abort(); s.entries.delete(id); }
  if (policies.length && !s.timer && !s.closed) s.timer = setInterval(() => { void pollNetworkPolicies(app).catch(() => {}); }, 2000).unref();
  if (!policies.length) { clearInterval(s.timer); s.timer = undefined; }
  return s;
}
async function checkLocal(app: App, e: Entry) {
  const dnsKey = dnsConfigurationKey(e.policy);
  if (e.checkedAt && e.dnsKey !== undefined && e.dnsKey !== dnsKey) {
    e.version++; e.probeAbort?.abort(); e.validUntil = 0; e.retryAt = 0;
    // DNS diagnostics are advisory. A config change schedules a fresh exit check without
    // interrupting an existing execution until an actual exit failure is observed.
    if (e.status === "ready") e.status = "unchecked";
    notify(app, e);
  }
  e.dnsKey = dnsKey;
  let reason = await localReason(e.policy);
  // The proxy port not answering one 2-second connect (a stalled event loop delivers the connect late) is
  // not yet a broken proxy: the next tick decides. A refused port or a vanished interface stops at once.
  if (reason?.startsWith("代理端口") && reason.endsWith("无响应")) {
    if (++e.portStrikes < 2) reason = null;
  } else e.portStrikes = 0;
  e.localCheckedAt = new Date().toISOString();
  const previous = e.localReason;
  e.localReason = reason;
  if (reason) block(app, e, reason);
  else if (previous) {
    e.version++;
    e.validUntil = 0;
    e.recoverUntil = Date.now() + 60000;
    e.retryAt = 0;
    e.status = "recovering";
    e.reason = "本地网络已恢复，等待出口复核";
    notify(app, e);
  }
  return !reason;
}
async function check(app: App, e: Entry, force = false) {
  if (e.pending) { await e.pending; return; }
  const work = async () => {
    if (!await checkLocal(app, e)) return;
    if (!force && e.status === "ready" && e.validUntil > Date.now()) return;
    if (!force && e.retryAt > Date.now()) return;
    const version = e.version;
    const control = new AbortController();
    e.probeAbort = control;
    // Each diagnostic request has its own deadline; DNS fallback must not consume the base probe's deadline.
    const timer = setTimeout(() => control.abort(), e.policy.probe.timeoutMs * (e.policy.ipv6.enabled ? 8 : 1) + (e.policy.dns.enabled ? 4000 : 0));
    const recovering = e.recoverUntil > 0;
    if (recovering && e.recoverUntil <= Date.now()) e.recoverUntil = Date.now() + 60000;
    e.status = recovering ? "recovering" : "checking";
    notify(app, e);
    try {
      const [identity, ipv6, dns] = await Promise.all([
        networkRequest(e.policy.connection, e.policy.probe.url, AbortSignal.any([control.signal, AbortSignal.timeout(e.policy.probe.timeoutMs)])).then((body) => parseNetworkIdentity(body, e.policy)),
        e.policy.ipv6.enabled ? inspectIpv6(e.policy, control.signal, (body) => parseNetworkIdentity(body, e.policy), fingerprint()) : undefined,
        e.policy.dns.enabled ? inspectDns(e.policy) : undefined,
      ]);
      if (e.version !== version || states.get(app)?.closed || state(app).entries.get(e.policy.id) !== e) return;
      // Check local state again: the network may have disappeared while the response was in flight.
      if (!await checkLocal(app, e) || e.version !== version) return;
      Object.assign(e, identity);
      e.ipv6 = ipv6; e.dns = dns;
      e.checkedAt = new Date().toISOString();
      const required = e.policy.require;
      // A definite answer (wrong region or IP) stops at once; only a probe that got no answer gets a second try.
      const mismatch = (message: string) => Object.assign(new Error(message), { definite: true });
      if (required.countries.length && !required.countries.includes(identity.country)) throw mismatch(`当前地区 ${identity.country || "未知"}，要求 ${required.countries.join("、")}`);
      if (required.ips.length && !required.ips.some((ip) => normalizeIp(ip) === normalizeIp(identity.ip))) throw mismatch(`当前出口 ${identity.ip} 不在允许的 IP 中`);
      for (const observation of ipv6?.observations ?? []) {
        if (required.countries.length && observation.country && !required.countries.includes(observation.country)) throw mismatch(`IPv6 目标路径出口 ${observation.ip} 的地区 ${observation.country}，要求 ${required.countries.join("、")}`);
        if (required.ips.length && !required.ips.some((ip) => normalizeIp(ip) === normalizeIp(observation.ip))) throw mismatch(`IPv6 目标路径出口 ${observation.ip} 不在允许的 IP 中`);
      }
      e.probeStrikes = 0;
      e.successes++;
      e.retryAt = Date.now() + 5000;
      if (recovering && e.successes < 2) { e.status = "recovering"; e.reason = "出口检查已通过，等待第二次确认"; }
      else { e.status = "ready"; e.reason = null; e.validUntil = Date.now() + e.policy.probe.maxAgeSeconds * 1000; e.recoverUntil = 0; }
      notify(app, e);
    } catch (error) {
      if (e.version !== version || states.get(app)?.closed) return;
      e.checkedAt = new Date().toISOString();
      // The exit was fine before and this probe got no answer: one more try shortly before stopping work.
      if (!(error as { definite?: boolean }).definite && e.successes > 0 && e.probeStrikes === 0 && !recovering) {
        e.probeStrikes = 1;
        e.retryAt = Date.now() + 2000;
        e.status = "checking";
        notify(app, e);
        return;
      }
      e.probeStrikes = 0;
      block(app, e, control.signal.aborted ? "出口检测超时或已中断" : readable((error as Error).message));
      e.retryAt = Date.now() + 5000;
    } finally { clearTimeout(timer); if (e.probeAbort === control) e.probeAbort = undefined; }
  };
  e.pending = work();
  try { await e.pending; } finally { e.pending = undefined; }
}
export async function pollNetworkPolicies(app: App) {
  const s = state(app);
  if (s.ticking || s.closed) return;
  s.ticking = true;
  try {
    for (const e of s.entries.values()) {
      const current = fingerprintFor(e.policy);
      if (e.interfaces === current) continue;
      e.interfaces = current;
      if (e.status === "unchecked") continue;
      block(app, e, "网络接口或地址已变化，需要重新检查出口");
      e.recoverUntil = Date.now() + 60000;
      e.retryAt = 0;
    }
    await Promise.all([...s.entries.values()].map(async (e) => {
      if (!await checkLocal(app, e)) return;
      // Remote checks may take seconds. Keep them independent so the next local tick can
      // still stop a backend while its identity request is slow or stuck.
      if (e.active.size || e.recoverUntil > Date.now()) void check(app, e).catch(() => {});
    }));
  } finally { s.ticking = false; }
}
export async function refreshNetworkPolicies(app: App, id?: string, force = false) {
  const entries = [...state(app).entries.values()].filter((e) => !id || e.policy.id === id);
  await Promise.all(entries.map((e) => check(app, e, force)));
  return networkPoliciesView(app);
}

/**
 * Before a run picks its AI: wait only for what the choice needs to know (a policy never checked, or
 * whose check expired), at most `waitMs`. A ready one is left to the poller; a failing one is retried in
 * the background on its own schedule, so runs of other backends no longer sit through its probes.
 */
export async function refreshForRun(app: App, waitMs = 4000) {
  if (!app.config.agents.networkPolicies?.length) return;
  const waits: Promise<void>[] = [];
  for (const e of state(app).entries.values()) {
    if (e.status === "ready" && e.validUntil > Date.now()) continue;
    const p = check(app, e).catch(() => {});
    if (e.status === "unchecked" || (e.status === "ready" && e.validUntil <= Date.now())) waits.push(p);
  }
  if (waits.length) await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, waitMs).unref())]);
}
function entryFor(app: App, profile: AgentProfile) {
  // Remote backends are governed on their execution host, never by this host's TUN.
  if (profile.peer || !app.config.agents.networkPolicies?.length) return undefined;
  return [...state(app).entries.values()].find((e) => e.policy.backends.includes(profile.id));
}
export function networkReason(app: App, profile: AgentProfile) {
  const e = entryFor(app, profile);
  if (!e) return null;
  if (e.status === "ready" && e.validUntil > Date.now()) return null;
  return `${e.policy.name}：${e.reason ?? (e.validUntil ? "出口检查已过期" : "尚未检查网络条件")}`;
}
export function networkPoliciesView(app: App) {
  return [...state(app).entries.values()].map((e) => ({ id: e.policy.id, status: e.status === "ready" && e.validUntil <= Date.now() ? "unchecked" : e.status, reason: e.reason, localReason: e.localReason, localCheckedAt: e.localCheckedAt, ip: e.ip, country: e.country, ipv6: e.ipv6, dns: e.dns, checkedAt: e.checkedAt, validUntil: e.validUntil ? new Date(e.validUntil).toISOString() : null, runs: [...new Set([...e.active].map((a) => a.runId).filter((id): id is string => !!id))] }));
}
export function networkEnvironment(app: App, profile: AgentProfile): Record<string, string> {
  const p = entryFor(app, profile)?.policy;
  if (!p) return {};
  const proxy = p.connection.type === "proxy" ? p.connection.url : "";
  // Override both spellings; an inherited lowercase variable must not silently win.
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: "", http_proxy: proxy, https_proxy: proxy, all_proxy: "", NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" };
}
export function networkProfile(app: App, profile: AgentProfile): AgentProfile {
  return { ...profile, env: { ...profile.env, ...networkEnvironment(app, profile) } };
}
export async function beginNetworkAttempt(app: App, profile: AgentProfile, opts: { signal?: AbortSignal; runId?: string | null; stop?: () => void } = {}) {
  const e = entryFor(app, profile);
  if (opts.signal?.aborted) throw new Error("CANCELLED");
  if (e) {
    await check(app, e);
    const reason = networkReason(app, profile);
    if (reason) throw new NetworkUnavailableError(reason);
  }
  if (opts.signal?.aborted) throw new Error("CANCELLED");
  const attempt: Attempt = { controller: new AbortController(), runId: opts.runId, stop: opts.stop };
  e?.active.add(attempt);
  const signal = opts.signal ? AbortSignal.any([opts.signal, attempt.controller.signal]) : attempt.controller.signal;
  return {
    profile: networkProfile(app, profile), signal,
    error(error: unknown): unknown { return opts.signal?.aborted ? new Error("CANCELLED") : attempt.controller.signal.aborted ? attempt.controller.signal.reason : error; },
    close() { e?.active.delete(attempt); },
  };
}
export async function withNetworkPolicy<T>(app: App, profile: AgentProfile, opts: { signal?: AbortSignal; runId?: string | null; stop?: () => void }, work: (profile: AgentProfile, signal: AbortSignal) => Promise<T>) {
  const attempt = await beginNetworkAttempt(app, profile, opts);
  try {
    if (attempt.signal.aborted) throw new Error("CANCELLED");
    const result = await work(attempt.profile, attempt.signal);
    if (attempt.signal.aborted) throw new Error("CANCELLED");
    return result;
  } catch (e) { throw attempt.error(e); }
  finally { attempt.close(); }
}
