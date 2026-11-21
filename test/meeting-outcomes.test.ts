import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { addMaterials } from "../src/items/materials.ts";
import { createRun } from "../src/agents/runs.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { callTool } from "../src/agents/tools.ts";
import { meetingLinks, outcomesTask } from "../src/agents/meeting-outcomes.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});

async function setup() {
  const app = testApp(); apps.push(app);
  const line = upsertItem(app, undefined, { title: "示例商城退款改造", kind: "line", dueAt: "2026-12-10" }, "user");
  const chat = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_refund", title: "退款群", lines: ["小王：下午开会"], meta: { chatId: "oc_refund" } });
  await addMaterials(app, line.id, [{ kind: "source", ref: chat.id }], "owner", "user");
  const record = upsertSource(app, { spaceId: "personal", kind: "meeting", uri: "meeting:m_demo", title: "退款评审会", text: "# 退款评审会\n小王：运费跟着商品一起退，就这么定\n小李：我周三前把接口文档发出来\n小张：部分发货要不要拆单退，还没想好\n本人：上线改到 12 月 15 日" });
  const at = new Date().toISOString();
  run(app.db, "insert into lark_meetings(meeting_id,topic,status,started_at,updated_at,chat_id,source_id,space_id) values('m_demo','退款评审会','ended',?,?,'oc_refund',?,'personal')", at, at, record.id);
  const summaryRun = () => createRun(app, { kind: "agent", title: "会后", input: { meetingId: "m_demo", task: "整理" }, notBefore: new Date(Date.now() + 3600_000).toISOString() });
  const ctx = (runId: string, spaces: string[] | null = null) => ({ app, runId, spaceId: "personal", spaces, tools: null, actor: "agent" as const, userId: "owner" });
  const src = (l: number) => `src:${record.id}#L${l}`;
  const outcomes = (itemId: string) => ({
    item_id: itemId,
    decisions: [{ who: "小王", what: "运费跟着商品一起退", refs: [src(2)] }],
    todos: [{ who: "小李", what: "发接口文档", due: "2026-12-02", refs: [src(3)] }],
    open_questions: [{ what: "部分发货要不要拆单退", refs: [src(4)] }],
  });
  return { app, line, record, summaryRun, ctx, src, outcomes };
}
const changes = (app: App, itemId: string) => all<{ type: string; summary: string; due: string | null; origin: string; refs: string }>(app.db, "select type, summary, due, origin, refs from item_changes where item_id = ? order by type", itemId);

