import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openAcp } from "../src/agents/acp.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { retireSession } from "../src/agents/dispatch.ts";
import { testApp } from "./helpers.ts";
import { all } from "../src/core/db.ts";

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
});
