import { receive } from "../agents/inbox.ts";
import { addMessage, findThread } from "../agents/threads.ts";
import type { App } from "../core/app.ts";
import { one, run, tx } from "../core/db.ts";
import { OWNER, canWrite } from "../core/users.ts";
import { larkUser } from "./lark-bots.ts";
import { buildCard, closeInteraction, deliverLark, describeAction, interactionForMessage, sendLark, updateLarkCard, type Content, type Delivery, type Target } from "./lark-send.ts";

/**
 * A button press, select or form submit on one of the bot's cards
 * (`card.action.trigger`). The return value is the callback response (a toast).
 *
 * - Only the people a card names may act on it.
 * - Drafts: "发送" posts the prepared message, "不发" drops it.
 * - Other cards: the action becomes a new message in the conversation that
 *   posted the card, so the agent that asked continues.
 */
type CardActionResult = { toast: { type: string; content: string }; card?: unknown };

export async function handleCardAction(app: App, data: any, nameOf: (openId: string) => Promise<string> = async (id) => id): Promise<CardActionResult> {
  const operator: string = data.operator?.open_id ?? data.open_id ?? "";
  // Who clicked, as this bot sees them (open_ids are per app; the other bots also know user_id).
  const operatorUser = () => larkUser(app, { open_id: operator, user_id: data.operator?.user_id });
  const messageId: string = data.context?.open_message_id ?? data.open_message_id ?? "";
  const action = data.action ?? {};
  const inter = messageId ? interactionForMessage(app, messageId) : null;
  if (!inter) return { toast: { type: "warning", content: "这张卡片已经失效" } };
  if (inter.allowed.length && !inter.allowed.includes(operator) && !(data.operator?.user_id && inter.allowed.includes(data.operator.user_id))) {
    const who = (await Promise.all(inter.allowed.slice(0, 3).map(nameOf))).join("、");
    return { toast: { type: "error", content: `只有 ${who} 可以处理` } };
  }
  if (inter.status !== "open") return { toast: { type: "info", content: "已经处理过了" } };
  const opName = await nameOf(operator);
  const value = typeof action.value === "string" ? safeJson(action.value) : action.value;
  if (inter.purpose === "ask") {
    // A question, suggested step or approval (agents/asks.ts): answered here, no agent turn of its own.
    const { handleAskAction } = await import("./lark-asks.ts");
    const formValue = typeof action.form_value === "string" ? safeJson(action.form_value) : action.form_value;
    const by = operatorUser() ?? operator;
    try {
      const r = await handleAskAction(app, inter.id, String((inter.payload as { askId?: string }).askId ?? ""), { name: action.name, value, formValue }, by);
      return { toast: { type: "success", content: r.toast }, ...(r.card ? { card: rawCard(r.card) } : {}) };
    } catch (e) {
      return { toast: { type: "error", content: (e as Error).message.slice(0, 80) } };
    }
  }
  if (inter.purpose === "guest-approval") {
    // A guest the gatekeeper refused (lark-guest.ts): the owner lets this message through or not.
    const { decideGuest, guestApprovalCard } = await import("./lark-guest.ts");
    const a = inter.payload as import("./lark-guest.ts").GuestApproval;
    const approve = (value as { action?: string } | undefined)?.action === "approve";
    closeInteraction(app, inter.id, operator);
    try {
      await decideGuest(app, a, approve, operator);
    } catch (e) {
      return { toast: { type: "error", content: (e as Error).message.slice(0, 80) } };
    }
    return { toast: { type: "success", content: approve ? "已同意，正在处理" : "已忽略" }, card: rawCard(buildCard(guestApprovalCard(a, approve ? "approved" : "declined"))) };
  }
  if (inter.purpose === "meeting-join") {
    // A meeting rule asking whether to bring the bots in (lark-meetings.ts).
    const { decideMeetingJoin } = await import("./lark-meetings.ts");
    const approve = (value as { action?: string } | undefined)?.action === "approve";
    closeInteraction(app, inter.id, operator);
    try {
      const card = await decideMeetingJoin(app, inter.payload as { meetingId: string }, approve);
      return { toast: { type: "success", content: approve ? "已处理" : "这次不拉" }, card: rawCard(buildCard(card)) };
    } catch (e) {
      return { toast: { type: "error", content: (e as Error).message.slice(0, 80) } };
    }
  }
  if (inter.purpose === "draft") {
    const choice = (value as { action?: string } | undefined)?.action;
    closeInteraction(app, inter.id, operator);
    const p = inter.payload as { target: Target; content: Content; delivery?: Delivery };
    if (choice === "send") {
      await deliverLark(p.target, p.content, p.delivery);
      await updateLarkCard(messageId, buildCard({ title: "已发送", color: "green", blocks: [{ markdown: previewOf(p.content) }, { note: `${opName} 确认发送` }] })).catch(() => {});
    } else await updateLarkCard(messageId, buildCard({ title: "没有发送", color: "grey", blocks: [{ markdown: previewOf(p.content) }] })).catch(() => {});
    if (inter.conversationId && findThread(app, inter.conversationId))
      addMessage(app, inter.conversationId, "assistant", choice === "send" ? "（本人确认，草稿已发出）" : "（本人决定不发这条草稿）", null, { command: true });
    return { toast: { type: "success", content: choice === "send" ? "已发送" : "已放弃" } };
  }
  if (!inter.conversationId || !findThread(app, inter.conversationId)) {
    // Standalone item notification card: resolve the item button without an agent turn.
    const itemId = (inter.payload as { itemId?: string }).itemId;
    const act = (typeof value === "object" && value ? (value as { action?: string }).action : "") ?? "";
    // Item digest: keep one item open, or reopen one that closed by itself. The card stays open for the rest.
    // Nightly replay's suggestions on the same card: only the owner decides them.
    const replay = /^replay:(adopt|ignore):([^:]+)$/.exec(act);
    if ((inter.payload as { digest?: boolean }).digest && replay) {
      const [, op, id] = replay;
      if (!((inter.payload as { effectIds?: string[] }).effectIds ?? []).includes(id)) return { toast: { type: "error", content: "按钮与建议不匹配" } };
      if (operatorUser() !== OWNER) return { toast: { type: "error", content: "只有本人可以处理复盘建议" } };
      try {
        const { resolveEffect } = await import("../agents/replay.ts");
        const r = resolveEffect(app, id, op as "adopt" | "ignore");
        return { toast: { type: r.status === "pending" ? "info" : "success", content: r.message } };
      } catch (e) {
        return { toast: { type: "error", content: (e as Error).message.slice(0, 80) } };
      }
    }
    const digest = /^item:(keep|reopen):([^:]+)$/.exec(act);
    if ((inter.payload as { digest?: boolean }).digest && digest) {
      const [, op, id] = digest;
      if (!((inter.payload as { itemIds?: string[] }).itemIds ?? []).includes(id)) return { toast: { type: "error", content: "按钮与事项不匹配" } };
      const { getItem } = await import("../items/store.ts");
      const { keepItem } = await import("../items/expiry.ts");
      const userId = operatorUser();
      const item = getItem(app, id);
      if (!userId || item.userId !== userId || !canWrite(app, userId, item.spaceId)) return { toast: { type: "error", content: "无权处理该事项" } };
      const closed = ["done", "cancelled", "expired"].includes(item.status);
      if (op === "reopen" && !closed) return { toast: { type: "info", content: `「${item.title}」已经是打开的` } };
      keepItem(app, id, "user");
      return { toast: { type: "success", content: op === "reopen" ? `已恢复「${item.title}」` : `已保留「${item.title}」，期限重新计算` } };
    }
    const m = /^item:(done|cancel|act):([^:]+)(?::([\s\S]*))?$/.exec(act);
    if (itemId && m) {
      const [, op, id] = m;
      const { getItem, upsertItem } = await import("../items/store.ts");
      const result = tx(app.db, (): { toast: { type: string; content: string }; title?: string } => {
        const current = interactionForMessage(app, messageId);
        if (!current || current.id !== inter.id || current.status !== "open" || JSON.stringify(current.payload) !== JSON.stringify(inter.payload) || JSON.stringify(current.allowed) !== JSON.stringify(inter.allowed))
          return { toast: { type: "warning", content: "卡片已变化或失效，请使用更新后的卡片" } };
        if (id !== itemId || !["done", "cancel"].includes(op)) return { toast: { type: "error", content: "按钮与事项不匹配" } };
        const userId = operatorUser();
        const item = getItem(app, id);
        if (!userId || item.userId !== userId || !canWrite(app, userId, item.spaceId)) return { toast: { type: "error", content: "无权处理该事项" } };
        if (op === "done") upsertItem(app, id, { status: "done", note: `${opName} 在飞书卡片上标记已处理` }, "user");
        else if (op === "cancel") upsertItem(app, id, { status: "cancelled", note: `${opName} 在飞书卡片上忽略` }, "user");
        run(app.db, "update card_interactions set status='done', handled_at=datetime('now'), handled_by=? where id=?", operator, inter.id);
        return { title: getItem(app, id).title, toast: { type: "success", content: "" } };
      });
      if (result.title && op === "cancel") {
        // "忽略" is a lesson: the model phrases a short "don't ping me for this"
        // rule. Fire-and-forget — card callbacks must answer Feishu within a few
        // seconds; the AI summarization can finish in the background.
        const noteRow = one<{ title: string; body: string }>(
          app.db,
          "select title, body from notifications where json_extract(context,'$.entityId') = ? order by at desc limit 1",
          id,
        );
        if (noteRow) {
          void import("../core/notify-ai-gate.ts")
            .then(({ learnIgnoreFromNotification }) => learnIgnoreFromNotification(app, noteRow))
            .then((rule) => { if (rule) console.info(`[omem] 已学习免提醒规则：${rule.rule}`); })
            .catch(() => {});
        }
      }
      if (!result.title) return { toast: result.toast };
      const title = result.title;
      return {
        // Feishu callback responses must wrap a replacement card as { type: "raw", data }.
        card: rawCard(buildCard({ title: op === "done" ? "已处理" : "已忽略", color: op === "done" ? "green" : "grey", blocks: [{ markdown: title }, { note: op === "done" ? `${opName} 在飞书卡片上标记已处理` : `${opName} 已忽略（同类提醒将不再推送，应用内仍可查看）` }] })),
        toast: { type: "success", content: op === "done" ? "已标记为已处理" : "已忽略" },
      };
    }
    return { toast: { type: "warning", content: "找不到对应的会话" } };
  }
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
    return { card: rawCard(r.card), toast: { type: "success", content: r.toast } };
  }
  const desc = describeAction({ tag: action.tag, name: action.name, value, formValue, option: action.option, options: action.options, input: action.input_value, checked: action.checked });
  const userId = operatorUser();
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

/** The card in a card.action.trigger response must be { type: "raw", data: <card json> }. */
export function rawCard(card: Record<string, unknown>) {
  return { type: "raw", data: card };
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
