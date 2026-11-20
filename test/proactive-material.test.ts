import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/agents/jobs.ts";
import { __testHandlers, createRun, listRuns } from "../src/agents/runs.ts";
import * as runner from "../src/agents/runner.ts";
import { nightlyProfileReviews, reviewTask } from "../src/agents/profile-jobs.ts";
import { ownerEdits, previousReport, scheduleWeeklyReport, weekLabel, weeklyPath } from "../src/agents/weekly-report.ts";
import { DEFAULT_CONTEXT_ID, defaultContext, saveContext } from "../src/channels/listen.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { ensureDefaultSchedules, listSchedules } from "../src/core/scheduler.ts";
import { defineMetric, recordPoints } from "../src/data/metrics.ts";
import { recordFiring } from "../src/rules/store.ts";
import { writeWorkFile } from "../src/sources/work.ts";
import { testApp } from "./helpers.ts";

type Role = Parameters<typeof runner.runRole>[1];
const fakeResult = (text: string) => ({ text, stopReason: "end_turn", agent: "fake", profileId: "fake", ai: { profile: "fake" } }) as Awaited<ReturnType<typeof runner.runRole>>;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

/** A case of a 关注 (reply_samples), the way the handlers and the triage record them. */
function addCase(app: App, c: { id: string; context: string; ask: string; asker?: string; decision?: string | null; draft?: string; final?: string; reason?: string; ownerReply?: string; verdict?: string; handleRun?: string; at?: string }) {
  const at = c.at ?? new Date().toISOString();
  run(
    app.db,
    `insert into reply_samples(id,handle_run,channel,chat_id,chat_kind,chat_name,asker_name,ask,last_ms,draft,decision,final,reason,decided_at,owner_reply,owner_reply_at,verdict,created_at,context_id,source)
     values(?,?,'lark','oc_ops','group','值班群',?,?,0,?,?,?,?,?,?,?,?,?,?,'watch')`,
    c.id, c.handleRun ?? null, c.asker ?? "小王", c.ask, c.draft ?? null, c.decision ?? null, c.final ?? null, c.reason ?? null, c.decision ? at : null,
    c.ownerReply ?? null, c.ownerReply ? at : null, c.verdict ?? null, at, c.context,
  );
}

function finish(app: App, id: string, output: Record<string, unknown>, quiet = false) {
  run(app.db, "update runs set status = 'done', started_at = ?, finished_at = ?, output = ?, quiet = ? where id = ?", ago(60_000), new Date().toISOString(), JSON.stringify(output), quiet ? 1 : 0, id);
}

afterEach(() => vi.restoreAllMocks());

