import { commandExists } from "./spawn.ts";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { accountOf, egressRequested, egressSupport, type SandboxAccount } from "./sandbox.ts";
import { addRunEvent } from "./runs.ts";
import { onToolTokenRevoked, toolContextForToken, type ToolContext } from "./tools.ts";
import type { McpAccess } from "./types.ts";
import { networkEnvironment } from "./network-policy.ts";
import { backendHosts, egressPolicy } from "./egress-policy.ts";
import { startProxy, type HostUsage } from "./egress-proxy.ts";

type Live = { runId: string | null; hosts: () => HostUsage[] };
const active = new Map<App, Set<Live>>();

function mergedHosts(groups: HostUsage[][]) {
  const rows = new Map<string, HostUsage>();
  for (const host of groups.flat()) {
    const current = rows.get(host.host);
    if (!current) {
      if (rows.size < 256) rows.set(host.host, { ...host });
      continue;
    }
    current.count += host.count;
    current.bytes += host.bytes;
    current.denied += host.denied;
    current.backend ||= host.backend;
    if (host.lastDeniedAt) current.lastDeniedAt = Math.max(current.lastDeniedAt ?? 0, host.lastDeniedAt);
    if (host.error) current.error = host.error;
  }
  return [...rows.values()];
}

function summarize(app: App, runId: string, hosts: HostUsage[]) {
  const previous = one<{ data: string; seq: number }>(app.db,
    "select e.seq,e.data from egress_runs r join run_events e using(run_id,seq) where r.run_id=?", runId);
  const summary = mergedHosts([previous ? JSON.parse(previous.data).hosts : [], hosts]);
  const text = summary.map(h => h.host + " × " + h.count + (h.denied ? "（拒绝 " + h.denied + "）" : "")).join("、");
  const data = { kind: "egress", text: "出网主机：" + (text || "无"), hosts: summary };
  const at = new Date().toISOString();
  withinTx(app.db, () => {
    if (previous) {
      run(app.db, "update run_events set data=?,at=? where run_id=? and seq=?", JSON.stringify(data), at, runId, previous.seq);
      run(app.db, "update egress_runs set updated_at=? where run_id=?", at, runId);
    } else {
      const seq = addRunEvent(app, runId, "status", data)!;
      run(app.db, "insert into egress_runs(run_id,seq,updated_at) values(?,?,?)", runId, seq, at);
    }
  });
}

