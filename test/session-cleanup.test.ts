import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/core/app.ts";
import { all, migrations, run } from "../src/core/db.ts";
import { DatabaseSync } from "node:sqlite";
import { sessionCleanup, recoverSessionCleanup } from "../src/agents/session-cleanup.ts";
import { saveDoubaoToken, setDoubaoFetchForTests } from "../src/agents/doubao.ts";
import { saveLarkSecret } from "../src/channels/lark-setup.ts";
import { testApp } from "./helpers.ts";
import { agentProfileSchema, saveConfig } from "../src/core/config.ts";
import { keepSession } from "../src/agents/code-overlap.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";

const opened: App[] = [];
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
const pending = (app: App) => all<{ session_id: string; ready: number; app_id: string }>(app.db, "select * from session_cleanup");
const due = (app: App) => run(app.db, "update session_cleanup set retry_at = ''");
function authorized() {
  const app = testApp(); opened.push(app);
  app.config.lark.appId = "cli_bot";
  // The subprocess loads its own config, which must select the same application.
  saveLarkSecret(app.home, { appId: "cli_bot", appSecret: "s" });
  saveDoubaoToken(app.home, { appId: "cli_bot", accessToken: "user-token", expiresAt: new Date(Date.now() + 3600_000).toISOString(), savedAt: "" });
  return app;
}
afterEach(() => { setDoubaoFetchForTests(null); for (const app of opened.splice(0)) app.db.close(); });