describe("会议结束后，把决定结构化地写到关联的事项", () => {
  it("有确认关联的会议写出决定、待办、待定问题，能回到原件；同一场会再交不重复", async () => {
    const t = await setup();
    expect(meetingLinks(t.app, "m_demo", "owner").confirmed.map((c) => [c.item.id, c.why])).toEqual([[t.line.id, "会议所在的群挂在这件事上"]]);
    expect(outcomesTask(t.app, "m_demo", "owner")).toContain(`${t.line.id}「示例商城退款改造」`);
    const r = await callTool(t.ctx(t.summaryRun().id), "meeting_outcomes", t.outcomes(t.line.id));
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("新记 3 条");
    const rows = changes(t.app, t.line.id);
    expect(rows.map((c) => [c.type, c.summary, c.origin])).toEqual([["decision", "小王：运费跟着商品一起退", "meeting"], ["question", "部分发货要不要拆单退", "meeting"], ["todo", "小李：发接口文档", "meeting"]]);
    expect(rows.find((c) => c.type === "todo")!.due).toBe("2026-12-02");
    expect(JSON.parse(rows[0].refs)).toEqual([t.src(2)]);
    // The item's own deadline is untouched by a to-do's date.
    expect(getItem(t.app, t.line.id).dueAt).toBe("2026-12-10");
    // Handled again (a second summary run): nothing new.
    const again = await callTool(t.ctx(t.summaryRun().id), "meeting_outcomes", t.outcomes(t.line.id));
    expect(again.text).toContain("新记 0 条");
    expect(changes(t.app, t.line.id)).toHaveLength(3);
  });

  it("没有确认关联的只出候选，本人同意后才记，会议记录也挂到那件事上", async () => {
    const t = await setup();
    const other = upsertItem(t.app, undefined, { title: "退款接口文档" }, "user");
    const r = await callTool(t.ctx(t.summaryRun().id), "meeting_outcomes", t.outcomes(other.id));
    expect(r.text).toContain("先问本人");
    expect(changes(t.app, other.id)).toHaveLength(0);
    const ask = listAsks(t.app, { status: "pending" }).find((a) => a.handler === "meeting-outcomes")!;
    expect(ask.options.map((o) => o.label)).toEqual(["记到这件事", "不用"]);
    await answerAsk(t.app, ask.id, { choice: 0, by: "owner" });
    expect(changes(t.app, other.id)).toHaveLength(3);
    expect(one(t.app.db, "select 1 from item_materials where item_id = ? and kind = 'source' and ref = ?", other.id, t.record.id)).toBeTruthy();
    expect(meetingLinks(t.app, "m_demo", "owner").confirmed.map((c) => c.item.id)).toContain(other.id);
  });

  it("本人说“不用”记到那件事，同一场会再交也不再问", async () => {
    const t = await setup();
    const other = upsertItem(t.app, undefined, { title: "退款接口文档" }, "user");
    await callTool(t.ctx(t.summaryRun().id), "meeting_outcomes", t.outcomes(other.id));
    const ask = listAsks(t.app, { status: "pending" }).find((a) => a.handler === "meeting-outcomes")!;
    await answerAsk(t.app, ask.id, { choice: 1, by: "owner" });
    const again = await callTool(t.ctx(t.summaryRun().id), "meeting_outcomes", t.outcomes(other.id));
    expect(again.text).toContain("不再问");
    expect(listAsks(t.app, { status: "pending" }).filter((a) => a.handler === "meeting-outcomes")).toHaveLength(0);
    expect(changes(t.app, other.id)).toHaveLength(0);
  });

  it("别的空间的事项写不进去；引用要是这场会的记录；会中旁听不交", async () => {
    const t = await setup();
    createSpace(t.app, { id: "other", name: "别的项目" });
    const elsewhere = upsertItem(t.app, undefined, { title: "别的项目的事", spaceId: "other" }, "user");
    const denied = await callTool(t.ctx(t.summaryRun().id, ["personal"]), "meeting_outcomes", t.outcomes(elsewhere.id));
    expect(denied.isError).toBe(true);
    expect(changes(t.app, elsewhere.id)).toHaveLength(0);
    const chat = one<{ id: string }>(t.app.db, "select id from sources where uri = 'lark:oc_refund'")!;
    const wrong = await callTool(t.ctx(t.summaryRun().id), "meeting_outcomes", { item_id: t.line.id, decisions: [{ what: "随便", refs: [`src:${chat.id}#L1`] }] });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("会议的记录");
    const window = createRun(t.app, { kind: "agent", title: "旁听", input: { meetingId: "m_demo", meetingWindow: true }, notBefore: new Date(Date.now() + 3600_000).toISOString() });
    expect((await callTool(t.ctx(window.id), "meeting_outcomes", t.outcomes(t.line.id))).isError).toBe(true);
  });

  it("会上有人提议改截止时间：不直接改，问本人改不改；会上定了的才直接改", async () => {
    const t = await setup();
    const proposal = { item_id: t.line.id, deadline: { due: "2026-12-15", summary: "提出上线改到 12 月 15 日", refs: [t.src(5)] } };
    await callTool(t.ctx(t.summaryRun().id), "meeting_outcomes", proposal);
    expect(getItem(t.app, t.line.id).dueAt).toBe("2026-12-10");
    const ask = listAsks(t.app, { status: "pending" }).find((a) => a.handler === "meeting-deadline")!;
    expect(ask.options.map((o) => o.label)).toEqual(["改成这个时间", "不改"]);
    await answerAsk(t.app, ask.id, { choice: 0, by: "owner" });
    expect(getItem(t.app, t.line.id).dueAt?.slice(0, 10)).toBe("2026-12-15");

    const decided = { item_id: t.line.id, deadline: { due: "2026-12-20", summary: "本人定了上线改到 12 月 20 日", decided: true, refs: [t.src(5)] } };
    const r = await callTool(t.ctx(t.summaryRun().id), "meeting_outcomes", decided);
    expect(r.text).toContain("截止时间改成了 2026-12-20");
    expect(getItem(t.app, t.line.id).dueAt?.slice(0, 10)).toBe("2026-12-20");
  });
});