export async function launchRun<T extends Pick<ChildProcess, "once">>(profile: AgentProfile,
  req: { app?: App; context?: ToolContext; mcp?: McpAccess; runId?: string | null; signal?: AbortSignal }, start: (account?: SandboxAccount) => T) {
  const account = accountOf(profile);
  const app = req.app;
  if (!app || !account || !egressRequested(app.config, profile)) return start(account);
  const support = egressSupport();
  if (!support.ok) {
    const reason = "出网隔离不可用：" + support.reason;
    if (app.config.agents.accountIsolation === "require") throw new Error(reason);
    if (req.runId) addRunEvent(app, req.runId, "status", { text: reason });
    return start(account);
  }
  const ctx = req.mcp ? toolContextForToken(app, req.mcp.token) : req.context ?? { app, userId: account.userId, spaceId: "", spaces: [], tools: new Set<string>(), actor: "agent" as const, runId: req.runId ?? null, agentProfile: profile.id };
  if (!ctx) throw new Error("本次运行的工具令牌已失效");
  const { inspect } = app.config.security.egress;
  const dir = await mkdtemp("/tmp/omem-net-");
  const socket = join(dir, "proxy");
  let close: (() => void) | undefined;
  try {
    const tls = inspect.length ? await (await import("./egress-ca.ts")).inspection(app.home, dir, inspect) : undefined;
    const lifetime = new AbortController();
    const policy = egressPolicy(ctx, backendHosts(profile), lifetime.signal);
    const callback = req.mcp && { target: app.baseUrl ?? req.mcp.baseUrl, origin: new URL(req.mcp.baseUrl).origin, token: req.mcp.token };
    if (callback && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(callback.origin)) throw new Error("出网隔离需要本机 HTTP 工具入口");
    const envProxy = { ...profile.env, ...networkEnvironment(app, profile) };
    function upstreamProxy(protocol: string) {
      const key = protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY";
      const value = envProxy[key.toLowerCase()] ?? envProxy[key] ?? envProxy.all_proxy ?? envProxy.ALL_PROXY;
      if (!value) return undefined;
      const proxy = new URL(value);
      if (!/^https?:$/.test(proxy.protocol)) throw new Error("上游代理需要 HTTP(S) CONNECT");
      return proxy;
    }
    const proxy = await startProxy(socket, { ...policy, callback, upstreamProxy, inspect: tls?.inspect });
    const item: Live = { runId: ctx.runId, hosts: () => [...proxy.usage.values()] };
    const live = active.get(app) ?? new Set<Live>();
    active.set(app, live); live.add(item);
    let unsubscribe: (() => void) | undefined;
    close = () => {
      if (!live.delete(item)) return;
      unsubscribe?.();
      req.signal?.removeEventListener("abort", close!);
      lifetime.abort();
      proxy.close();
      void rm(dir, { recursive: true, force: true }).catch(() => { });
      if (ctx.runId) try { summarize(app, ctx.runId, item.hosts()); }
        catch (err) { console.warn("出网汇总写入失败", err); }
    };
    if (req.mcp) {
      if (!toolContextForToken(app, req.mcp.token)) throw new Error("运行令牌已撤销");
      unsubscribe = onToolTokenRevoked(req.mcp.token, close);
    }
    req.signal?.throwIfAborted();
    req.signal?.addEventListener("abort", close, { once: true });
    const env = { ...account.env };
    if (tls) for (const key of ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"]) env[key] = "/tmp/omem-ca.pem";
    const child = start({ ...account, env, network: { socket, secrets: join(app.home, "secrets"), bundle: tls?.bundle, callbackPort: callback ? Number(new URL(callback.origin).port || 80) : undefined } });
    child.once("close", close);
    child.once("error", close);
    return child;
  } catch (e) { if (close) close(); else await rm(dir, { recursive: true, force: true }); throw e; }
}

export function egressStatus(app: App) {
  const live = [...(active.get(app) ?? [])].slice(-32);
  const recent = all<{ run_id: string; data: string; at: string }>(app.db,
    "select r.run_id,e.data,r.updated_at as at from egress_runs r join run_events e using(run_id,seq) order by r.updated_at desc limit 32").map(r => ({ runId: r.run_id, at: r.at, hosts: JSON.parse(r.data).hosts as HostUsage[] }));
  const groups = new Map<string | null, HostUsage[][]>();
  for (const item of [...live].reverse().map(l => ({ runId: l.runId, hosts: l.hosts() })).concat(recent)) {
    const hosts = groups.get(item.runId) ?? [];
    hosts.push(item.hosts);
    groups.set(item.runId, hosts);
  }
  const pending = all<{ askId: string; runId: string | null; target: string; at: string }>(app.db, `select id as askId, run_id as runId,
      json_extract(context,'$.command') as target,created_at as at from asks indexed by asks_egress_pending where status='pending'
      and json_type(context,'$.egressFallback') is not null order by created_at desc limit 64`);
  const ids = [...groups.keys(), ...pending.map(p => p.runId)];
  const titles = new Map(all<{ id: string; title: string }>(app.db,
    "select id,title from runs where id in (select value from json_each(?))", JSON.stringify(ids)).map(r => [r.id, r.title]));
  const runs = [...groups].slice(0, 32).map(([runId, hosts]) => ({ runId, title: titles.get(runId ?? "") ?? null, hosts: mergedHosts(hosts) }));
  return {
    ...app.config.security.egress, support: egressSupport(), peer: "代跑的运行不经这台的代理",
    inspectionAvailable: app.config.security.egress.inspect.length ? commandExists("openssl") : null,
    rootGenerated: existsSync(join(app.home, "secrets", "egress-ca", "root.pem")), runs,
    denied: runs.flatMap(r => r.hosts.filter(h => h.denied).map(h => ({ runId: r.runId, title: r.title, host: h.host, count: h.denied, at: h.lastDeniedAt ?? 0, reason: h.error }))).sort((a, b) => b.at - a.at).slice(0, 64),
    pending: pending.map(p => ({ ...p, title: titles.get(p.runId ?? "") ?? null })),
  };
}
