import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { detachHostsForShutdown, setHostGraceForTests, sweepAgentHosts, type HostRow } from "../src/agents/hosted.ts";
import { runRole } from "../src/agents/runner.ts";
import { addRunEvent, createRun, markRestarted } from "../src/agents/runs.ts";
import { forgetToolTokensForTests } from "../src/agents/tools.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import type { App } from "../src/core/app.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/*
 * A turn that lives on through a restart of omem (src/agents/hosted.ts, agent-host.ts). Two App
 * instances on one data directory stand for the omem before and after the restart: the first one's
 * hosts are handed over (detachHostsForShutdown), its server stops and its tool tokens are forgotten,
 * as when the process goes away; the second one re-runs the turn the way a restarted run's handler does.
 */

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  setHostGraceForTests(null);
  for (const f of cleanups.splice(0).reverse()) await f();
});

const alive = (pid: number | null | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until<T>(what: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = what();
    if (v) return v;
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function omem(home: string, env: Record<string, string>) {
  const app = testApp(home);
  app.config.agents.default = "fake";
  app.config.agents.restartHold = { enabled: true, minutes: 5 };
  // Long idle limit: the first omem's turn is left hanging on purpose and must not stop the agent on its own.
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env, idleTimeoutMs: 600_000 })];
  return app;
}

/** The first omem starts a hosted turn; returns once its host has the turn, with what it reported. */
async function startTurn(env: Record<string, string>, opts: { persist?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "omem-host-"));
  const app = omem(home, env);
  const server = await startServer(app, { port: 0, quiet: true });
  const port = Number(new URL(app.baseUrl).port);
  const r = createRun(app, { kind: "code", spaceId: "personal", title: "跨过重启的一轮" });
  run(app.db, "update runs set status = 'running', started_at = ? where id = ?", new Date().toISOString(), r.id);
  const seen: AgentEvent[] = [];
  void runRole(app, { role: "coder", spaceId: "personal", task: "改退款按钮", runId: r.id, onEvent: (e) => { seen.push(e); if (opts.persist) addRunEvent(app, r.id, e.type, e); } }).catch(() => {});
  const row = await until(() => one<HostRow>(app.db, "select * from agent_hosts where run_id = ?", r.id));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    detachHostsForShutdown();
    await server.close();
    forgetToolTokensForTests();
  };
  cleanups.push(async () => { await stop(); app.db.close(); });
  return { home, app, port, runId: r.id, row, seen, stop };
}

async function comeBack(home: string, port: number | undefined, env: Record<string, string>) {
  const app = omem(home, env);
  if (port !== undefined) {
    const server = await startServer(app, { port, quiet: true });
    cleanups.push(() => server.close());
  }
  cleanups.push(() => app.db.close());
  markRestarted(app);
  return app;
}

const reply = (text: string | undefined) => JSON.parse(String(text).replace(/^第二段：/, "")) as { pid: number; prompts: number; toolError: boolean; search: string; permission: string; url: string };

it("finishes a turn started before a restart under the next omem: same agent process, no new prompt, a tool call made in the gap succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-gap-"));
  const env = { FAKE_MODE: "gap", FAKE_GAP_FILE: join(dir, "go"), FAKE_PROMPT_LOG: join(dir, "prompts.log") };
  const first = await startTurn(env);
  await until(() => first.seen.some((e) => e.type === "text" && e.text.includes("第一段")));
  await first.stop();
  // The agent goes on while no omem is there: its search waits in the host for the next one.
  writeFileSync(env.FAKE_GAP_FILE, "go");
  await new Promise((r) => setTimeout(r, 800));

  const app = await comeBack(first.home, first.port, env);
  const seen: AgentEvent[] = [];
  const result = await runRole(app, { role: "coder", spaceId: "personal", task: "改退款按钮", runId: first.runId, onEvent: (e) => seen.push(e) });
  const out = reply(result.reply);
  expect(out.pid).toBe(first.row.agent_pid);
  expect(out.prompts).toBe(1);
  expect(readFileSync(env.FAKE_PROMPT_LOG, "utf8").trim().split("\n")).toHaveLength(1);
  // The token the agent was started with works under the second omem, through the host's proxy.
  expect(out.toolError).toBe(false);
  expect(out.url).not.toContain(`:${first.port}`);
  // The reply is the whole turn's; what the first omem had already reported is not reported again.
  expect(result.text).toContain("第一段");
  expect(seen.some((e) => e.type === "text" && e.text.includes("第一段"))).toBe(false);
  expect(seen.some((e) => e.type === "text" && e.text.includes("第二段"))).toBe(true);
  expect(seen.some((e) => e.type === "status" && e.text.includes("接回重启前仍在运行"))).toBe(true);
  // Done: the host and its agent go, and so does their row.
  await until(() => !alive(first.row.host_pid) && !alive(first.row.agent_pid));
  expect(all(app.db, "select id from agent_hosts")).toEqual([]);
});

