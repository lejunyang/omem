import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { receive, registerThreadSender, flushRecoveredReplies, deliverToThread } from "../src/agents/inbox.ts";
import { getRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { threadMessages } from "../src/agents/threads.ts";
import { App } from "../src/core/app.ts";
import { all, run } from "../src/core/db.ts";
import { boot } from "../src/main.ts";
import { testApp } from "./helpers.ts";

it("resumes channel turns without a live adapter waiter and retries their saved reply after reconnecting", async () => {
  const previous = testApp();
  writeFileSync(resolve(previous.home, "config.json"), JSON.stringify({
    agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" } }] },
    sessions: { mergeMs: 0 },
  }));
  const pending = await receive(previous, { channel: "recovery-test", chatId: "room", text: "请核对项目 A", mergeMs: 0 });
  run(previous.db, "update runs set status = 'running' where id = ?", pending.runId);
  const web = await receive(previous, { channel: "web", chatId: "web-room", text: "网页提问", mergeMs: 0 });
  const home = previous.home;
  previous.db.close();
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(async () => { releaseAll(); await server.close(); });

  expect((await waitForRun(app, pending.runId!)).status).toBe("done");
  expect(getRun(app, pending.runId!).input.recoverReply).toBe(true);
  expect(getRun(app, pending.runId!).output.channelDelivered).toBe(true);
  await waitForRun(app, web.runId!);
  expect(getRun(app, web.runId!).input.recoverReply).toBeUndefined();
  expect(all(app.db, "select key from kv where key glob 'recovered-reply:*'")).toHaveLength(1);

  const posted: { text: string; messageId: string }[] = [];
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>(ok => { release = ok; });
  const unregister = registerThreadSender("recovery-test", async (_t, text, meta, messageId) => {
    attempts++;
    expect(meta.runId).toBe(pending.runId);
    if (attempts === 1) throw new Error("channel reconnecting");
    await gate;
    posted.push({ text, messageId });
  });
  try {
    await flushRecoveredReplies(app);
    expect(all(app.db, "select key from kv where key glob 'recovered-reply:*'")).toHaveLength(1);
    // A new database handle sees the persisted reply; concurrent checks do not send it twice.
    const reopened = App.open(home);
    try {
      const sending = flushRecoveredReplies(reopened);
      await flushRecoveredReplies(app);
      release();
      await sending;
      await flushRecoveredReplies(app);
    } finally { reopened.db.close(); }
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0].text).msgs).toEqual(["请核对项目 A"]);
    const answers = threadMessages(app, pending.thread.id).filter(m => m.role === "assistant");
    expect(answers).toHaveLength(1);
    expect(answers[0].id).toBe(posted[0].messageId);
    expect(answers[0].meta.deliveredAt).toBeTruthy();
    expect(all(app.db, "select key from kv where key glob 'recovered-reply:*'")).toEqual([]);
  } finally { release(); unregister(); }

  // A flush waiting on the first reply must not resend the second one if another flush sent it.
  await deliverToThread(app, pending.thread.id, "第一份结果", { recoverReply: true });
  await deliverToThread(app, pending.thread.id, "第二份结果", { recoverReply: true });
  const firstKey = all<{ value: string }>(app.db, "select value from kv where key glob 'recovered-reply:*' order by key")[0];
  const firstId = JSON.parse(firstKey.value).messageId;
  const sent: string[] = [];
  let unblock!: () => void;
  const firstGate = new Promise<void>(ok => { unblock = ok; });
  const remove = registerThreadSender("recovery-test", async (_t, _text, _meta, id) => {
    if (id === firstId) await firstGate;
    sent.push(id);
  });
  try {
    const slow = flushRecoveredReplies(app);
    await flushRecoveredReplies(app);
    unblock();
    await slow;
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
  } finally { unblock(); remove(); }
}, 30000);
