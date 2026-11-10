import { receive } from "../agents/inbox.ts";
import { addMessage, findThread } from "../agents/threads.ts";
import type { App } from "../core/app.ts";
import { one, run, tx } from "../core/db.ts";
import { OWNER, canWrite } from "../core/users.ts";
import { currentBot } from "../core/bot-context.ts";
import { larkUser } from "./lark-bots.ts";
import { larkCardMarkdown } from "./lark-markdown.ts";
import { bindInteraction, buildCard, closeInteraction, decidedBlocks, deliverLark, describeAction, getInteraction, interactionForMessage, sendLark, updateLarkCard, type Content, type Delivery, type Target } from "./lark-send.ts";

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
/** Feishu waits about 3 s for the callback; past this the click is acknowledged and the card patched later. */
export const CALLBACK_WAIT_MS = 1000;

export async function handleCardAction(app: App, data: any, nameOf: (openId: string) => Promise<string> = async (id) => id): Promise<CardActionResult> {
  const work = actOnCard(app, data, nameOf);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([work, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CALLBACK_WAIT_MS); })]);
    if (result) return result;
    // Slow remote actions continue once; the completed card is patched after the callback closes.
    void work.then(async (late) => {
      const messageId = data.context?.open_message_id ?? data.open_message_id;
      const card = late.card as { type?: string; data?: Record<string, unknown> } | undefined;
      if (messageId && card?.type === "raw" && card.data) await updateLarkCard(messageId, card.data, interactionForMessage(app, messageId)?.bot);
      else if (late.toast.type === "error") console.warn("[omem] 卡片操作失败", late.toast.content);
    }).catch((e) => console.warn("[omem] 卡片操作后续处理失败", e));
    return { toast: { type: "info", content: "已收到，正在处理" } };
  } finally {
    clearTimeout(timer);
  }
}

/** A name lookup may call the contacts API: inside the callback it gets a short budget, then the id stands in. */
const NAME_WAIT_MS = 300;
function quickName(nameOf: (openId: string) => Promise<string>, openId: string, waitMs = NAME_WAIT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([nameOf(openId).catch(() => openId), new Promise<string>((ok) => { timer = setTimeout(() => ok(openId), waitMs); })]).finally(() => clearTimeout(timer));
}

