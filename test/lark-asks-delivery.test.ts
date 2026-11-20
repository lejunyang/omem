import { expect, it, vi } from "vitest";
import { answerAsk, createAsk, lapseAsk } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { registerLarkAsks, releaseDeferredAsks } from "../src/channels/lark-asks.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { one, run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

it("holds background cards until morning, sends live questions and approvals, skips settled asks", async () => {
  const app = testApp();
  app.config.timezone = "Asia/Shanghai";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-04-01T02:50:00+08:00"));
  const post = vi.fn(async () => ({ code: 0, data: { message_id: "om_card" } }));
  registerLarkAsks(app, () => "ou_owner");
  setLarkClient({ im: { message: { create: post, patch: async () => ({ code: 0 }) } } });
  try {
    const proposal = () => createAsk(app, { runId: null, question: "建成工作线？", context: { handler: "line-propose" } });
    const waiting = proposal();
    const answered = proposal();
    const lapsed = proposal();
    const background = createRun(app, { kind: "ask", title: "定时整理", trigger: { via: "schedule" } });
    run(app.db, "update runs set status='running' where id=?", background.id);
    createAsk(app, { runId: background.id, question: "补充哪一项？" });
    const state = () => one(app.db, "select json_extract(context,'$.deferredUntil') later, json_extract(context,'$.sentAt') sent from asks where id=?", waiting.id);
    expect(state()).toEqual({ later: "2026-04-01T01:00:00.000Z", sent: null });
    expect(post).toHaveBeenCalledTimes(0);
    const live = createRun(app, { kind: "ask", title: "当轮", trigger: { via: "chat", by: { key: "user:owner", name: "你" } } });
    run(app.db, "update runs set status='running' where id=?", live.id);
    createAsk(app, { runId: live.id, question: "选哪天？" });
    createAsk(app, { runId: null, kind: "approval", question: "批准？" });
    await expect.poll(() => post.mock.calls.length).toBe(2);
    await answerAsk(app, answered.id, { text: "不用", by: "owner" });
    lapseAsk(app, lapsed.id, "已结束");
    vi.setSystemTime(new Date("2026-04-01T09:00:00+08:00"));
    await Promise.all([releaseDeferredAsks(app), releaseDeferredAsks(app)]);
    await releaseDeferredAsks(app);
    expect(post).toHaveBeenCalledTimes(4);
    expect(state()).toEqual({ later: null, sent: "2026-04-01T01:00:00.000Z" });
  } finally {
    vi.useRealTimers();
    setLarkClient(null);
    app.db.close();
  }
});
