import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/core/app.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { all, one, run } from "../src/core/db.ts";
import { decideScene, decisionReport, describeScene, labelDecisions, recordDecisionSweep, replayDecisions, type DecisionRow, type DecisionScene } from "../src/core/decision-log.ts";
import { resetDecisionCooldownForTests, setDecisionFetchForTests, type DecisionQuestion } from "../src/core/decision.ts";
import { createRun } from "../src/agents/runs.ts";
import { ensurePersonalSpace } from "../src/core/spaces.ts";
import { upsertSource } from "../src/sources/store.ts";
import { upsertItem } from "../src/items/store.ts";
import { triage } from "../src/mentions/triage.ts";
import { decisionCommands } from "../src/cli-decision.ts";
import { configSchema } from "../src/core/config.ts";
import { peerCommands } from "../src/core/peer-exec.ts";

const apps: App[] = [];
const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
afterEach(() => {
  setDecisionFetchForTests(null); resetDecisionCooldownForTests(); vi.restoreAllMocks();
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "omem-decision-log-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ ai: { decision: { provider: "d" } } }));
  const app = App.open(home); apps.push(app); ensurePersonalSpace(app);
  app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai", backends: [] }];
  setKey(home, "d", "test-key");
  return app;
}
function fake(choice: string, probabilities: Record<string, number>) {
  setDecisionFetchForTests(async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "q", choice, probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })) }] })));
}
const question: DecisionQuestion = { type: "choice", instructions: "怎么处理？", options: { ignore: "不用管", notify: "提醒", handle: "先查" } };
async function record(app: App, scene: DecisionScene, choice: string, probabilities: Record<string, number>, ref?: string, sources?: string[]) {
  fake(choice, probabilities);
  return (await decideScene(app, scene, { 材料: "虚构讨论" }, question, { ref, sources }))!;
}
const row = (app: App, id: string) => one<DecisionRow & { label_why: string; labelled_at: string }>(app.db, "select * from decisions where id=?", id)!;
function ended(app: App, input: Record<string, unknown> = {}, output: Record<string, unknown> = {}) {
  const r = createRun(app, { kind: "mention", title: "虚构运行", input });
  run(app.db, "update runs set status='done', finished_at=?, output=? where id=?", ago(0), JSON.stringify(output), r.id);
  return r.id;
}
function notice(app: App, ref: string, outcome: string | null, sourceRefs: string[] = []) {
  run(app.db, "insert into notifications(id,at,title,body,user_id,context,outcome) values(?,?,?,?,?,?,?)", `n-${Math.random()}`, ago(0), "虚构通知", "虚构正文", "owner", JSON.stringify({ runId: ref, sourceRefs }), outcome);
}
const age = (app: App, id: string, days: number) => run(app.db, "update decisions set at=?, next_label_at='' where id=?", ago(days), id);
const source = (app: App) => upsertSource(app, { spaceId: "personal", kind: "note", uri: `note:${Math.random()}`, title: "虚构材料", text: "项目 A 的新进展" }).id;