describe("durable Doubao cleanup", () => {
  it("migrates an existing Doubao cleanup record into the shared ledger without losing ownership", async () => {
    const old = authorized();
    old.db.close(); opened.splice(opened.indexOf(old), 1);
    rmSync(join(old.home, "omem.db"));
    const legacy = new DatabaseSync(join(old.home, "omem.db"));
    // Recreate the actual predecessor, even after unrelated migrations have been appended.
    const version = migrations.findIndex((sql) => sql.includes("create table session_cleanup"));
    expect(version).toBeGreaterThan(0);
    for (const sql of migrations.slice(0, version)) legacy.exec(sql);
    legacy.exec(`insert into doubao_session_cleanup values('legacy','doubao-cli','cli_bot',null,1,1,''); pragma user_version = ${version};`);
    legacy.close();
    const app = App.open(old.home); opened.push(app);
    expect(pending(app)).toMatchObject([{ session_id: "legacy", app_id: "cli_bot", ready: 1 }]);
    let deleted = false;
    setDoubaoFetchForTests(async (_input, init) => {
      if (init?.method === "DELETE") { deleted = true; return ok({}); }
      return ok({ session: { status: "idle" } });
    });
    await recoverSessionCleanup(app, () => {});
    expect(deleted).toBe(true);
    expect(pending(app)).toEqual([]);
  });
  it("recovers a session after the owning process exits, waits until idle, then deletes once", async () => {
    const original = authorized();
    execFileSync(process.execPath, [resolve("test/session-cleanup-child.ts"), original.home], { timeout: 10000, stdio: "pipe" });
    expect(pending(original)).toMatchObject([{ session_id: "s-1", ready: 0, app_id: "cli_bot" }]);
    // A fresh App reads only the persisted state; no live turn or in-memory id survives.
    const app = App.open(original.home); opened.push(app);
    let status = "in_progress";
    const deleted: string[] = [];
    setDoubaoFetchForTests(async (input, init) => {
      if (init?.method === "DELETE") { deleted.push(String(input)); return ok({}); }
      return ok({ session: { status } });
    });
    await recoverSessionCleanup(app, () => {});
    expect(deleted).toEqual([]);
    expect(pending(app)).toHaveLength(1);
    status = "idle"; due(app);
    await recoverSessionCleanup(app, () => {});
    expect(deleted).toHaveLength(1);
    expect(pending(app)).toEqual([]);
    await recoverSessionCleanup(app, () => {});
    expect(deleted).toHaveLength(1);
  });

  it("leaves sessions owned by a live turn alone", async () => {
    const app = authorized();
    const cleanup = await sessionCleanup(app, { id: "doubao-cli", transport: "doubao-cli", command: "doubao", args: [], env: {}, idleTimeoutMs: 5000 }, { cwd: app.home }, () => {});
    cleanup.created("live");
    let calls = 0;
    setDoubaoFetchForTests(async () => { calls++; return ok({}); });
    await recoverSessionCleanup(app, () => {});
    expect(calls).toBe(0);
    expect(pending(app)).toHaveLength(1);
  });

  it("retries a failed deletion with the original application after the configured bot changes", async () => {
    const app = authorized();
    const cleanup = await sessionCleanup(app, { id: "doubao-cli", transport: "doubao-cli", command: "doubao", args: [], env: {}, idleTimeoutMs: 5000 }, { cwd: app.home }, e => { if (e.type === "status") messages.push(e.text); });
    cleanup.created("retry");
    setDoubaoFetchForTests(async () => new Response(JSON.stringify({ code: 500, msg: "unavailable" }), { status: 503 }));
    const messages: string[] = [];
    await cleanup.discard("retry");
    expect(messages.some(m => m.includes("稍后重试"))).toBe(true);
    expect(pending(app)).toMatchObject([{ session_id: "retry", ready: 1 }]);
    saveLarkSecret(app.home, { appId: "cli_other", appSecret: "other" });
    app.config.lark.appId = "cli_other";
    saveDoubaoToken(app.home, { appId: "cli_other", accessToken: "other-token", expiresAt: new Date(Date.now() + 3600_000).toISOString(), savedAt: "" });
    const auth: string[] = [];
    setDoubaoFetchForTests(async (_input, init) => {
      auth.push((init?.headers as Record<string, string>).authorization);
      return init?.method === "DELETE" ? ok({}) : ok({ session: { status: "idle" } });
    });
    due(app); await recoverSessionCleanup(app, () => {});
    expect(auth).toEqual(["Bearer user-token", "Bearer user-token"]);
    expect(pending(app)).toEqual([]);
  });

  it("lets go of the sessions a delegation kept once it is confirmed or discarded, and of agent work idle for two days", async () => {
    const app = authorized();
    const keep = (runId: string, id: string) =>
      run(app.db, "insert into session_cleanup(backend_key,session_id,transport,profile_id,fingerprint,app_id,cwd,run_id,owner_pid,ready,retry_at) values(?,?,?,?,?,?,?,?,?,-1,'')", "doubao:cli_bot", id, "doubao-cli", "doubao-cli", null, "cli_bot", app.home, runId, process.pid);
    const done = (id: string, at?: string) => run(app.db, "update runs set status = 'done', finished_at = ? where id = ?", at ?? new Date().toISOString(), id);
    // A discarded delegation and its second round, each with a reviewer's kept session; an open one.
    const gone = createRun(app, { kind: "code", spaceId: "personal", title: "退款改造", input: { task: "t" } });
    const round = createRun(app, { kind: "code", spaceId: "personal", title: "第 2 轮", input: { task: "t", continueFrom: gone.id } });
    const open = createRun(app, { kind: "code", spaceId: "personal", title: "导出改造", input: { task: "t" } });
    for (const r of [gone, round, open]) done(r.id);
    setRunOutput(app, gone.id, { discardedAt: new Date().toISOString() });
    keep(gone.id, "review-1"); keep(round.id, "review-2"); keep(open.id, "review-open");
    // Work handed to an agent: one whose last run was ten days ago, one from yesterday.
    const old = createRun(app, { kind: "agent", spaceId: "personal", title: "调查", input: { spec: "assistant", task: "t", agentWorkId: "w-old" } });
    const recent = createRun(app, { kind: "agent", spaceId: "personal", title: "调查", input: { spec: "assistant", task: "t", agentWorkId: "w-new" } });
    done(old.id, new Date(Date.now() - 10 * 86400_000).toISOString()); done(recent.id, new Date(Date.now() - 86400_000).toISOString());
    keep(old.id, "work-old"); keep(recent.id, "work-new");
    const deleted: string[] = [];
    setDoubaoFetchForTests(async (input, init) => {
      if (init?.method === "DELETE") { deleted.push(String(input).split("/").pop()!.split("?")[0]); return ok({}); }
      return ok({ session: { status: "idle" } });
    });
    await recoverSessionCleanup(app, () => {});
    expect(deleted.sort()).toEqual(["review-1", "review-2", "work-old"]);
    expect(pending(app).map((x) => [x.session_id, x.ready]).sort()).toEqual([["review-open", -1], ["work-new", -1]]);
  });

  it("forgets an already deleted session, while retaining denied or malformed queries", async () => {
    const app = authorized();
    const cleanup = await sessionCleanup(app, { id: "doubao-cli", transport: "doubao-cli", command: "doubao", args: [], env: {}, idleTimeoutMs: 5000 }, { cwd: app.home }, () => {});
    cleanup.created("gone");
    run(app.db, "update session_cleanup set ready = 1");
    for (const response of [() => new Response(JSON.stringify({ code: 403, msg: "denied" }), { status: 403 }), () => ok({})]) {
      setDoubaoFetchForTests(async () => response());
      due(app); await recoverSessionCleanup(app, () => {});
      expect(pending(app)).toHaveLength(1);
    }
    setDoubaoFetchForTests(async (_input, init) => {
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ code: 3440008, msg: "not found" }), { status: 404 });
    });
    due(app); await recoverSessionCleanup(app, () => {});
    expect(pending(app)).toEqual([]);
  });
});

