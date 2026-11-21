import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { answerAsk, createAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { itemDigestDue } from "../src/agents/jobs.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { askCard, registerLarkAsks, releaseDeferredAsks } from "../src/channels/lark-asks.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { notify } from "../src/core/notify.ts";
import { decideCandidate } from "../src/items/auto.ts";
import { askLineEnd } from "../src/items/lifecycle.ts";
import { decideNext, nextOf, submitLineState } from "../src/items/lines.ts";
import { setParent } from "../src/items/parent.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { attachBrief, buildToday, morningDue, proposalsDue, sendToday, TODAY_MAX, todayDue } from "../src/items/today.ts";
import { createProposal, expireProposals } from "../src/agents/proposals.ts";
import * as runner from "../src/agents/runner.ts";
import { __testHandlers } from "../src/agents/runs.ts";
import { weekLabel, weeklyPath } from "../src/agents/weekly-report.ts";
import { defineMetric, getMetric } from "../src/data/metrics.ts";
import { writeWorkFile } from "../src/sources/work.ts";
import { testApp } from "./helpers.ts";

const DAY = 86_400_000;

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 20));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});
/** Friday 2026-11-20, 10:00 where the owner is. */
const MORNING = new Date("2026-11-20T02:00:00Z");
function fresh(at = MORNING) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  const app = testApp();
  apps.push(app);
  app.config.timezone = "Asia/Shanghai";
  return app;
}
const running = (app: App, kind: Parameters<typeof createRun>[1]["kind"], input: Record<string, unknown> = {}) => {
  const r = createRun(app, { kind, spaceId: "personal", title: "测试", input });
  run(app.db, "update runs set status = 'running' where id = ?", r.id);
  return r;
};
const candidate = (app: App, title: string) => {
  const i = upsertItem(app, undefined, { title }, "agent");
  run(app.db, "update items set status = 'candidate' where id = ?", i.id);
  return i;
};

/** Two lines with new next steps (one with something due), a watched line, a proposal from last night, two candidates, one that expired. */
function morning(app: App) {
  const a = upsertItem(app, undefined, { kind: "line", title: "项目 A" }, "user");
  const b = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
  const watched = upsertItem(app, undefined, { kind: "line", title: "老的报表线" }, "user");
  run(app.db, "update items set phase = 'watching' where id = ?", watched.id);
  const due = upsertItem(app, undefined, { title: "接口联调", dueAt: "2026-11-22T10:00:00+08:00" }, "user");
  setParent(app, due.id, a.id);
  submitLineState(app, running(app, "agent", { lineState: a.id }).id, { now: "截至今天，运费一栏做完，等测试账号", next: [{ text: "读退款回调文档", why: "测试卡在回调", refs: [], kind: "read" }, { text: "改重试逻辑", why: "", refs: [], kind: "code" }] });
  submitLineState(app, running(app, "agent", { lineState: b.id }).id, { now: "截至今天，退款单上线", next: [{ text: "看退款失败数", why: "上线后第一周", refs: [], kind: "data" }] });
  const loose = upsertItem(app, undefined, { title: "对账口径" }, "user");
  const ws = createRun(app, { kind: "work-state", title: "近况" });
  setRunOutput(app, ws.id, { lineProposals: [
    { key: "p0", name: "项目 B 上线", goal: "12 月上线", items: [], sources: [] },
    { key: "p1", name: "退款对账", goal: "", items: [loose.id], sources: [] },
  ] });
  run(app.db, "update runs set status = 'done' where id = ?", ws.id);
  const c1 = candidate(app, "跟进发布单 #12"), c2 = candidate(app, "回复小王的排期");
  const gone = upsertItem(app, undefined, { title: "整理报销单" }, "user");
  upsertItem(app, gone.id, { status: "expired", note: "自动过期：14 天没有新进展（待办的默认期限），最后一次进展在 11 月 6 日。" }, "agent");
  // A member's line: not on the owner's card.
  const theirs = upsertItem(app, undefined, { kind: "line", title: "同事的线", userId: "member" } as never, "user");
  run(app.db, "insert into item_next(id,item_id,text,why,refs,kind,status,created_at,updated_at) values('nx_member',?,'同事的一步','','[]','read','open',?,?)", theirs.id, new Date().toISOString(), new Date().toISOString());
  return { a, b, watched, loose, ws, c1, c2, gone, theirs };
}

