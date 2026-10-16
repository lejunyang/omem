import { receive } from "../agents/inbox.ts";
import { addMessage, findThread } from "../agents/threads.ts";
import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { OWNER, resolveIdentity } from "../core/users.ts";
import { buildCard, closeInteraction, describeAction, interactionForMessage, sendLark, updateLarkCard, type Content, type Target } from "./lark-send.ts";

/**
 * A button press, select or form submit on one of the bot's cards
 * (`card.action.trigger`). The return value is the callback response (a toast).
 *
 * - Only the people a card names may act on it.
 * - Drafts: "发送" posts the prepared message, "不发" drops it.
 * - Other cards: the action becomes a new message in the conversation that
 *   posted the card, so the agent that asked continues.
 */
export async function handleCardAction(app: App, data: any, nameOf: (openId: string) => Promise<string> = async (id) => id) {
  const operator: string = data.operator?.open_id ?? data.open_id ?? "";
  const messageId: string = data.context?.open_message_id ?? data.open_message_id ?? "";
  const action = data.action ?? {};
  const inter = messageId ? interactionForMessage(app, messageId) : null;
  if (!inter) return { toast: { type: "warning", content: "这张卡片已经失效" } };
  if (inter.allowed.length && !inter.allowed.includes(operator)) {
    const who = (await Promise.all(inter.allowed.slice(0, 3).map(nameOf))).join("、");
    return { toast: { type: "error", content: `只有 ${who} 可以处理` } };
  }
  if (inter.status !== "open") return { toast: { type: "info", content: "已经处理过了" } };
  const opName = await nameOf(operator);
  const value = typeof action.value === "string" ? safeJson(action.value) : action.value;
  if (inter.purpose === "draft") {
    const choice = (value as { action?: string } | undefined)?.action;
    closeInteraction(app, inter.id, operator);
    const p = inter.payload as { target: Target; content: Content };
    if (choice === "send") {
      await sendLark(p.target, p.content);
      await updateLarkCard(messageId, buildCard({ title: "已发送", color: "green", blocks: [{ markdown: previewOf(p.content) }, { note: `${opName} 确认发送` }] })).catch(() => {});
    } else await updateLarkCard(messageId, buildCard({ title: "没有发送", color: "grey", blocks: [{ markdown: previewOf(p.content) }] })).catch(() => {});
    if (inter.conversationId && findThread(app, inter.conversationId))
      addMessage(app, inter.conversationId, "assistant", choice === "send" ? "（本人确认，草稿已发出）" : "（本人决定不发这条草稿）", null, { command: true });
    return { toast: { type: "success", content: choice === "send" ? "已发送" : "已放弃" } };
  }
  if (!inter.conversationId || !findThread(app, inter.conversationId)) return { toast: { type: "warning", content: "找不到对应的会话" } };
  // The /model card changes the thread's model settings directly; no agent turn.
  const buttonAction = value as { action?: string } | undefined;
  const formValue = typeof action.form_value === "string" ? safeJson(action.form_value) : action.form_value;
  const isModelCard = inter.purpose === "model" || buttonAction?.action?.startsWith("model:") || (typeof formValue === "object" && formValue !== null && "modelText" in formValue);
  if (isModelCard) {
    const { applyModelCard } = await import("./lark-model-card.ts");
    const r = applyModelCard(app, inter.conversationId, { value, formValue });
    if (r.probe) {
      const { allProfiles } = await import("../core/config.ts");
      const { probeProfile, saveProbe } = await import("../agents/probe.ts");
      const t = findThread(app, inter.conversationId)!;
      const id = t.settings.profile ?? app.config.agents.default ?? allProfiles(app.config)[0]?.id;
      const p = allProfiles(app.config).find((x) => x.id === id);
      if (p) void probeProfile(p).then((probe) => { if (!probe.error) saveProbe(app, id, probe); });
    }
    run(app.db, "update card_interactions set status = 'done', handled_at = datetime('now'), handled_by = ? where id = ?", operator, inter.id);
    return { card: r.card, toast: { type: "success", content: r.toast } };
  }
  const desc = describeAction({ tag: action.tag, name: action.name, value, formValue, option: action.option, options: action.options, input: action.input_value, checked: action.checked });
  const userId = resolveIdentity(app, "lark", operator);
  run(app.db, "update card_interactions set handled_at = datetime('now'), handled_by = ? where id = ?", operator, inter.id);
  await receive(app, {
    conversationId: inter.conversationId,
    text: `[卡片操作] ${opName}（${operator}）在卡片 ${messageId} 上${desc}`,
    speaker: userId === OWNER ? undefined : opName,
    userId: OWNER,
    externalMessageId: messageId,
  });
  return { toast: { type: "info", content: "已收到，处理中" } };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
function previewOf(c: Content) {
  return "markdown" in c ? c.markdown.slice(0, 3000) : "text" in c ? c.text.slice(0, 3000) : "card" in c ? "（交互卡片）" : "（图片或文件）";
}