describe("the nightly dream reads what the 关注, the assistant's items, the rules and the metrics showed", () => {
  it("puts each 关注 with news, its corrections, keep/drop counts, rule firings and metrics past their threshold into the task", async () => {
    const app = testApp();
    run(app.db, "insert into kv(key,value) values('dream_at', ?)", ago(3600_000));
    const ops = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"], knobs: { reply: "draft" } });
    saveContext(app, { kind: "place", name: "安静的群", chats: ["oc_quiet"] });
    run(app.db, "update conversations set summary = ?, summary_at = ? where id = ?", "这周主要在排查支付回调超时，小王负责重试。", new Date().toISOString(), ops.conversationId);
    addCase(app, { id: "rs_fix1", context: ops.id, ask: "退款按单还是按行算？", draft: "按单退", decision: "edited", final: "按未发货的行退" });
    addCase(app, { id: "rs_own1", context: ops.id, ask: "回调超时谁在看？", decision: "quiet", ownerReply: "我在看，下午给结论" });
    addCase(app, { id: "rs_old1", context: ops.id, ask: "上周的问题", decision: "sent", at: ago(5 * 86400_000) });
    // An item the patrol made on its own that the owner did not want.
    run(app.db, `insert into reply_samples(id,channel,chat_id,chat_kind,chat_name,asker_name,ask,last_ms,decision,final,reason,decided_at,settled_at,created_at,source)
      values('rs_item1','omem','personal','item','','heartbeat',?,0,'dropped','i_demo','candidate-dropped',?,?,?,'item')`, "跟进发布窗口\n本人在群里提过发布", new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    // A rule that acted once and failed once.
    run(app.db, "insert into rules(id,name,description,enabled,trigger,actions,created_at,updated_at) values('r_demo','报错转值班','报错消息转给值班群',1,'{}','[]',?,?)", ago(86400_000), ago(86400_000));
    recordFiring(app, { ruleId: "r_demo", eventKey: "k1", summary: "报错", judgedBy: "code", reason: "", results: [{ action: "forward", ok: true, detail: "已转发" }] });
    recordFiring(app, { ruleId: "r_demo", eventKey: "k2", summary: "报错", judgedBy: "code", reason: "", results: [{ action: "forward", ok: false, detail: "机器人不在目标群" }] });
    // A metric past its threshold tonight.
    const m = defineMetric(app, { name: "支付回调超时", unit: "次", query: "查网关日志里回调超时的次数，按天", direction: "down-good" });
    for (const [i, v] of [10, 11, 10, 9].entries()) await recordPoints(app, m.id, [{ value: v, at: day(5 - i) }]);
    await recordPoints(app, m.id, [{ value: 30, at: day(0) }]);

    const tasks: string[] = [];
    vi.spyOn(runner, "runRole").mockImplementation(async (_app, input: Role) => {
      tasks.push(input.task);
      return fakeResult("整理完了");
    });
    const r = createRun(app, { kind: "dream", spaceId: "personal", title: "整理记忆与页面" });
    await __testHandlers.get("dream")!({ app, run: r, signal: new AbortController().signal, event: vi.fn(), output: vi.fn() });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task).toContain("## 关注、自动建的事项、规则和指标");
    expect(task).toContain(`「值班群」${ops.id}`);
    expect(task).toContain("回复：草稿；问本人的：只提醒本人");
    expect(task).toContain("会话摘要（上次以来更新过）：这周主要在排查支付回调超时");
    expect(task).toContain("新案例 2 个");
    expect(task).toContain("其中本人纠正 2 个");
    expect(task).toContain("[rs_fix1]");
    expect(task).toContain("本人改了再发：按未发货的行退");
    expect(task).toContain("本人自己回了：我在看");
    expect(task).not.toContain("rs_old1");
    expect(task).toMatch(/其余没有新动静：[^\n]*「安静的群」/);
    expect(task).toContain("巡检：留下 0、不要 1");
    expect(task).toContain("「报错转值班」r_demo：触发 2 次，做了 1、让开 0、失败 1；最近一次失败 forward：机器人不在目标群");
    expect(task).toContain("支付回调超时：30次（基线 10次，+200%），变差");
  });

  it("looks even when no memory or item changed, as long as a 关注 has new cases; stays quiet when nothing at all is new", async () => {
    const app = testApp();
    run(app.db, "insert into kv(key,value) values('dream_at', ?)", ago(3600_000));
    const role = vi.spyOn(runner, "runRole").mockResolvedValue(fakeResult("没什么要改的"));
    const dream = () => __testHandlers.get("dream")!({ app, run: createRun(app, { kind: "dream", spaceId: "personal", title: "整理" }), signal: new AbortController().signal, event: vi.fn(), output: vi.fn() });
    expect(await dream()).toMatchObject({ quiet: true });
    expect(role).not.toHaveBeenCalled();
    addCase(app, { id: "rs_new", context: defaultContext(app).id, ask: "能帮忙看下这个报错吗", draft: "看了，是配置问题", decision: "dropped", reason: "owner-decides" });
    await dream();
    expect(role).toHaveBeenCalledOnce();
    expect((role.mock.calls[0][1] as Role).task).toContain("「有人找你」listen_default");
  });
});

