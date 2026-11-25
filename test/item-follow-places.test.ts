import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { addMember, createUser, personalSpaceId } from "../src/core/users.ts";
import { createSpace } from "../src/core/spaces.ts";
import { setVisibility } from "../src/auth/visibility.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { itemEvents, upsertItem } from "../src/items/store.ts";
import { addMaterials, itemMaterials, removeMaterials } from "../src/items/materials.ts";
import { lineTimeline } from "../src/items/changes.ts";
import { linkRunPlaces } from "../src/items/places.ts";
import { writeParent } from "../src/items/tree.ts";
import { itemContext, saveContext } from "../src/channels/listen.ts";
import { itemChatsPatch, setItemListening } from "../src/channels/listen-items.ts";
import { createRun, getRun, listRuns } from "../src/agents/runs.ts";
import { listAsks } from "../src/agents/asks.ts";
import { followContexts, finishFollow, followLimit, followView, noteItemChange } from "../src/flows/follow.ts";
import { discoverFollowChats } from "../src/flows/follow-places.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { startFlow } from "../src/flows/engine.ts";
import { testApp } from "./helpers.ts";

const DAY = 86400_000;
const apps: App[] = [];
afterEach(async () => {
  setDecisionFetchForTests(null);
  resetDecisionCooldownForTests();
  await new Promise(r => setImmediate(r));
  for (const app of apps.splice(0)) {
    app.events.emit("close");
    app.db.close();
    rmSync(app.home, { force: true, recursive: true });
  }
});

function setup() {
  const app = testApp(); apps.push(app);
  app.config.flows.follow.maxMessages = 1;
  app.config.flows.follow.maxRunsPerDay = 0;
  app.config.timezone = "UTC";
  const item = upsertItem(app, undefined, { title: "月牙桥退款", detail: "支持跨月退回运费" }, "user");
  const context = setItemListening(app, item.id, true)!;
  const base = Date.now() + 1000;
  const patrol = (offset = 0) => followContexts(app, new Date(base + offset));
  const batches = () => listRuns(app, { kind: "item-follow" });
  const done = async (id: string) => {
    run(app.db, "update runs set status='running' where id=?", id);
    await finishFollow(app, getRun(app, id));
    run(app.db, "update runs set status='done' where id=?", id);
  };
  return { app, item, base, context, patrol, batches, done };
}

function chat(app: App, chatId: string, title: string, kind = "group", spaceId = "personal") {
  run(app.db, "insert into lark_cursors(chat_id,name,kind) values(?,?,?)", chatId, title, kind);
  let n = 0;
  const say = (content: string, at: number, person: string | null = null) => {
    const s = appendToSource(app, { spaceId, uri: `lark:${chatId}`, kind: "chat", title, lines: [content], meta: { chatId } });
    run(app.db, "update sources set updated_at=? where id=?", new Date(at).toISOString(), s.id);
    const message = `msg_${chatId}_${++n}`;
    if (n % 2 === 1) {
      run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,content,create_ms,sender_id,sender_name) values(?,?,?,?,?,?,?,'小王')",
        message, chatId, s.id, s.appendedFrom, content, at, person);
    } else {
      run(app.db, "insert into lark_messages(message_id,chat_id,content,create_ms,sender_id,sender_name) values(?,?,?,?,?,'小王')",
        message, chatId, content, at, person);
      run(app.db, "insert into lark_message_lines(source_id,message_id,line) values(?,?,?)", s.id, message, s.appendedFrom);
    }
    return { source: s.id, ref: `src:${s.id}#L${s.appendedFrom}` };
  };
  return { say, chatId };
}

type Judge = (name: string, material: Record<string, unknown>) => number;
function judge(app: App, answer: Judge) {
  const calls: { names: string[]; material: Record<string, unknown> }[] = [];
  app.config.ai.providers = [{ id: "decision", name: "决策", kind: "openai", backends: [] }];
  app.config.ai.decision.provider = "decision";
  app.config.ai.decision.model = "example";
  setKey(app.home, "decision", "example-key");
  setDecisionFetchForTests(async (_url, init) => {
    const req = JSON.parse(String(init?.body));
    const material = req.input[0].content[0].data;
    const names: string[] = req.questions.map((q: { name: string }) => q.name);
    calls.push({ names, material });
    return Response.json({ answers: names.map(name => ({ name, type: "predicate", probability: answer(name, material) })) });
  });
  return calls;
}

