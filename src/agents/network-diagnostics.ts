import { getServers } from "node:dns";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";
import type { NetworkPolicy } from "../core/config.ts";
import { NetworkHttpError, networkRequest } from "./network-request.ts";

export type Ipv6Diagnostic = {
  status: "unknown" | "observed"; reason?: string; source?: string; checkedAt: string;
  observations: { address: string; ip: string; country: string }[];
};
export type DnsDiagnostic = {
  status: "inspected" | "unknown"; checkedAt: string; servers: string[]; source: string;
  warnings: string[]; mihomo?: { dnsEnabled?: boolean; ipv6?: boolean; dnsIpv6?: boolean; tunEnabled?: boolean; hijack: string[]; strictRoute?: boolean; respectRules?: boolean };
};
type Aaaa = { addresses: string[]; source: string; reason?: string };
type Cached = { until: number; value?: Aaaa; pending?: Promise<Aaaa> };
const cache = new Map<string, Cached>();
const cooldowns = new Map<string, number>();
const files = new Map<string, { key: string; checkedAt: number; pending?: Promise<void> }>();
const command = promisify(execFile);
const unique = (list: string[]) => [...new Set(list)];
const canonicalIp = (ip: string) => isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;

/** Avoid external lookups for single-label and common local suffixes. Other names may be split DNS. */
export function publicName(host: string) {
  return !isIP(host) && host.includes(".") && !/(^|\.)(localhost|local|localdomain|lan|internal|intranet|corp|private|home|test|invalid|example|onion)\.?$/i.test(host) && !/\.home\.arpa\.?$/i.test(host);
}
function publicV6(ip: string) { return isIP(ip) === 6 && /^[23]/i.test(ip); }
function boundedSignal(parent: AbortSignal, ms: number) { return AbortSignal.any([parent, AbortSignal.timeout(ms)]); }

