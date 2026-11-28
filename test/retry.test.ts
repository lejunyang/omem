import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attemptNote, lastSession, retryRun } from "../src/agents/retry.ts";
import { addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { resolveThread } from "../src/agents/threads.ts";
import { testApp } from "./helpers.ts";

const fail = (app: ReturnType<typeof testApp>, id: string, error: string) => run(app.db, "update runs set status = 'failed', error = ? where id = ?", error, id);

describe("retrying a run", () => {
  it("continues a coding run in its worktree and coding session instead of starting over", async () => {
    const app = testApp();
    const first = createRun(app, { kind: "code", spaceId: "personal", title: "改登录页", input: { task: "改登录页的报错文案" }, notBefore: "2999-01-01T00:00:00Z" });
    const path = join(app.runsDir, first.id, "work", "personal");
    mkdirSync(path, { recursive: true });
    setRunOutput(app, first.id, { worktrees: [{ space: "personal", path, branch: `omem/${first.id}`, base: "abc" }] });
    addRunEvent(app, first.id, "session", { type: "session", sessionId: "sess-1", resumed: false, phase: "coder" });
    addRunEvent(app, first.id, "tool-write", { name: "write_file", args: { path: "notes/login" } });
    fail(app, first.id, "ACP connection closed");

    const again = await retryRun(app, first.id);
    expect(again.continued).toBe(true);
    expect(again.input).toMatchObject({ continueFrom: first.id, retryOf: first.id, resumeSessionId: "sess-1", task: "改登录页的报错文案" });
    // What the attempt did is handed to the next one.
    const note = attemptNote(app, first.id);
    expect(note).toContain("ACP connection closed");
    expect(note).toContain("write_file");
    expect(lastSession(app, first.id, "coder")).toBe("sess-1");

    // Applied or discarded work has no worktree to continue: the same input runs again.
    setRunOutput(app, first.id, { discardedAt: "2026-10-27T00:00:00Z" });
    const fresh = await retryRun(app, first.id);
    expect(fresh.continued).toBeUndefined();
    expect(fresh.input.continueFrom).toBeUndefined();
    app.db.close();
  });

  it("tells a retried agent run what was already done and refuses a run still going", async () => {
    const app = testApp();
    const r = createRun(app, { kind: "agent", title: "处理报警", input: { spec: "assistant", task: "看报警" }, notBefore: "2999-01-01T00:00:00Z" });
    await expect(retryRun(app, r.id)).rejects.toThrow(/还没结束/);
    fail(app, r.id, "timeout");
    const again = await retryRun(app, r.id);
    expect(again.input).toMatchObject({ retryOf: r.id, task: "看报警" });
    expect(again.input.resumeSessionId).toBeUndefined();
    expect(getRun(app, again.id).status).toBe("queued");
    app.db.close();
  });

  it("lets a retried chat question post its own answer, since no channel adapter awaits it", async () => {
    const app = testApp();
    const lark = resolveThread(app, { channel: "lark", chatId: "oc_retry" }).thread.id;
    const web = resolveThread(app, { channel: "web", chatId: "retry-web" }).thread.id;
    const ask = (conversationId: string) => {
      const r = createRun(app, { kind: "ask", title: "问", input: { conversationId, messageIds: [] }, notBefore: "2999-01-01T00:00:00Z" });
      fail(app, r.id, "sandbox");
      return r.id;
    };
    expect((await retryRun(app, ask(lark))).input.recoverReply).toBe(true);
    expect((await retryRun(app, ask(web))).input.recoverReply).toBeUndefined();
    app.db.close();
  });
});