async function actOnCard(app: App, data: any, nameOf: (openId: string) => Promise<string>): Promise<CardActionResult> {
  const operator: string = data.operator?.open_id ?? data.open_id ?? "";
  // Who clicked, as this bot sees them (open_ids are per app; the other bots also know user_id).
  const operatorUser = () => larkUser(app, { open_id: operator, user_id: data.operator?.user_id });
  const messageId: string = data.context?.open_message_id ?? data.open_message_id ?? "";
  const action = data.action ?? {};
  const value = typeof action.value === "string" ? safeJson(action.value) : action.value;
  const named = /^(opt_\d+|answer|approve|reject)__(ci[a-z0-9]+)$/.exec(action.name ?? "");
  const earlyId = named?.[2] ?? (typeof value?.interactionId === "string" ? value.interactionId : null);
  let inter = messageId ? interactionForMessage(app, messageId) : null;
  if (!inter && messageId && earlyId) {
    const pending = getInteraction(app, earlyId);
    const chatId = data.context?.open_chat_id;
    if (pending?.purpose === "ask" && pending.status === "open" && !pending.messageId && pending.bot === currentBot() && (!pending.chatId || chatId === pending.chatId) &&
      pending.allowed.length && (pending.allowed.includes(operator) || (data.operator?.user_id && pending.allowed.includes(data.operator.user_id)))) {
      bindInteraction(app, pending.id, messageId);
      inter = getInteraction(app, pending.id);
    }
  }
  if (!inter) return { toast: { type: "warning", content: "这张卡片已经失效" } };
  if (earlyId && earlyId !== inter.id) return { toast: { type: "warning", content: "卡片与交互记录不匹配" } };
  if (inter.allowed.length && !inter.allowed.includes(operator) && !(data.operator?.user_id && inter.allowed.includes(data.operator.user_id))) {
    const who = (await Promise.all(inter.allowed.slice(0, 3).map((id) => quickName(nameOf, id)))).join("、");
    return { toast: { type: "error", content: `只有 ${who} 可以处理` } };
  }
  if (inter.status !== "open") return { toast: { type: "info", content: "已经处理过了" } };
  const opName = operatorUser() === OWNER ? "本人" : await quickName(nameOf, operator);
  if (inter.purpose === "ask") {
    // A question, suggested step or approval (agents/asks.ts): answered here, no agent turn of its own.
    const { handleAskAction } = await import("./lark-asks.ts");
    const formValue = typeof action.form_value === "string" ? safeJson(action.form_value) : action.form_value;
    const by = operatorUser() ?? operator;
    try {
      const r = await handleAskAction(app, inter.id, String((inter.payload as { askId?: string }).askId ?? ""), { name: named?.[1] ?? action.name, value, formValue }, by);
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
    return { toast: { type: "success", content: approve ? "已同意，正在处理" : "已忽略" }, card: rawCard(buildCard(guestApprovalCard(a, approve ? "approved" : "declined", { at: new Date().toISOString(), timeZone: app.config.timezone }))) };
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
  if (inter.purpose === "rule-script") {
    // A rule's script waiting for its approver (rules/script.ts).
    const { decideScript } = await import("../rules/script.ts");
    const approve = (value as { action?: string } | undefined)?.action === "approve";
    closeInteraction(app, inter.id, operator);
    try {
      const card = decideScript(app, inter.payload as { runId: string }, approve, opName);
      return { toast: { type: "success", content: approve ? "已批准，开始执行" : "不执行" }, card: rawCard(buildCard(card as never)) };
    } catch (e) {
      return { toast: { type: "error", content: (e as Error).message.slice(0, 80) } };
    }
  }
  if (inter.purpose === "command-gate") {
    // A command held by the command rules, waiting for its approver (agents/command-gate.ts).
    const { decideCommandCard } = await import("../agents/command-gate.ts");
    const approve = (value as { action?: string } | undefined)?.action === "approve";
    try {
      const card = await decideCommandCard(app, inter.payload as { askId?: string }, approve, operatorUser() ?? opName);
      closeInteraction(app, inter.id, operator);
      return { toast: { type: "success", content: approve ? "已批准" : "已拒绝" }, card: rawCard(buildCard(card as never)) };
    } catch (e) {
      return { toast: { type: "error", content: (e as Error).message.slice(0, 80) } };
    }
  }
  if (inter.purpose === "mention-reply") {
    // A reply to someone who looked for the owner (mention-reply.ts): the owner sends it (maybe edited) or not.
    const { decideMentionReply } = await import("./mention-reply.ts");
    const formValue = typeof action.form_value === "string" ? safeJson(action.form_value) : action.form_value;
    const edited = formValue && typeof formValue === "object" && typeof (formValue as { reply?: unknown }).reply === "string" ? String((formValue as { reply: string }).reply) : null;
    const send = (value as { action?: string } | undefined)?.action !== "drop" && (edited !== null || (value as { action?: string } | undefined)?.action === "send");
    closeInteraction(app, inter.id, operator);
    try {
      const card = await decideMentionReply(app, inter.payload as { runId: string; text: string }, send, edited, opName);
      return { toast: { type: "success", content: send ? "已回复" : "不回复" }, card: rawCard(card) };
    } catch (e) {
      // Not sent: the card stays usable for another try.
      run(app.db, "update card_interactions set status = 'open', handled_at = null, handled_by = null where id = ?", inter.id);
      return { toast: { type: "error", content: `没有发出去：${(e as Error).message}`.slice(0, 80) } };
    }
  }
  if (inter.purpose === "draft") {
    const choice = (value as { action?: string } | undefined)?.action;
    closeInteraction(app, inter.id, operator);
    const p = inter.payload as { target: Target; content: Content; delivery?: Delivery };
    if (choice === "send") {
      try {
        await deliverLark(p.target, p.content, p.delivery);
      } catch (e) {
        // Not sent: the buttons stay usable for another try.
        run(app.db, "update card_interactions set status = 'open', handled_at = null, handled_by = null where id = ?", inter.id);
        return { toast: { type: "error", content: `没有发出去：${(e as Error).message}`.slice(0, 80) } };
      }
    }
    if (inter.conversationId && findThread(app, inter.conversationId))
      addMessage(app, inter.conversationId, "assistant", choice === "send" ? "（本人确认，草稿已发出）" : "（本人决定不发这条草稿）", null, { command: true });
    // The new card goes back in the callback response, like the other cards here: an API update made
    // while the callback is still open does not reliably replace what the clicker sees.
    const sent = choice === "send";
    const decided = { by: opName, at: new Date().toISOString(), timeZone: app.config.timezone, verdict: sent ? "确认发送" : "决定不发" };
    const card = buildCard({ title: sent ? "已发送" : "没有发送", color: sent ? "green" : "grey", blocks: [{ markdown: previewOf(p.content) }, ...decidedBlocks(decided)] });
    return { toast: { type: "success", content: choice === "send" ? "已发送" : "已放弃" }, card: rawCard(card) };
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
      if (p) void probeProfile(p, app).then((probe) => { if (!probe.error) saveProbe(app, id, probe); });
    }
    run(app.db, "update card_interactions set status = 'done', handled_at = datetime('now'), handled_by = ? where id = ?", operator, inter.id);
    return { card: rawCard(r.card), toast: { type: "success", content: r.toast } };
  }
  const desc = describeAction({ tag: action.tag, name: action.name, value, formValue, option: action.option, options: action.options, input: action.input_value, checked: action.checked });
  const userId = operatorUser();
  run(app.db, "update card_interactions set handled_at = datetime('now'), handled_by = ? where id = ?", operator, inter.id);
  // After the callback has answered there is time for the full lookup: the Agent should know who clicked.
  const conversationId = inter.conversationId;
  void (async () => {
    const name = userId === OWNER || opName !== operator ? opName : await quickName(nameOf, operator, 5000);
    await receive(app, {
      conversationId,
      text: `[卡片操作] ${name}（${operator}）在卡片 ${messageId} 上${desc}`,
      speaker: userId === OWNER ? undefined : name,
      userId: OWNER,
      externalMessageId: messageId,
    });
  })().catch((e) => console.warn("[omem] 卡片操作续聊失败", e));
  return { toast: { type: "info", content: "已收到，处理中" } };
}

/** The card in a card.action.trigger response must be { type: "raw", data: <card json> }. */
export function rawCard(card: Record<string, unknown>) {
  return { type: "raw", data: larkCardMarkdown(card) };
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