describe("今天：拼卡", () => {
  it("各段有内容时的文字和表单项，空的段不出现，全空不发", async () => {
    const app = fresh();
    expect(await buildToday(app)).toBeNull();
    const m = morning(app);
    const t = (await buildToday(app))!;
    expect(t.question.split("\n")[0]).toBe("**今天 · 11 月 20 日（周五）**");
    expect(t.question).toContain("**各条线**");
    expect(t.question).toContain("**项目 A**：截至今天，运费一栏做完，等测试账号");
    expect(t.question).toContain("快到期：「接口联调」11 月 22 日");
    expect(t.question).toContain("新的下一步 2 条");
    expect(t.question).toContain("**夜里整理出来的**");
    expect(t.question).toContain("「项目 B 上线」");
    expect(t.question).toContain("自动收尾 1 件");
    // The watched line without anything new, and the member's line, are not on it; nothing else waits, so no such section.
    expect(t.question).not.toContain("老的报表线");
    expect(t.question).not.toContain("同事的线");
    expect(t.question).not.toContain("等你处理");
    expect(t.question).not.toContain("不急的通知");
    expect([...new Set(t.fields.map((f) => f.group))]).toEqual(["「项目 A」的下一步", "「示例商城 · 退款改造」的下一步", "要建成工作线吗", "要不要跟", "自动收尾的"]);
    expect(t.fields.map((f) => f.id.slice(0, 2)).join("")).toBe("n_n_n_p_p_c_c_r_");
    const prop = t.fields.find((f) => f.id === "p_p0") as { options: string[] };
    expect(prop.options).toEqual(["建", "不用", "并进「项目 A」", "并进「示例商城 · 退款改造」", "并进「老的报表线」"]);
    expect(t.fields.find((f) => f.id === `r_${m.gone.id}`)).toMatchObject({ options: ["恢复", "就这样"], help: expect.stringContaining("14 天没有新进展") });
    expect(t.context).toMatchObject({ handler: "today", next: expect.any(Array), candidates: expect.arrayContaining([m.c2.id, m.c1.id]), reopen: [m.gone.id] });

    // Something waiting and a held notification: their sections come in.
    createAsk(app, { runId: null, question: "评审会定在周几？" });
    notify(app, { title: "后台查询完成", urgency: "later" });
    const t2 = (await buildToday(app))!;
    expect(t2.question).toContain("**等你处理（1）**：提问 1");
    expect(t2.question).toContain("- 评审会定在周几？");
    expect(t2.question).toContain("**不急的通知**：攒着 1 条");
  });

  it("每段有上限，多的写“还有 N 条”", async () => {
    const app = fresh();
    for (let i = 0; i < 12; i++) candidate(app, `候选 ${i}`);
    const t = (await buildToday(app))!;
    expect(t.fields.filter((f) => f.group === "要不要跟")).toHaveLength(TODAY_MAX.candidates);
    expect(t.question).toContain(`我建的 12 件候选，要不要跟（还有 ${12 - TODAY_MAX.candidates} 条在工作页。）`);
    // Held notifications alone are no card.
    run(app.db, "update items set status = 'cancelled'");
    notify(app, { title: "后台查询完成", urgency: "later" });
    expect(await buildToday(app)).toBeNull();
  });
});

