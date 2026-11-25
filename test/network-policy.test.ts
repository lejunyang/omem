import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { networkPolicySchema, agentProfileSchema, configSchema } from "../src/core/config.ts";
import { beginNetworkAttempt, networkPoliciesView, networkProfile, networkReason, pollNetworkPolicies, refreshForRun, refreshNetworkPolicies, stopNetworkPolicies, withNetworkPolicy } from "../src/agents/network-policy.ts";
import { candidateProfiles } from "../src/agents/choose-ai.ts";
import { runRole } from "../src/agents/runner.ts";
import { createRun, addRunEvent, flushRunText, type RunContext } from "../src/agents/runs.ts";
import { all } from "../src/core/db.ts";
import { threadTurn, releaseAll } from "../src/agents/sessions.ts";
import { createThread, addMessage, threadMessages, getThread } from "../src/agents/threads.ts";
import { recoverSessionCleanup, sessionCleanup } from "../src/agents/session-cleanup.ts";
import { startServer } from "../src/server/http.ts";
import { createUser, createApiToken, setUserRole } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

let tunUp = true;
let dockerUp = false;
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, networkInterfaces: () => {
    const all = actual.networkInterfaces();
    return { ...all, ...(dockerUp ? { docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4", mac: "02:42:00:00:00:01", internal: false, cidr: "172.17.0.1/16" }] } : {}), ...(tunUp ? { "omem-test-tun": Object.values(all).flat().filter((a) => a?.family === "IPv4").slice(0, 1).map((a) => ({ ...a!, internal: false })) } : {}) };
  } };
});
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => { releaseAll(); for (const f of cleanups.splice(0).reverse()) await f(); tunUp = true; dockerUp = false; vi.restoreAllMocks(); });
async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture() {
  let body = "ip=203.0.113.10\nloc=JP\n", hits = 0;
  const url = await listen(createServer((_req, res) => { hits++; res.end(body); }));
  const app = testApp();
  cleanups.push(() => {
    stopNetworkPolicies(app);
    // These tests drive live ACP text streams without the job scheduler's final flush.
    for (const { id } of all<{ id: string }>(app.db, "select id from runs")) flushRunText(app, id);
    app.db.close();
  });
  const first = agentProfileSchema.parse({ id: "guarded", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_DELAY: "10000" } });
  const spare = agentProfileSchema.parse({ id: "spare", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_PROMPT_LOG: join(app.home, "spare-prompts.jsonl") } });
  app.config.agents.profiles = [first, spare]; app.config.agents.default = first.id;
  app.config.agents.fallback = [{ profile: spare.id }]; app.baseUrl = "http://127.0.0.1:1";
  const policy = networkPolicySchema.parse({ id: "test-network", name: "测试出口", backends: [first.id], connection: { type: "system" }, watch: { interface: "omem-test-tun" }, probe: { url }, require: { countries: ["JP"], ips: ["203.0.113.10"] } });
  app.config.agents.networkPolicies = [policy];
  return { app, first, spare, policy, hits: () => hits, body: (s: string) => { body = s; } };
}

it("shares concurrent probes, caches success for an hour, and refreshes after expiry", async () => {
  const { app, policy, hits } = await fixture();
  expect(policy.probe.maxAgeSeconds).toBe(3600);
  await Promise.all(Array.from({ length: 8 }, () => refreshNetworkPolicies(app)));
  expect(hits()).toBe(1);
  const before = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(before + 3599_000);
  await refreshNetworkPolicies(app); expect(hits()).toBe(1);
  vi.mocked(Date.now).mockReturnValue(before + 3601_000);
  await refreshNetworkPolicies(app); expect(hits()).toBe(2);
});

it("runs resumed together after a start all wait for the first probe, not only the one that started it", async () => {
  const { app, first, policy } = await fixture();
  let hits = 0;
  const slow = await listen(createServer((_req, res) => { hits++; setTimeout(() => res.end("ip=203.0.113.10\nloc=JP\n"), 300); }));
  app.config.agents.networkPolicies = [{ ...policy, probe: { ...policy.probe, url: slow } }];
  const one = refreshForRun(app, 50);
  // The second run arrives while the first probe is in flight.
  await new Promise((r) => setTimeout(r, 20));
  const two = refreshForRun(app, 50);
  await two;
  expect(networkReason(app, first)).toBeNull();
  await one;
  expect(hits).toBe(1);
  // Later checks keep the short wait: an expired result does not hold a run for the first-check allowance.
  expect(networkPoliciesView(app)[0].status).toBe("ready");
});

