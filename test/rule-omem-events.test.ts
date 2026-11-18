import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { run } from "../src/core/db.ts";
import { createAsk } from "../src/agents/asks.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { upsertItem } from "../src/items/store.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { startFlow } from "../src/flows/engine.ts";
import { emitPluginSignal } from "../src/plugins/signals.ts";
import { attachOmemEvents, dispatchOmemEvent, reviewFinished } from "../src/rules/omem-events.ts";
import { listFirings, saveRule } from "../src/rules/store.ts";
import { startServer } from "../src/server/http.ts";
import { closeVault } from "../src/auth/vault.ts";
import { testApp } from "./helpers.ts";

let app: App;
const rule = (types: string[], extra: Record<string, unknown> = {}) =>
  saveRule(app, { name: "内部事件", description: "omem 里有事时告诉我", enabled: true, trigger: { event: "omem", omemTypes: types }, judge: "code", actions: [{ type: "notify" }], ...extra } as never, "user", "owner");
/** The bus hands events to the rules without waiting: give it a moment. */
async function settle() {
  for (let n = 0; n < 20; n++) await new Promise((r) => setTimeout(r, 10));
}
const fired = (id: string) => listFirings(app, id);
function endRun(kind: Parameters<typeof createRun>[1]["kind"], status: "done" | "failed", input: Record<string, unknown> = {}, extra: Partial<Parameters<typeof createRun>[1]> = {}) {
  const r = createRun(app, { kind, spaceId: "personal", title: `示例运行 ${kind}`, input, ...extra });
  run(app.db, "update runs set status=?, error=?, output=? where id=?", status, status === "failed" ? "超时" : null, JSON.stringify({ text: "整理好了" }), r.id);
  app.emit({ type: "run", runId: r.id, status });
  return r;
}

beforeEach(() => {
  app = testApp();
  attachOmemEvents(app);
});
afterEach(async () => {
  await settle();
  app.db.close();
  closeVault(app.home);
  rmSync(app.home, { recursive: true, force: true });
});

