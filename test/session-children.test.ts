import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { App } from "../src/core/app.ts";
import { agentProfileSchema, saveConfig } from "../src/core/config.ts";
import { all, run } from "../src/core/db.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { disposableChildren } from "../src/agents/session-children.ts";
import { recoverSessionCleanup, sessionCleanup } from "../src/agents/session-cleanup.ts";
import { createRun } from "../src/agents/runs.ts";
import { testApp } from "./helpers.ts";

const opened: App[] = [];
afterEach(() => { for (const app of opened.splice(0)) app.db.close(); });
function setup() {
  const app = testApp(); opened.push(app);
  const home = join(app.home, "history");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const log = join(app.home, "deleted.txt");
  const fail = join(app.home, "busy");
  const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath,
    args: [resolve("test/fake-acp-agent.ts")], sessionHistory: { format: "codex-rollout", root: join(app.home, "unused"), env: "CODEX_HOME" },
    env: { FAKE_MODE: "echo", FAKE_DELETE_LOG: log, FAKE_DELETE_FAIL_FILE: fail, FAKE_HISTORY_ROOT: home, CODEX_HOME: home } });
  app.config.agents.profiles = [profile]; saveConfig(app.config, app.home);
  const meta = (id: string, parent: string) => ({ type: "session_meta", payload: { id, parent_thread_id: parent, originator: "omem", source: { subagent: { other: "guardian" } } } });
  const file = (id: string) => join(home, "sessions", `rollout-${id}.jsonl`);
  const write = (id: string, parent: string) => writeFileSync(file(id), JSON.stringify(meta(id, parent)) + "\n");
  const deleted = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { app, profile, home, fail, meta, file, write, deleted };
}

it("archives only omem's guardian children after a retained turn, preserving workers and other chats", async () => {
  const { app, profile, home, meta, file, write, deleted } = setup();
  const r = createRun(app, { kind: "code", title: "示例编码任务" });
  const result = await runBackend(app, profile, { cwd: app.home, runId: r.id, prompt: "继续编码", persistSession: true }, e => {
    if (e.type !== "session") return;
    write("own-guardian", e.sessionId);
    write("other-guardian", "other-chat");
    const external = meta("external", e.sessionId);
    external.payload.originator = "Codex Desktop";
    writeFileSync(file("external"), JSON.stringify(external) + "\n");
    const worker = meta("worker", e.sessionId);
    worker.payload.source.subagent.other = "worker";
    writeFileSync(file("worker"), JSON.stringify(worker) + "\n");
  });
  expect(deleted()).toEqual(["own-guardian"]);
  expect(all(app.db, "select session_id,ready from session_cleanup")).toEqual([{ session_id: result.sessionId, ready: -1 }]);
  expect(existsSync(join(home, "archived_sessions", "rollout-own-guardian.jsonl"))).toBe(true);
  for (const id of ["external", "worker", "other-guardian"]) expect(existsSync(file(id))).toBe(true);
});

it("recovers helpers after a retained host exits, waiting until its run stops", async () => {
  const { app, profile, write, deleted } = setup();
  const r = createRun(app, { kind: "code", title: "中断后的编码任务" });
  const cleanup = await sessionCleanup(app, profile, { cwd: app.home, runId: r.id, persistSession: true }, () => {});
  cleanup.created("kept-parent");
  write("guardian", "kept-parent");
  run(app.db, "update runs set status='running' where id=?", r.id);
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual([]);
  run(app.db, "update runs set status='done' where id=?", r.id);
  // A live conversation may already be in a later turn than the run saved on its ledger row.
  cleanup.active!("kept-parent", true);
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual([]);
  cleanup.active!("kept-parent", false);
  await recoverSessionCleanup(app, () => {});
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual(["guardian"]);
  expect(all(app.db, "select session_id,ready from session_cleanup")).toEqual([{ session_id: "kept-parent", ready: -1 }]);
});

it("persists a helper's failed archive and retries after reopening without deleting its parent", async () => {
  const { app, profile, fail, write, deleted } = setup();
  const r = createRun(app, { kind: "code", title: "保留上下文" });
  const cleanup = await sessionCleanup(app, profile, { cwd: app.home, runId: r.id, persistSession: true }, () => {});
  cleanup.created("parent"); write("guardian", "parent");
  writeFileSync(fail, "busy");
  await cleanup.children!("parent");
  expect(all(app.db, "select session_id,ready from session_cleanup order by session_id")).toEqual([{ session_id: "guardian", ready: 1 }, { session_id: "parent", ready: -1 }]);
  app.db.close(); opened.splice(opened.indexOf(app), 1);
  const reopened = App.open(app.home); opened.push(reopened);
  rmSync(fail);
  run(reopened.db, "update session_cleanup set retry_at='' ");
  await recoverSessionCleanup(reopened, () => {});
  expect(deleted()).toEqual(["guardian"]);
  expect(all(reopened.db, "select session_id from session_cleanup")).toEqual([{ session_id: "parent" }]);
});

it("recovers a disposable parent and its unreported helper after the actual owner process exits", async () => {
  const { app, write, deleted } = setup();
  execFileSync(process.execPath, [resolve("test/session-cleanup-child.ts"), app.home, "fake"], { timeout: 10000, stdio: "pipe" });
  const [{ session_id: parent }] = all<{ session_id: string }>(app.db, "select session_id from session_cleanup");
  write("guardian", parent);
  await recoverSessionCleanup(app, () => {});
  expect(deleted()).toEqual(["guardian", parent]);
  expect(all(app.db, "select session_id from session_cleanup")).toEqual([]);
});

it("retries incomplete metadata and ignores linked files and mismatched ids", async () => {
  const { profile, home, meta, file, write } = setup();
  writeFileSync(file("partial"), '{"type":"session_meta"');
  expect(await disposableChildren(profile, "parent")).toEqual([]);
  write("partial", "parent");
  const wrong = meta("different-id", "parent");
  writeFileSync(file("wrong"), JSON.stringify(wrong) + "\n");
  const outside = join(home, "outside.jsonl");
  writeFileSync(outside, JSON.stringify(meta("linked", "parent")) + "\n");
  if (process.platform !== "win32") symlinkSync(outside, file("linked"));
  expect(await disposableChildren(profile, "parent")).toEqual(["partial"]);
  expect(await disposableChildren({ ...profile, peer: { id: "other-device", agent: "fake" } }, "parent")).toEqual([]);
});