describe("决策门槛和记录", () => {
  it("旧配置加载默认值；提供的门槛逐项校验", () => {
    const app = setup();
    expect(app.config.ai.decision.thresholds).toEqual({ route: 0.55, heartbeat: 0.6, watch: 0.6, follow: 0.6, meeting: 0.6, triage: 0.6, progress: 0.7, item: 0.6, firstlook: 0.7, "notify-known": 0.8, "flow-blocker": 0.7, "item-place": 0.8 });
    for (const n of [0.49, 1, NaN]) expect(configSchema.safeParse({ ai: { decision: { thresholds: { triage: n } } } }).success).toBe(false);
  });
  it.each([0.41, 0.58, 0.59, 0.6, 0.8])("不用管的把握 %s 按门槛执行", async (p) => {
    const app = setup();
    const r = await record(app, "triage", "ignore", { ignore: p, notify: (1 - p) / 2, handle: (1 - p) / 2 }, "run-demo");
    expect(r.taken).toBe(p < 0.6 ? "notify" : "ignore");
    expect(r.lowered).toBe(p < 0.6);
    expect(row(app, r.id)).toMatchObject({ choice: "ignore", taken: r.taken, threshold: 0.6, ref: "run-demo", by: "决策 · gpt-6-luna", label: null });
    if (r.lowered) expect(describeScene(r, { ignore: "不用管", notify: "简短提醒" })).toContain("把握不到 0.6，按简短提醒处理");
  });
  it.each(["heartbeat", "watch", "follow", "meeting", "progress", "flow-blocker", "item-place"] as const)("%s 的风险答案低于、等于门槛与谨慎答案", async (scene) => {
    const app = setup();
    const risky = ["progress", "flow-blocker", "item-place"].includes(scene) ? "yes" : "no", cautious = risky === "yes" ? "no" : "yes";
    const threshold = scene === "item-place" ? 0.8 : risky === "yes" ? 0.7 : 0.6;
    expect((await record(app, scene, risky, { [risky]: threshold - 0.01 })).taken).toBe(cautious);
    expect((await record(app, scene, risky, { [risky]: threshold })).taken).toBe(risky);
    expect((await record(app, scene, cautious, { [cautious]: 0.51 })).taken).toBe(cautious);
  });
  it("保存完整问题、概率和来源，材料 JSON 不超过 12000 字符；空或出错不留记录", async () => {
    const app = setup(); fake("no", { no: 0.8, yes: 0.2 });
    const material = { 甲: '"\n'.repeat(15000), 乙: "长文本".repeat(15000) };
    const r = (await decideScene(app, "heartbeat", material, question, { ref: "run-demo", sources: ["s1", "s2", "s1"] }))!;
    const saved = row(app, r.id);
    expect(saved.material.length).toBeLessThanOrEqual(12000);
    expect(Object.keys(JSON.parse(saved.material))).toEqual(["甲", "乙"]);
    expect(JSON.parse(saved.question)).toEqual(question);
    expect(JSON.parse(saved.probabilities)).toEqual({ no: 0.8, yes: 0.2 });
    expect(JSON.parse(saved.sources)).toEqual(["s1", "s2"]);
    app.config.ai.decision.provider = "";
    expect(await decideScene(app, "triage", "材料", question)).toBeNull();
    app.config.ai.decision.provider = "d";
    setDecisionFetchForTests(async () => { throw new Error("test failure"); });
    await expect(decideScene(app, "triage", "材料", question)).rejects.toThrow("test failure");
    expect(all(app.db, "select id from decisions")).toHaveLength(1);
  });
});

it("分诊采用改判动作，直接答复也受门槛约束；交给谁仍是普通判断", async () => {
  const app = setup();
  fake("ignore", { ignore: 0.58, notify: 0.3, handle: 0.12 });
  const t = await triage(app, { 材料: "虚构提问" }, { needProgress: false, ref: "mention-demo" });
  expect(t.action).toBe("notify");
  expect(t.reason).toContain("把握 0.58，不到 0.6，按「简短提醒」处理");
  setDecisionFetchForTests(async (_url, init) => {
    const q = JSON.parse(String(init!.body)).questions[0];
    if (q.type === "predicate") return new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability: 0.65 }] }));
    return new Response(JSON.stringify({ answers: [{ type: "choice", name: "q", choice: "handle", probabilities: [{ value: "handle", probability: 0.9 }] }] }));
  });
  const handle = await triage(app, { 材料: "虚构提问" }, { needProgress: true, ref: "mention-demo" });
  expect(handle.action).toBe("handle"); expect(handle.canProgress).toBe(false);
  expect(handle.reason).toContain("不到 0.7，按「要本人定」处理");
  expect(all<{ scene: string; ref: string }>(app.db, "select scene, ref from decisions")).toEqual([
    { scene: "triage", ref: "mention-demo" }, { scene: "triage", ref: "mention-demo" }, { scene: "progress", ref: "mention-demo" },
  ]);
});

