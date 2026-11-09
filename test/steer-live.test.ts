import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { getRun, waitForRun } from "../src/agents/runs.ts";
import { liveSessionInfo, releaseAll } from "../src/agents/sessions.ts";
import { boot } from "../src/main.ts";

// An agent that takes words mid-turn (codex-acp `_session/steering`): a message sent while the turn
// runs reaches it at once, not at its next omem tool call (steer.ts) or as a turn of its own.
it("hands a message to the running turn through the agent's steering, without a tool call", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-steer-live-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_DELAY: "2500", FAKE_STEER: "1" } }] },
    sessions: { mergeMs: 0, liveMinutes: 5, maxLive: 2, maxTurns: 40, idleHours: 12 },
  }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => { releaseAll(); server.close(); });
  const first = await receive(app, { channel: "web", conversationId: "c_live", text: "查一下登录失败的原因" });
  // Wait until the agent is in the turn.
  for (let i = 0; i < 100 && !liveSessionInfo(first.thread.id)?.busy; i++) await new Promise((r) => setTimeout(r, 50));
  const extra = await receive(app, { channel: "web", conversationId: "c_live", text: "顺便看看是不是只有安卓端" });
  const done = await waitForRun(app, first.runId!);
  expect(done.error).toBeNull();
  const echo = JSON.parse(String((done.output as { answer: string }).answer)) as { steered?: string[] };
  expect(echo.steered).toEqual(["顺便看看是不是只有安卓端"]);
  const dropped = getRun(app, extra.runId!);
  expect(dropped.status).toBe("cancelled");
  expect(dropped.output.steeredInto).toBe(first.runId);
  expect(getRun(app, first.runId!).output.steered).toEqual([extra.messageId]);
}, 60000);