describe("the coach reviews the assistant's handling of other people's messages", () => {
  it("samples someone-looks-for-you and 关注 runs beside the owner's asks, with their cases and the 关注's lessons", () => {
    const app = testApp();
    const since = ago(86400_000);
    const ops = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"], brief: { handle: ["线上报错"], skip: ["闲聊"], valid: "有日志依据", at: new Date().toISOString() } });
    writeWorkFile(app, { spaceId: "personal", path: "关注/值班群/经验.md", text: "## 报错\n先查日志再回，没有依据不下结论。" });
    // The owner's own ask.
    const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "帮我查下发布时间", input: { conversationId: "c_owner" }, lane: "c_owner" });
    finish(app, ask.id, { answer: "下周二发布" });
    // A turn of the 关注's handling conversation, whose draft the owner rewrote.
    const handled = createRun(app, { kind: "ask", spaceId: "personal", title: "值班群：支付报错", input: { conversationId: ops.conversationId }, lane: ops.conversationId! });
    finish(app, handled.id, { answer: "（拟了一条回复）" });
    addCase(app, { id: "rs_l1", context: ops.id, ask: "支付报错是不是网关的问题？", draft: "是网关的问题", decision: "edited", final: "日志里是下游超时，不是网关", handleRun: handled.id });
    // A quiet one that counts because the owner answered where it stayed quiet.
    const quiet = createRun(app, { kind: "ask", spaceId: "personal", title: "值班群：谁在看", input: { conversationId: ops.conversationId }, lane: ops.conversationId! });
    finish(app, quiet.id, { answer: "" }, true);
    addCase(app, { id: "rs_l2", context: ops.id, ask: "这个告警谁在看？", decision: "quiet", reason: "不是问本人的", ownerReply: "我在看", handleRun: quiet.id });
    // Someone looking for the owner.
    const mention = createRun(app, { kind: "agent", spaceId: "personal", title: "有人找你：小李（私聊）", input: { spec: "assistant", task: "…", mention: { chatId: "oc_p2p" }, conversationId: "c_owner" } });
    finish(app, mention.id, { answer: "小李要接口文档：已经找到，附了链接" });
    addCase(app, { id: "rs_m1", context: DEFAULT_CONTEXT_ID, ask: "接口文档在哪", draft: "在 Wiki 的接口页", decision: "dropped", reason: "verbose", handleRun: mention.id });
    // A quiet 关注 turn nobody corrected stays out.
    const idle = createRun(app, { kind: "ask", spaceId: "personal", title: "值班群：闲聊", input: { conversationId: ops.conversationId }, lane: ops.conversationId! });
    finish(app, idle.id, { answer: "" }, true);

    const { runs, task } = reviewTask(app, "assistant", since);
    expect(runs).toBe(4);
    expect(task).toContain(ask.id);
    expect(task).toContain(`${handled.id}（ask/done · 关注「值班群」的处理`);
    expect(task).toContain(`${mention.id}（agent/done · 有人找你`);
    expect(task).toContain(quiet.id);
    expect(task).not.toContain(idle.id);
    expect(task).toContain("它处理的案例");
    expect(task).toContain("[rs_l1]");
    expect(task).toContain("本人改了再发：日志里是下游超时，不是网关");
    expect(task).toContain("本人自己回了：我在看");
    expect(task).toContain("本人没发（太啰嗦）");
    expect(task).toContain("# 这些运行所在关注的说明和经验");
    expect(task).toContain("先查日志再回，没有依据不下结论");
    expect(task).toContain("- 要处理：线上报错");
  });

  it("the nightly pass reviews the assistant when only a case shows the owner correcting it", () => {
    const app = testApp();
    const ops = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"] });
    for (let i = 0; i < 3; i++) {
      const r = createRun(app, { kind: "ask", spaceId: "personal", title: `值班群 ${i}`, input: { conversationId: ops.conversationId }, lane: ops.conversationId! });
      finish(app, r.id, { answer: `草稿 ${i}` });
      addCase(app, { id: `rs_n${i}`, context: ops.id, ask: `问题 ${i}`, draft: `草稿 ${i}`, decision: i ? "sent" : "dropped", reason: i ? undefined : "wrong", handleRun: r.id });
    }
    expect(nightlyProfileReviews(app)).toBe(1);
    expect(listRuns(app, { kind: "profile-review" }).map((r) => r.input.target)).toEqual(["assistant"]);
  });
});

