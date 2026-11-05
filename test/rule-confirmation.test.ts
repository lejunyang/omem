import { afterEach, expect, it, vi } from "vitest";
import { answerAsk, createAsk, getAsk, listAsks, settleAsks, showSuggestions, LARK_SUGGESTION_FALLBACK_MS } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool } from "../src/agents/tools.ts";
import { all, one } from "../src/core/db.ts";
import { withBot } from "../src/core/bot-context.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { registerLarkAsks } from "../src/channels/lark-asks.ts";
import { interactionForMessage, setLarkClient } from "../src/channels/lark-send.ts";
import { confirmRule } from "../src/rules/confirmation.ts";
import { getRule, listRules, saveRule } from "../src/rules/store.ts";
import { testApp } from "./helpers.ts";

let registered = false;
const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { setLarkClient(null); vi.useRealTimers(); for (const app of apps.splice(0)) app.db.close(); });
function fixture() {
  const app = testApp(); apps.push(app);
  app.config.lark.ownerOpenId = "ou_owner";
  if (!registered) { registerLarkAsks(app, () => "ou_owner"); registered = true; }
  const thread = createThread(app, { channel: "lark", key: "oc_test", spaceId: "personal", userId: "owner" });
  const task = createRun(app, { kind: "ask", spaceId: "personal", title: "创建规则", input: { conversationId: thread.id } });
  const ctx = { app, runId: task.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const, userId: "owner", role: "assistant" };
  return { app, thread, task, ctx };
}
const ruleInput = { name: "退款提醒", description: "群里提到退款时通知本人", enabled: false, trigger: { event: "message" as const }, conditions: { field: "message.text" as const, op: "contains" as const, value: "退款" }, judge: "code" as const, actions: [{ type: "notify" as const }] };
function findButton(value: any, name: string): any {
  if (!value || typeof value !== "object") return;
  if (value.tag === "button" && value.name.startsWith(name)) return value;
  for (const child of Object.values(value)) { const found = Array.isArray(child) ? child.map((v) => findButton(v, name)).find(Boolean) : findButton(child, name); if (found) return found; }
}
function client(create: (card: any) => Promise<any>) {
  setLarkClient({ im: { message: { create: async (args: any) => create(JSON.parse(args.data.content)), patch: async () => ({ code: 0 }) } } });
}

it("sends document approvals from a group or scheduled task privately to the owner", async () => {
  const { app, task } = fixture();
  const recipients: string[] = [];
  setLarkClient({ im: { message: {
    create: async ({ data }: any) => { recipients.push(data.receive_id); return { code: 0, data: { message_id: `om_private_${recipients.length}` } }; },
    patch: async () => ({ code: 0 }),
    reply: async () => { throw new Error("审批不应回复到群里"); },
  } } });
  for (const runId of [task.id, null]) {
    const ask = createAsk(app, { runId, kind: "approval", tool: "lark_doc_authorize", question: "批准周会节点下的复制？" });
    await expect.poll(() => recipients.length).toBe(runId ? 1 : 2);
    expect(recipients.at(-1)).toBe("ou_owner");
    const interaction = one<{ chat_id: string | null; allowed: string }>(app.db, "select chat_id, allowed from card_interactions where json_extract(payload, '$.askId') = ?", ask.id)!;
    expect(interaction.chat_id).toBeNull();
    expect(JSON.parse(interaction.allowed)).toEqual(["ou_owner"]);
    await answerAsk(app, ask.id, { approved: false, by: "owner" });
  }
});

