import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/core/app.ts";
import { all, run } from "../src/core/db.ts";
import { finishDoubaoCleanup, queueDoubaoCleanup, recoverDoubaoCleanup } from "../src/agents/doubao-cleanup.ts";
import { saveDoubaoToken, setDoubaoFetchForTests } from "../src/agents/doubao.ts";
import { saveLarkSecret } from "../src/channels/lark-setup.ts";
import { testApp } from "./helpers.ts";

const opened: App[] = [];
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
const pending = (app: App) => all<{ session_id: string; ready: number; app_id: string }>(app.db, "select * from doubao_session_cleanup");
const due = (app: App) => run(app.db, "update doubao_session_cleanup set retry_at = ''");
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
  it("recovers a session after the owning process exits, waits until idle, then deletes once", async () => {
    const original = authorized();
    execFileSync(process.execPath, [resolve("test/doubao-cleanup-child.ts"), original.home], { timeout: 10000, stdio: "pipe" });
    expect(pending(original)).toMatchObject([{ session_id: "s-1", ready: 0, app_id: "cli_bot" }]);
    // A fresh App reads only the persisted state; no live turn or in-memory id survives.
    const app = App.open(original.home); opened.push(app);
    let status = "in_progress";
    const deleted: string[] = [];
    setDoubaoFetchForTests(async (input, init) => {
      if (init?.method === "DELETE") { deleted.push(String(input)); return ok({}); }
      return ok({ session: { status } });
    });
    await recoverDoubaoCleanup(app, () => {});
    expect(deleted).toEqual([]);
    expect(pending(app)).toHaveLength(1);
    status = "idle"; due(app);
    await recoverDoubaoCleanup(app, () => {});
    expect(deleted).toHaveLength(1);
    expect(pending(app)).toEqual([]);
    await recoverDoubaoCleanup(app, () => {});
    expect(deleted).toHaveLength(1);
  });

  it("leaves sessions owned by a live turn alone", async () => {
    const app = authorized();
    queueDoubaoCleanup(app, "live", "doubao-cli", "cli_bot");
    let calls = 0;
    setDoubaoFetchForTests(async () => { calls++; return ok({}); });
    await recoverDoubaoCleanup(app, () => {});
    expect(calls).toBe(0);
    expect(pending(app)).toHaveLength(1);
  });

  it("retries a failed deletion with the original application after the configured bot changes", async () => {
    const app = authorized();
    queueDoubaoCleanup(app, "retry", "doubao-cli", "cli_bot");
    setDoubaoFetchForTests(async () => new Response(JSON.stringify({ code: 500, msg: "unavailable" }), { status: 503 }));
    const messages: string[] = [];
    await finishDoubaoCleanup(app, "retry", e => { if (e.type === "status") messages.push(e.text); });
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
    due(app); await recoverDoubaoCleanup(app, () => {});
    expect(auth).toEqual(["Bearer user-token", "Bearer user-token"]);
    expect(pending(app)).toEqual([]);
  });

  it("forgets an already deleted session, while retaining denied or malformed queries", async () => {
    const app = authorized();
    queueDoubaoCleanup(app, "gone", "doubao-cli", "cli_bot");
    run(app.db, "update doubao_session_cleanup set ready = 1");
    for (const response of [() => new Response(JSON.stringify({ code: 403, msg: "denied" }), { status: 403 }), () => ok({})]) {
      setDoubaoFetchForTests(async () => response());
      due(app); await recoverDoubaoCleanup(app, () => {});
      expect(pending(app)).toHaveLength(1);
    }
    setDoubaoFetchForTests(async (_input, init) => {
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ code: 3440008, msg: "not found" }), { status: 404 });
    });
    due(app); await recoverDoubaoCleanup(app, () => {});
    expect(pending(app)).toEqual([]);
  });
});
