import { afterEach, expect, it } from "vitest";
import { createThread, getThread, updateThread } from "../src/agents/threads.ts";
import { releaseTopicRoot } from "../src/channels/lark-bot.ts";
import { onLarkSent, sendLark, setLarkClient } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

afterEach(() => { setLarkClient(null); onLarkSent(null); });

it("reports when a reply opens a topic under a message", async () => {
  const seen: unknown[] = [];
  onLarkSent((s) => seen.push(s.topicRoot));
  setLarkClient({ im: { message: { reply: async ({ data }: any) => ({ code: 0, data: { message_id: "om_r", chat_id: "oc_dm", ...(data.reply_in_thread ? { thread_id: "omt_new" } : {}) } }) } } });
  await sendLark({ replyTo: "om_root", inThread: true }, { text: "这项任务在本话题中开始" });
  await sendLark({ replyTo: "om_plain" }, { text: "普通回复" });
  expect(seen).toEqual([{ root: "om_root", topicId: "omt_new" }, undefined]);
});

it("a main-stream conversation stops replying to a message that became another conversation's topic root", () => {
  const app = testApp();
  try {
    const main = createThread(app, { channel: "lark", key: "oc_dm", spaceId: "personal", userId: "owner" });
    updateThread(app, main.id, { settings: { lastMessageId: "om_root", lastTopicId: null } });
    const coding = createThread(app, { channel: "lark", key: "oc_group", spaceId: "personal", userId: "owner" });
    updateThread(app, coding.id, { settings: { lastMessageId: "om_request" } });
    // /topic (no conversation yet): the main stream lets go of the root, so its later posts go to the chat itself.
    releaseTopicRoot(app, "oc_dm", "om_root", { conversationId: null, runId: null });
    expect(getThread(app, main.id).settings.lastMessageId).toBeUndefined();
    // A conversation opening a topic under its own request (a coding progress card) keeps it: its answer belongs there.
    releaseTopicRoot(app, "oc_group", "om_request", { conversationId: coding.id, runId: null });
    expect(getThread(app, coding.id).settings.lastMessageId).toBe("om_request");
  } finally { app.db.close(); }
});