describe("按结果标注", () => {
  it.each(["notification", "item", "quiet"])("巡检要看：%s", async (outcome) => {
    const app = setup(), ref = ended(app);
    const r = await record(app, "heartbeat", "yes", { yes: 0.8 }, ref);
    if (outcome === "notification") notice(app, ref, null);
    if (outcome === "item") upsertItem(app, undefined, { title: "虚构事项", spaceId: "personal" }, "agent", ref);
    labelDecisions(app, { limit: 20 });
    expect(row(app, r.id).label).toBe(outcome === "quiet" ? "unneeded" : "needed");
  });
  it("巡检未结束时等待；失败不记成无需关注", async () => {
    const app = setup(), ref = ended(app);
    run(app.db, "update runs set status='running', finished_at=null where id=?", ref);
    const r = await record(app, "heartbeat", "yes", { yes: 0.8 }, ref);
    labelDecisions(app); expect(row(app, r.id).label).toBeNull();
    run(app.db, "update runs set status='failed', finished_at=? where id=?", ago(0), ref);
    run(app.db, "update decisions set next_label_at='' where id=?", r.id);
    labelDecisions(app); expect(row(app, r.id).label).toBe("unclear");
  });
  it.each(["notification", "item", "item-existing", "unrelated", "quiet"])("跳过后补看，按来源判断：%s", async (outcome) => {
    const app = setup(), s = source(app), ref = ended(app);
    const r = await record(app, "heartbeat", "no", { no: 0.9 }, ended(app), [s]);
    recordDecisionSweep(app, [s], ref);
    if (outcome === "notification" || outcome === "unrelated") notice(app, ref, null, [`src:${outcome === "unrelated" ? "other" : s}#L1-L2`]);
    if (outcome === "item") upsertItem(app, undefined, { title: "虚构事项", spaceId: "personal", sourceRefs: [`src:${s}#L1`] }, "agent", ref);
    if (outcome === "item-existing") {
      const item = upsertItem(app, undefined, { title: "已有虚构事项", spaceId: "personal", sourceRefs: [`src:${s}`] }, "user");
      upsertItem(app, item.id, { note: "补看后有新进展" }, "agent", ref);
    }
    labelDecisions(app);
    expect(row(app, r.id).label).toBe(["notification", "item", "item-existing"].includes(outcome) ? "needed" : "unneeded");
    expect(row(app, r.id).label_why).toContain("补看时");
  });
  it("分批补看等齐所有来源；任一来源被引用就是需要关注", async () => {
    const app = setup(), a = source(app), b = source(app);
    const r = await record(app, "heartbeat", "no", { no: 0.9 }, ended(app), [a, b]);
    recordDecisionSweep(app, [a], ended(app)); labelDecisions(app);
    expect(row(app, r.id).label).toBeNull();
    const ref = ended(app); recordDecisionSweep(app, [b], ref); notice(app, ref, null, [`src:${b}`]);
    run(app.db, "update decisions set next_label_at='' where id=?", r.id); labelDecisions(app);
    expect(row(app, r.id).label).toBe("needed");
  });
  it.each(["deleted", "timeout"])("来源被删除或三天没补看：%s", async (kind) => {
    const app = setup(), s = source(app);
    const r = await record(app, "heartbeat", "no", { no: 0.9 }, ended(app), [s]);
    if (kind === "deleted") run(app.db, "update sources set deleted_at=? where id=?", ago(0), s);
    else age(app, r.id, 4);
    labelDecisions(app); expect(row(app, r.id).label).toBe("unclear");
  });
  it.each(["acted", "negative", "unread", "known", "read", "bundled"])("分诊提醒结果：%s，沿处理运行关联", async (outcome) => {
    const app = setup(), handleRun = ended(app), ref = ended(app, {}, { handleRun });
    const r = await record(app, "triage", "handle", { handle: 0.9 }, ref);
    notice(app, handleRun, outcome); labelDecisions(app);
    expect(row(app, r.id).label).toBe(outcome === "acted" ? "needed" : ["negative", "unread"].includes(outcome) ? "unneeded" : "unclear");
  });
  it("分诊直接提醒用 mention 运行；未标注的通知等待；三天没通知记不明确", async () => {
    const app = setup(), ref = ended(app);
    const r = await record(app, "triage", "notify", { notify: 0.8 }, ref);
    notice(app, ref, null); labelDecisions(app); expect(row(app, r.id).label).toBeNull();
    run(app.db, "update notifications set outcome='acted'"); run(app.db, "update decisions set next_label_at=''");
    const missing = await record(app, "triage", "notify", { notify: 0.8 }, ended(app)); age(app, missing.id, 4);
    labelDecisions(app); expect(row(app, r.id).label).toBe("needed"); expect(row(app, missing.id).label).toBe("unclear");
  });
  it("缺少原消息时间时不把忽略判成正确", async () => {
    const app = setup();
    const r = await record(app, "triage", "ignore", { ignore: 0.9 }, ended(app, { channel: "lark", chatId: "chat-demo", messageIds: ["missing"] }));
    age(app, r.id, 3); labelDecisions(app);
    expect(row(app, r.id).label).toBe("unclear");
  });
  it.each(["owner", "none", "late", "signed"])("分诊忽略：48 小时后看本人在消息后一天内是否回复（%s）", async (reply) => {
    const app = setup(), ms = Date.now() - 3 * DAY;
    run(app.db, "insert into lark_messages(message_id,chat_id,create_ms,content) values('ask','chat-demo',?,'虚构提问')", ms);
    if (reply !== "none") run(app.db, "insert into lark_messages(message_id,chat_id,create_ms,sender_kind,content) values('reply','chat-demo',?,'owner',?)", ms + (reply === "late" ? 2 * DAY : 3600_000), reply === "signed" ? `答复${app.config.lark.commands.signature}` : "本人答复");
    const r = await record(app, "triage", "ignore", { ignore: 0.9 }, ended(app, { channel: "lark", chatId: "chat-demo", messageIds: ["ask"] }));
    labelDecisions(app); expect(row(app, r.id).label).toBeNull(); age(app, r.id, 2.1);
    labelDecisions(app); expect(row(app, r.id).label).toBe(reply === "owner" ? "needed" : "unneeded");
  });
  it("只检查最多 200 条；不标注盯群与直接答复；清理超过 90 天的记录", async () => {
    const app = setup();
    const watch = await record(app, "watch", "no", { no: 0.8 }), progress = await record(app, "progress", "yes", { yes: 0.9 });
    age(app, watch.id, 4); age(app, progress.id, 4);
    const old = await record(app, "watch", "no", { no: 0.9 }); age(app, old.id, 91);
    const ref = ended(app);
    for (let i = 0; i < 205; i++) await record(app, "heartbeat", "yes", { yes: 0.9 }, ref);
    expect(labelDecisions(app, { limit: 999 })).toBe(200);
    expect(one<{ n: number }>(app.db, "select count(*) n from decisions where label is not null")!.n).toBe(200);
    expect(row(app, watch.id).label).toBeNull(); expect(row(app, progress.id).label).toBeNull(); expect(row(app, old.id)).toBeUndefined();
    expect(labelDecisions(app)).toBe(5);
  });
  it("关键结果查询使用运行、来源和会话时间索引", () => {
    const app = setup();
    for (const [sql, params, index] of [
      ["select context from notifications where json_extract(context, '$.runId') = ?", ["r"], "notifications_run"],
      ["select source_refs from item_events where run_id = ?", ["r"], "item_events_run"],
      ["select 1 from lark_messages where chat_id = ? and create_ms > ? and sender_kind = 'owner'", ["chat", 0], "lark_messages_chat"],
      ["select run_id from decision_sweeps where source_id = ? and at >= ? order by at limit 1", ["s", ""], "decision_sweeps_source_at"],
    ] as const) {
      expect(all<{ detail: string }>(app.db, `explain query plan ${sql}`, ...params).map((x) => x.detail).join(" ")).toContain(index);
    }
  });
});