describe("今天：提交", () => {
  it("答了的交给原来的处理；只答一部分；别处已经定了的跳过", async () => {
    const app = fresh();
    const m = morning(app);
    const ask = (await sendToday(app))!;
    expect(ask.ui!.fields!.length).toBeGreaterThan(5);
    const [read, code] = nextOf(app, m.a.id);
    // Decided on the line's page meanwhile, and one candidate put down on the work page.
    decideNext(app, read.id, "declined", "owner");
    decideCandidate(app, m.c2.id, false, "owner", "web");
    await answerAsk(app, ask.id, { value: { [`n_${read.id}`]: "就这么做", [`n_${code.id}`]: "就这么做", p_p0: "建", p_p1: "并进「项目 A」", [`c_${m.c1.id}`]: "留下", [`c_${m.c2.id}`]: "留下", [`r_${m.gone.id}`]: "恢复" }, by: "owner" });
    expect(nextOf(app, m.a.id, ["declined"]).map((n) => n.id)).toEqual([read.id]);
    expect(nextOf(app, m.a.id, ["doing"]).map((n) => n.id)).toEqual([code.id]);
    // 就这么做 queues one run on the step (nothing runs here).
    const runs = all<{ lane: string; status: string }>(app.db, "select lane, status from runs where json_extract(input, '$.lineNext') is not null");
    expect(runs).toEqual([{ lane: `line-next:${m.a.id}`, status: "queued" }]);
    expect(one(app.db, "select 1 from items where kind = 'line' and title = '项目 B 上线'")).toBeTruthy();
    expect(getItem(app, m.loose.id).parentId).toBe(m.a.id);
    expect(getItem(app, m.c1.id).status).toBe("open");
    expect(getItem(app, m.c2.id).status).toBe("cancelled");
    expect(getItem(app, m.gone.id).status).toBe("open");
    // Unanswered: the other line's step stays open.
    expect(nextOf(app, m.b.id).map((n) => n.status)).toEqual(["open"]);
    expect(getAsk(app, ask.id).result).toBe("已处理：开始做 1，建了线 1，并进线 1，留下 1，恢复 1");
    // What it offered is not offered again tomorrow.
    vi.setSystemTime(new Date("2026-11-21T02:00:00Z"));
    const next = await buildToday(app);
    expect(next?.fields.some((f) => f.id.startsWith("n_") || f.id.startsWith("p_") || f.id.startsWith("r_")) ?? false).toBe(false);
  });
});

describe("今天：开着和关掉", () => {
  it("开着时三张卡都不单独发，内容进了“今天”；一天一张，再跑不重发", async () => {
    const app = fresh();
    const m = morning(app);
    const member = upsertItem(app, undefined, { title: "同事的待办", userId: "member" } as never, "user");
    upsertItem(app, member.id, { status: "expired", note: "自动过期：14 天没有新进展。" }, "agent");
    expect(proposalsDue(app, m.ws.id)).toBeNull();
    const sent = await itemDigestDue(app);
    expect(sent.map((n) => n.userId)).toEqual(["member"]);
    vi.setSystemTime(new Date("2026-11-20T01:00:00Z")); // 09:00: not yet
    expect(await morningDue(app)).toBeNull();
    vi.setSystemTime(MORNING);
    const ask = (await morningDue(app))!;
    expect(ask.handler).toBe("today");
    expect(ask.userId).toBe("owner");
    expect(ask.question).toContain("项目 B 上线");
    expect(ask.question).toContain("自动收尾 1 件");
    expect(await morningDue(app)).toBeNull();
    expect(await todayDue(app, new Date("2026-11-20T08:00:00Z"))).toBeNull();
    expect(listAsks(app, { status: "pending" }).map((a) => a.handler).filter((h) => h === "line-next" || h === "line-propose")).toEqual([]);
  });

  it("关掉时各发各的：下一步卡、清点卡、提议卡", async () => {
    const app = fresh();
    app.config.notify.today = { ...app.config.notify.today, enabled: false };
    const m = morning(app);
    expect(proposalsDue(app, m.ws.id)?.handler).toBe("line-propose");
    expect((await itemDigestDue(app)).map((n) => n.userId).sort()).toEqual(["owner"]);
    expect((await morningDue(app))?.handler).toBe("line-next");
    expect(await todayDue(app)).toBeNull();
  });
});

