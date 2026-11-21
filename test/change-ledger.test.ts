import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { upsertItem } from "../src/items/store.ts";
import { addChange, lineTimeline, recordChange, sourceKeys } from "../src/items/changes.ts";
import { defineMetric, recordPoints } from "../src/data/metrics.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});

function setup() {
  const app = testApp(); apps.push(app);
  const line = upsertItem(app, undefined, { title: "示例商城退款", kind: "line" }, "user");
  const item = upsertItem(app, undefined, { title: "部分发货的退款" }, "user");
  run(app.db, "update items set parent_id=? where id=?", line.id, item.id);
  const chat = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_demo", title: "退款群", lines: ["开始"], meta: { chatId: "oc_demo" } });
  let n = 1;
  const say = (text: string, id = `om_${n + 1}`) => {
    n++;
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_demo", title: "退款群", lines: [text] });
    run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,sender_kind,sender_name,content,create_ms) values(?,?,?,?,?,?,?,?)", id, "oc_demo", chat.id, n, "user", "小王", text, Date.now());
    return `src:${chat.id}#L${n}`;
  };
  return { app, line, item, chat, say };
}
const rows = (app: App, itemId: string) => all<{ id: string; type: string; summary: string; due: string | null; origin: string; added: string | null; source_key: string | null }>(app.db, "select id,type,summary,due,origin,added,source_key from item_changes where item_id=? order by at", itemId);