describe("报告和离线回放", () => {
  it("统计漏看、多看和改判，建议至少需要 20 条可判断的风险选择", async () => {
    const app = setup();
    for (let i = 0; i < 19; i++) {
      const r = await record(app, "triage", "ignore", { ignore: i === 0 ? 0.55 : 0.85 });
      run(app.db, "update decisions set label=? where id=?", i === 0 ? "needed" : "unneeded", r.id);
    }
    let s = decisionReport(app).scenes.find((s) => s.scene === "triage")!;
    expect(s.suggestion).toBe("有结果的记录还不到 20 条，先按现在的门槛");
    const last = await record(app, "triage", "ignore", { ignore: 0.85 }); run(app.db, "update decisions set label='needed' where id=?", last.id);
    const waste = await record(app, "triage", "notify", { notify: 0.8 }); run(app.db, "update decisions set label='unneeded' where id=?", waste.id);
    s = decisionReport(app).scenes.find((s) => s.scene === "triage")!;
    expect(s).toMatchObject({ records: 21, risky: 19, lowered: 1, labelled: 21, misses: 1, wasted: 1, suggested: null });
    expect(s.thresholds[0]).toMatchObject({ threshold: 0.5, risky: 20, misses: 2, labelled: 20 });
    expect(s.thresholds[1]).toMatchObject({ threshold: 0.6, risky: 19, misses: 1 });
    run(app.db, "update decisions set label='unneeded' where id=?", last.id);
    expect(decisionReport(app).scenes.find((s) => s.scene === "triage")!.suggested).toBe(0.5);
    expect(decisionReport(app).scenes.find((s) => s.scene === "watch")!.suggestion).toContain("不标注结果");
    expect(JSON.stringify(await peerCommands.decisions.run(app, {}))).not.toContain("虚构讨论");
    expect(() => peerCommands.decisions.schema.parse({ material: true })).toThrow();
  });
  it("有足够历史选择时，建议能排除已知漏看的最低门槛", async () => {
    const app = setup();
    for (let i = 0; i < 20; i++) {
      const r = await record(app, "triage", "ignore", { ignore: i < 2 ? 0.55 : 0.85 });
      run(app.db, "update decisions set label=? where id=?", i < 2 ? "needed" : "unneeded", r.id);
    }
    expect(decisionReport(app).scenes.find((s) => s.scene === "triage")!.suggested).toBe(0.6);
  });
  it("命令顺序重放，按当前门槛比较同一批样本，不写数据库", async () => {
    const app = setup();
    const a = await record(app, "triage", "ignore", { ignore: 0.59 }), b = await record(app, "triage", "ignore", { ignore: 0.9 }), c = await record(app, "triage", "notify", { notify: 0.8 });
    for (const [id, label] of [[a.id, "needed"], [b.id, "needed"], [c.id, "unneeded"]]) run(app.db, "update decisions set label=? where id=?", label, id);
    // Current threshold differs from what was recorded.
    app.config.ai.decision.thresholds!.triage = 0.5;
    fake("notify", { notify: 0.8, ignore: 0.2 });
    const before = JSON.stringify(all(app.db, "select * from decisions order by id"));
    const r = await replayDecisions(app, { scene: "triage", model: "d:candidate" });
    expect(r).toMatchObject({ compared: 3, agreement: 1, original: { misses: 2, wasted: 1 }, candidate: { misses: 0, wasted: 1 }, errors: 0 });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const cmd = new Command(); decisionCommands(cmd, () => app);
    await cmd.parseAsync(["decision", "replay", "--scene", "triage", "--model", "d:candidate", "--limit", "3"], { from: "user" });
    expect(output.mock.calls.flat().join("\n")).toContain("比较 3/3 条");
    await cmd.parseAsync(["decision", "report", "--days", "7"], { from: "user" });
    expect(output.mock.calls.flat().join("\n")).toContain("最近 7 天");
    expect(JSON.stringify(all(app.db, "select * from decisions order by id"))).toBe(before);
  });
  it("连续三次失败停止，不将失败样本算进任何一侧", async () => {
    const app = setup(); for (let i = 0; i < 5; i++) await record(app, "triage", "ignore", { ignore: 0.8 });
    let calls = 0; setDecisionFetchForTests(async () => { calls++; throw new Error("候选失败"); });
    expect(await replayDecisions(app, { scene: "triage", model: "d:bad" })).toMatchObject({ compared: 0, errors: 3, stopped: true });
    expect(calls).toBe(3);
  });
});
