import { afterEach, describe, expect, it } from "vitest";
import { callTool, type ToolContext, toolContextForToken, revokeToolToken } from "../src/agents/tools.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { createRun, getRun } from "../src/agents/runs.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createUser, addMember } from "../src/core/users.ts";
import { one } from "../src/core/db.ts";
import { listNotifications, notify } from "../src/core/notify.ts";
import { deliverDueReminders } from "../src/items/reminders.ts";
import { getItem, itemEvents, upsertItem, reminderSourceRefs } from "../src/items/store.ts";
import { upsertSource, deleteSource } from "../src/sources/store.ts";
import { notificationOrigins } from "../src/channels/common.ts";
import { itemDigestCard, itemNotificationCard } from "../src/channels/item-notification.ts";
import { getInteraction, recordInteraction, setLarkClient } from "../src/channels/lark-send.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { setLarkClient(null); for (const a of apps.splice(0)) a.db.close(); });
function fixture() {
  const app = testApp(); apps.push(app);
  app.config.lark.ownerOpenId = "ou_owner";
  createSpace(app, { id: "project-a", name: "项目 A" });
  const doc = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "https://example.com/plan", title: "计划", text: "第一行\n第二行\n第三行" });
  const later = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "https://example.com/schema", title: "接口约定", text: "新的接口交付\n截止周五" });
  const refs = [`src:${doc.id}#L1-L1`, `src:${doc.id}#L2-L3`];
  const fresh = `src:${later.id}#L1-L2`;
  const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, writable: undefined, tools: null, actor: "agent", userId: "owner", role: "assistant", larkChats: null };
  return { app, ctx, refs, fresh };
}