function acpApp(protocol: boolean) {
  const app = testApp(); opened.push(app);
  const log = join(app.home, "deleted.txt");
  const profile = agentProfileSchema.parse({ id: "fake-acp", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], archiveArgs: [resolve("test/fake-session-archive.ts"), protocol ? join(app.home, "fallback.txt") : log], env: { FAKE_MODE: "background", ...(protocol ? { FAKE_DELETE_LOG: log } : {}) } });
  app.config.agents.profiles = [profile]; saveConfig(app.config, app.home);
  return { app, profile, deleted: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

describe("unified ACP cleanup", () => {
  it("keeps a rule session for queued work and followed topics, then cleans after cancellation or expiry", async () => {
    const { app, profile, deleted } = acpApp(true);
    const r = createRun(app, { kind: "agent", title: "规则的一批任务", lane: "rule:test", input: { rule: { id: "test" }, silent: {} } });
    const cleanup = await sessionCleanup(app, profile, { cwd: app.home, runId: r.id, persistSession: true }, () => {});
    cleanup.created("rule-session"); setRunOutput(app, r.id, { sessionId: "rule-session" });
    run(app.db, "update runs set status='done' where id=?", r.id);
    const next = createRun(app, { kind: "agent", title: "下一条", lane: "rule:test", input: { rule: { id: "test" }, resumeFromRun: r.id } });
    await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual([]);
    run(app.db, "insert into kv(key,value) values(?,?)", "rule_follow:chat#topic", JSON.stringify({ runId: r.id, until: new Date(Date.now() + 3600_000).toISOString() }));
    run(app.db, "update runs set status='cancelled' where id=?", next.id);
    await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual([]);
    run(app.db, "update kv set value=? where key=?", JSON.stringify({ runId: r.id, until: "2000-01-01T00:00:00Z" }), "rule_follow:chat#topic");
    await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual(["rule-session"]);
    expect(pending(app)).toEqual([]);
  });

  it("keeps a rule session while a wake it set is pending, so the wake can continue it", async () => {
    const { app, profile, deleted } = acpApp(true);
    const r = createRun(app, { kind: "agent", title: "规则的报警", input: { spec: "assistant", rule: { id: "test" }, silent: {} } });
    const cleanup = await sessionCleanup(app, profile, { cwd: app.home, runId: r.id, persistSession: true }, () => {});
    cleanup.created("waking-session"); setRunOutput(app, r.id, { sessionId: "waking-session" });
    run(app.db, "update runs set status='done' where id=?", r.id);
    const { scheduleWake } = await import("../src/agents/wakes.ts");
    const wake = scheduleWake(app, { at: new Date(Date.now() + 300_000).toISOString(), note: "五分钟后接着查", target: { spec: "assistant", resumeRunId: r.id }, setBy: { agent: "assistant", runId: r.id } });
    await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual([]);
    run(app.db, "update runs set status='done' where id=?", wake.id);
    await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual(["waking-session"]);
  });

  it("releases completed and failed rule sessions, including an id lost when a run restarted", async () => {
    const { app, profile, deleted } = acpApp(true);
    const r = createRun(app, { kind: "agent", title: "规则重启", input: { rule: { id: "test" } } });
    const cleanup = await sessionCleanup(app, profile, { cwd: app.home, runId: r.id, persistSession: true }, () => {});
    cleanup.created("lost-at-restart"); cleanup.created("failed-attempt");
    run(app.db, "update runs set status='failed' where id=?", r.id);
    await recoverSessionCleanup(app, () => {});
    expect(deleted().sort()).toEqual(["failed-attempt", "lost-at-restart"]);
    expect(pending(app)).toEqual([]);
  });

  it("keeps the actual protocol error and retries, without switching to an archive command", async () => {
    const { app, profile, deleted } = acpApp(true);
    const failFile = join(app.home, "protocol-busy");
    profile.env.FAKE_DELETE_FAIL_FILE = failFile;
    writeFileSync(failFile, "busy");
    const messages: string[] = [];
    const cleanup = await sessionCleanup(app, profile, { cwd: app.home }, e => { if (e.type === "status") messages.push(e.text); });
    cleanup.created("protocol-retry");
    await cleanup.discard("protocol-retry");
    expect(messages.some(m => m.includes("session still active"))).toBe(true);
    expect(existsSync(join(app.home, "fallback.txt"))).toBe(false);
    expect(pending(app)).toMatchObject([{ ready: 1 }]);
    rmSync(failFile); due(app);
    await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual(["protocol-retry"]);
    expect(pending(app)).toEqual([]);
  });
  it.each([true, false])("recovers a crashed host using advertised deletion or configured archive (protocol=%s)", async protocol => {
    const { app, deleted } = acpApp(protocol);
    execFileSync(process.execPath, [resolve("test/session-cleanup-child.ts"), app.home, "fake-acp"], { timeout: 10000, stdio: "pipe" });
    const records = pending(app);
    expect(records).toHaveLength(1);
    await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual([records[0].session_id]);
    expect(existsSync(join(app.home, "fallback.txt"))).toBe(false);
    expect(pending(app)).toEqual([]);
  });

  it("keeps retained sessions across process exit, but retires a review session when replaced", async () => {
    const { app, deleted, profile } = acpApp(true);
    execFileSync(process.execPath, [resolve("test/session-cleanup-child.ts"), app.home, "fake-acp", "keep"], { timeout: 10000, stdio: "pipe" });
    const old = pending(app)[0].session_id;
    expect(pending(app)[0].ready).toBe(-1);
    await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual([]);
    const root = createRun(app, { kind: "code", spaceId: "personal", title: "测试评审会话轮换" });
    keepSession(app, root.id, "reviewer", old, 130000);
    const next = await sessionCleanup(app, profile, { cwd: app.home, persistSession: true }, () => {});
    next.created("next-review");
    keepSession(app, root.id, "reviewer", "next-review", 1000);
    await vi.waitFor(() => expect(deleted()).toEqual([old]));
    expect(pending(app)).toMatchObject([{ session_id: "next-review", ready: -1 }]);
  });

  it("retries archive failures, and refuses a changed executable or account configuration", async () => {
    const { app, profile, deleted } = acpApp(false);
    const failFile = join(app.home, "fail-archive");
    profile.env.FAKE_ARCHIVE_FAIL_FILE = failFile;
    writeFileSync(failFile, "fail");
    const cleanup = await sessionCleanup(app, profile, { cwd: app.home }, () => {});
    cleanup.created("failed");
    await cleanup.discard("failed");
    expect(pending(app)).toMatchObject([{ ready: 1 }]);
    profile.command = "a-different-agent";
    due(app); await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual([]); // Credentials/config changed; do not act under the new identity.
    expect(pending(app)).toHaveLength(1);
    profile.command = process.execPath;
    rmSync(failFile);
    // The same operation can succeed later without changing its credentials or executable.
    due(app); await recoverSessionCleanup(app, () => {});
    expect(deleted()).toEqual(["failed"]);
    expect(pending(app)).toEqual([]);
  });
});
