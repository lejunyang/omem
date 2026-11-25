import { receive } from "../agents/inbox.ts";
import { addMessage, findThread } from "../agents/threads.ts";
import type { App } from "../core/app.ts";
import { one, run, tx } from "../core/db.ts";
import { OWNER, canWrite } from "../core/users.ts";
import { markReadIds } from "../core/notify.ts";
import { currentBot } from "../core/bot-context.ts";
import { larkUser } from "./lark-bots.ts";
import { larkCardMarkdown } from "./lark-markdown.ts";
import { bindInteraction, buildCard, closeInteraction, decidedBlocks, deliverLark, describeAction, getInteraction, interactionForMessage, sendLark, updateEphemeralCard, updateLarkCard, type Content, type Delivery, type Target } from "./lark-send.ts";

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
      if (messageId && card?.type === "raw" && card.data) {
        const inter = interactionForMessage(app, messageId);
        if (inter?.payload.ephemeral === true) {
          if (data.token && data.operator?.open_id) await updateEphemeralCard(data.token, data.operator.open_id, card.data, inter.bot);
        } else await updateLarkCard(messageId, card.data, inter?.bot);
      } else if (late.toast.type === "error") console.warn("[omem] 卡片操作失败", late.toast.content);
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

/**
 * Whether the person who clicked is one of the card's `allowed`. open_ids are per app: an id the
 * agent read through lark-cli (another app) names the same person as this bot's id for them, so
 * both are matched through lark_people, as is the user_id every app shares.
 */
export function mayAct(app: App, allowed: string[], operator: string, userId?: string) {
  if (allowed.includes(operator) || (userId && allowed.includes(userId))) return true;
  const main = currentBot() === "main";
  if (!userId && !(main && operator)) return false;
  const p = one<{ cli_open_id: string | null; bot_open_id: string | null; user_id: string | null }>(app.db,
    `select cli_open_id, bot_open_id, user_id from lark_people where ${main && operator ? "bot_open_id = ? or " : ""}user_id = ? limit 1`,
    ...(main && operator ? [operator, userId ?? ""] : [userId ?? ""]));
  return !!p && [p.cli_open_id, main ? p.bot_open_id : null, p.user_id].some((id) => !!id && allowed.includes(id));
}