it("holds a permission the agent asks for while omem is away and gives it to the next one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-gap-"));
  const env = { FAKE_MODE: "gap", FAKE_GAP_FILE: join(dir, "go"), FAKE_GAP_ASK: "1" };
  const first = await startTurn(env);
  await until(() => first.seen.some((e) => e.type === "text" && e.text.includes("第一段")));
  await first.stop();
  writeFileSync(env.FAKE_GAP_FILE, "go");
  await new Promise((r) => setTimeout(r, 500));
  const app = await comeBack(first.home, first.port, env);
  const out = reply((await runRole(app, { role: "coder", spaceId: "personal", task: "改退款按钮", runId: first.runId })).reply);
  expect(out).toMatchObject({ pid: first.row.agent_pid, permission: "yes", toolError: false });
});

it("keeps the result of a turn that finished while omem was away for the next one", async () => {
  const first = await startTurn({ FAKE_MODE: "thread", FAKE_DELAY: "1200" });
  await first.stop();
  await new Promise((r) => setTimeout(r, 2500));
  expect(alive(first.row.host_pid)).toBe(true);
  const app = await comeBack(first.home, first.port, { FAKE_MODE: "thread" });
  const seen: AgentEvent[] = [];
  const result = await runRole(app, { role: "coder", spaceId: "personal", task: "改退款按钮", runId: first.runId, onEvent: (e) => seen.push(e) });
  expect(JSON.parse(result.text)).toMatchObject({ session: first.row.session_id, turn: 1 });
  expect(seen.some((e) => e.type === "status" && e.text.includes("omem 不在时已经做完"))).toBe(true);
  await until(() => !alive(first.row.host_pid));
});

it("gives a held turn up when no omem comes back in time; the run then continues as after any restart", async () => {
  setHostGraceForTests(1500);
  const first = await startTurn({ FAKE_MODE: "thread", FAKE_DELAY: "60000" }, { persist: true });
  await first.stop();
  // Past the hold the host cancels the turn, stops the agent and exits.
  await until(() => !alive(first.row.host_pid) && !alive(first.row.agent_pid), 15_000);

  const app = await comeBack(first.home, first.port, { FAKE_MODE: "echo" });
  await sweepAgentHosts(app);
  expect(all(app.db, "select id from agent_hosts")).toEqual([]);
  const r = JSON.parse((await runRole(app, { role: "coder", spaceId: "personal", task: "改退款按钮", runId: first.runId })).text) as { session: string; resumed: boolean; prompt: string };
  // Today's restart path: the same agent session in a new process, told what happened.
  expect(r.session).toBe(first.row.session_id);
  expect(r.resumed).toBe(true);
  expect(r.prompt).toContain("omem 重启打断了这次任务");
});

it("stops a host whose run ended while omem was away", async () => {
  const first = await startTurn({ FAKE_MODE: "thread", FAKE_DELAY: "60000" });
  await first.stop();
  expect(alive(first.row.host_pid)).toBe(true);
  run(first.app.db, "update runs set status = 'cancelled' where id = ?", first.runId);
  const app = await comeBack(first.home, undefined, { FAKE_MODE: "thread" });
  await sweepAgentHosts(app);
  expect(all(app.db, "select id from agent_hosts")).toEqual([]);
  await until(() => !alive(first.row.host_pid) && !alive(first.row.agent_pid), 15_000);
});

it("runs an ordinary turn under a host and stops it afterwards", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-host-"));
  const app: App = omem(home, { FAKE_MODE: "thread", FAKE_DELAY: "400" });
  const server = await startServer(app, { port: 0, quiet: true });
  cleanups.push(async () => { await server.close(); app.db.close(); });
  const r = createRun(app, { kind: "code", spaceId: "personal", title: "一轮" });
  let hostPid: number | null = null;
  const watch = setInterval(() => { hostPid ??= one<HostRow>(app.db, "select * from agent_hosts where run_id = ?", r.id)?.host_pid ?? null; }, 10);
  const result = await runRole(app, { role: "coder", spaceId: "personal", task: "改退款按钮", runId: r.id });
  clearInterval(watch);
  expect(JSON.parse(result.text)).toMatchObject({ turn: 1, resumed: false });
  await until(() => !one(app.db, "select 1 from agent_hosts where run_id = ?", r.id));
  expect(hostPid).not.toBeNull();
  await until(() => !alive(hostPid));
});
