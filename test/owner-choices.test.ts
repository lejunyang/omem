import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { one, run } from "../src/core/db.ts";
import { answerAsk, createAsk } from "../src/agents/asks.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { itemFocus } from "../src/agents/turn-context.ts";
import { focusBlock } from "../src/agents/turn-focus.ts";
import { defineMetric } from "../src/data/metrics.ts";
import { choiceOn, fingerprint, mayPropose, recordChoice } from "../src/items/choices.ts";
import { askLineEnd, mayAsk } from "../src/items/lifecycle.ts";
import { heldProposals, linesCard } from "../src/items/lines.ts";
import { decideCandidate, sameAutoItem } from "../src/items/auto.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});
const fresh = () => { const app = testApp(); apps.push(app); return app; };
const night = (app: App, names: string[]) => {
  const ws = createRun(app, { kind: "work-state", title: "近况" });
  setRunOutput(app, ws.id, { lineProposals: names.map((name, i) => ({ key: `p${i}`, name, goal: "", items: [], sources: [] })) });
  run(app.db, "update runs set status = 'done' where id = ?", ws.id);
  return ws;
};

describe("本人取舍的统一记录", () => {
  it("在每晚的卡片上说“不用”，“今天”里不再提；记录里只有一条，在哪答的都算", async () => {
    const app = fresh();
    const ws = night(app, ["退款对账"]);
    const card = linesCard(app, ws.id)!;
    await answerAsk(app, card.id, { value: { p0: "不用" }, by: "owner" });
    expect(choiceOn(app, "owner", "line", fingerprint("退款对账"))).toMatchObject({ choice: "drop", via: `ask:${card.id}` });
    // The old per-domain marker gone, the one record still holds: the next night's proposal of the same name is not offered.
    run(app.db, "delete from kv where key like 'line_declined:%'");
    night(app, ["退款 对账"]);
    expect(heldProposals(app).proposals).toEqual([]);
  });

  it("线要不要结束：在任何入口说“还没完”，两周内不再问；过了期限再问", async () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    const ask = askLineEnd(app, getItem(app, line.id), "子项都做完了")!;
    await answerAsk(app, ask.id, { choice: 2, by: "owner" });
    expect(choiceOn(app, "owner", "line-end", line.id)).toMatchObject({ choice: "keep" });
    run(app.db, "delete from kv");
    expect(mayAsk(app, line.id)).toBe(false);
    run(app.db, "update owner_choices set until = ? where kind = 'line-end'", new Date(Date.now() - 1000).toISOString());
    expect(mayAsk(app, line.id)).toBe(true);
    // 结束 is no choice to remember: it acts.
    expect(mayPropose(app, "owner", "line-end", "another").ok).toBe(true);
  });

  it("“以后再说”到期后再提；对象变了之后可以再提", () => {
    const app = fresh();
    recordChoice(app, { userId: "owner", kind: "metric", target: fingerprint("退款时长"), version: fingerprint("退款记录表"), choice: "later" });
    expect(mayPropose(app, "owner", "metric", fingerprint("退款时长"), fingerprint("退款记录表")).ok).toBe(false);
    run(app.db, "update owner_choices set until = ?", new Date(Date.now() - 1000).toISOString());
    expect(mayPropose(app, "owner", "metric", fingerprint("退款时长"), fingerprint("退款记录表")).ok).toBe(true);

    // Dropped on the data page; proposed again under a slightly different name: not, unless its query changed.
    const m = defineMetric(app, { name: "退款成功率", why: "退款是不是都成了", query: "退款记录表" }, { by: "agent" });
    defineMetric(app, { id: m.id, name: m.name, status: "dropped", ownerNote: "看日报就行" }, { by: "owner" });
    expect(choiceOn(app, "owner", "metric", fingerprint("退款成功率"))).toMatchObject({ choice: "drop", reason: "看日报就行" });
    run(app.db, "delete from metrics where id = ?", m.id);
    expect(() => defineMetric(app, { name: "退款 成功率", why: "再提", query: "退款记录表" }, { by: "agent" })).toThrow(/看日报就行/);
    expect(defineMetric(app, { name: "退款 成功率", why: "换了口径", query: "支付平台的退款回执" }, { by: "agent" }).status).toBe("proposed");
  });

  it("候选事项：在事项页说不要，助手不再建同名的；成员的取舍只影响他自己", () => {
    const app = fresh();
    const c = upsertItem(app, undefined, { title: "跟进发布单 #12" }, "agent");
    run(app.db, "update items set status = 'candidate' where id = ?", c.id);
    decideCandidate(app, c.id, false, "owner", "web");
    run(app.db, "delete from items where id = ?", c.id);
    expect(sameAutoItem(app, "owner", "跟进发布单#12")).toMatchObject({ candidate: false });
    // A member's no is theirs alone.
    recordChoice(app, { userId: "member", kind: "item-candidate", target: fingerprint("周报"), choice: "drop" });
    expect(mayPropose(app, "member", "item-candidate", fingerprint("周报")).ok).toBe(false);
    expect(mayPropose(app, "owner", "item-candidate", fingerprint("周报")).ok).toBe(true);
  });

  it("提问里带上对象：通用的回答路径记下；助手看这条线时带上最近的取舍", async () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    const ask = createAsk(app, { runId: null, conversationId: null, question: "要不要？", options: [{ label: "要" }, { label: "以后再说" }], context: { choice: { kind: "line-end", target: line.id } } });
    await answerAsk(app, ask.id, { choice: 1, by: "owner" });
    expect(choiceOn(app, "owner", "line-end", line.id)).toMatchObject({ choice: "later" });
    const focus = itemFocus(app, getItem(app, line.id), "explicit");
    expect(focus.context.choices?.[0]).toContain("以后再说");
    expect(focusBlock(app, focus, "owner").text).toContain("本人取舍");
    expect(one(app.db, "select count(*) n from owner_choices")).toEqual({ n: 1 });
  });
});