describe("变化台账：一件事只记一次", () => {
  it("同一条消息从两路进来只留一条；后来更具体的更新原行并记下谁补的", () => {
    const t = setup();
    const ref = t.say("小王：退款上线改到下周五");
    // The assistant noted it from the group (upsert_item change_type), then item-follow read the same message.
    const first = addChange(t.app, { itemId: t.item.id, type: "deadline", summary: "提到上线要改期", refs: [ref], origin: "owner", runId: "r_owner" });
    const again = recordChange(t.app, { itemId: t.item.id, type: "deadline", summary: "提到上线要改期", refs: [ref], origin: "follow", runId: "r_follow" });
    expect(again).toMatchObject({ id: first, created: false, updated: false });
    const more = recordChange(t.app, { itemId: t.item.id, type: "deadline", summary: "上线改到下周五（12 月 4 日）", due: "2026-12-04", refs: [ref], origin: "follow", runId: "r_follow2" });
    expect(more).toMatchObject({ id: first, created: false, updated: true });
    const [row] = rows(t.app, t.item.id);
    expect(rows(t.app, t.item.id)).toHaveLength(1);
    expect(row).toMatchObject({ origin: "owner", summary: "上线改到下周五（12 月 4 日）", due: "2026-12-04", source_key: "lark:om_2" });
    expect(JSON.parse(row.added!)).toEqual([expect.objectContaining({ origin: "follow", runId: "r_follow2", fields: expect.arrayContaining(["due", "summary"]) })]);
    // The timeline says who noted it first and who added to it.
    expect(lineTimeline(t.app, t.line.id)[0]).toMatchObject({ origin: "owner", runId: "r_owner", sourceKey: "lark:om_2", added: [expect.objectContaining({ origin: "follow" })] });
  });

  it("不同变化类型、不同事项各留一条", () => {
    const t = setup();
    const ref = t.say("小王：运费也要退，另外下周五上线");
    const other = upsertItem(t.app, undefined, { title: "运费规则" }, "user");
    recordChange(t.app, { itemId: t.item.id, type: "scope", summary: "运费也要退", refs: [ref], origin: "follow" });
    recordChange(t.app, { itemId: t.item.id, type: "deadline", summary: "下周五上线", refs: [ref], origin: "follow" });
    recordChange(t.app, { itemId: other.id, type: "scope", summary: "运费也要退", refs: [ref], origin: "owner" });
    expect(rows(t.app, t.item.id).map((r) => r.type).sort()).toEqual(["deadline", "scope"]);
    expect(rows(t.app, other.id)).toHaveLength(1);
  });

  it("同一条消息在两份原件里是同一个键；文档的行挪了位置也认得出", () => {
    const t = setup();
    const ref = t.say("小王：退款走原路", "om_same");
    const copy = appendToSource(t.app, { spaceId: "personal", kind: "chat", uri: "lark:oc_demo#copy", title: "退款群（另一份）", lines: ["别的", "小王：退款走原路"] });
    run(t.app.db, "insert into lark_message_lines(source_id,message_id,line) values(?,?,2)", copy.id, "om_same");
    expect(sourceKeys(t.app, [`src:${copy.id}#L2`])).toEqual(sourceKeys(t.app, [ref]));
    const doc = upsertSource(t.app, { spaceId: "personal", kind: "doc", uri: "doc:plan", title: "退款方案", text: "背景\n退商品款\n七天内原路退回" });
    const before = sourceKeys(t.app, [`src:${doc.id}#L2-L3`]);
    upsertSource(t.app, { spaceId: "personal", kind: "doc", uri: "doc:plan", title: "退款方案", text: "背景\n新加的一行\n退商品款\n七天内原路退回" });
    expect(sourceKeys(t.app, [`src:${doc.id}#L3-L4`])).toEqual(before);
    // Memories, items and plain words are no source.
    expect(sourceKeys(t.app, ["mem:m_1", "item:i_1", "随便一句"])).toEqual([]);
  });

  it("本人处理过的变化，后来者不改它的说法", () => {
    const t = setup();
    const ref = t.say("小王：要不要也退运费");
    const id = addChange(t.app, { itemId: t.item.id, type: "scope", summary: "问要不要退运费", refs: [ref], origin: "owner" })!;
    run(t.app.db, "update item_changes set status='dismissed' where id=?", id);
    recordChange(t.app, { itemId: t.item.id, type: "scope", summary: "小王提出运费也要退，原因是部分发货", detail: "群里说的", refs: [ref], origin: "follow" });
    expect(one(t.app.db, "select summary, detail, status from item_changes where id=?", id)).toEqual({ summary: "问要不要退运费", detail: null, status: "dismissed" });
  });

  it("同一次越线记两遍只有一条；没有键的旧行照常显示", async () => {
    const t = setup();
    const m = defineMetric(t.app, { name: "退款时长", baseline: 10, query: "退款记录", itemId: t.item.id });
    const at = "2026-11-20T00:00:00.000Z";
    await recordPoints(t.app, m.id, [{ value: 30, at }]);
    await recordPoints(t.app, m.id, [{ value: 30, at }]);
    expect(all(t.app.db, "select 1 from item_changes where origin='metric'")).toHaveLength(1);
    expect(all(t.app.db, "select 1 from item_events where item_id=? and text like '指标变化%'", t.item.id)).toHaveLength(1);
    run(t.app.db, "insert into item_changes(id,item_id,at,type,summary,refs,run_id,updated_at,origin) values('ic_old',?,?,'info','以前记的','[]','',?,'problem')", t.item.id, at, at);
    expect(lineTimeline(t.app, t.line.id).map((c) => c.id)).toContain("ic_old");
    expect(lineTimeline(t.app, t.line.id).find((c) => c.id === "ic_old")).not.toHaveProperty("sourceKey");
  });

  it("宿主自己的事件只按自己的键认：同一段证据的两次阶段变化是两条", () => {
    const t = setup();
    const ref = t.say("验证通过");
    recordChange(t.app, { itemId: t.item.id, type: "stage", summary: "「验证」做完", refs: [ref], origin: "flow", source: "stage:verify:done@1" });
    recordChange(t.app, { itemId: t.item.id, type: "stage", summary: "「验证」要复核", refs: [ref], origin: "flow", source: "stage:verify:stale@2" });
    recordChange(t.app, { itemId: t.item.id, type: "stage", summary: "「验证」做完", refs: [ref], origin: "flow", source: "stage:verify:done@1" });
    expect(rows(t.app, t.item.id)).toHaveLength(2);
  });
});