it("filters automatic candidates and never lets a named backend bypass country or IP requirements", async () => {
  const { app, policy, body } = await fixture();
  body("ip=203.0.113.11\nloc=US\n");
  app.config.agents.routing.candidates = [{ profile: "guarded", when: "处理材料" }];
  await refreshNetworkPolicies(app);
  expect(candidateProfiles(app)).toEqual([]);
  await expect(beginNetworkAttempt(app, app.config.agents.profiles[0])).rejects.toThrow("当前地区 US");
  const r = await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结材料", execution: { profile: "guarded", source: "user", reason: "本轮指定" } });
  expect(r.profileId).toBe("spare");
  app.config.agents.routing.pinnedFallback = "never";
  await expect(runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结材料", execution: { profile: "guarded", source: "user", reason: "本轮指定" } })).rejects.toThrow("当前地区 US");
  policy.require.countries = [];
  await refreshNetworkPolicies(app, policy.id, true);
  expect(networkReason(app, app.config.agents.profiles[0])).toContain("不在允许的 IP");
  body("ip=203.0.113.10\nloc=JP\n");
  await refreshNetworkPolicies(app, policy.id, true);
  expect(networkPoliciesView(app)[0].status).toBe("recovering");
  await refreshNetworkPolicies(app, policy.id, true);
  expect(networkReason(app, app.config.agents.profiles[0])).toBeNull();
});

it("invalidates a live successful cache on TUN loss and requires two recovery confirmations", async () => {
  const { app, first, policy, hits } = await fixture();
  await refreshNetworkPolicies(app);
  const attempt = await beginNetworkAttempt(app, first);
  tunUp = false;
  await pollNetworkPolicies(app);
  expect(attempt.signal.aborted).toBe(true);
  expect(attempt.signal.reason.name).toBe("NetworkUnavailableError");
  expect(networkReason(app, first)).toMatch(/接口/);
  expect(hits()).toBe(1);
  attempt.close();
  tunUp = true;
  await pollNetworkPolicies(app);
  await refreshNetworkPolicies(app, policy.id);
  expect(networkPoliciesView(app)[0].status).toBe("recovering");
  await refreshNetworkPolicies(app, policy.id, true);
  expect(networkReason(app, first)).toBeNull();
});

it("discards an in-flight old success after policy edits or TUN loss", async () => {
  let finish: (() => void) | undefined;
  const url = await listen(createServer((_req, res) => { finish = () => res.end("ip=203.0.113.10\nloc=JP\n"); }));
  const { app, policy, first } = await fixture(); policy.probe.url = url;
  const pending = refreshNetworkPolicies(app);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  tunUp = false; await pollNetworkPolicies(app); finish!(); await pending;
  expect(networkReason(app, first)).toMatch(/接口/);
  expect(networkPoliciesView(app)[0].status).toBe("unavailable");
});

it("keeps monitoring TUN while a periodic remote probe is stuck", async () => {
  const { app, policy, first } = await fixture(); let hits = 0;
  const server = createServer((_req, res) => { if (++hits === 1) res.end("ip=203.0.113.10\nloc=JP\n"); });
  policy.probe.url = await listen(server); policy.probe.timeoutMs = 30000;
  const attempt = await beginNetworkAttempt(app, first);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601_000);
  const tick = pollNetworkPolicies(app);
  await vi.waitFor(() => expect(hits).toBe(2));
  tunUp = false; await pollNetworkPolicies(app);
  expect(attempt.signal.aborted).toBe(true);
  attempt.close(); await tick;
});

it("keeps running work through a container interface appearing and an edit of the policy", async () => {
  const { app, policy, first } = await fixture();
  await refreshNetworkPolicies(app);
  const attempt = await beginNetworkAttempt(app, first);
  // Not the watched interface: nothing to stop for.
  dockerUp = true;
  await pollNetworkPolicies(app);
  expect(attempt.signal.aborted).toBe(false);
  // Renamed in the form: checked again, the attempt carries on.
  app.config.agents.networkPolicies = [{ ...policy, name: "改了名字" }];
  await pollNetworkPolicies(app);
  await refreshNetworkPolicies(app);
  expect(attempt.signal.aborted).toBe(false);
  expect(networkReason(app, first)).toBeNull();
  attempt.close();
});