const attach = (app: App, item: string, src: string, by: "agent" | "user" = "agent") => addMaterials(app, item, [{ kind: "source", ref: src }], "owner", by);
const state = (app: App, item: string, chat: string) =>
  one<{ state: string; empty_batches: number }>(app.db, "select state,empty_batches from item_chat_follow where item_id=? and chat_id=?", item, chat);

it("把确实在谈这件事的群挂上，只把决策认出的历史变化放进下一批", async () => {
  const t = setup(), group = chat(t.app, "oc_release", "月牙桥退款协作");
  const history = group.say("月牙桥退款支持跨月退回运费", t.base - 7200_000);
  const news = group.say("月牙桥退款的验收结果已经通过", t.base - 3600_000);
  group.say("下午去借会议室", t.base - 1200_000);
  const calls = judge(t.app, name => name === "place1" || name === "place1_line1" ? 0.95 : 0.05);
  await t.patrol();
  expect(calls).toHaveLength(1);
  expect(itemMaterials(t.app, t.item.id)).toMatchObject([{ ref: news.source, addedBy: "agent" }]);
  expect(itemContext(t.app, t.item.id)!.chats).toEqual([group.chatId]);
  expect(itemEvents(t.app, t.item.id)).toContainEqual(expect.objectContaining({ text: "开始跟进会话「月牙桥退款协作」", sourceRefs: [news.ref, history.ref] }));
  expect(lineTimeline(t.app, t.item.id)).toContainEqual(expect.objectContaining({ status: "noted", origin: "context", refs: [news.ref, history.ref] }));
  expect(listAsks(t.app)).toHaveLength(0);
  expect(t.batches()).toHaveLength(1);
  const first = t.batches()[0];
  expect(String(first.input.task)).toContain(news.ref);
  expect(String(first.input.task)).not.toContain(history.ref);
  expect(String(first.input.task)).not.toContain("下午去借会议室");
  expect(followView(t.app, t.item.id)[0]).toMatchObject({ line: 3, pending: 1 });
  await t.done(first.id);
  expect(followView(t.app, t.item.id)[0]).toMatchObject({ line: 3, pending: 0 });
  const next = group.say("刚找到一个验收后的问题", t.base + 500);
  judge(t.app, () => 0.95);
  await t.patrol(1000);
  const task = String(t.batches().find(b => b.id !== first.id)!.input.task);
  expect(task).toContain(next.ref);
  expect(task).not.toContain(news.ref);
});

it("同时用标题、对象、参与者找候选，关联私聊时保留群列表的原范围", async () => {
  const t = setup(), a = chat(t.app, "oc_known", "协作群");
  const existing = a.say("正在整理验收结果", t.base - 2000, "ou_wang");
  await attach(t.app, t.item.id, existing.source, "user");
  const doc = upsertSource(t.app, { spaceId: "personal", kind: "doc", uri: "https://tenant.larkoffice.com/docx/example", title: "测试说明", text: "验收条件" });
  await attach(t.app, t.item.id, doc.id, "user");
  const dm = chat(t.app, "oc_dm", "小王", "p2p");
  const dmSource = dm.say("上次联调留下的回归项过了", t.base - 1000, "ou_wang");
  const other = chat(t.app, "oc_doc", "读材料");
  const otherSource = other.say("https://tenant.larkoffice.com/docx/example 第三项也验证了", t.base - 1000);
  const noisy = chat(t.app, "oc_noisy", "茶水间");
  noisy.say("有人要咖啡吗", t.base - 500, "ou_tea");
  const calls = judge(t.app, name => name.includes("_line") ? 0.05 : 0.95);
  await t.patrol();
  expect(calls.map(c => c.names)).toEqual([["place1", "place1_line1", "place2", "place2_line1"]]);
  expect(itemMaterials(t.app, t.item.id).map(m => m.ref)).toEqual(expect.arrayContaining([dmSource.source, otherSource.source]));
  expect(itemContext(t.app, t.item.id)!.chats).toEqual([a.chatId, other.chatId]);
  expect(t.batches()).toHaveLength(0);
  expect(followView(t.app, t.item.id).find(v => v.sourceId === dmSource.source)).toMatchObject({ line: 1, pending: 0 });
});