it("saves a disabled rule, then commits its enable button before acknowledging without starting AI", async () => {
  const { app, ctx, task } = fixture();
  const saved = await callTool(ctx, "save_rule", { description: ruleInput.description, rule: ruleInput });
  expect(saved.isError).toBeFalsy();
  const rule = listRules(app)[0];
  const ask = listAsks(app, { runId: task.id })[0];
  expect(ask).toMatchObject({ handler: "rule-enable", status: "pending", shownAt: null });
  expect(rule.enabled).toBe(false);
  await callTool(ctx, "suggest_next", { options: ["启用规则"] });
  expect(listAsks(app, { runId: task.id })).toHaveLength(1);
  let posted: any;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  client(async (card) => { posted = card; await waiting; return { code: 0, data: { message_id: "om_confirm" } }; });
  const showing = showSuggestions(app, task.id);
  await expect.poll(() => !!posted).toBe(true);
  expect(interactionForMessage(app, "om_confirm")).toBeNull();
  const button = findButton(posted, "opt_0");
  const event = { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_confirm", open_chat_id: "oc_test" }, action: { value: button.behaviors[0].value } };
  const forged = await handleCardAction(app, { ...event, context: { ...event.context, open_chat_id: "oc_other" } });
  expect(forged.toast.type).toBe("warning");
  expect((await handleCardAction(app, { ...event, operator: { open_id: "ou_other" } })).toast.type).toBe("warning");
  expect((await withBot("other", () => handleCardAction(app, event))).toast.type).toBe("warning");
  expect(getRule(app, rule.id).enabled).toBe(false);
  const result = await handleCardAction(app, event);
  expect(result.toast.content).toContain("已启用");
  expect(JSON.stringify(result.card)).not.toContain("已选");
  expect(getRule(app, rule.id).enabled).toBe(true);
  expect(getAsk(app, ask.id)).toMatchObject({ status: "answered", consumed: true, result: expect.stringContaining("已启用") });
  expect(all(app.db, "select id from runs")).toHaveLength(1);
  release(); await showing;
  expect((await handleCardAction(app, event)).toast.content).toBe("已经处理过了");
});

it("also accepts a form button clicked before the send response, with its typed answer", async () => {
  const { app, thread, task } = fixture();
  let posted: any;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  client(async (card) => { posted = card; await waiting; return { code: 0, data: { message_id: "om_form" } }; });
  const ask = createAsk(app, { runId: task.id, conversationId: thread.id, question: "哪天？", options: [{ label: "周四" }] });
  await expect.poll(() => !!posted).toBe(true);
  const button = findButton(posted, "opt_0");
  const result = await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_form", open_chat_id: "oc_test" }, action: { name: button.name, form_value: { text: "下午" } } });
  expect(result.toast.content).toBe("已回答");
  expect(getAsk(app, ask.id).answer).toBe("周四：下午");
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect.poll(() => interactionForMessage(app, "om_form")?.status).toBe("done");
});

it("does not show Feishu confirmations on a timer while the answer has not been delivered", async () => {
  vi.useFakeTimers();
  const { app, ctx, task } = fixture();
  let posts = 0;
  client(async () => { posts++; return { code: 0, data: { message_id: "om_order" } }; });
  await callTool(ctx, "save_rule", { description: ruleInput.description, rule: ruleInput });
  await settleAsks(app, task.id);
  await vi.advanceTimersByTimeAsync(8000);
  expect(posts).toBe(0);
  await showSuggestions(app, task.id);
  expect(posts).toBe(1);
  // Shown once: the late fallback finds nothing left to show.
  await vi.advanceTimersByTimeAsync(LARK_SUGGESTION_FALLBACK_MS);
  expect(posts).toBe(1);
});

it("still shows a Feishu confirmation when the reply itself never went out", async () => {
  vi.useFakeTimers();
  const { app, ctx, task } = fixture();
  let posts = 0;
  client(async () => { posts++; return { code: 0, data: { message_id: "om_late" } }; });
  await callTool(ctx, "save_rule", { description: ruleInput.description, rule: ruleInput });
  await settleAsks(app, task.id);
  await vi.advanceTimersByTimeAsync(LARK_SUGGESTION_FALLBACK_MS - 1000);
  expect(posts).toBe(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(posts).toBe(1);
});

it("rejects an edited rule without consuming its confirmation and updates schedule state immediately", async () => {
  const { app, thread, task } = fixture();
  const rule = saveRule(app, { ...ruleInput, trigger: { event: "schedule", cron: "0 9 * * *" } });
  const ask = confirmRule(app, rule, task.id, thread.id)!;
  saveRule(app, { ...rule, temporary: undefined, name: "已修改的提醒" });
  await expect(answerAsk(app, ask.id, { choice: 0, by: "owner" })).rejects.toThrow("规则已修改");
  expect(getAsk(app, ask.id).status).toBe("pending");
  expect(getRule(app, rule.id).enabled).toBe(false);
  const current = confirmRule(app, getRule(app, rule.id), task.id, thread.id)!;
  expect(getAsk(app, ask.id).status).toBe("cancelled");
  await expect(answerAsk(app, current.id, { choice: 0, by: "someone-else" })).rejects.toThrow("只有本人");
  const done = await answerAsk(app, current.id, { choice: 0, by: "owner", deferEffects: true });
  expect(done.result).toContain("已启用");
  expect(one<{ enabled: number }>(app.db, "select enabled from schedules where id = ?", `rule:${rule.id}`)?.enabled).toBe(1);
});

it("keeps a declined rule disabled without turning the decision into another agent request", async () => {
  const { app, thread, task } = fixture();
  const rule = saveRule(app, ruleInput);
  const ask = confirmRule(app, rule, task.id, thread.id)!;
  const done = await answerAsk(app, ask.id, { choice: 1, by: "owner" });
  expect(done.result).toContain("保持停用");
  expect(getRule(app, rule.id).enabled).toBe(false);
  expect(all(app.db, "select id from runs")).toHaveLength(1);
});
