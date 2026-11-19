import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendItemDigests } from "../src/agents/jobs.ts";
import * as runner from "../src/agents/runner.ts";
import { createRun, __testHandlers } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { itemDigestCard } from "../src/channels/item-notification.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { recordInteraction, setLarkClient } from "../src/channels/lark-send.ts";
import { setOwnerInChatForTests } from "../src/channels/lark-guest.ts";
import { saveContext } from "../src/channels/listen.ts";
import type { App } from "../src/core/app.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { all, one, run } from "../src/core/db.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { itemLessons, sweepCandidates } from "../src/items/auto.ts";
import { digestFor, expireDue, itemExpiry } from "../src/items/expiry.ts";
import { deliverDueReminders } from "../src/items/reminders.ts";
import { getItem, itemEvents, listItems, upsertItem } from "../src/items/store.ts";
import { replyStats } from "../src/mentions/reply-learn.ts";
import { startServer } from "../src/server/http.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  setDecisionFetchForTests(null);
  setLarkClient(null);
  for (const s of servers.splice(0)) await s.close();
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

function fixture() {
  const app = testApp(); apps.push(app);
  app.config.lark.ownerOpenId = "ou_owner";
  return app;
}
const ctxFor = (app: App, runId: string) => toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
const ingestRun = (app: App) => createRun(app, { kind: "ingest", spaceId: "personal", title: "整理新材料", input: { sourceIds: [] } });

/** The decision model answers `choice` with this probability (scene item: keep / candidate). */
function decision(app: App, choice: "keep" | "candidate", p: number, seen?: (body: string) => void) {
  app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai" as never, backends: [] }];
  app.config.ai.decision = { provider: "d", model: "", fallback: "general", gatekeeper: true };
  setKey(app.home, "d", "key-1");
  const other = choice === "keep" ? "candidate" : "keep";
  setDecisionFetchForTests((async (_u: string, init: RequestInit) => {
    seen?.(String(init.body));
    return new Response(JSON.stringify({ answers: [{ type: "choice", name: "q", choice, probabilities: [{ value: choice, probability: p }, { value: other, probability: 1 - p }] }] }));
  }) as unknown as typeof fetch);
}

const cases = (app: App) => all<{ handle_run: string; chat_kind: string; ask: string; decision: string; reason: string; final: string; settled_at: string | null }>(app.db, "select * from reply_samples where source = 'item' order by created_at, rowid");