it.each(["no", "low", "error"] as const)("候选结果 %s 不挂上，没有新线索的七天内不再问", async verdict => {
  const t = setup(), group = chat(t.app, "oc_mention", "月牙桥退款闲聊");
  group.say("主要是聊别的项目", t.base - 1000);
  await t.patrol(); // No decision model.
  expect(itemMaterials(t.app, t.item.id)).toEqual([]);
  const calls = judge(t.app, () => {
    if (verdict === "error") throw new Error("假模型暂不可用");
    return verdict === "no" ? 0.1 : 0.79;
  });
  await t.patrol();
  group.say("发了会议室安排", t.base + DAY - 1000);
  await t.patrol(DAY);
  expect(calls).toHaveLength(1);
  expect(itemMaterials(t.app, t.item.id)).toEqual([]);
  group.say("再次转发会议室安排", t.base + 8 * DAY - 1000);
  await t.patrol(8 * DAY);
  expect(calls).toHaveLength(2);
});

it("送给决策的材料只含事项本人可以读的聊天", async () => {
  const { app, base } = setup();
  const user = createUser(app, { id: "member-a", name: "成员甲" });
  const personal = personalSpaceId(user.id);
  const item = upsertItem(app, undefined, { userId: user.id, spaceId: personal, title: "月牙桥退款" }, "user");
  createSpace(app, { id: "shared-demo", name: "项目 A" });
  addMember(app, "shared-demo", user.id, "reader");
  const hidden = chat(app, "oc_hidden", "月牙桥退款未开放的群");
  const restricted = chat(app, "oc_restricted", "月牙桥退款受限的群", "group", "shared-demo");
  const visible = chat(app, "oc_visible", "月牙桥退款公开讨论", "group", "shared-demo");
  hidden.say("受限讨论", base - 1000);
  setVisibility(app, restricted.say("受限讨论", base - 1000).source, "restricted");
  const open = visible.say("月牙桥退款准备上线", base - 1000);
  const calls = judge(app, name => name === "place1" ? 0.95 : 0.05);
  await discoverFollowChats(app, item, new Date(base), "example-anchor", () => true, () => {});
  expect(calls.map(c => c.names)).toEqual([["place1", "place1_line1"]]);
  expect(JSON.stringify(calls[0].material)).toContain("公开讨论");
  expect(JSON.stringify(calls[0].material)).not.toContain("受限");
  expect(itemMaterials(app, item.id).map(m => m.ref)).toEqual([open.source]);
});

it("拒绝后有新的命中消息可以重判；子项材料和主动移除的群不再判", async () => {
  const t = setup();
  const removed = chat(t.app, "oc_removed", "月牙桥退款评审");
  const ref = removed.say("月牙桥退款的验收结果已出", t.base - 2000);
  const [m] = await attach(t.app, t.item.id, ref.source, "user");
  removeMaterials(t.app, t.item.id, [m.id], "owner", "agent");
  const sub = upsertItem(t.app, undefined, { title: "补验收" }, "user");
  writeParent(t.app, sub.id, t.item.id);
  const inSub = chat(t.app, "oc_child", "月牙桥退款联调");
  await attach(t.app, sub.id, inSub.say("月牙桥退款开始验收", t.base - 1000).source, "user");
  const keepOut = chat(t.app, "oc_manual", "月牙桥退款协作");
  const manual = keepOut.say("月牙桥退款开始验收", t.base - 1000);
  await attach(t.app, t.item.id, manual.source, "user");
  saveContext(t.app, { id: t.context.id, kind: "item", ...itemChatsPatch(t.app, t.item.id, [inSub.chatId]) });
  const target = chat(t.app, "oc_retry", "月牙桥退款讨论");
  target.say("没到排期", t.base - 1000);
  let relevant = false;
  const calls = judge(t.app, name => relevant && name === "place1" ? 0.95 : 0.05);
  await t.patrol();
  expect(calls[0].names).toEqual(["place1", "place1_line1"]);
  expect(JSON.stringify(calls[0].material)).toContain("月牙桥退款讨论");
  expect(itemContext(t.app, t.item.id)!.chats).toEqual([inSub.chatId]);
  relevant = true;
  const news = target.say("月牙桥退款确定周五验证", t.base + 100);
  removed.say("月牙桥退款收到了新报告", t.base + 100);
  await t.patrol(200);
  expect(calls).toHaveLength(2);
  expect(itemMaterials(t.app, t.item.id).map(m => m.ref)).toEqual([manual.source, news.source]);
  expect(itemContext(t.app, t.item.id)!.chats).toEqual([inSub.chatId, target.chatId]);
  expect(followView(t.app, t.item.id).map(s => s.sourceId)).toEqual([news.source]);
  const incidental = createRun(t.app, { kind: "agent", title: "随手记一句", input: { lark: { chats: [removed.chatId] } } });
  expect(await linkRunPlaces(t.app, incidental.id, t.item.id, "owner")).toEqual([]);
  await attach(t.app, t.item.id, ref.source, "user");
  await t.patrol(200);
  expect(itemContext(t.app, t.item.id)!.chats).toContain(removed.chatId);
  expect(followView(t.app, t.item.id).find(s => s.sourceId === ref.source)).toMatchObject({ line: 2, pending: 0 });
});