it("uses the configured proxy and fails closed when its port disappears", async () => {
  const { app, policy, first } = await fixture();
  const paths: string[] = [];
  const proxy = createServer((req, res) => { paths.push(req.url!); res.end("ip=203.0.113.10\nloc=JP\n"); });
  policy.connection = { type: "proxy", url: await listen(proxy) };
  policy.probe.url = "http://egress.example.test/identity";
  await refreshNetworkPolicies(app);
  expect(paths).toEqual([policy.probe.url]);
  expect(networkProfile(app, first).env.https_proxy).toBe(policy.connection.url);
  const attempt = await beginNetworkAttempt(app, first);
  proxy.closeAllConnections(); await new Promise<void>((r) => proxy.close(() => r()));
  await pollNetworkPolicies(app);
  expect(attempt.signal.aborted).toBe(true); attempt.close();
  expect(networkReason(app, first)).toMatch(/代理端口/);
});

it("uses HTTPS CONNECT without bypassing a rejecting proxy", async () => {
  const { app, policy, first } = await fixture();
  const proxy = createServer(); let authority = "";
  proxy.on("connect", (req, socket) => { authority = req.url!; socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n"); });
  policy.connection = { type: "proxy", url: await listen(proxy) };
  policy.probe.url = "https://egress.example.test/trace";
  await refreshNetworkPolicies(app);
  expect(authority).toBe("egress.example.test:443");
  expect(networkReason(app, first)).toContain("代理连接失败：HTTP 403");
});

it("supports JSON fields, rejects malformed identity, and normalizes IPv6 allowlists", async () => {
  const { app, policy, first, body } = await fixture();
  policy.probe.format = "json"; policy.probe.countryField = "location.code";
  policy.require.ips = ["2001:db8:0:0:0:0:0:1"];
  body(JSON.stringify({ ip: "2001:db8::1", location: { code: "jp" } }));
  await refreshNetworkPolicies(app); expect(networkReason(app, first)).toBeNull();
  body("<html>not an identity</html>");
  await refreshNetworkPolicies(app, policy.id, true);
  expect(networkReason(app, first)).not.toBeNull();
});

it("checks the same IPv6 target through the declared proxy and stops on a confirmed country mismatch", async () => {
  const { app, policy, first } = await fixture();
  const paths: string[] = [], hosts: string[] = [];
  let country = "JP";
  const proxy = createServer((req, res) => {
    paths.push(req.url!); hosts.push(req.headers.host!);
    res.end(req.url!.includes("[2001:db8::10]") ? `ip=2001:db8::20\nloc=${country}\n` : "ip=203.0.113.10\nloc=JP\n");
  });
  policy.connection = { type: "proxy", url: await listen(proxy) };
  policy.probe.url = "http://egress.example.test/trace"; policy.require.ips = []; policy.ipv6.enabled = true;
  const lookup = vi.spyOn(Resolver.prototype, "resolve6").mockResolvedValue([{ address: "2001:db8::10", ttl: 300 }] as never);
  const attempt = await beginNetworkAttempt(app, first);
  expect(networkPoliciesView(app)[0].ipv6?.observations[0].ip).toBe("2001:db8::20");
  country = "CN";
  await refreshNetworkPolicies(app, policy.id, true);
  expect(paths).toEqual([policy.probe.url, "http://[2001:db8::10]/trace", policy.probe.url, "http://[2001:db8::10]/trace"]);
  expect(hosts).toEqual(Array(4).fill("egress.example.test"));
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(attempt.signal.aborted).toBe(true); attempt.close();
  expect(networkReason(app, first)).toContain("IPv6 目标路径出口");
  expect(networkReason(app, first)).toContain("CN");
});

it.each(["no-aaaa", "unreachable", "unknown-country"])("allows a verified default exit when IPv6 is uncertain (%s)", async (mode) => {
  const { app, policy, first } = await fixture();
  policy.connection = { type: "proxy", url: await listen(createServer((req, res) => {
    if (req.url!.includes("[2001:db8::10]")) {
      if (mode === "unreachable") req.socket.destroy();
      else res.end("ip=2001:db8::20\n");
    } else res.end("ip=203.0.113.10\nloc=JP\n");
  })) };
  policy.probe.url = `http://${mode}.example.test/trace`; policy.require.ips = []; policy.ipv6.enabled = true;
  vi.spyOn(Resolver.prototype, "resolve6").mockResolvedValue((mode === "no-aaaa" ? [] : [{ address: "2001:db8::10", ttl: 0 }]) as never);
  const attempt = await beginNetworkAttempt(app, first);
  expect(networkReason(app, first)).toBeNull();
  expect(attempt.signal.aborted).toBe(false); attempt.close();
  expect(networkPoliciesView(app)[0].ipv6?.status).toBe(mode === "unknown-country" ? "observed" : "unknown");
});

it("reports DNS config risks without gating execution and invalidates its cached check after file changes", async () => {
  const { app, policy, first, hits } = await fixture();
  const config = join(app.home, "mihomo.yaml");
  writeFileSync(config, "ipv6: false\ndns:\n  enable: true\n  ipv6: false\ntun:\n  enable: true\n  strict-route: false\n  dns-hijack: [any:53]\n");
  policy.dns = { enabled: true, expectedServers: ["192.0.2.53"], mihomoConfig: config };
  const attempt = await beginNetworkAttempt(app, first);
  let view = networkPoliciesView(app)[0];
  expect(view.status).toBe("ready");
  expect(view.dns?.warnings.join(" ")).toMatch(/TCP 53/);
  expect(view.dns?.warnings.join(" ")).toMatch(/strict-route/);
  expect(view.dns?.mihomo?.dnsIpv6).toBe(false);
  expect(hits()).toBe(1);
  writeFileSync(config, "dns: { enable: true }\ntun: { enable: false }\n");
  await vi.waitFor(async () => {
    await pollNetworkPolicies(app); await refreshNetworkPolicies(app);
    expect(networkPoliciesView(app)[0].dns?.mihomo?.tunEnabled).toBe(false);
  }, { timeout: 5000, interval: 250 });
  view = networkPoliciesView(app)[0];
  expect(view.dns?.mihomo?.tunEnabled).toBe(false);
  expect(hits()).toBe(2);
  expect(attempt.signal.aborted).toBe(false); attempt.close();
});

it("restrict-new leaves current work alone; user cancellation stays cancellation", async () => {
  const { app, policy, first } = await fixture(); policy.onFailure = "restrict-new";
  const attempt = await beginNetworkAttempt(app, first);
  tunUp = false; await pollNetworkPolicies(app);
  expect(attempt.signal.aborted).toBe(false);
  await expect(beginNetworkAttempt(app, first)).rejects.toThrow("网络条件不满足");
  attempt.close(); tunUp = true; await pollNetworkPolicies(app); await refreshNetworkPolicies(app, policy.id); await refreshNetworkPolicies(app, policy.id, true);
  const controller = new AbortController();
  await expect(withNetworkPolicy(app, first, { signal: controller.signal }, async (_p, signal) => {
    controller.abort(); throw signal.reason;
  })).rejects.toThrow("CANCELLED");
});

it.each([false, true])("stops an ACP role attempt (pooled=%s) and hands completed writes to the next backend", async (reuseSession) => {
  const { app, spare } = await fixture();
  const run = createRun(app, { kind: "ingest", spaceId: "personal", title: "网络中断接手" });
  let connected!: () => void;
  const ready = new Promise<void>((r) => { connected = r; });
  const task = runRole(app, { role: "summarizer", spaceId: "personal", runId: run.id, reuseSession, task: "总结材料", onEvent: (e) => {
    if (e.type === "status" && e.text.includes("已连接")) connected();
  } });
  await ready;
  addRunEvent(app, run.id, "tool-write", { name: "save_note", args: { text: "已经保存的结论" } });
  tunUp = false; await pollNetworkPolicies(app);
  const r = await task;
  expect(r.profileId).toBe("spare");
  expect(readFileSync(spare.env.FAKE_PROMPT_LOG, "utf8")).toContain("已经保存的结论");
  expect(networkPoliciesView(app)[0].runs).toEqual([]);
}, 30000);

it("switches a live conversation turn after TUN loss and keeps the replacement for the next turn", async () => {
  const { app } = await fixture();
  const t = createThread(app, { channel: "web", spaceId: "personal" });
  addMessage(app, t.id, "user", "继续处理材料");
  const run = createRun(app, { kind: "ask", spaceId: "personal", title: "网络中断对话", input: { conversationId: t.id } });
  let connected!: () => void;
  const ready = new Promise<void>((r) => { connected = r; });
  const ctx: RunContext = { app, run, signal: new AbortController().signal, event: (type, data) => { addRunEvent(app, run.id, type, data); if (type === "status" && (data as { text: string }).text?.includes("已连接")) connected(); }, output: () => {} };
  const turn = threadTurn(ctx, t.id, threadMessages(app, t.id));
  await ready; tunUp = false; await pollNetworkPolicies(app);
  expect((await turn).profileId).toBe("spare");
  expect(getThread(app, t.id).settings.auto?.profile).toBe("spare");
}, 30000);

it("defers session cleanup offline and preserves backend identity across derived proxy variables", async () => {
  const { app, first, policy } = await fixture();
  first.env.FAKE_DELETE_LOG = join(app.home, "network-cleanup.txt");
  await refreshNetworkPolicies(app);
  const cleanup = await sessionCleanup(app, networkProfile(app, first), { cwd: app.home }, () => {});
  cleanup.created("network-session");
  app.db.prepare("update session_cleanup set ready=1, retry_at='' where session_id=?").run("network-session");
  tunUp = false; await pollNetworkPolicies(app);
  await recoverSessionCleanup(app, () => {});
  expect(existsSync(first.env.FAKE_DELETE_LOG)).toBe(false);
  expect(app.db.prepare("select attempts from session_cleanup where session_id=?").get("network-session")).toMatchObject({ attempts: 0 });
  tunUp = true; await pollNetworkPolicies(app); await refreshNetworkPolicies(app, policy.id); await refreshNetworkPolicies(app, policy.id, true);
  app.db.prepare("update session_cleanup set retry_at='' where session_id=?").run("network-session");
  await recoverSessionCleanup(app, () => {});
  expect(readFileSync(first.env.FAKE_DELETE_LOG, "utf8")).toContain("network-session");
  expect(app.db.prepare("select session_id from session_cleanup where session_id=?").get("network-session")).toBeUndefined();
});

it("validates and persists conditions via owner settings and reports local interfaces", async () => {
  const { app, policy } = await fixture();
  const server = await startServer(app, { port: 0, quiet: true }); cleanups.push(() => server.close());
  createUser(app, { id: "member", name: "示例成员" });
  const headers = { authorization: `Bearer ${createApiToken(app, "member", "network-test")}` };
  for (const admin of [false, true]) {
    if (admin) setUserRole(app, "member", "admin");
    for (const [method, url] of [["GET", "/api/agents/network-policies"], ["PUT", "/api/agents/network-policies"], ["POST", `/api/agents/network-policies/${policy.id}/check`]] as const) {
      expect((await server.inject({ method, url, headers, ...(method === "PUT" ? { payload: { policies: [] } } : method === "POST" ? { payload: {} } : {}) })).statusCode).toBe(403);
    }
  }
  const changed = await server.inject({ method: "PUT", url: "/api/settings", payload: { agents: { ...app.config.agents, networkPolicies: [] } } });
  expect(changed.statusCode).toBe(200);
  expect(app.config.agents.networkPolicies).toHaveLength(1);
  const read = await server.inject({ method: "GET", url: "/api/agents/network-policies" });
  expect(read.json().interfaces.some((i: { name: string }) => i.name === "omem-test-tun")).toBe(true);
  const invalid = await server.inject({ method: "PUT", url: "/api/agents/network-policies", payload: { policies: [{ ...policy, probe: { ...policy.probe, url: "file:///private" } }] } });
  expect(invalid.statusCode).toBe(400);
  expect(configSchema.safeParse({ agents: { networkPolicies: [policy, { ...policy, id: "other" }] } }).success).toBe(false);
  expect((await server.inject({ method: "PUT", url: "/api/agents/network-policies", payload: { policies: [policy, { ...policy, id: "other" }] } })).statusCode).toBe(400);
  const saved = await server.inject({ method: "PUT", url: "/api/agents/network-policies", payload: { policies: [policy] } });
  expect(saved.statusCode).toBe(200);
  const checked = await server.inject({ method: "POST", url: `/api/agents/network-policies/${policy.id}/check`, payload: {} });
  expect(checked.json().states[0].status).toBe("ready");
  expect(JSON.parse(readFileSync(join(app.home, "config.json"), "utf8")).agents.networkPolicies[0].probe.maxAgeSeconds).toBe(3600);
});
