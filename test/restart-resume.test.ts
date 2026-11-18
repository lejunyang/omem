import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareRun, runRole } from "../src/agents/runner.ts";
import { createRun, markRestarted } from "../src/agents/runs.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { one, run } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0)) await f(); });

type Echo = { session: string; resumed: boolean; prompt: string };

async function interrupted(startedAt: string) {
  const app = testApp();
  app.config.agents.default = "fake";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "echo" } })];
  const server = await startServer(app, { port: 0, quiet: true });
  cleanups.push(() => server.close());
  const cwd = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: null }).cwd;
  const r = createRun(app, { kind: "code", spaceId: "personal", title: "重启前在跑" });
  // What the run looked like when the process went away: running, in session s-old, one message posted.
  run(app.db, "update runs set status = 'running', started_at = ? where id = ?", startedAt, r.id);
  run(app.db, "insert into run_events(run_id, seq, at, type, data) values(?, 1, ?, 'session', ?)", r.id, startedAt, JSON.stringify({ sessionId: "s-old", resumed: false }));
  run(app.db, "insert into run_events(run_id, seq, at, type, data) values(?, 2, ?, 'tool-write', ?)", r.id, startedAt, JSON.stringify({ name: "lark_send", args: { text: "已经回复过的一句" } }));
  run(app.db, "insert into session_cleanup(backend_key, session_id, transport, profile_id, cwd, run_id, owner_pid, ready, retry_at) values('acp:x', 's-old', 'acp', 'fake', ?, ?, 999999, 0, ?)", cwd, r.id, startedAt);
  return { app, runId: r.id };
}

const ready = (app: ReturnType<typeof testApp>) => one<{ ready: number }>(app.db, "select ready from session_cleanup where session_id = 's-old'")!.ready;

it("continues a run a restart cut off in its agent session, told what it already wrote", async () => {
  const { app, runId } = await interrupted(new Date().toISOString());
  markRestarted(app);
  // Kept from cleanup until the run continues in it.
  expect(ready(app)).toBe(-1);

  const first = JSON.parse((await runRole(app, { role: "coder", spaceId: "personal", task: "改退款按钮", runId })).text) as Echo;
  expect(first).toMatchObject({ session: "s-old", resumed: true });
  expect(first.prompt).toContain("omem 重启打断了这次任务");
  expect(first.prompt).toContain("已经回复过的一句");
  expect(first.prompt).toContain("改退款按钮");
  // A disposable session goes to cleanup once continued.
  expect(ready(app)).toBe(1);

  // Only the first agent turn after the restart is a continuation.
  const second = JSON.parse((await runRole(app, { role: "coder", spaceId: "personal", task: "再看一遍", runId })).text) as Echo;
  expect(second.session).not.toBe("s-old");
  expect(second.prompt).not.toContain("omem 重启");
  app.db.close();
});

it("starts a long-interrupted run in a new session, still told what it already wrote", async () => {
  const { app, runId } = await interrupted(new Date(Date.now() - 13 * 3600_000).toISOString());
  markRestarted(app);
  expect(ready(app)).toBe(0);
  const r = JSON.parse((await runRole(app, { role: "coder", spaceId: "personal", task: "改退款按钮", runId })).text) as Echo;
  expect(r.session).not.toBe("s-old");
  expect(r.prompt).toContain("之前的对话没有保留");
  expect(r.prompt).toContain("已经回复过的一句");
  app.db.close();
});
