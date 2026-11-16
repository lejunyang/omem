import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all, run } from "../src/core/db.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { recoverSessionCleanup, sessionCleanup } from "../src/agents/session-cleanup.ts";
import { createThread, updateThread } from "../src/agents/threads.ts";
import { scheduleWake } from "../src/agents/wakes.ts";
import { MENTION_FOLLOW_MS } from "../src/mentions/channel.ts";
import { testApp } from "./helpers.ts";

const opened: App[] = [];
afterEach(() => { for (const app of opened.splice(0)) app.db.close(); });

function setup(mode = "background") {
  const app = testApp(); opened.push(app);
  const log = join(app.home, "deleted.txt");
  const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath,
    args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: mode, FAKE_DELETE_LOG: log } });
  app.config.agents.profiles = [profile];
  const keep = async (runId: string, id: string) => {
    const cleanup = await sessionCleanup(app, profile, { cwd: app.home, runId, persistSession: true }, () => {});
    cleanup.created(id);
    return cleanup;
  };
  const done = (id: string, status = "done") => run(app.db, "update runs set status=?,finished_at=? where id=?", status, new Date().toISOString(), id);
  const pending = () => all<{ session_id: string; ready: number }>(app.db, "select session_id,ready from session_cleanup order by session_id");
  const deleted = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").sort() : [];
  return { app, profile, keep, done, pending, deleted };
}

it.each([false, true])("cleans a fresh session after a failed resume unless explicitly kept (persist=%s)", async persistSession => {
  const { app, profile, pending, deleted } = setup("echo");
  profile.env.FAKE_RESUME_FAIL = "1";
  const cleanup = await sessionCleanup(app, profile, { cwd: app.home, resumeSessionId: "old" }, () => {});
  cleanup.created("old");
  const result = await runBackend(app, profile, { cwd: app.home, prompt: "检查临时会话", resumeSessionId: "old", persistSession }, () => {});
  expect(result.sessionId).toBeTruthy();
  expect(result.sessionId).not.toBe("old");
  expect(deleted()).toEqual(persistSession ? [] : [result.sessionId]);
  expect(pending()).toEqual([
    { session_id: "old", ready: -1 },
    ...(persistSession ? [{ session_id: result.sessionId, ready: -1 }] : []),
  ].sort((a, b) => a.session_id!.localeCompare(b.session_id!)));
});

it("retains an actually resumed session even without an explicit persistence flag", async () => {
  const { app, profile, pending, deleted } = setup("echo");
  const result = await runBackend(app, profile, { cwd: app.home, prompt: "接着检查", resumeSessionId: "resumed" }, () => {});
  expect(JSON.parse(result.text)).toMatchObject({ resumed: true });
  expect(result.sessionId).toBe("resumed");
  expect(pending()).toEqual([{ session_id: "resumed", ready: -1 }]);
  expect(deleted()).toEqual([]);
});

it("recovers expired mention sessions, preserving the follow-up window and active turns", async () => {
  const { app, keep, done, pending, deleted } = setup();
  const past = new Date(Date.now() - MENTION_FOLLOW_MS - 60_000).toISOString();
  const mention = { chatId: "room", topicId: null };
  const old = createRun(app, { title: "会话清理验收", kind: "agent", input: { mention } });
  const recent = createRun(app, { title: "会话清理验收", kind: "agent", input: { mention } });
  const failed = createRun(app, { title: "会话清理验收", kind: "agent", input: { mention } });
  const active = createRun(app, { title: "会话清理验收", kind: "agent", input: { mention } });
  for (const r of [old, recent, failed, active]) done(r.id, r === failed ? "failed" : "done");
  for (const r of [old, active]) run(app.db, "update runs set created_at=? where id=?", past, r.id);
  await keep(old.id, "expired"); await keep(recent.id, "recent"); await keep(failed.id, "failed");
  const live = await keep(active.id, "active"); live.active!("active", true);
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual(["expired", "failed"]);
  expect(pending()).toEqual([{ session_id: "active", ready: -1 }, { session_id: "recent", ready: -1 }]);
  live.active!("active", false);
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual(["active", "expired", "failed"]);
});

