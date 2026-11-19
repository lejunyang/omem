import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { threadMessages } from "../src/agents/threads.ts";
import { saveContext } from "../src/channels/listen.ts";
import { boot } from "../src/main.ts";

// A booted app runs its run worker: kept apart from test/listen-meetings.test.ts, whose runs must stay queued.
const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

describe("a 关注's meeting: what the listening agent noted, end to end", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-listen-meet-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { default: "say", profiles: [fake("say", { FAKE_SAY: "小李说今晚八点回滚支付服务，等本人确认。" }), fake("quiet", { FAKE_SAY: "这一段没什么。", FAKE_QUIET: "这一段和关注无关" })] }, sessions: { mergeMs: 0 } }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    releaseAll();
    server.close();
  });

  it("goes into the 关注's conversation, unless the window stayed quiet", async () => {
    const c = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_team"], knobs: { reply: "none" } });
    saveAgentSpec(app, { name: "listener-say", description: "旁听", prompt: "旁听", status: "active", agent: "say" }, "user");
    saveAgentSpec(app, { name: "listener-quiet", description: "旁听", prompt: "旁听", status: "active", agent: "quiet" }, "user");
    const window = (spec: string) =>
      createRun(app, { kind: "agent", spaceId: "personal", title: "旁听", lane: "meeting:m1", input: { spec, task: "旁听会议", meeting: { id: "m1" }, denyTools: ["notify"], meetingWindow: true, listenMeeting: { contextId: c.id, meetingId: "m1", topic: "周会" } } });
    expect((await waitForRun(app, window("listener-say").id)).status).toBe("done");
    const noted = threadMessages(app, c.conversationId!).filter((m) => m.meta.meeting === "m1");
    expect(noted).toHaveLength(1);
    expect(noted[0].text).toContain("旁听会议「周会」时记下的");
    expect(noted[0].text).toContain("今晚八点回滚支付服务");
    expect(noted[0].meta).toMatchObject({ speaker: "会议「周会」" });
    expect((await waitForRun(app, window("listener-quiet").id)).status).toBe("done");
    expect(threadMessages(app, c.conversationId!).filter((m) => m.meta.meeting === "m1")).toHaveLength(1);
  }, 60_000);
});