describe("omem 内部事件触发规则", () => {
  it("运行结束和失败：带运行类型、档案、触发方式和结论；条件可以细分", async () => {
    const done = rule(["run.done"]), failed = rule(["run.failed"]);
    const agentOnly = rule(["run.done", "run.failed"], { conditions: { field: "omem.kind", op: "equals", value: "agent" } });
    endRun("agent", "done", { spec: "示例助手" });
    endRun("wiki-plan", "failed");
    await settle();
    expect(fired(done.id)).toHaveLength(1);
    expect(fired(done.id)[0].summary).toContain("运行结束（run.done）「示例运行 agent」");
    expect(fired(done.id)[0].summary).toContain("档案 示例助手");
    expect(fired(done.id)[0].summary).toContain("整理好了");
    expect(fired(failed.id)).toHaveLength(1);
    expect(fired(failed.id)[0].summary).toContain("超时");
    expect(fired(agentOnly.id)).toHaveLength(1);
  });

  it("事项新建、改状态；流程阶段变化；插件信号", async () => {
    const created = rule(["item.created"]), status = rule(["item.status"], { conditions: { field: "omem.status", op: "equals", value: "done" } });
    const stage = rule(["flow.stage"], { conditions: { field: "omem.stage", op: "equals", value: "first" } }), signal = rule(["plugin.signal"], { conditions: { field: "omem.plugin", op: "equals", value: "demo" } });
    const i = upsertItem(app, undefined, { title: "示例商城退款", spaceId: "personal", userId: "owner" }, "user");
    upsertItem(app, i.id, { status: "done" }, "user");
    saveFlow(app, JSON.stringify({ id: "simple", name: "示例流程", stages: [{ id: "first", name: "等本人", by: "owner" }] }), "user");
    const j = upsertItem(app, undefined, { title: "示例需求", spaceId: "personal", userId: "owner" }, "user");
    await startFlow(app, j.id, "simple", { actor: "owner", userId: "owner" });
    emitPluginSignal(app, "demo", { kind: "pushed", keys: { mr: 7 } });
    await settle();
    expect(fired(created.id)).toHaveLength(2);
    expect(fired(created.id)[0].summary).toContain("新事项");
    expect(fired(status.id)).toHaveLength(1);
    expect(fired(status.id)[0].summary).toMatch(/open → done/);
    expect(fired(stage.id).length).toBeGreaterThanOrEqual(1);
    expect(fired(stage.id)[0].summary).toContain("流程 simple 阶段 first");
    expect(fired(signal.id)).toHaveLength(1);
    expect(fired(signal.id)[0].summary).toContain("插件 demo");
  });

  it("交办应用、丢弃，评审结束；提问回答和失效", async () => {
    const code = rule(["code.applied", "code.discarded"]), review = rule(["review.done"]), asks = rule(["ask.answered", "ask.expired"]);
    const a = createRun(app, { kind: "code", spaceId: "personal", title: "交办：示例", input: {} });
    setRunOutput(app, a.id, { appliedAt: new Date().toISOString() });
    setRunOutput(app, a.id, { appliedAt: new Date().toISOString() });
    const b = createRun(app, { kind: "code", spaceId: "personal", title: "交办：另一个", input: {} });
    setRunOutput(app, b.id, { discardedAt: new Date().toISOString() });
    setRunOutput(app, b.id, { reviewStage: "done", verdict: "approved", reviewLead: { round: 1, summary: "可以合" } });
    const q = createAsk(app, { runId: null, question: "用哪个方案？", options: [{ label: "甲" }, { label: "乙" }] });
    run(app.db, "update asks set status='answered', choice=1 where id=?", q.id);
    app.emit({ type: "ask", id: q.id, status: "answered", conversationId: null });
    const q2 = createAsk(app, { runId: null, question: "还要吗？" });
    run(app.db, "update asks set status='cancelled' where id=?", q2.id);
    app.emit({ type: "ask", id: q2.id, status: "cancelled", conversationId: null });
    await settle();
    expect(fired(code.id).map((f) => f.summary.includes("交办已应用") ? "applied" : "discarded").sort()).toEqual(["applied", "discarded"]);
    expect(fired(review.id)).toHaveLength(1);
    expect(fired(review.id)[0].summary).toContain("approved");
    expect(fired(review.id)[0].summary).toContain("新问题 0 条");
    expect(fired(asks.id)).toHaveLength(2);
    expect(fired(asks.id).map((f) => f.summary).join("\n")).toContain("回答：乙");
  });

  it("复审带上已修、仍在的数目（reviewFinished）；和运行输出发的那条十分钟内只算一次", async () => {
    const review = rule(["review.done"], { conditions: { field: "omem.fixed", op: "gte", value: "2" } });
    const r = createRun(app, { kind: "code", spaceId: "personal", title: "复审：示例", input: {} });
    reviewFinished(app, { runId: r.id, verdict: "changes-requested", newFindings: 1, fixed: 2, still: 1, repo: "shop", branch: "feature/refund" });
    setRunOutput(app, r.id, { reviewStage: "done", verdict: "changes-requested" });
    await settle();
    expect(fired(review.id)).toHaveLength(1);
    expect(fired(review.id)[0].summary).toContain("已修 2 条，仍在 1 条");
    expect(fired(review.id)[0].summary).toContain("仓库 shop 分支 feature/refund");
  });

  it("防循环：规则自己起的运行不叫醒它；omem 规则起的运行不叫醒任何 omem 规则；别的规则的运行照常", async () => {
    const self = rule(["run.done"]), other = rule(["run.done"]);
    const message = saveRule(app, { name: "群消息", description: "有人问时处理", enabled: true, trigger: { event: "message" }, judge: "ai", actions: [{ type: "notify" }] }, "user", "owner");
    endRun("agent", "done", { rule: { id: self.id, name: self.name } }, { trigger: { via: "rule", source: { kind: "rule", id: self.id, name: self.name } } });
    await settle();
    expect(fired(self.id)).toHaveLength(0);
    expect(fired(other.id)).toHaveLength(0);
    endRun("agent", "done", { rule: { id: message.id, name: message.name } }, { trigger: { via: "rule", source: { kind: "rule", id: message.id, name: message.name } } });
    await settle();
    expect(fired(self.id)).toHaveLength(1);
    expect(fired(other.id)).toHaveLength(1);
    // An item the omem rule's run made wakes no omem rule either.
    const made = rule(["item.created"]);
    const r = createRun(app, { kind: "agent", spaceId: "personal", title: "规则的运行", input: { rule: { id: self.id, name: self.name } }, trigger: { via: "rule", source: { kind: "rule", id: self.id, name: self.name } } });
    upsertItem(app, undefined, { title: "运行建的事项", spaceId: "personal", userId: "owner" }, "agent", r.id);
    upsertItem(app, undefined, { title: "本人建的事项", spaceId: "personal", userId: "owner" }, "user");
    await settle();
    expect(fired(made.id).map((f) => f.summary)).toEqual([expect.stringContaining("本人建的事项")]);
  });

  it("去重：同一件事同一状态十分钟内只算一次，之后再来算新的；没有规则在听时什么也不做", async () => {
    const facts = { type: "item.status" as const, id: "item-x", title: "示例", status: "done" };
    expect(await dispatchOmemEvent(app, facts)).toBe(false);
    const r = rule(["item.status"]);
    const t0 = new Date("2026-11-19T10:00:00Z");
    expect(await dispatchOmemEvent(app, facts, t0)).toBe(true);
    expect(await dispatchOmemEvent(app, facts, new Date(t0.getTime() + 5 * 60_000))).toBe(false);
    expect(await dispatchOmemEvent(app, { ...facts, status: "open" }, new Date(t0.getTime() + 6 * 60_000))).toBe(true);
    expect(await dispatchOmemEvent(app, facts, new Date(t0.getTime() + 11 * 60_000))).toBe(true);
    expect(fired(r.id)).toHaveLength(3);
  });

  it("规则只看选了的事件；选了空间就只看这个空间", async () => {
    const r = rule(["item.created"], { spaceId: "personal" });
    await dispatchOmemEvent(app, { type: "item.created", id: "a", title: "别处的", space: "elsewhere" });
    await dispatchOmemEvent(app, { type: "item.status", id: "b", title: "不是选的", space: "personal" });
    await dispatchOmemEvent(app, { type: "item.created", id: "c", title: "这里的", space: "personal" });
    expect(fired(r.id).map((f) => f.summary)).toEqual([expect.stringContaining("这里的")]);
  });

  it("保存时核对：至少一种事件、只能用 omem 字段、没有群的动作", () => {
    expect(() => rule([])).toThrow("至少选一种事件");
    expect(() => rule(["run.done"], { conditions: { field: "chat.name", op: "contains", value: "x" } })).toThrow("只能用 omem 的字段");
    expect(() => rule(["run.done"], { actions: [{ type: "invite-bot" }] })).toThrow("没有群");
    expect(() => rule(["run.done"], { actions: [{ type: "agent", spec: "assistant", reply: "auto" }] })).toThrow("先选发到哪个会话");
    expect(() => rule(["run.done"], { trigger: { event: "omem", omemTypes: ["run.done"], waitMinutes: 5 } })).toThrow("不能等待回应");
    expect(() => saveRule(app, { name: "x", description: "x", trigger: { event: "message", omemTypes: ["run.done"] }, judge: "ai", actions: [{ type: "notify" }] } as never, "user", "owner")).toThrow("只有“omem 里发生的事”规则");
    expect(() => saveRule(app, { name: "x", description: "x", trigger: { event: "message" }, conditions: { field: "omem.kind", op: "equals", value: "agent" }, judge: "code", actions: [{ type: "notify" }] }, "user", "owner")).toThrow("只用于“omem 里发生的事”规则");
    expect(() => saveRule(app, { name: "x", description: "x", trigger: { event: "omem", omemTypes: ["nope"] }, judge: "code", actions: [{ type: "notify" }] } as never, "user", "owner")).toThrow();
  });

  it("规则页的选项列出 omem 的事件和字段", async () => {
    const s = await startServer(app, { port: 0, quiet: true });
    try {
      const o = (await s.inject("/api/rule-options")).json();
      expect(o.omemTypes).toContainEqual({ type: "review.done", label: "评审结束" });
      expect(o.eventFields.omem).toContain("omem.status");
      expect(o.eventFields.message).not.toContain("omem.status");
      expect(o.eventFields.object).toContain("object.change");
    } finally {
      await s.close();
    }
  });
});