const proposal = (app: App, title: string, kind: "settings" | "prompt" = "settings") =>
  createProposal(app, { target: "assistant", kind, title, reason: "最近三次都要本人补查", content: kind === "settings" ? { add_tools: ["scan"] } : { prompt: "新的提示词" }, runId: null });
const proposedMetric = (app: App, name: string) =>
  defineMetric(app, { name, why: "上线后退款失败的有多少", query: "按天数退款失败单", unit: "单" }, { by: "agent" });

describe("今天：复盘提的改动和 AI 提议的指标", () => {
  it("各有一段，有上限，多的写“还有 N 条”并链到各自的清单；改设置的和指标能在卡上定，改提示词的只给链接", async () => {
    const app = fresh();
    const settings = [0, 1, 2, 3].map((i) => proposal(app, `加上全文检索 ${i}`));
    run(app.db, "update profile_proposals set created_at = ? where id = ?", "2026-11-19T00:00:00.000Z", settings[3]);
    const prompt = proposal(app, "回答前先查事项", "prompt");
    // The one about to expire comes first, with its day.
    run(app.db, "update profile_proposals set expiry_notice_at = ? where id = ?", "2026-11-19T19:00:00.000Z", prompt);
    const ms = [0, 1, 2, 3, 4, 5].map((i) => proposedMetric(app, `退款失败数 ${i}`));
    const t = (await buildToday(app))!;
    expect(t.question).toContain("**复盘提的改动（5）**");
    expect(t.question).toMatch(/「assistant」改写提示词：回答前先查事项（12 月 4 日过期），\[看一下再定\]\([^)]*#\/agents\?tab=agents&role=assistant\)/);
    expect(t.question).toContain(`还有 ${5 - TODAY_MAX.profiles} 条在 [Agent 页]`);
    const a = t.fields.filter((f) => f.group === "复盘提的改动");
    expect(a).toHaveLength(TODAY_MAX.profiles - 1);
    expect(a[0]).toMatchObject({ options: ["采纳", "不要"], help: "最近三次都要本人补查" });
    expect(t.question).toContain("**AI 提议的指标（6）**");
    expect(t.question).toContain(`还有 ${6 - TODAY_MAX.metrics} 条在 [数据页]`);
    expect(t.fields.filter((f) => f.group === "AI 提议的指标")).toHaveLength(TODAY_MAX.metrics);
    // Not counted again under 等你处理.
    expect(t.question).not.toContain("等你处理");

    const ask = (await sendToday(app))!;
    const ctx = JSON.parse(one<{ context: string }>(app.db, "select context from asks where id = ?", ask.id)!.context) as { metrics: string[]; profiles: string[] };
    const [keep, drop] = ctx.metrics;
    const [take, no] = ctx.profiles;
    // One decided on the data page meanwhile.
    defineMetric(app, { id: ms[5].id, name: ms[5].name, status: "dropped" }, { by: "owner" });
    await answerAsk(app, ask.id, { value: { [`a_${take}`]: "采纳", [`a_${no}`]: "不要", [`m_${keep}`]: "留下", [`m_${drop}`]: "不要", [`m_${ms[5].id}`]: "留下" }, by: "owner" });
    const status = (id: string) => one<{ status: string }>(app.db, "select status from profile_proposals where id = ?", id)!.status;
    expect([status(take), status(no), status(prompt)]).toEqual(["applied", "rejected", "pending"]);
    expect([getMetric(app, keep)!.status, getMetric(app, drop)!.status, getMetric(app, ms[5].id)!.status]).toEqual(["active", "dropped", "dropped"]);
    expect(getAsk(app, ask.id).result).toBe("已处理：采纳改动 1，不要改动 1，留下指标 1，不要指标 1");
  });

  it("开着时复盘不另发过期通知，卡上写哪天过期；关着时照旧发通知", async () => {
    const app = fresh();
    const id = proposal(app, "加上全文检索");
    run(app.db, "update profile_proposals set created_at = ? where id = ?", new Date(Date.now() - 13 * DAY).toISOString(), id);
    expect(await expireProposals(app)).toEqual({ expired: 0, noticed: 1 });
    expect(all(app.db, "select 1 from notifications")).toHaveLength(0);
    expect((await buildToday(app))!.fields.find((f) => f.id === `a_${id}`)!.label).toContain("过期）");

    const off = fresh();
    off.config.notify.today = { ...off.config.notify.today, enabled: false };
    const id2 = proposal(off, "加上全文检索");
    run(off.db, "update profile_proposals set created_at = ? where id = ?", new Date(Date.now() - 13 * DAY).toISOString(), id2);
    await expireProposals(off);
    expect(all(off.db, "select 1 from notifications")).toHaveLength(1);
  });
});

describe("今天：简报", () => {
  const BRIEF = "今天先回小王的排期：联调卡在测试账号上，他在等你一句话。已备好：上月退款失败的 12 单查清了，都是满减分摊。";
  it("先写好的是卡的开头一段；没写就没有", async () => {
    const app = fresh();
    morning(app);
    expect((await buildToday(app))!.question).not.toContain("联调卡在测试账号");
    expect(await attachBrief(app, BRIEF)).toBe("held");
    const q = (await buildToday(app))!.question.split("\n\n");
    expect(q[0]).toBe("**今天 · 11 月 20 日（周五）**");
    expect(q[1]).toBe(BRIEF);
    // Yesterday's brief is not today's.
    vi.setSystemTime(new Date("2026-11-21T02:00:00Z"));
    expect((await buildToday(app))?.question ?? "").not.toContain("联调卡在测试账号");
  });

  it("晚到的更新同一张卡；卡答过了交给调用方照旧发；那天没别的事就单发一张", async () => {
    const app = fresh();
    morning(app);
    const ask = (await todayDue(app))!;
    expect(ask.question).not.toContain(BRIEF);
    expect(await attachBrief(app, BRIEF)).toBe("revised");
    const after = getAsk(app, ask.id);
    expect(after.status).toBe("pending");
    expect(after.question.split("\n\n")[1]).toBe(BRIEF);
    expect(after.ui!.fields!.length).toBe(ask.ui!.fields!.length);
    expect(listAsks(app, { status: "pending" }).filter((a) => a.handler === "today")).toHaveLength(1);
    // Twice: still one paragraph.
    await attachBrief(app, BRIEF);
    expect(getAsk(app, ask.id).question.split(BRIEF)).toHaveLength(2);
    await answerAsk(app, ask.id, { value: {}, by: "owner" });
    expect(await attachBrief(app, BRIEF)).toBe("late");

    const quiet = fresh();
    expect(await todayDue(quiet)).toBeNull();
    expect(await attachBrief(quiet, BRIEF)).toBe("sent");
    const only = listAsks(quiet, { status: "pending" }).find((a) => a.handler === "today")!;
    expect(only.question.split("\n\n")).toEqual(["**今天 · 11 月 20 日（周五）**", BRIEF]);
  });

  it("简报运行：开着时不给 notify、写进卡里；关着时照旧自己发", async () => {
    const seen: { deny?: string[]; task: string }[] = [];
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      seen.push({ deny: input.denyTools, task: input.task });
      return { text: BRIEF, profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    try {
      for (const on of [true, false]) {
        const app = fresh();
        if (!on) app.config.notify.today = { ...app.config.notify.today, enabled: false };
        const r = createRun(app, { kind: "brief", title: "简报", spaceId: "personal" });
        const out = await __testHandlers.get("brief")!({ app, run: r, signal: new AbortController().signal, event() {}, output() {} });
        if (on) {
          expect(out).toMatchObject({ today: "held" });
          expect((await buildToday(app))!.question).toContain(BRIEF);
        } else expect(out).not.toHaveProperty("today");
      }
      expect(seen.map((s) => s.deny ?? [])).toEqual([["notify"], []]);
      expect(seen[0].task.split("\n")[0]).toContain("并进“今天”");
      expect(seen[1].task.split("\n")[0]).toContain("单独发");
    } finally { fake.mockRestore(); }
  });
});

describe("今天：周五的周报", () => {
  it("周五写好了才有那一行，别的日子没有", async () => {
    const app = fresh();
    morning(app);
    expect((await buildToday(app))!.question).not.toContain("本周的周报");
    const f = writeWorkFile(app, { spaceId: "personal", path: weeklyPath(weekLabel(app)), text: "# 这周\n\n退款单上线。" });
    expect((await buildToday(app))!.question).toContain(`本周的周报写好了：[周报 · ${weekLabel(app)}]`);
    expect((await buildToday(app))!.question).toContain(`#/sources/${f.id}`);
    vi.setSystemTime(new Date("2026-11-19T02:00:00Z")); // Thursday
    expect((await buildToday(app))!.question).not.toContain("本周的周报");
  });
});

describe("今天：免打扰和夜里的询问", () => {
  it("到点在免打扰里就等免打扰结束；夜里问的线要不要结束并进这张，答了交给原来的处理", async () => {
    const app = fresh(new Date("2026-11-19T18:00:00Z")); // 02:00 on the 20th
    app.config.notify.today = { ...app.config.notify.today, at: "08:00" };
    const post = vi.fn(async () => ({ code: 0, data: { message_id: "om_card" } }));
    registerLarkAsks(app, () => "ou_owner");
    const patch = vi.fn(async () => ({ code: 0 }));
    setLarkClient({ im: { message: { create: post, patch } } });
    try {
      const line = upsertItem(app, undefined, { kind: "line", title: "项目 A" }, "user");
      upsertItem(app, undefined, { title: "还开着的事" }, "user");
      const end = askLineEnd(app, getItem(app, line.id), "观察了 30 天，最近没有动静")!;
      expect(one(app.db, "select json_extract(context,'$.deferredUntil') later from asks where id = ?", end.id)).toEqual({ later: "2026-11-20T01:00:00.000Z" });
      vi.setSystemTime(new Date("2026-11-20T00:00:00Z")); // 08:00, still quiet
      const ask = (await todayDue(app))!;
      expect(ask.ui!.fields!.find((f) => f.id === `e_${end.id}`)).toMatchObject({ group: "线要不要结束", options: ["结束", "再看一周", "还没完（回到进行中）"] });
      expect(one(app.db, "select json_extract(context,'$.deferredUntil') later from asks where id = ?", ask.id)).toEqual({ later: "2026-11-20T01:00:00.000Z" });
      expect(post).toHaveBeenCalledTimes(0);
      // The Feishu card shows the form by sections.
      const card = JSON.stringify(askCard(app, ask));
      expect(card).toContain("**线要不要结束**");
      expect(card).toContain(`f_e_${end.id}`);
      vi.setSystemTime(new Date("2026-11-20T01:00:00Z"));
      await releaseDeferredAsks(app);
      // Only 今天 goes out; the night's question is on it.
      expect(post).toHaveBeenCalledTimes(1);
      // The brief done after it: the card sent is edited, nothing new is sent.
      expect(await attachBrief(app, "今天先定项目 A 要不要结束。")).toBe("revised");
      expect(post).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(patch.mock.calls[0])).toContain("今天先定项目 A 要不要结束。");
      await answerAsk(app, ask.id, { value: { [`e_${end.id}`]: "再看一周" }, by: "owner" });
      expect(getAsk(app, end.id).status).toBe("answered");
      expect(getItem(app, line.id).phase).toBe("watching");
    } finally {
      setLarkClient(null);
    }
  });
});
