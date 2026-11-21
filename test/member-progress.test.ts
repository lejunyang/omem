import { describe, expect, it } from "vitest";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken, type ToolContext } from "../src/agents/tools.ts";
import { toolAllowed } from "../src/auth/tools.ts";
import type { App } from "../src/core/app.ts";
import { all, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { recordChange } from "../src/items/changes.ts";
import { askMemberProgress, PROGRESS_COOLDOWN_MS } from "../src/items/member-progress.ts";
import { pendingActions } from "../src/items/pending.ts";
import { upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

/**
 * ask_member_progress (docs/v2/multi-user.md “成员的线”): the assistant asks a member, for the owner,
 * how a line is going; the answer becomes a change of the line.
 */
function setup() {
  const app = testApp();
  app.config.approvals.waitSeconds = 0;
  createSpace(app, { id: "proj", name: "项目 A" });
  createSpace(app, { id: "other", name: "项目 B" });
  for (const [id, name, role] of [["xw", "小王", "member"], ["xl", "小林", "member"], ["obs", "观察者", "observer"]] as const) createUser(app, { id, name, role });
  addMember(app, "proj", "xw", "contributor");
  addMember(app, "proj", "obs", "reader");
  addMember(app, "other", "xl", "contributor");
  // 小王 reads the owner's lines in 项目 A.
  run(app.db, "insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values('xw','work.view','space','proj','allow',?, 'owner')", new Date().toISOString());
  const line = upsertItem(app, undefined, { spaceId: "proj", kind: "line", title: "退款改造" } as never, "user");
  const hidden = upsertItem(app, undefined, { spaceId: "other", kind: "line", title: "合同评审" } as never, "user");
  const personal = upsertItem(app, undefined, { spaceId: "personal", kind: "line", title: "本人自己的事" } as never, "user");
  return { app, line, hidden, personal };
}

/** A turn of the assistant for someone: answering their own message, or not (a wake-up, a rule…). */
function turn(app: App, opts: { ownerAsked: boolean; userId?: string }): ToolContext {
  const userId = opts.userId ?? "owner";
  const thread = createThread(app, { spaceId: "personal", channel: "web", userId });
  const messageIds = opts.ownerAsked ? [addMessage(app, thread.id, "user", "去问小王退款改造到哪了", null, {})] : [];
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: "问进展", userId, input: { conversationId: thread.id, messageIds, userId }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
  return { ...toolContextForToken(app, issueToolToken({ runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: null, userId }))!, runId: r.id };
}

const progressAsks = (app: App, userId: string) => listAsks(app, { userId }).filter((a) => a.handler === "member-progress");
const audits = (app: App) => all<{ action: string; target: string }>(app.db, "select action, target from audit_events where action = 'member-progress.ask' order by id");

describe("ask_member_progress", () => {
  it("asks the owner first unless the owner asked for it this turn, and audits every one sent", async () => {
    const { app, line } = setup();
    const args = { item_id: line.id, member: "小王", question: "退款接口联调到哪了？" };
    // A wake-up or a rule's turn: a card for the owner, nothing sent.
    const held = await callTool(turn(app, { ownerAsked: false }), "ask_member_progress", args);
    expect(held.text).toContain("需要本人批准");
    expect(progressAsks(app, "xw")).toHaveLength(0);
    const [card] = listAsks(app, { status: "pending", userId: "owner" });
    expect(card.question).toContain("小王");
    expect(card.question).toContain("退款接口联调到哪了");
    expect((await callTool(turn(app, { ownerAsked: false }), "ask_member_progress", args)).text).toContain("正在等本人确认");
    expect(audits(app)).toHaveLength(0);
    // The owner says yes: sent.
    await answerAsk(app, card.id, { approved: true, by: "owner" });
    expect(progressAsks(app, "xw")).toHaveLength(1);
    expect(audits(app)).toEqual([{ action: "member-progress.ask", target: "xw" }]);
    // The owner's own words this turn: sent at once, and the open question is revised, not doubled.
    const out = await callTool(turn(app, { ownerAsked: true }), "ask_member_progress", { ...args, question: "退款接口联调这周能完吗？" });
    expect(out.text).toContain("已改了还没答的那条提问");
    const asks = progressAsks(app, "xw");
    expect(asks).toHaveLength(1);
    expect(asks[0].question).toContain("这周能完吗");
    expect(asks[0].askedBy).toBe("owner");
    expect(audits(app)).toHaveLength(2);
    // It is theirs: in their 等我的, not the owner's.
    expect((await pendingActions(app, "xw")).map((p) => p.askId)).toContain(asks[0].id);
    expect((await pendingActions(app, "owner")).map((p) => p.askId)).not.toContain(asks[0].id);
  });

  it("is refused for a member's run and for whoever may not read the item", async () => {
    const { app, line, hidden, personal } = setup();
    expect(toolAllowed(app, "xw", "ask_member_progress")).toBe(false);
    const member = await callTool(turn(app, { ownerAsked: true, userId: "xw" }), "ask_member_progress", { item_id: line.id, member: "小林", question: "替我问问" });
    expect(member.isError).toBe(true);
    const owner = turn(app, { ownerAsked: true });
    for (const [item, who, why] of [[hidden.id, "小王", "读不到"], [personal.id, "小王", "读不到"], [line.id, "小林", "读不到"], [line.id, "观察者", "观察者"], [line.id, "小周", "没有这个成员"]] as const) {
      const r = await callTool(owner, "ask_member_progress", { item_id: item, member: who, question: "到哪了？" });
      expect(r.isError, `${who} ${item}`).toBe(true);
      expect(r.text).toContain(why);
    }
    expect(listAsks(app).filter((a) => a.handler === "member-progress")).toHaveLength(0);
  });

  it("notes the answer word for word as one change of the line, once, and tells the owner", async () => {
    const { app, line } = setup();
    const { askId } = await askMemberProgress(app, { itemId: line.id, member: "xw", question: "退款接口联调到哪了？" });
    // Only the person asked may answer.
    await expect(answerAsk(app, askId, { text: "我来替他答", by: "xl" })).rejects.toThrow();
    await answerAsk(app, askId, { text: "联调完了一半，周四前能完", by: "xw" });
    const changes = all<{ origin: string; summary: string; source_key: string; type: string }>(app.db, "select origin, summary, source_key, type from item_changes where item_id = ?", line.id);
    expect(changes).toEqual([{ origin: "member", summary: "小王：联调完了一半，周四前能完", source_key: `ask:${askId}`, type: "info" }]);
    // Replayed (the same answer handed in again): no second change.
    recordChange(app, { itemId: line.id, type: "info", origin: "member", source: `ask:${askId}`, summary: "小王：联调完了一半，周四前能完", detail: "联调完了一半，周四前能完" });
    expect(all(app.db, "select id from item_changes where item_id = ?", line.id)).toHaveLength(1);
    const told = all<{ title: string; user_id: string }>(app.db, "select title, user_id from notifications where title like '%回了%'");
    expect(told).toEqual([{ title: "小王回了「退款改造」的进展", user_id: "owner" }]);
    expect(getAsk(app, askId).status).toBe("answered");
  });

  it("keeps “现在说不了” and does not ask the same person about the same item again for a while", async () => {
    const { app, line } = setup();
    const { askId } = await askMemberProgress(app, { itemId: line.id, member: "xw", question: "到哪了？" });
    await answerAsk(app, askId, { choice: 0, by: "xw" });
    expect(all(app.db, "select id from item_changes where item_id = ?", line.id)).toHaveLength(0);
    const again = await callTool(turn(app, { ownerAsked: true }), "ask_member_progress", { item_id: line.id, member: "小王", question: "现在呢？" });
    expect(again.text).toContain("说了现在说不了");
    expect(progressAsks(app, "xw").filter((a) => a.status === "pending")).toHaveLength(0);
    // After the cooldown: asked again.
    run(app.db, "update kv set value = ? where key like 'member_progress_unable:%'", new Date(Date.now() - PROGRESS_COOLDOWN_MS - 60_000).toISOString());
    expect((await callTool(turn(app, { ownerAsked: true }), "ask_member_progress", { item_id: line.id, member: "小王", question: "现在呢？" })).text).toContain("已去问");
  });
});