export async function resolveProbeIpv6(p: NetworkPolicy, signal: AbortSignal, network = ""): Promise<Aaaa> {
  const host = new URL(p.probe.url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { addresses: isIP(host) === 6 ? [host] : [], source: "literal", reason: "检测地址是 IPv4，没有 IPv6 要查" };
  const key = JSON.stringify([host, p.connection, p.ipv6.doh, network]);
  const previous = cache.get(key);
  if (previous?.pending) return previous.pending;
  if (previous?.value && previous.until > Date.now()) return previous.value;
  // Keep this process-wide cache bounded even when policies and network addresses change often.
  if (cache.size > 256) for (const [k, v] of cache) if (!v.pending) { cache.delete(k); if (cache.size <= 128) break; }
  const entry: Cached = { until: 0 };
  cache.set(key, entry);
  const work = async (): Promise<Aaaa> => {
    let ttl = 60, value: Aaaa = { addresses: [], source: "system", reason: "这个域名没有公网 IPv6 地址，只走 IPv4" };
    const resolver = new Resolver({ timeout: Math.min(1500, p.probe.timeoutMs), tries: 1 });
    const cancel = () => resolver.cancel();
    const localSignal = boundedSignal(signal, Math.min(1500, p.probe.timeoutMs));
    localSignal.addEventListener("abort", cancel, { once: true });
    try {
      if (localSignal.aborted) throw new Error("已中断");
      // Public targets behind an explicit proxy resolve over that proxy, rather than introducing
      // a direct local DNS query. Empty DoH explicitly selects system DNS only.
      if (p.connection.type === "proxy" && p.ipv6.doh.length && publicName(host)) throw new Error("使用代理内的 DoH");
      const records = await resolver.resolve6(host, { ttl: true });
      const usable = records.filter((r) => !publicName(host) || publicV6(r.address));
      if (usable.length) {
        ttl = Math.min(...usable.map((r) => r.ttl));
        value = { addresses: unique(usable.map((r) => r.address)), source: "system" };
      }
    } catch { /* Suppressed AAAA and unavailable system DNS can use the declared DoH alternatives. */ }
    finally { localSignal.removeEventListener("abort", cancel); resolver.cancel(); }
    if (!value.addresses.length && publicName(host)) for (const endpoint of p.ipv6.doh) {
      if (signal.aborted) break;
      if ((cooldowns.get(endpoint) ?? 0) > Date.now()) { value.reason = "备用解析服务限流了，稍后再查 IPv6"; continue; }
      try {
        const url = new URL(endpoint);
        url.searchParams.set("name", host); url.searchParams.set("type", "AAAA");
        const data = JSON.parse(await networkRequest(p.connection, url.href, boundedSignal(signal, p.probe.timeoutMs), { accept: "application/dns-json" }));
        if (data.Status !== 0 || data.TC === true) throw new Error("DNS 查询未成功或响应被截断");
        const records = (Array.isArray(data.Answer) ? data.Answer : []).filter((r: { type?: number; data?: string }) => r.type === 28 && typeof r.data === "string" && publicV6(r.data));
        // CNAME expiry also limits how long a final AAAA may be reused.
        ttl = records.length ? Math.min(...data.Answer.filter((r: { type?: number }) => r.type === 28 || r.type === 5).map((r: { TTL?: number }) => typeof r.TTL === "number" ? r.TTL : 60)) : 60;
        value = { addresses: unique(records.map((r: { data: string }) => r.data)), source: new URL(endpoint).host, ...(!records.length ? { reason: "这个域名没有公网 IPv6 地址，只走 IPv4" } : {}) };
        break;
      } catch (error) {
        if (error instanceof NetworkHttpError && error.status === 429) cooldowns.set(endpoint, Math.max(Date.now() + 60000, error.retryAt));
        value.reason = "这次没查到这个域名的 IPv6 地址（系统和备用解析都没回应），按 IPv4 判断";
      }
    }
    if (signal.aborted) return value;
    entry.value = value;
    // DNS expiry only bounds address reuse; it does not schedule extra network checks.
    entry.until = Date.now() + Math.min(Math.max(0, ttl), p.probe.maxAgeSeconds) * 1000;
    return value;
  };
  entry.pending = work();
  try { return await entry.pending; } finally { entry.pending = undefined; }
}

export async function inspectIpv6(p: NetworkPolicy, signal: AbortSignal, parseIdentity: (body: string) => { ip: string; country: string }, network: string): Promise<Ipv6Diagnostic> {
  const result: Ipv6Diagnostic = { status: "unknown", checkedAt: new Date().toISOString(), observations: [] };
  try {
    const resolved = await resolveProbeIpv6(p, signal, network);
    result.source = resolved.source;
    result.reason = resolved.reason;
    // Check all bounded candidates rather than inferring the route from an unrelated IP service.
    const responses = await Promise.allSettled(resolved.addresses.slice(0, 4).map(async (address) => ({ address, ...parseIdentity(await networkRequest(p.connection, p.probe.url, boundedSignal(signal, p.probe.timeoutMs), { address })) })));
    result.observations = responses.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
    if (result.observations.length) result.status = "observed";
    if (resolved.addresses.length && !result.observations.length) {
      result.reason = responses.every((r) => r.status === "rejected" && ["EACCES", "EPERM"].includes(r.reason?.code))
        ? "本机禁止了 IPv6 出站，请求都走 IPv4"
        : "有 IPv6 地址但连不上，这台机器多半没有 IPv6 出口，请求会走 IPv4";
    } else if (responses.some((r) => r.status === "rejected") || resolved.addresses.length > 4) result.reason = `查了 ${Math.min(4, resolved.addresses.length)} 个 IPv6 地址，${result.observations.length} 个连得上，按连得上的判断`;
  } catch { result.reason = "IPv6 这次没查成，按 IPv4 判断"; }
  return result;
}

/** Changes invalidate diagnostic results without spawning OS commands on the two-second local tick. */
export function dnsConfigurationKey(p: NetworkPolicy) {
  if (!p.dns.enabled) return "";
  let file = "";
  if (p.dns.mihomoConfig) {
    const path = p.dns.mihomoConfig;
    let item = files.get(path);
    if (!item) { item = { key: "pending", checkedAt: 0 }; files.set(path, item); }
    if (!item.pending && Date.now() - item.checkedAt >= 2000) {
      const current = item;
      // A slow filesystem (for example a disconnected mapped Windows drive) must never stall
      // TUN/port monitoring. Keep at most one outstanding stat per configured path.
      current.pending = stat(path).then((s) => { current.key = `${s.mtimeMs}:${s.size}`; }, () => { current.key = "unavailable"; }).finally(() => { current.checkedAt = Date.now(); current.pending = undefined; });
    }
    file = item.key;
    if (files.size > 256) for (const [key, value] of files) if (!value.pending && key !== path) { files.delete(key); if (files.size <= 128) break; }
  }
  return JSON.stringify([getServers(), file]);
}

async function boundedFile(path: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => { const info = await stat(path); if (info.size > 1024 * 1024) throw new Error("too large"); return readFile(path, { encoding: "utf8", signal: AbortSignal.timeout(1500) }); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("configuration read timed out")), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function inspectDns(p: NetworkPolicy): Promise<DnsDiagnostic> {
  const result: DnsDiagnostic = { status: "inspected", checkedAt: new Date().toISOString(), servers: getServers(), source: "Node 默认解析器", warnings: [] };
  try {
    let output: string;
    if (process.platform === "win32") output = (await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-DnsClientServerAddress | ForEach-Object { $_.ServerAddresses } | ConvertTo-Json -Compress"], { timeout: 1500, maxBuffer: 131072 })).stdout;
    else if (process.platform === "darwin") output = (await command("/usr/sbin/scutil", ["--dns"], { timeout: 1500, maxBuffer: 131072 })).stdout;
    else output = (await command("resolvectl", ["dns", "--no-pager"], { timeout: 1500, maxBuffer: 131072 })).stdout;
    const candidates = output.split(/[\s",\[\]]+/).map((s) => s.split("%")[0]).filter((s) => isIP(s));
    if (candidates.length) { result.servers = unique(candidates); result.source = "操作系统各接口 DNS 配置"; }
  } catch { result.warnings.push("读不到各网卡的 DNS 设置，下面是 Node 自己用的解析器"); }
  if (p.dns.expectedServers.length) {
    const expected = p.dns.expectedServers.map(canonicalIp);
    if (result.servers.some((s) => !expected.includes(canonicalIp(s)))) result.warnings.push(`有不在预期列表里的 DNS 服务器：${result.servers.filter((s) => !expected.includes(canonicalIp(s))).join("、")}`);
    if (!result.servers.length) result.warnings.push("读不到 DNS 服务器，没法和预期列表对照");
  }
  if (p.dns.mihomoConfig) try {
    const config = parse(await boundedFile(p.dns.mihomoConfig), { maxAliasCount: 0 });
    if (!config || typeof config !== "object" || !config.dns || typeof config.dns !== "object") throw new Error("no DNS config");
    const bool = (value: unknown) => typeof value === "boolean" ? value : undefined;
    result.mihomo = { dnsEnabled: bool(config.dns.enable), ipv6: bool(config.ipv6), dnsIpv6: bool(config.dns.ipv6), tunEnabled: bool(config.tun?.enable), hijack: Array.isArray(config.tun?.["dns-hijack"]) ? config.tun["dns-hijack"].filter((v: unknown) => typeof v === "string").slice(0, 20) : [], strictRoute: bool(config.tun?.["strict-route"]), respectRules: bool(config.dns["respect-rules"]) };
    const m = result.mihomo;
    if (m.dnsEnabled !== true) result.warnings.push("Mihomo 没开内置 DNS（dns.enable）");
    if (m.tunEnabled && !m.hijack.some((s) => /^(any:53|\*:53|udp:\/\/(any|\*):53)$/.test(s))) result.warnings.push("TUN 没接管 UDP 53：dns-hijack 里加 any:53");
    if (m.tunEnabled && !m.hijack.some((s) => /^tcp:\/\/(any|\*):53$/.test(s))) result.warnings.push("TUN 没接管 TCP 53：dns-hijack 里加 tcp://any:53");
    if (m.tunEnabled && m.strictRoute !== true) result.warnings.push("TUN 没开 strict-route，DNS 请求可能绕过 TUN 直接出去");
  } catch { result.status = "unknown"; result.warnings.push("读不了这份 Mihomo 配置：路径要指向正在用的生成配置"); }
  return result;
}