describe("items the assistant makes on its own", () => {
  it("leaves the owner's own turn as it was: no reason asked, made at once", async () => {
    const app = fixture();
    const thread = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
    const said = addMessage(app, thread.id, "user", "周五下午提醒我交报销单");
    const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "提醒", input: { conversationId: thread.id, messageIds: [said] } });
    const r = await callTool(ctxFor(app, turn.id), "upsert_item", { title: "交报销单", kind: "reminder", remind_at: new Date(Date.now() + 86400_000).toISOString() });
    expect(r.isError, r.text).toBe(false);
    const item = listItems(app, { status: "all" })[0];
    expect(item.status).toBe("open");
    expect(itemEvents(app, item.id).map((e) => e.kind)).not.toContain("auto");
  });

  it("refuses a background run's new item without a reason, or with a reference that does not exist", async () => {
    const app = fixture();
    const ctx = ctxFor(app, ingestRun(app).id);
    const none = await callTool(ctx, "upsert_item", { title: "看一下发布单", kind: "todo" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("why");
    const bad = await callTool(ctx, "upsert_item", { title: "看一下发布单", kind: "todo", why: "本人说过要跟（src:s_missing#L1）" });
    expect(bad.isError).toBe(true);
    expect(listItems(app, { status: "all" })).toHaveLength(0);
  });

  it("makes it a candidate when the decision model is not sure: no reminder, out of the lists, on the daily card", async () => {
    const app = fixture();
    let body = "";
    decision(app, "candidate", 0.8, (b) => (body = b));
    const runId = ingestRun(app).id;
    const r = await callTool(ctxFor(app, runId), "upsert_item", { title: "跟进发布单 #12", kind: "reminder", remind_at: new Date(Date.now() - 60_000).toISOString(), why: "可能和本人有关" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("候选");
    expect(body).toContain("跟进发布单 #12");
    expect(body).toContain("可能和本人有关");
    const item = listItems(app, { status: "all" })[0];
    expect(item.status).toBe("candidate");
    expect(itemEvents(app, item.id).find((e) => e.kind === "auto")!.text).toContain("为什么建：可能和本人有关");
    // Its reminder time is past, yet nothing is delivered; it is in no active list and does not expire.
    expect(deliverDueReminders(app)).toEqual([]);
    expect(listItems(app, { status: "active" })).toHaveLength(0);
    expect(itemExpiry(app, item)).toBeNull();
    expect(one<{ scene: string; ref: string }>(app.db, "select scene, ref from decisions")).toEqual({ scene: "item", ref: runId });
    // The 09:30 card offers it with 留下 / 不要.
    const [n] = await sendItemDigests(app);
    expect(n.digest?.candidates).toEqual([item.id]);
    expect(n.body).toContain("这几件我觉得你可能要跟");
    const card = JSON.stringify(itemDigestCard(app, n));
    expect(card).toContain(`item:take:${item.id}`);
    expect(card).toContain(`item:drop:${item.id}`);

    // Sure enough: made at once. Sure but under the threshold: a candidate.
    decision(app, "keep", 0.9);
    const kept = await callTool(ctxFor(app, runId), "upsert_item", { title: "回复小王的接口问题", kind: "todo", why: "本人在群里答应了小王今天回" });
    expect(kept.text).toContain("[todo/open]");
    decision(app, "keep", 0.55);
    const lowered = await callTool(ctxFor(app, runId), "upsert_item", { title: "整理退款口径", kind: "todo", why: "服务本人近况里的退款改造" });
    expect(lowered.text).toContain("[todo/candidate]");
  });

  it("without a decision model: the owner's own words or a 关注 make it an item, anything else waits as a candidate", async () => {
    const app = fixture();
    const chat = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_a", title: "项目 A 退款群", text: "[2026-11-19 10:00] 小王: 接口文档发你了 (om_a1)\n[2026-11-19 10:05] 我（本人）: 好，周五前我看完回你 (om_a2)" });
    saveContext(app, { kind: "place", name: "项目 A 退款群", chats: ["oc_a"] });
    setOwnerInChatForTests("oc_a", true);
    const ctx = ctxFor(app, ingestRun(app).id);
    const own = await callTool(ctx, "upsert_item", { title: "周五前看完接口文档", kind: "todo", why: `本人答应了小王（src:${chat.id}#L2）`, source_refs: [`src:${chat.id}#L2`] });
    expect(own.text).toContain("[todo/open]");
    const theirs = await callTool(ctx, "upsert_item", { title: "小王发了接口文档", kind: "watch", why: `小王说的（src:${chat.id}#L1）` });
    expect(theirs.text).toContain("[watch/candidate]");
    const listen = await callTool(ctx, "upsert_item", { title: "退款群的接口变更", kind: "watch", why: "属于关注「项目 A 退款群」" });
    expect(listen.text).toContain("[watch/open]");
  });

  it("keeps or drops a candidate from the card and from the items page, and every choice is a case", async () => {
    const app = fixture();
    decision(app, "candidate", 0.9);
    const runId = ingestRun(app).id;
    const make = async (title: string) => {
      await callTool(ctxFor(app, runId), "upsert_item", { title, kind: "todo", remind_at: new Date(Date.now() + 3600_000).toISOString(), why: `${title}的理由` });
      return listItems(app, { status: "candidate", q: title })[0];
    };
    const a = await make("候选甲"), b = await make("候选乙");

    // The card: 留下 opens it with its reminder time.
    recordInteraction(app, { messageId: "om_digest", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { digest: true, itemIds: [a.id], userId: "owner" } });
    const press = (action: string) => handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_digest" }, action: { value: { action } } });
    expect((await press(`item:take:${b.id}`)).toast.type).toBe("error");
    expect((await press(`item:take:${a.id}`)).toast.content).toContain("已留下");
    expect(getItem(app, a.id)).toMatchObject({ status: "open", remindAt: a.remindAt });
    expect((await press(`item:drop:${a.id}`)).toast.type).toBe("info");

    // The page: 不要 puts it down.
    const server = await startServer(app, { port: 0, quiet: true }); servers.push(server);
    const listed = (await server.inject({ method: "GET", url: "/api/items?status=candidate" })).json();
    expect(listed.map((i: { id: string }) => i.id)).toEqual([b.id]);
    expect(listed[0].auto).toEqual({ why: "候选乙的理由", by: "整理新材料" });
    const dropped = await server.inject({ method: "POST", url: `/api/items/${b.id}/candidate`, payload: { keep: false } });
    expect(dropped.statusCode).toBe(200);
    expect(getItem(app, b.id).status).toBe("cancelled");
    expect((await server.inject({ method: "POST", url: `/api/items/${b.id}/candidate`, payload: { keep: true } })).statusCode).toBe(409);

    // An auto item the owner ignores, one that expires untouched, a candidate nobody answers.
    decision(app, "keep", 0.95);
    await callTool(ctxFor(app, runId), "upsert_item", { title: "自动丙", kind: "todo", why: "本人近况里的退款改造" });
    await callTool(ctxFor(app, runId), "upsert_item", { title: "自动丁", kind: "todo", why: "本人近况里的退款改造" });
    const c = listItems(app, { status: "open", q: "自动丙" })[0], d = listItems(app, { status: "open", q: "自动丁" })[0];
    upsertItem(app, c.id, { status: "cancelled", note: "本人在飞书卡片上忽略" }, "user");
    expireDue(app, new Date(Date.now() + 30 * 86400_000));
    expect(getItem(app, d.id).status).toBe("expired");
    decision(app, "candidate", 0.9);
    const e = await make("候选戊");
    run(app.db, "update items set created_at = ? where id = ?", new Date(Date.now() - 4 * 86400_000).toISOString(), e.id);
    expect(sweepCandidates(app)).toEqual([e.id]);
    expect(getItem(app, e.id).status).toBe("cancelled");
    // Put down quietly: not news for the digest.
    expect(digestFor(app, "owner")?.closed.map((x) => x.id) ?? []).not.toContain(e.id);

    const got = cases(app);
    expect(got.map((x) => [x.final, x.decision, x.reason])).toEqual([
      [a.id, "sent", "candidate-kept"],
      [b.id, "dropped", "candidate-dropped"],
      [c.id, "dropped", "ignored"],
      [d.id, "dropped", "expired"],
      [e.id, "dropped", "candidate-expired"],
    ]);
    expect(got[0]).toMatchObject({ handle_run: runId, chat_kind: "item", ask: "候选甲\n候选甲的理由" });
    expect(got.every((x) => x.settled_at)).toBe(true);
    // The owner's reply habits for 有人找你 are not about items.
    expect(replyStats(app).samples).toBe(0);
  });

  it("does not make the same candidate twice, nor what the owner just turned down, and leaves a candidate's status to the owner", async () => {
    const app = fixture();
    decision(app, "candidate", 0.9);
    const ctx = ctxFor(app, ingestRun(app).id);
    await callTool(ctx, "upsert_item", { title: "看发布单", kind: "todo", why: "可能有用" });
    const again = await callTool(ctx, "upsert_item", { title: "看 发布单", kind: "todo", why: "可能有用" });
    expect(again.text).toContain("已经是候选");
    const item = listItems(app, { status: "candidate" })[0];
    const promote = await callTool(ctx, "upsert_item", { id: item.id, status: "open" });
    expect(promote.isError).toBe(true);
    expect((await callTool(ctx, "upsert_item", { id: item.id, note: "发布单有了新进展" })).isError).toBe(false);
    expect(getItem(app, item.id).status).toBe("candidate");
    upsertItem(app, item.id, { status: "cancelled" }, "user");
    const refused = await callTool(ctx, "upsert_item", { title: "看发布单", kind: "todo", why: "可能有用" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("不要过");
  });

  it("shows the creating role what the owner kept and dropped, in its task", async () => {
    const app = fixture();
    decision(app, "candidate", 0.9);
    const ctx = ctxFor(app, ingestRun(app).id);
    await callTool(ctx, "upsert_item", { title: "跟进环境回收通知", kind: "reminder", why: "系统通知说环境要回收" });
    await callTool(ctx, "upsert_item", { title: "周五前看完接口文档", kind: "todo", why: "本人答应了小王" });
    const [x, y] = [listItems(app, { status: "candidate", q: "环境回收" })[0], listItems(app, { status: "candidate", q: "接口文档" })[0]];
    upsertItem(app, x.id, { status: "cancelled" }, "user");
    upsertItem(app, y.id, { status: "open" }, "user");
    const lessons = itemLessons(app, "ingest");
    expect(lessons).toContain("本人最近对你自动建的事项的取舍");
    expect(lessons).toContain("不要：「跟进环境回收通知」");
    expect(lessons).toContain("留下：「周五前看完接口文档」");

    const src = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "doc:plan", title: "退款方案", text: "退款按未发货行算。" });
    const tasks: string[] = [];
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      tasks.push(input.task);
      return { text: "没有要改的", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    try {
      const r = createRun(app, { kind: "ingest", spaceId: "personal", title: "整理新材料", input: { sourceIds: [src.id] } });
      await __testHandlers.get("ingest")!({ app, run: r, signal: new AbortController().signal, event() {}, output() {} } as never);
    } finally { fake.mockRestore(); }
    expect(tasks[0]).toContain("本人最近对你自动建的事项的取舍");
    expect(tasks[0]).toContain("跟进环境回收通知");
  });
});