describe("item evidence and notification scope", () => {
  it("deduplicates final external URLs, snapshots each event, and keeps accumulated evidence", () => {
    const { app, refs, fresh } = fixture();
    const item = upsertItem(app, undefined, { title: "项目 A 发布", sourceRefs: refs });
    const first = notify(app, { title: "创建", body: `[第一段](${refs[0]}) [第二段](${refs[1]}) [直链](https://example.com/plan)`, entityId: item.id });
    upsertItem(app, item.id, { sourceRefs: [fresh], note: "接口交付变化" });
    const second = notify(app, { title: "进展", body: `[旧文](${refs[0]}) [新文](${fresh})`, entityId: item.id });
    expect(notificationOrigins(app, refs).match(/https:\/\//g)).toHaveLength(1);
    expect(first.sourceRefs).toEqual(refs);
    const firstCard = JSON.stringify(itemNotificationCard(app, first));
    expect(firstCard.match(/https:\/\/example\.com\/plan/g)).toHaveLength(1);
    expect(firstCard).toContain("第一段");
    expect(firstCard).toContain("第二段");
    expect(firstCard).toContain("直链");
    expect(second.sourceRefs).toEqual([fresh]);
    const originsOnly = JSON.stringify(itemNotificationCard(app, { ...first, body: "", sourceRefs: [...refs, fresh] }));
    expect(originsOnly.match(/https:\/\/example\.com\/plan/g)).toHaveLength(1);
    expect(originsOnly.match(/https:\/\/example\.com\/schema/g)).toHaveLength(1);
    expect(() => notify(app, { title: "错配事件", entityId: item.id, eventId: first.eventId, sourceRefs: [fresh] })).toThrow(/不属于指定事件/);
    const card = JSON.stringify(itemNotificationCard(app, second));
    expect(card.match(/https:\/\/example\.com\/schema/g)).toHaveLength(1);
    expect(card).not.toContain("https://example.com/plan");
    expect(getItem(app, item.id).sourceRefs).toEqual([...refs, fresh]);
    expect(listNotifications(app).find((n) => n.id === first.id)?.sourceRefs).toEqual(refs);
    const another = upsertItem(app, undefined, { title: "其他任务" });
    expect(() => notify(app, { title: "错误事件", entityId: another.id, eventId: second.eventId })).toThrow(/事件不属于/);
  });

  it("supports explicit source corrections with stale-set checks and retains history", async () => {
    const { app, ctx, refs, fresh } = fixture();
    const item = upsertItem(app, undefined, { title: "发布", sourceRefs: refs });
    expect((await callTool(ctx, "upsert_item", { id: item.id, source_refs: [] })).isError).toBe(false);
    expect(getItem(app, item.id).sourceRefs).toEqual(refs);
    for (const args of [
      { source_refs: [], expected_source_refs: refs },
      { source_refs: [fresh], expected_source_refs: [] },
      { source_refs: ["src:missing"], expected_source_refs: refs },
      { source_refs: [refs[0].replace("L1-L1", "L1-L99")], expected_source_refs: refs },
    ]) expect((await callTool(ctx, "upsert_item", { id: item.id, note: "纠正来源", source_refs_mode: "replace", ...args })).isError).toBe(true);
    expect((await callTool(ctx, "upsert_item", { id: item.id, note: "纠正来源", source_refs_mode: "replace", source_refs: [fresh], expected_source_refs: refs })).isError).toBe(false);
    expect(getItem(app, item.id).sourceRefs).toEqual([fresh]);
    expect(itemEvents(app, item.id).find((e) => e.kind === "sources-corrected")?.text).toContain(refs[0]);
    expect(itemEvents(app, item.id)[0].sourceRefs).toEqual(refs);
    expect((await callTool(ctx, "upsert_item", { id: item.id, note: "撤回错误引用", source_refs_mode: "remove", source_refs: [refs[0]], expected_source_refs: [fresh] })).isError).toBe(true);
    expect((await callTool(ctx, "upsert_item", { id: item.id, note: "撤回错误引用", source_refs_mode: "remove", source_refs: [fresh], expected_source_refs: [fresh] })).isError).toBe(false);
    expect(getItem(app, item.id).sourceRefs).toEqual([]);
    expect(notify(app, { title: "旧事件不复活", entityId: item.id, eventId: itemEvents(app, item.id)[0].id }).sourceRefs).toEqual([]);
    expect(() => notify(app, { title: "不能显式恢复", entityId: item.id, sourceRefs: [fresh] })).toThrow(/当前有效来源/);
    expect(notify(app, { title: "已纠正", entityId: item.id }).sourceRefs).toEqual([]);
  });

  it("keeps scheduled reminder evidence distinct from later progress", () => {
    const { app, refs, fresh } = fixture();
    const item = upsertItem(app, undefined, { title: "发布", sourceRefs: refs, remindAt: "2030-01-01T09:00:00Z" });
    upsertItem(app, item.id, { sourceRefs: [fresh], note: "无关进展" });
    expect(reminderSourceRefs(app, getItem(app, item.id))).toEqual(refs);
    upsertItem(app, item.id, { remindAt: "2030-01-02T09:00:00Z", sourceRefs: [fresh] });
    expect(reminderSourceRefs(app, getItem(app, item.id))).toEqual([fresh]);
  });

  it("delivers stale-source reminders without leaking links or blocking later items", () => {
    const { app, refs, fresh } = fixture();
    const bad = upsertItem(app, undefined, { title: "原件已删除的提醒", remindAt: "2000-01-01T00:00:00Z", sourceRefs: refs, detail: `[原文](${refs[0]})` });
    const good = upsertItem(app, undefined, { title: "正常提醒", remindAt: "2000-01-01T00:00:00Z", sourceRefs: [fresh] });
    deleteSource(app, refs[0].replace(/^src:/, "").split("#")[0]);
    deliverDueReminders(app);
    const notices = listNotifications(app);
    expect(notices.find((n) => n.entityId === bad.id)?.sourceRefs).toEqual([]);
    expect(notices.find((n) => n.entityId === bad.id)?.body).toBe("原文");
    expect(notices.find((n) => n.entityId === good.id)?.sourceRefs).toEqual([fresh]);
    expect(getItem(app, bad.id).remindAt).toBeNull();
    expect(getItem(app, good.id).remindAt).toBeNull();
    expect(itemEvents(app, bad.id).find((e) => e.kind === "reminded")?.sourceRefs).toEqual(refs);
  });

  it("discovers unrelated-space items without expanding ordinary read/write scope, then routes safely", async () => {
    const { app, ctx, fresh } = fixture();
    const target = upsertItem(app, undefined, { spaceId: "project-a", title: "接口 Schema 交付" });
    app.baseUrl = "http://127.0.0.1:1";
    const prepared = prepareRun(app, { actor: { role: "ingest" }, spaceId: "personal", runId: null });
    const bg = toolContextForToken(app, prepared.token)!;
    try {
      expect(bg.spaces).toEqual(["personal"]);
      expect(bg.writable).toEqual(["personal"]);
      const restricted = prepareRun(app, { actor: { role: "ingest" }, spaceId: "personal", spaces: ["personal"], runId: null });
      try {
        expect((await callTool(toolContextForToken(app, restricted.token)!, "list_items", { space: "*", query: "Schema" })).text).not.toContain(target.id);
      } finally { revokeToolToken(restricted.token); }
      expect((await callTool(bg, "list_items", { space: "*", query: "Schema" })).text).toContain(target.id);
      expect((await callTool(bg, "read_item", { item_id: target.id })).isError).toBe(false);
      expect((await callTool(bg, "upsert_item", { id: target.id, note: "越权" })).isError).toBe(true);
      expect((await callTool(bg, "notify", { entity_id: target.id, title: "越权", body: "x" })).isError).toBe(true);
      const args = { item_id: target.id, note: "接口有更新", source_refs: [fresh] };
      const proposed = await callTool(bg, "propose_item_update", args);
      expect(proposed.isError).toBe(false);
      const id = /提案 (ip\w+)/.exec(proposed.text)![1];
      expect((await callTool(bg, "propose_item_update", args)).text).toContain(id);
      expect(getItem(app, target.id).sourceRefs).toEqual([]);
      expect((await callTool(bg, "resolve_item_proposal", { proposal_id: id, action: "apply", reason: "复核" })).isError).toBe(true);
      expect((await callTool(ctx, "list_item_proposals", {})).text).toContain(id);
      expect((await callTool(ctx, "resolve_item_proposal", { proposal_id: id, action: "apply", reason: "已核对为同一交付" })).isError).toBe(false);
      expect(getItem(app, target.id).sourceRefs).toEqual([fresh]);
      expect((await callTool(ctx, "resolve_item_proposal", { proposal_id: id, action: "apply", reason: "重复" })).isError).toBe(true);
    } finally { revokeToolToken(prepared.token); }
  });

  it("does not discover inaccessible spaces or allow member readers to write or notify", async () => {
    const { app, refs } = fixture();
    createUser(app, { id: "wang", name: "小王" });
    addMember(app, "project-a", "wang", "reader");
    const target = upsertItem(app, undefined, { spaceId: "project-a", userId: "wang", title: "用户事项" });
    const secret = upsertItem(app, undefined, { userId: "wang", title: "不可访问事项" });
    for (let i = 0; i < 101; i++) upsertItem(app, undefined, { userId: "wang", title: `隐藏高优先级事项 ${i}`, priority: 1 });
    const member: ToolContext = { app, runId: null, spaceId: "personal-wang", spaces: ["personal-wang", "project-a"], tools: null, actor: "agent", userId: "wang" };
    const visible = (await callTool(member, "list_items", { space: "*" })).text;
    expect(visible).not.toContain(secret.id);
    expect(visible).toContain(target.id);
    expect((await callTool(member, "read_item", { item_id: secret.id })).isError).toBe(true);
    expect((await callTool(member, "upsert_item", { id: target.id, note: "越权" })).isError).toBe(true);
    expect((await callTool(member, "notify", { entity_id: target.id, title: "x", body: "x" })).isError).toBe(true);
    expect((await callTool(member, "upsert_item", { title: "引用机密", source_refs: refs })).isError).toBe(true);
    expect((await callTool(member, "repair_item_association", {})).isError).toBe(true);
  });

  it("rejects forged button targets and unauthorized operators against persisted payload", async () => {
    const { app } = fixture();
    const a = upsertItem(app, undefined, { title: "任务 A" }), b = upsertItem(app, undefined, { title: "任务 B" });
    recordInteraction(app, { messageId: "om_card", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: a.id } });
    const press = (id: string, who = "ou_owner") => handleCardAction(app, { operator: { open_id: who }, context: { open_message_id: "om_card" }, action: { value: { action: `item:done:${id}` } } });
    expect((await press(b.id)).toast.type).toBe("error");
    expect((await press(a.id, "ou_unknown")).toast.type).toBe("error");
    expect(getItem(app, a.id).status).toBe("open");
    expect(getItem(app, b.id).status).toBe("open");
    expect((await press(a.id)).toast.type).toBe("success");
    expect(getItem(app, a.id).status).toBe("done");
  });

  it("digest card: reopens or keeps only the items it lists, and stays usable for the rest", async () => {
    const { app } = fixture();
    const gone = upsertItem(app, undefined, { title: "已过期的事项" });
    upsertItem(app, gone.id, { status: "expired", note: "自动过期" }, "agent");
    const soon = upsertItem(app, undefined, { title: "明天过期的事项" });
    const other = upsertItem(app, undefined, { title: "不在卡片里" });
    const card = JSON.stringify(itemDigestCard(app, { id: "n1", at: "", title: "事项清点", body: "…", link: null, readAt: null, userId: "owner", digest: { closed: [gone.id], soon: [soon.id] } }));
    expect(card).toContain(`item:reopen:${gone.id}`);
    expect(card).toContain(`item:keep:${soon.id}`);
    recordInteraction(app, { messageId: "om_digest", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { digest: true, itemIds: [gone.id, soon.id], userId: "owner" } });
    const press = (action: string) => handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_digest" }, action: { value: { action } } });
    expect((await press(`item:keep:${other.id}`)).toast.type).toBe("error");
    expect((await press(`item:reopen:${gone.id}`)).toast.content).toMatch(/已恢复/);
    expect(getItem(app, gone.id).status).toBe("open");
    expect((await press(`item:keep:${soon.id}`)).toast.content).toMatch(/已保留/);
    expect(itemEvents(app, soon.id).at(-1)!.actor).toBe("user");
  });

  it("rejects a stale callback that was waiting while maintenance expired the card", async () => {
    const { app } = fixture();
    const item = upsertItem(app, undefined, { title: "旧事项" });
    const interaction = recordInteraction(app, { messageId: "om_race", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: item.id } });
    let resume!: (name: string) => void;
    const name = new Promise<string>((resolve) => { resume = resolve; });
    const pending = handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_race" }, action: { value: { action: `item:done:${item.id}` } } }, () => name);
    app.db.prepare("update card_interactions set status='expired' where id=?").run(interaction);
    resume("本人");
    expect((await pending).toast.type).toBe("warning");
    expect(getItem(app, item.id).status).toBe("open");
    expect(getInteraction(app, interaction)?.status).toBe("expired");
  });

  it("can reject a proposal after its source is deleted, with a durable resolution", async () => {
    const { app, ctx, fresh } = fixture();
    const item = upsertItem(app, undefined, { title: "接口交付", spaceId: "project-a" });
    const result = await callTool(ctx, "propose_item_update", { item_id: item.id, note: "过期进展", source_refs: [fresh] });
    const id = /提案 (ip\w+)/.exec(result.text)![1];
    deleteSource(app, fresh.replace(/^src:/, "").split("#")[0]);
    expect((await callTool(ctx, "resolve_item_proposal", { proposal_id: id, action: "apply", reason: "不可应用" })).isError).toBe(true);
    expect((await callTool(ctx, "resolve_item_proposal", { proposal_id: id, action: "reject", reason: "原件已删除" })).isError).toBe(false);
    expect(one(app.db, "select status,resolution from item_update_proposals where id=?", id)).toMatchObject({ status: "reject", resolution: "原件已删除" });
  });

  it("retains shared evidence for unmoved events when repairing an association", async () => {
    const { app, ctx, refs, fresh } = fixture();
    const from = upsertItem(app, undefined, { title: "季度计划", sourceRefs: [refs[0]] });
    const keptEvent = itemEvents(app, from.id)[0];
    const to = upsertItem(app, undefined, { title: "独立交付", spaceId: "project-a" });
    upsertItem(app, from.id, { note: "待迁移进展", sourceRefs: [refs[0], fresh] });
    const movedEvent = itemEvents(app, from.id).at(-1)!;
    const origin = createRun(app, { kind: "ingest", spaceId: "personal", title: "整理", notBefore: "2999-01-01T00:00:00Z" });
    const n = notify(app, { title: "进展", entityId: from.id, eventId: movedEvent.id, runId: origin.id });
    const args = { from_item_id: from.id, to_item_id: to.id, event_ids: [movedEvent.id], source_refs: [refs[0], fresh], expected_source_refs: [refs[0], fresh], run_id: origin.id, notification_id: n.id, title: "独立交付进展", body: "交付更新", reason: "纠正错误关联" };
    const preview = await callTool(ctx, "repair_item_association", args);
    expect(preview.isError, preview.text).toBe(false);
    expect(JSON.parse(preview.text).snapshot).toMatchObject({ retainedSourceRefs: [refs[0]], removedSourceRefs: [fresh] });
    expect(getItem(app, from.id).sourceRefs).toEqual([refs[0], fresh]);
    const result = await callTool(ctx, "repair_item_association", { ...args, apply: true });
    expect(result.isError, result.text).toBe(false);
    expect(getItem(app, from.id).sourceRefs).toEqual([refs[0]]);
    expect(getItem(app, to.id).sourceRefs).toEqual([refs[0], fresh]);
    expect(itemEvents(app, from.id)).toContainEqual(keptEvent);
    expect(itemEvents(app, from.id)).not.toContainEqual(movedEvent);
    expect(itemEvents(app, to.id)).toContainEqual({ ...movedEvent, itemId: to.id });
    expect(notify(app, { title: "保留事件仍可通知", entityId: from.id, eventId: keptEvent.id }).sourceRefs).toEqual([refs[0]]);
    const audit = /审计 (ir\w+)/.exec(result.text)![1];
    const saved = await callTool(ctx, "read_item_repair", { repair_id: audit });
    expect(JSON.parse(JSON.parse(saved.text).snapshot)).toMatchObject({ retainedSourceRefs: [refs[0]], removedSourceRefs: [fresh] });
  });

  it("previews and repairs only exact history, invalidates stale cards and refreshes coherent buttons with audit", async () => {
    const { app, ctx, refs, fresh } = fixture();
    const from = upsertItem(app, undefined, { title: "季度计划", sourceRefs: refs });
    const to = upsertItem(app, undefined, { spaceId: "project-a", title: "接口 Schema 交付" });
    upsertItem(app, from.id, { note: "接口进展挂错", sourceRefs: [fresh] });
    const event = itemEvents(app, from.id).at(-1)!;
    const origin = createRun(app, { kind: "ingest", spaceId: "personal", title: "整理", notBefore: "2999-01-01T00:00:00Z" });
    const n = notify(app, { title: "进展", body: "待复核", entityId: from.id, sourceRefs: [fresh], runId: origin.id });
    const interaction = recordInteraction(app, { messageId: "om_old", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: from.id, notificationId: n.id } });
    const repeated = notify(app, { title: "重复通知", body: "待复核", entityId: from.id, sourceRefs: [fresh], runId: origin.id });
    const duplicateCard = recordInteraction(app, { messageId: "om_duplicate", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: from.id, notificationId: n.id } });
    const repeatedCard = recordInteraction(app, { messageId: "om_repeated", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: from.id, notificationId: repeated.id } });
    const args = { notification_ids: [repeated.id], interaction_ids: [duplicateCard, repeatedCard], from_item_id: from.id, to_item_id: to.id, event_ids: [event.id], source_refs: [fresh], expected_source_refs: [...refs, fresh], notification_id: n.id, interaction_id: interaction, run_id: origin.id, title: "接口交付更新", body: "Schema 已明确", reason: "误关联具体交付", apply: false };
    expect((await callTool(ctx, "repair_item_association", args)).isError).toBe(false);
    expect(itemEvents(app, from.id)).toContainEqual(event);
    expect((await callTool(ctx, "inspect_item_notification", { notification_id: n.id })).text).toContain(interaction);
    const noNotice = await callTool(ctx, "repair_item_association", { ...args, notification_id: undefined, interaction_id: undefined, notification_ids: undefined, interaction_ids: undefined, apply: true });
    expect(noNotice.isError).toBe(true);
    expect(noNotice.text).toContain("不能遗漏");
    const invalid = await callTool(ctx, "repair_item_association", { ...args, event_ids: [itemEvents(app, to.id)[0].id], apply: true });
    expect(invalid.isError).toBe(true);
    expect((await callTool(ctx, "repair_item_association", { ...args, interaction_id: undefined, apply: true })).isError).toBe(true);
    const result = await callTool(ctx, "repair_item_association", { ...args, apply: true });
    expect(result.isError, result.text).toBe(false);
    expect(getItem(app, from.id).sourceRefs).toEqual(refs);
    expect(getItem(app, to.id).sourceRefs).toEqual([fresh]);
    expect(itemEvents(app, to.id)).toContainEqual({ ...event, itemId: to.id });
    for (const id of [interaction, duplicateCard, repeatedCard]) expect(getInteraction(app, id)).toMatchObject({ status: "expired", payload: { itemId: to.id } });
    expect(listNotifications(app).find((x) => x.id === n.id)?.entityId).toBe(to.id);
    expect(getRun(app, origin.id).output.itemAssociationCorrection).toMatchObject({ itemId: to.id });
    expect((await callTool(ctx, "repair_item_association", { ...args, apply: true })).isError).toBe(true);
    const audit = /审计 (ir\w+)/.exec(result.text)![1];
    expect((await callTool(ctx, "read_item_repair", { repair_id: audit })).text).toContain("接口进展挂错");
    setLarkClient({ im: { message: { patch: async () => { throw new Error("模拟网络失败"); } } } });
    expect((await callTool(ctx, "refresh_item_notification", { interaction_id: interaction, reason: "修复卡片" })).isError).toBe(true);
    expect(getInteraction(app, interaction)?.status).toBe("expired");
    let patched = "";
    setLarkClient({ im: { message: { patch: async (p: any) => { patched = p.data.content; return { code: 0 }; } } } });
    expect((await callTool(ctx, "refresh_item_notification", { interaction_id: interaction, reason: "重试修复卡片" })).isError).toBe(false);
    expect(patched).toContain(`item:done:${to.id}`);
    expect(patched).not.toContain(from.id);
    expect(patched).not.toContain("example.com/plan");
    expect(getInteraction(app, interaction)).toMatchObject({ status: "open", payload: { itemId: to.id } });
    expect(one<{ n: number }>(app.db, "select count(*) n from item_repairs")?.n).toBe(3);
    // An older PATCH may finish after a second repair and a newer refresh.
    const finalItem = upsertItem(app, undefined, { spaceId: "project-a", title: "最终独立交付" });
    let release!: () => void, started!: () => void;
    const waitPatch = new Promise<void>((resolve) => { release = resolve; });
    const patchStarted = new Promise<void>((resolve) => { started = resolve; });
    let requests = 0;
    setLarkClient({ im: { message: { patch: async (p: any) => {
      if (++requests === 1) { started(); await waitPatch; }
      patched = p.data.content;
      return { code: 0 };
    } } } });
    const oldRefresh = callTool(ctx, "refresh_item_notification", { interaction_id: interaction, reason: "并发中的旧刷新" });
    await patchStarted;
    const movedAgain = await callTool(ctx, "repair_item_association", { ...args, from_item_id: to.id, to_item_id: finalItem.id, expected_source_refs: [fresh], title: "最终交付", apply: true });
    expect(movedAgain.isError, movedAgain.text).toBe(false);
    expect((await callTool(ctx, "refresh_item_notification", { interaction_id: interaction, reason: "新版本刷新" })).isError).toBe(false);
    expect(getInteraction(app, interaction)?.status).toBe("open");
    release();
    expect((await oldRefresh).isError).toBe(true);
    expect(getInteraction(app, interaction)).toMatchObject({ status: "expired", payload: { itemId: finalItem.id } });
    expect((await callTool(ctx, "refresh_item_notification", { interaction_id: interaction, reason: "冲突后重试" })).isError).toBe(false);
    expect(patched).toContain(`item:done:${finalItem.id}`);

  });
});