describe("the weekly report", () => {
  it("is a Friday 17:00 schedule, on by default", () => {
    const app = testApp();
    ensureDefaultSchedules(app);
    expect(listSchedules(app).find((s) => s.id === "weekly-report")).toMatchObject({ kind: "weekly-report", cron: "0 17 * * 5", enabled: true });
  });

  it("names its file by the ISO week in the owner's time zone", () => {
    const app = testApp();
    app.config.timezone = "Asia/Shanghai";
    expect(weekLabel(app, new Date("2026-11-20T09:00:00Z"))).toBe("2026-W47");
    // 2027-01-01 is a Friday: the week is still 2026's 53rd.
    expect(weekLabel(app, new Date("2027-01-01T09:00:00Z"))).toBe("2026-W53");
    // Sunday 16:30 UTC is Monday 00:30 in Shanghai: the local date decides.
    expect(weekLabel(app, new Date("2026-11-22T16:30:00Z"))).toBe("2026-W48");
    expect(weeklyPath("2026-W47")).toBe("周报/2026-W47.md");
    expect(ownerEdits("a\nb\nc", "a\nc2\nc")).toEqual({ removed: ["b"], added: ["c2"] });
  });

  it("runs the brief role on the week's material and last week's report as the owner left it, then sends one later notification", async () => {
    const app = testApp();
    const label = weekLabel(app);
    const prevLabel = "2000-W01";
    // Last week's report: what the run wrote, then the owner's edits.
    writeWorkFile(app, { spaceId: "personal", path: weeklyPath(prevLabel), text: "# 周报\n\n## 本周进展\n- 助手查了支付超时\n- 消息中心上线" });
    run(app.db, "insert into kv(key,value) values(?, ?)", `weekly_report_written:${prevLabel}`, "# 周报\n\n## 本周进展\n- 助手查了支付超时\n- 消息中心上线\n- 杂项若干");
    const ops = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"] });
    run(app.db, "update conversations set summary = ?, summary_at = ? where id = ?", "本周处理了三次支付告警。", new Date().toISOString(), ops.conversationId);
    addCase(app, { id: "rs_w1", context: ops.id, ask: "告警谁看", decision: "sent" });
    const m = defineMetric(app, { name: "消息中心报错", unit: "次", query: "前端监控，按天", direction: "down-good" });
    for (const [i, v] of [5, 5, 6, 5].entries()) await recordPoints(app, m.id, [{ value: v, at: day(5 - i) }]);
    await recordPoints(app, m.id, [{ value: 20, at: day(0) }]);
    run(app.db, "insert into lark_meetings(meeting_id,topic,status,started_at,updated_at) values('mt1','退款改造评审','ended',?,?)", ago(86400_000), ago(86400_000));

    const r = scheduleWeeklyReport(app);
    expect(r).toMatchObject({ kind: "brief", input: { mode: "weekly" } });
    expect(scheduleWeeklyReport(app).id).toBe(r.id);

    const inputs: Role[] = [];
    vi.spyOn(runner, "runRole").mockImplementation(async (_app, input: Role) => {
      inputs.push(input);
      // What write_file does for the role.
      writeWorkFile(app, { spaceId: "personal", path: weeklyPath(label), text: "# 周报\n\n## 本周进展\n- 消息中心报错升到 20 次", runId: input.runId });
      return fakeResult("这周最要紧的是消息中心报错上升。");
    });
    const out = await __testHandlers.get("brief")!({ app, run: r, signal: new AbortController().signal, event: vi.fn(), output: vi.fn() });
    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    expect(input.role).toBe("brief");
    expect(input.denyTools).toEqual(expect.arrayContaining(["notify", "upsert_item"]));
    expect(input.addTools).toContain("metric_read");
    expect(input.task).toContain(`# 周报（${label}）`);
    expect(input.task).toContain(`write_file(path="${weeklyPath(label)}", space="personal")`);
    expect(input.task).toContain(`## 上一份周报（${prevLabel}`);
    expect(input.task).toContain("本人改过这一份");
    expect(input.task).toContain("本人删掉或改掉的行：\n- - 杂项若干");
    expect(input.task).toContain("消息中心上线");
    expect(input.task).toContain("会话摘要（本周更新过）：本周处理了三次支付告警。");
    expect(input.task).toContain("消息中心报错：20次");
    expect(input.task).toContain("「退款改造评审」");
    expect(input.task).not.toContain("回复：草稿");

    const file = one<{ id: string }>(app.db, "select id from sources where uri = ?", `work/${weeklyPath(label)}`)!;
    expect(out).toMatchObject({ label, file: file.id });
    const sent = all<{ title: string; link: string; context: string }>(app.db, "select title, link, context from notifications where title like '周报%'");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: `周报 · ${label}`, link: `#/sources/${file.id}` });
    expect(JSON.parse(sent[0].context).urgency).toBe("later");
    // Next week compares the file with what this run left.
    expect(one<{ value: string }>(app.db, "select value from kv where key = ?", `weekly_report_written:${label}`)!.value).toContain("消息中心报错升到 20 次");
    expect(previousReport(app, "2999-W01")).toMatchObject({ label, edited: false, known: true });
  });

  it("fails when the role wrote no report file, and sends nothing", async () => {
    const app = testApp();
    vi.spyOn(runner, "runRole").mockResolvedValue(fakeResult("写好了"));
    const r = scheduleWeeklyReport(app);
    await expect(__testHandlers.get("brief")!({ app, run: r, signal: new AbortController().signal, event: vi.fn(), output: vi.fn() })).rejects.toThrow("没有写出周报文件");
    expect(all(app.db, "select 1 from notifications where title like '周报%'")).toHaveLength(0);
  });
});
