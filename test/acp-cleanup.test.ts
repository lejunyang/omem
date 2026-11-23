import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openAcp } from "../src/agents/acp.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { retireSession } from "../src/agents/dispatch.ts";
import { testApp } from "./helpers.ts";
import { all } from "../src/core/db.ts";
import { spawnSync } from "node:child_process";

it("survives late stdout after the ACP reader cancels an oversized message", () => {
  // The SDK cancels its input at the message limit. More stdout arriving after that used to
  // enqueue into a closed controller and crash omem, including unrelated ongoing turns.
  const agent = `process.stdin.resume(); process.stdout.on('error', () => process.exit(0));
    let left = 34 * 1024 * 1024;
    const more = () => { if (left <= 0) return; left -= 65536; process.stdout.write('x'.repeat(65536)); setImmediate(more); }; more();`;
  const script = `import { openAcp } from './src/agents/acp.ts';
    const p = { id: 'broken', transport: 'acp', command: process.execPath, args: ['-e', ${JSON.stringify(agent)}], env: {}, idleTimeoutMs: 5000 };
    try { const h = await openAcp(p, { cwd: process.cwd() }); h.close(); process.exitCode = 2; }
    catch { await new Promise(ok => setTimeout(ok, 100)); console.log('closed cleanly'); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("closed cleanly");
});

it("deletes a session whose agent process is gone through a new connection", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "omem-acp-")), "deleted.txt");
  const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_DELETE_LOG: log } });
  const events: string[] = [];
  const handle = await openAcp(profile, { cwd: process.cwd() }, (e) => e.type === "status" && events.push(e.text));
  await handle.prompt("hi", () => {});
  // The process dies while the session sits idle (a background pool entry an hour later).
  handle.close();
  await new Promise((r) => setTimeout(r, 300));
  await handle.discard();
  expect(existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []).toEqual([handle.sessionId]);
  expect(events.filter((t) => t.includes("清理失败"))).toEqual([]);
});

it("retires a thread's replaced ACP session through a connection of its own", async () => {
  const app = testApp();
  const log = join(app.home, "retired.txt");
  const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_DELETE_LOG: log } });
  const events: string[] = [];
  await retireSession(app, profile, "old-session", process.cwd(), (e) => e.type === "status" && events.push(e.text));
  expect(readFileSync(log, "utf8").trim()).toBe("old-session");
  expect(events.some(t => t.includes("已清理后端会话"))).toBe(true);
  // Unsupported cleanup stays recorded and reports why; it must not look successful.
  await retireSession(app, { ...profile, env: { FAKE_MODE: "thread" } }, "other", process.cwd(), (e) => e.type === "status" && events.push(e.text));
  expect(events.some(t => t.includes("不支持自动清理"))).toBe(true);
  expect(all(app.db, "select session_id,ready from session_cleanup")).toEqual([{ session_id: "other", ready: 1 }]);
  // Waiting will not make the backend support it: no retries, but the row stays for a manual retry.
  expect(all(app.db, "select attempts, failed_at is not null failed from session_cleanup")).toEqual([{ attempts: 1, failed: 1 }]);
});