/** "小王（wang@example.com）" for an id of anyone omem has seen, under whichever app's id the card holds. */
function personLabel(app: App, id: string): string | null {
  const p = one<{ name: string; email: string | null }>(app.db, "select name, email from lark_people where (cli_open_id = ? or bot_open_id = ? or user_id = ?) and name != '' limit 1", id, id, id);
  return p ? (p.email ? `${p.name}（${p.email}）` : p.name) : null;
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
      pending.allowed.length && mayAct(app, pending.allowed, operator, data.operator?.user_id)) {
      bindInteraction(app, pending.id, messageId);
      inter = getInteraction(app, pending.id);
    }
  }
  if (!inter) return { toast: { type: "warning", content: "这张卡片已经失效" } };
  if (earlyId && earlyId !== inter.id) return { toast: { type: "warning", content: "卡片与交互记录不匹配" } };
  if (inter.allowed.length && !mayAct(app, inter.allowed, operator, data.operator?.user_id)) {
    const who = (await Promise.all(inter.allowed.slice(0, 3).map((id) => personLabel(app, id) ?? quickName(nameOf, id)))).join("、") + (inter.allowed.length > 3 ? ` 等 ${inter.allowed.length} 人` : "");
    return { toast: { type: "error", content: `只有 ${who} 可以处理` } };
  }
  if (inter.status !== "open") return { toast: { type: "info", content: "已经处理过了" } };
  // A button on a notification's card (an item's 已处理 / 忽略, the digest): the notification has been read.
  const notificationId = (inter.payload as { notificationId?: unknown } | null)?.notificationId;
  if (typeof notificationId === "string") markReadIds(app, [notificationId]);
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
  if (inter.purpose === "listen-meeting") {
    // A 「关注」 asking whether to listen to a meeting in its groups, or one the owner joined (listen-meetings.ts).
    const { decideListenMeeting } = await import("./listen-meetings.ts");
    const act = String((value as { action?: string } | undefined)?.action ?? "");
    closeInteraction(app, inter.id, operator);
    try {
      const card = await decideListenMeeting(app, inter.payload as import("./listen-meetings.ts").ListenMeetingCard, act, opName);
      return { toast: { type: "success", content: act === "join" ? "已处理" : act === "never" ? "这个会以后不问" : "这次不进会" }, card: rawCard(card) };
    } catch (e) {
      // Not done: the card stays usable for another try.
      run(app.db, "update card_interactions set status = 'open', handled_at = null, handled_by = null where id = ?", inter.id);
      return { toast: { type: "error", content: `没有办成：${(e as Error).message}`.slice(0, 80) } };
    }
  }
  if (inter.purpose === "meeting-answer") {
    // A drafted answer to a question put to a bot in a meeting (meeting-answers.ts).
    const { decideMeetingAnswer } = await import("./meeting-answers.ts");
    const choice = String((value as { action?: string } | undefined)?.action ?? "");
    closeInteraction(app, inter.id, operator);
    try {
      const card = await decideMeetingAnswer(app, inter.payload as import("./meeting-answers.ts").DraftPayload, choice);
      return { toast: { type: "success", content: choice === "send" ? "已发到会里" : choice === "pause" ? "这场会不再回答" : "不发" }, card: rawCard(buildCard(card)) };
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
    const act = String(value?.action ?? "");
    const approve = ["approve","run","always"].includes(act);
    try {
      const card = await decideCommandCard(app, inter.payload as { askId?: string }, approve, operatorUser() ?? `lark:${operator}`, approve ? ["approve","run","always"].indexOf(act) : undefined);
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
    // 不发 carries why (drop:<reason>): what later drafts learn from.
    const act = String((value as { action?: string } | undefined)?.action ?? "");
    const dropped = act === "drop" || act.startsWith("drop:");
    const send = !dropped && (edited !== null || act === "send");
    closeInteraction(app, inter.id, operator);
    try {
      const card = await decideMentionReply(app, inter.payload as { runId: string; text: string }, send, edited, opName, dropped ? act.slice(5) || null : null);
      return { toast: { type: "success", content: send ? "已回复" : "不回复" }, card: rawCard(card) };
    } catch (e) {
      // Not sent: the card stays usable for another try.
      run(app.db, "update card_interactions set status = 'open', handled_at = null, handled_by = null where id = ?", inter.id);
      return { toast: { type: "error", content: `没有发出去：${(e as Error).message}`.slice(0, 80) } };
    }
  }
  if (inter.purpose === "watch-brief" || inter.purpose === "watch-draft" || inter.purpose === "watch-promote") {
    // A watched group's cards that only the owner sees (watch-trial.ts): the brief, a reply draft, going direct.
    const trial = await import("./watch-trial.ts");
    const formValue = typeof action.form_value === "string" ? safeJson(action.form_value) : action.form_value;
    const form = formValue && typeof formValue === "object" ? (formValue as Record<string, unknown>) : null;
    const act = String((value as { action?: string } | undefined)?.action ?? "");
    closeInteraction(app, inter.id, operator);
    try {
      const card =
        inter.purpose === "watch-brief" ? await trial.decideBrief(app, inter.payload as { contextId: string; at: string }, act, form, opName)
        : inter.purpose === "watch-promote" ? await trial.decidePromotion(app, inter.payload as { contextId: string }, act, opName)
        : await trial.decideWatchDraft(app, inter.payload as never, act, form && typeof form.reply === "string" ? form.reply : null, opName);
      return { toast: { type: "success", content: "已处理" }, card: rawCard(card) };
    } catch (e) {
      // Not done: the card stays usable for another try.
      run(app.db, "update card_interactions set status = 'open', handled_at = null, handled_by = null where id = ?", inter.id);
      return { toast: { type: "error", content: `没有办成：${(e as Error).message}`.slice(0, 80) } };
    }
  }
  if (inter.purpose === "probe-proposal" || inter.purpose === "first-look") {
    // 快速通道 (docs/v2/first-look.md): a proposed probe (保存 / 不要), or a first look's card (发给大家 / 不用查了 / 不用了).
    const act = String((value as { action?: string } | undefined)?.action ?? "");
    if (inter.purpose === "first-look") {
      if (act === "continue" && !inter.allowed.length) return { toast: { type: "error", content: "无法确认卡片的主人" } };
      if (!run(app.db, "update card_interactions set status = 'done', handled_at = ?, handled_by = ? where id = ? and status = 'open'", new Date().toISOString(), operator, inter.id).changes) return { toast: { type: "info", content: "已经处理过了" } };
      inter = getInteraction(app, inter.id)!;
    } else closeInteraction(app, inter.id, operator);
    try {
      if (inter.purpose === "probe-proposal") {
        const card = await (await import("../rules/probes.ts")).decideProposal(app, inter.payload as never, act, opName);
        return { toast: { type: "success", content: act === "save" ? "已保存" : "不要了" }, card: rawCard(buildCard(card as never)) };
      }
      const r = await (await import("../rules/first-look.ts")).decideCard(app, inter.id, inter.payload as never, act, opName);
      if (r.keepOpen) run(app.db, "update card_interactions set status = 'open', handled_at = null, handled_by = null where id = ?", inter.id);
      return { toast: { type: "success", content: r.toast }, card: rawCard(r.card) };
    } catch (e) {
      // Not done: the card stays usable for another try.
      run(app.db, "update card_interactions set status = 'open', handled_at = null, handled_by = null where id = ?", inter.id);
      return { toast: { type: "error", content: `没有办成：${(e as Error).message}`.slice(0, 80) } };
    }
  }
  if (inter.purpose === "draft") {
    const choice = (value as { action?: string } | undefined)?.action;
    closeInteraction(app, inter.id, operator);
    const p = inter.payload as { target: Target; content: Content; delivery?: Delivery; situationChat?: string };
    if (choice === "send") {
      try {
        if (p.situationChat) {
          const { situationOfRun, situationChatScope, situationSendError } = await import("../situations/chat.ts");
          const situation = situationOfRun(app, inter.runId, OWNER);
          if (!situation || !situationChatScope(app, situation, true).chats.includes(p.situationChat))
            throw new Error("这一次的群或回复档已改，请不要发这条草稿");
          await deliverLark(p.target, p.content, p.delivery).catch(error => { throw situationSendError(error); });
        } else await deliverLark(p.target, p.content, p.delivery);
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
    const digest = /^item:(keep|reopen|take|drop):([^:]+)$/.exec(act);
    if ((inter.payload as { digest?: boolean }).digest && digest) {
      const [, op, id] = digest;
      if (!((inter.payload as { itemIds?: string[] }).itemIds ?? []).includes(id)) return { toast: { type: "error", content: "按钮与事项不匹配" } };
      const { getItem } = await import("../items/store.ts");
      const { keepItem } = await import("../items/expiry.ts");
      const userId = operatorUser();
      const item = getItem(app, id);
      if (!userId || item.userId !== userId || !canWrite(app, userId, item.spaceId)) return { toast: { type: "error", content: "无权处理该事项" } };
      // A candidate the assistant made on its own (items/auto.ts): 留下 opens it, 不要 puts it down.
      if (op === "take" || op === "drop") {
        if (item.status !== "candidate") return { toast: { type: "info", content: `「${item.title}」已经处理过了` } };
        const { decideCandidate } = await import("../items/auto.ts");
        decideCandidate(app, id, op === "take", userId, "card");
        return { toast: { type: "success", content: op === "take" ? `已留下「${item.title}」` : `不要了「${item.title}」` } };
      }
      const closed = ["done", "cancelled", "expired"].includes(item.status);
      if (op === "reopen" && !closed) return { toast: { type: "info", content: `「${item.title}」已经是打开的` } };
      keepItem(app, id, "user");
      return { toast: { type: "success", content: op === "reopen" ? `已恢复「${item.title}」` : `已保留「${item.title}」，期限重新计算` } };
    }
    // A nudge to finish an item (a reminder, a deadline): 已处理 closes it, 忽略 drops it and is a lesson.
    const m = /^item:(done|cancel):([^:]+)$/.exec(act);
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
      if (result.title && op === "cancel" && operatorUser() === OWNER) {
        // "忽略" is a lesson: the model phrases a short "don't ping me for this"
        // rule. Fire-and-forget — card callbacks must answer Feishu within a few
        // seconds; the AI summarization can finish in the background.
        const clicked = typeof notificationId === "string" ? notificationId : null;
        const noteRow = one<{ id: string }>(
          app.db,
          "select id from notifications where user_id = 'owner' and json_extract(context,'$.entityId') = ? and (? is null or id = ?) order by at desc limit 1",
          id, clicked, clicked,
        );
        if (noteRow) {
          void import("../core/notify-reactions.ts")
            .then(({ handleNegativeNotification }) => handleNegativeNotification(app, noteRow.id, "ignore"))
            .catch((e) => console.warn(`[omem] 学习免提醒规则失败：${(e as Error).message}`));
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
    // A card an agent run posted outside any conversation (a rule's agent replying under the triggering
    // message): the same agent picks the click up, continuing its session, whenever it comes.
    const resumed = await resumeAgentFromCard(app, inter, messageId, describeAction({ tag: action.tag, name: action.name, value, formValue: typeof action.form_value === "string" ? safeJson(action.form_value) : action.form_value, option: action.option, options: action.options, input: action.input_value, checked: action.checked }), opName, operator);
    if (resumed) return resumed;
    return { toast: { type: "warning", content: "找不到对应的会话" } };
  }
  // The /model card changes the thread's model settings directly; no agent turn.
  const buttonAction = value as { action?: string } | undefined;
  const formValue = typeof action.form_value === "string" ? safeJson(action.form_value) : action.form_value;
  const isModelCard = inter.purpose === "model" || buttonAction?.action?.startsWith("model:") || (typeof formValue === "object" && formValue !== null && "modelText" in formValue);
  if (isModelCard) {
    if (operatorUser() !== OWNER) return { toast: { type: "warning", content: "用 /agent 或 /model 更改你在本会话的 AI" } };
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

/** Starts the agent that posted a card again with the click as its next step; null when the card has no such run. */
async function resumeAgentFromCard(app: App, inter: { id: string; runId: string | null }, messageId: string, desc: string, opName: string, operator: string) {
  if (!inter.runId) return null;
  const { createRun, getRun } = await import("../agents/runs.ts");
  let prev;
  try { prev = getRun(app, inter.runId); } catch { return null; }
  const input = prev.input as { spec?: string; task?: string; triggers?: unknown; moreTriggers?: unknown; resumeSessionId?: unknown };
  if (prev.kind !== "agent" || !input.spec) return null;
  const { triggers: _t, moreTriggers: _m, resumeSessionId: _s, ...rest } = input;
  const task = [
    "# 卡片操作",
    "",
    `${opName}（${operator}）在你之前（运行 ${prev.id}）发的卡片 ${messageId} 上${desc}。按这个选择接着把事情做完。之前的过程在你的会话里；会话接不上时用 read_run 读运行 ${prev.id}。`,
    "",
    "# 原来的任务",
    "",
    input.task ?? "",
  ].join("\n");
  const next = createRun(app, { kind: "agent", spaceId: prev.spaceId, title: `${input.spec}：处理卡片上的选择`, input: { ...rest, task, resumeFromRun: prev.id }, parentId: prev.parentId, lane: prev.lane, userId: OWNER });
  run(app.db, "update card_interactions set handled_at = datetime('now'), handled_by = ? where id = ?", operator, inter.id);
  return { toast: { type: "info" as const, content: `已收到，${input.spec} 接着处理（运行 ${next.id}）` } };
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
  return "markdown" in c ? c.markdown.slice(0, 3000) : "text" in c ? c.text.slice(0, 3000) : "post" in c ? c.post.markdown.slice(0, 3000) : "card" in c ? "（交互卡片）" : "（图片或文件）";
}