it("手动加进群列表的群会进批次，拿掉后列表再编辑仍记得这个选择", async () => {
  const t = setup();
  const group = chat(t.app, "oc_pin", "月牙桥退款讨论");
  const src = group.say("之前的讨论", t.base - 1000).source;
  const changeGroups = (chats: string[]) => saveContext(t.app, { id: t.context.id, kind: "item", ...itemChatsPatch(t.app, t.item.id, chats) });
  changeGroups([group.chatId]);
  await t.patrol();
  expect(followView(t.app, t.item.id)).toMatchObject([{ sourceId: src, line: 1, pending: 0 }]);
  const msg = group.say("月牙桥退款验收通过", t.base + 100);
  await t.patrol(200);
  expect(String(t.batches()[0].input.task)).toContain(msg.ref);
  await t.done(t.batches()[0].id);
  changeGroups([]);
  changeGroups([]);
  const calls = judge(t.app, () => 0.95);
  group.say("月牙桥退款准备上线", t.base + 300);
  await t.patrol(400);
  expect(itemContext(t.app, t.item.id)!.dropped).toEqual([group.chatId]);
  expect(calls).toHaveLength(0);
  expect(followView(t.app, t.item.id)).toHaveLength(0);
});

it("逐群累计有消息的空批，保留材料并同步关注，等新线索接回", async () => {
  const t = setup();
  const agent = chat(t.app, "oc_agent", "临时讨论"), mine = chat(t.app, "oc_mine", "本人群"), pinned = chat(t.app, "oc_pinned", "另一个群");
  for (const [g, by] of [[agent, "agent"], [mine, "user"], [pinned, "agent"]] as const) {
    const material = g.say("早前消息", t.base - 2000);
    await attach(t.app, t.item.id, material.source, by);
  }
  // The owner explicitly chooses the third group in the list, even though a material later links it.
  saveContext(t.app, { id: t.context.id, kind: "item", added: [pinned.chatId] });
  await t.patrol();
  const row = itemMaterials(t.app, t.item.id)[0];
  let relevant = false;
  const calls = judge(t.app, name => name === "q" ? 0.05 : relevant ? 0.95 : 0.05);
  for (let i = 1; i <= 5; i++) {
    for (const g of [agent, mine, pinned]) g.say("会议室调整了", t.base + i * 1000);
    await t.patrol(i * 1000);
    await t.patrol(i * 1000); // no messages, no extra empty batch
  }
  expect(t.batches()).toHaveLength(0);
  expect(followLimit(t.app, t.item.id).count).toBe(0);
  expect(state(t.app, t.item.id, agent.chatId)).toEqual({ state: "idle", empty_batches: 5 });
  expect(itemMaterials(t.app, t.item.id)).toContainEqual(row);
  expect(itemContext(t.app, t.item.id)!.chats).toEqual([mine.chatId, pinned.chatId]);
  expect(itemEvents(t.app, t.item.id)).toContainEqual(expect.objectContaining({ text: "不再跟进会话「临时讨论」：最近 5 批没有这件事的内容" }));
  agent.say("发了会议室密码", t.base + 6000);
  await t.patrol(6000);
  expect(calls).toHaveLength(5);
  relevant = true;
  const news = agent.say("月牙桥退款的测试通过了", t.base + 7000);
  await t.patrol(7000);
  expect(state(t.app, t.item.id, agent.chatId)).toMatchObject({ state: "active" });
  expect(itemContext(t.app, t.item.id)!.chats).toContain(agent.chatId);
  expect(itemEvents(t.app, t.item.id)).toContainEqual(expect.objectContaining({ text: "重新跟进会话「临时讨论」", sourceRefs: [news.ref] }));
  expect(String(t.batches()[0].input.task)).toContain(news.ref);
  expect(String(t.batches()[0].input.task)).not.toContain("发了会议室密码");
});

