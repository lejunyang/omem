import { describe, expect, it } from "vitest";
import { learningTick } from "../src/agents/jobs.ts";
import { receive } from "../src/agents/inbox.ts";
import { listRuns } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { listNotifications } from "../src/core/notify.ts";
import { createCard, learningProgress, reviewCard, studyStats } from "../src/learn/cards.ts";
import { getGoal, listGoals, upsertGoal } from "../src/learn/goals.ts";
import { testApp } from "./helpers.ts";

describe("learning goals", () => {
  it("feeds once a day, reminds at the goal's time, and tracks progress", () => {
    const app = testApp();
    app.config.timezone = "UTC";
    const g = upsertGoal(app, undefined, { title: "英语会议表达", spaceId: "personal", remindAt: "00:00", dailyNew: 5 });
    const c1 = createCard(app, { spaceId: "personal", front: "follow up on", back: "跟进", goalId: g.id }).card;
    createCard(app, { spaceId: "personal", front: "circle back", back: "回头再讨论", goalId: g.id });
    run(app.db, "update cards set due_at = ?", new Date(Date.now() - 1000).toISOString());

    learningTick(app);
    expect(listRuns(app, { kind: "learn-feed" })).toHaveLength(1);
    expect(listNotifications(app).some((n) => n.title.includes("英语会议表达") && n.body.includes("2 张卡到期"))).toBe(true);
    // Not again the same day.
    learningTick(app);
    expect(listNotifications(app).filter((n) => n.title.includes("英语会议表达"))).toHaveLength(1);
    expect(getGoal(app, g.id).lastRemindedAt).toBeTruthy();

    reviewCard(app, c1.id, 1);
    reviewCard(app, c1.id, 3);
    const p = learningProgress(app, { goalId: g.id });
    expect(p.reviews).toBe(2);
    expect(p.recall).toBe(0.5);
    expect(p.streak).toBe(1);
    expect(studyStats(app, { goalId: g.id }).reviewedToday).toBe(2);
    expect(listGoals(app, { status: "active" })).toHaveLength(1);
  });

  it("reviews in chat with /review, plain replies and ratings", async () => {
    const app = testApp();
    createCard(app, { spaceId: "personal", front: "touch base", back: "简单沟通一下" });
    run(app.db, "update cards set due_at = ?", new Date(Date.now() - 1000).toISOString());
    const start = await receive(app, { channel: "lark", chatId: "oc_me", text: "/review" });
    expect(start.reply).toMatch(/touch base/);
    const back = await receive(app, { channel: "lark", chatId: "oc_me", text: "不记得了" });
    expect(back.runId).toBeNull();
    expect(back.reply).toMatch(/简单沟通一下/);
    expect((await receive(app, { channel: "lark", chatId: "oc_me", text: "好" })).reply).toMatch(/回复 1～4/);
    const done = await receive(app, { channel: "lark", chatId: "oc_me", text: "3" });
    expect(done.reply).toMatch(/复习完了，本次 1 张/);
    expect(studyStats(app).reviewedToday).toBe(1);
  });
});