it("keeps an expired mention while a queued continuation or wake can still resume it", async () => {
  const { app, keep, done, deleted } = setup();
  const r = createRun(app, { title: "会话清理验收", kind: "agent", input: { mention: { chatId: "room" } } }); done(r.id);
  run(app.db, "update runs set created_at=? where id=?", new Date(Date.now() - MENTION_FOLLOW_MS - 60_000).toISOString(), r.id);
  await keep(r.id, "mention"); setRunOutput(app, r.id, { sessionId: "mention" });
  const next = createRun(app, { title: "会话清理验收", kind: "agent", input: { resumeFromRun: r.id } });
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual([]);
  done(next.id, "cancelled");
  const wake = scheduleWake(app, { at: new Date(Date.now() + 300_000).toISOString(), note: "接着检查", target: { spec: "assistant", resumeRunId: r.id }, setBy: { agent: "assistant", runId: r.id } });
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual([]);
  done(wake.id);
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual(["mention"]);
});

it.each(["appliedAt", "discardedAt"])("cleans separate reviews and second looks after their coding root is closed (%s)", async field => {
  const { app, keep, done, deleted, pending } = setup();
  const root = createRun(app, { title: "会话清理验收", kind: "code" }); done(root.id);
  const round = createRun(app, { title: "会话清理验收", kind: "code", input: { continueFrom: root.id } }); done(round.id);
  const review = createRun(app, { title: "会话清理验收", kind: "review", input: { codeRunId: round.id } }); done(review.id);
  const look = createRun(app, { title: "会话清理验收", kind: "agent", input: { secondLookOf: round.id, workId: root.id } }); done(look.id);
  const legacy = createRun(app, { title: "会话清理验收", kind: "agent", input: { secondLookOf: round.id } }); done(legacy.id);
  const unrelated = createRun(app, { title: "会话清理验收", kind: "agent", input: { workId: root.id } }); done(unrelated.id);
  for (const [r, id] of [[round, "coder"], [review, "review"], [look, "look"], [legacy, "legacy"], [unrelated, "unrelated"]] as const) await keep(r.id, id);
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual([]); // An unfinished delegation can continue every check.
  setRunOutput(app, root.id, { [field]: new Date().toISOString() });
  const next = createRun(app, { title: "会话清理验收", kind: "agent", input: { resumeSessionId: "look" } });
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual(["coder", "legacy", "review"]);
  expect(pending()).toEqual([{ session_id: "look", ready: -1 }, { session_id: "unrelated", ready: -1 }]);
  done(next.id, "cancelled");
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual(["coder", "legacy", "look", "review"]);
});

it("sweeps replaced chat sessions after restart while retaining current and archived conversations", async () => {
  const { app, keep, done, deleted } = setup();
  const thread = createThread(app, { spaceId: "personal", channel: "web" });
  const r = createRun(app, { title: "会话清理验收", kind: "ask", input: { conversationId: thread.id } }); done(r.id);
  await keep(r.id, "old"); await keep(r.id, "current");
  updateThread(app, thread.id, { agentSession: "current" });
  const archived = createThread(app, { spaceId: "personal", channel: "web" });
  updateThread(app, archived.id, { agentSession: "archived" });
  run(app.db, "update conversations set status='archived' where id=?", archived.id);
  await keep(r.id, "archived");
  const live = await keep(r.id, "active"); live.active!("active", true);
  const running = createRun(app, { title: "会话清理验收", kind: "ask", input: { conversationId: thread.id } });
  run(app.db, "update runs set status='running' where id=?", running.id);
  await keep(running.id, "running");
  const next = createRun(app, { title: "会话清理验收", kind: "agent", input: { resumeSessionId: "old" } });
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual([]);
  done(next.id, "cancelled");
  // A new App has no in-memory retirement callback or list of live sessions.
  const { App: AppClass } = await import("../src/core/app.ts");
  const reopened = AppClass.open(app.home); opened.push(reopened);
  reopened.config.agents.profiles = app.config.agents.profiles;
  await recoverSessionCleanup(reopened, () => {});
  expect(deleted()).toEqual(["old"]);
  live.active!("active", false);
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual(["active", "old"]);
});