it("提炼只重置有对应依据的群，空批的第五次才放下另一个群", async () => {
  const t = setup();
  const noisy = chat(t.app, "oc_a", "群甲"), active = chat(t.app, "oc_b", "群乙");
  for (const g of [noisy, active]) await attach(t.app, t.item.id, g.say("早前讨论", t.base - 2000).source);
  await t.patrol();
  for (let i = 1; i <= 5; i++) {
    noisy.say("借用会议室", t.base + i * 1000);
    const msg = active.say(`补充运费退款的用例条数 ${i}`, t.base + i * 1000);
    await t.patrol(i * 1000);
    const queued = t.batches().find(r => r.status === "queued")!;
    run(t.app.db, "update runs set status='running' where id=?", queued.id);
    noteItemChange(t.app, queued.id, { item: t.item.id, type: "info", summary: `验收补充了第 ${i} 条结果`, refs: [msg.ref] });
    await t.done(queued.id);
  }
  expect(state(t.app, t.item.id, noisy.chatId)?.state).toBe("idle");
  expect(state(t.app, t.item.id, active.chatId)).toEqual({ state: "active", empty_batches: 0 });
});

it.each(["due", "stage"] as const)("临近 %s 只加一批额度，预筛无关不消耗它", async kind => {
  const t = setup();
  const group = chat(t.app, "oc_deadline", "协作群");
  await attach(t.app, t.item.id, group.say("早前讨论", t.base - 1000).source, "user");
  const deadline = new Date(t.base + DAY).toISOString();
  if (kind === "due") upsertItem(t.app, t.item.id, { dueAt: deadline }, "user");
  else {
    saveFlow(t.app, YAML.stringify({ id: "demo", name: "示例交付", stages: [{ id: "verify", name: "验收", by: "wait" }] }), "owner");
    await startFlow(t.app, t.item.id, "demo", { actor: "owner", userId: "owner" });
    run(t.app.db, "update item_stages set control=json_set(control,'$.ownerPlanAt',?) where item_id=?", deadline, t.item.id);
  }
  t.app.config.flows.follow.maxRunsPerDay = 1;
  await t.patrol();
  group.say("有新进度", t.base + 1000);
  await t.patrol(1000);
  await t.done(t.batches()[0].id);
  const date = new Date(t.base + 2000);
  expect(followLimit(t.app, t.item.id, date)).toMatchObject({ count: 1, extra: true, capped: false });
  judge(t.app, () => 0.05);
  group.say("只谈会议室", t.base + 2000);
  await t.patrol(2000);
  expect(followLimit(t.app, t.item.id, date)).toMatchObject({ count: 1, extra: true });
  judge(t.app, () => 0.95);
  group.say("确认了验收结论", t.base + 3000);
  await t.patrol(3000);
  await t.done(t.batches().find(b => b.status === "queued")!.id);
  group.say("补了另一条说明", t.base + 4000);
  await t.patrol(4000);
  expect(t.batches()).toHaveLength(2);
  expect(followLimit(t.app, t.item.id, new Date(t.base + 4000))).toEqual({ count: 2, capped: true, noted: true });
  expect(all<{ outcome: string }>(t.app.db, "select outcome from flow_signals where json_extract(keys,'$.extra')=1")).toEqual([
    { outcome: "看过，没有变化。临近计划时间或截止时间，今天的批数放宽一倍" },
  ]);
});
