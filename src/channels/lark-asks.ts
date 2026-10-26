import { addAskSink, answerAsk, getAsk, type Ask } from "../agents/asks.ts";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import { identitiesOf, OWNER } from "../core/users.ts";
import { resolveCitations } from "./common.ts";
import { buildCard, closeInteraction, getInteraction, larkOwnerOpenId, recordInteraction, sendLark, updateLarkCard, type Target } from "./lark-send.ts";
import { botOfChannel } from "../core/bot-context.ts";

/**
 * Asks in Feishu: a card in the conversation's chat or topic (or the person's private chat with
 * the bot when the ask has no Feishu conversation). Options are buttons; a text box takes a free
 * answer or a refusal's reason. Answered anywhere, the card turns into a record of the answer.
 */
const TITLE: Record<Ask["kind"], string> = { question: "需要你回答", approval: "需要你批准", suggestion: "" };

function button(text: string, name: string, kind: "primary" | "danger" | "default", inForm: boolean, value: string) {
  return {
    tag: "column",
    width: "auto",
    elements: [
      inForm
        ? { tag: "button", name, text: { tag: "plain_text", content: text }, type: kind, form_action_type: "submit" }
        : { tag: "button", name, text: { tag: "plain_text", content: text }, type: kind, behaviors: [{ type: "callback", value: { action: value } }] },
    ],
  };
}

export function askCard(app: App, ask: Ask): Record<string, unknown> {
  if (ask.status !== "pending") {
    const how = ask.status === "cancelled" ? "已失效（在对话或网页上接着处理了）" : ask.kind === "approval" ? (ask.approved ? `已批准${ask.answer ? `：${ask.answer}` : ""}` : `已拒绝${ask.answer ? `：${ask.answer}` : ""}`) : `已选：${ask.answer ?? ""}`;
    return buildCard({ color: "grey", ...(ask.kind === "suggestion" ? {} : { title: TITLE[ask.kind] }), blocks: [...(ask.question ? [{ markdown: resolveCitations(app, truncate(ask.question, 1500)) }] : []), { note: how }] });
  }
  const card = buildCard({ ...(ask.kind === "suggestion" ? {} : { title: TITLE[ask.kind], color: ask.kind === "approval" ? "orange" : "blue" }), blocks: ask.question ? [{ markdown: resolveCitations(app, ask.question) }] : [] });
  const elements = (card.body as { elements: unknown[] }).elements;
  const buttons =
    ask.kind === "approval"
      ? [button("批准", "approve", "primary", true, ""), button("拒绝", "reject", "danger", true, "")]
      : ask.options.map((o, i) => button(o.label, `opt_${i}`, i === 0 ? "primary" : "default", ask.allowText, `ask:${i}`));
  if (ask.allowText) {
    if (ask.kind === "question" && !ask.options.length) buttons.push(button("回答", "answer", "primary", true, ""));
    else if (ask.kind === "question") buttons.push(button("用文字回答", "answer", "default", true, ""));
    elements.push({
      tag: "form",
      name: "ask",
      elements: [
        { tag: "input", name: "text", placeholder: { tag: "plain_text", content: ask.kind === "approval" ? "理由或附言（可不填）" : ask.options.length ? "也可以写别的回答" : "你的回答" } },
        { tag: "column_set", flex_mode: "flow", columns: buttons },
      ],
    });
  } else elements.push({ tag: "column_set", flex_mode: "flow", columns: buttons });
  return card;
}

/** Where an ask goes in Feishu, or null when this channel is not the one to show it. */
function targetFor(app: App, ask: Ask, ownerOpenId: string | undefined): { target: Target; chatId: string | null; bot: string } | null {
  if (ask.conversationId) {
    const t = one<{ channel: string; external_id: string | null; last: string | null }>(app.db, "select channel, external_id, json_extract(settings, '$.lastMessageId') last from conversations where id = ?", ask.conversationId);
    // The host's own decisions about background work (a review plan, a finished review) reach the
    // person in Feishu even when the work was asked for elsewhere; an agent's question stays in its chat.
    const hostAsk = !!one(app.db, "select 1 from asks where id = ? and json_extract(context, '$.handler') is not null", ask.id);
    if (t && t.channel !== "lark" && !t.channel.startsWith("lark:") && !hostAsk) return null;
    if (t?.external_id && (t.channel === "lark" || t.channel.startsWith("lark:"))) {
      // The card goes through the bot of the conversation (lark.bots), whose ids it then uses.
      const bot = botOfChannel(t.channel);
      const [chatId, topic] = t.external_id.split("#");
      return { target: topic && t.last ? { replyTo: t.last, inThread: true, bot } : { chatId, bot }, chatId, bot };
    }
  }
  // No Feishu conversation: the person's private chat with the bot (suggestions only live under a reply).
  if (ask.kind === "suggestion") return null;
  const openId = ask.userId === OWNER ? ownerOpenId : identitiesOf(app, ask.userId).find((i) => i.channel === "lark")?.external_id;
  return openId ? { target: { userId: openId, bot: "main" }, chatId: null, bot: "main" } : null;
}

/** A user's tenant-wide user_id (known from the main bot's id for them), for cards of the other bots. */
function larkUserIdOf(app: App, userId: string) {
  const openId = identitiesOf(app, userId).find((i) => i.channel === "lark")?.external_id;
  return openId ? one<{ user_id: string | null }>(app.db, "select user_id from lark_people where bot_open_id = ?", openId)?.user_id ?? undefined : undefined;
}

export function registerLarkAsks(app: App, ownerOpenId: () => string | undefined) {
  addAskSink({
    async show(app, ask) {
      const to = targetFor(app, ask, ownerOpenId());
      if (!to) return false;
      const sent = await sendLark(to.target, { card: askCard(app, ask) });
      // Who may answer, in the posting bot's ids (the owner's open_id there; others by their main-bot id or user_id).
      const who = ask.userId === OWNER ? larkOwnerOpenId(app, to.bot) : to.bot === "main" ? identitiesOf(app, ask.userId).find((i) => i.channel === "lark")?.external_id : larkUserIdOf(app, ask.userId);
      recordInteraction(app, { messageId: sent.messageId, chatId: to.chatId, conversationId: ask.conversationId, runId: ask.runId, purpose: "ask", allowed: who ? [who] : [], payload: { askId: ask.id }, bot: to.bot });
      return true;
    },
    async closed(app, ask) {
      const row = one<{ id: string; message_id: string | null }>(app.db, "select id, message_id from card_interactions where purpose = 'ask' and json_extract(payload, '$.askId') = ? and status = 'open'", ask.id);
      if (!row?.message_id) return;
      closeInteraction(app, row.id, ask.answeredBy ?? "");
      await updateLarkCard(row.message_id, askCard(app, ask), getInteraction(app, row.id)?.bot).catch(() => {});
    },
  });
}

/** A click or form submit on an ask card (lark-actions routes purpose "ask" here). */
export async function handleAskAction(app: App, interactionId: string, askId: string, action: { name?: string; value?: unknown; formValue?: unknown }, by: string) {
  const ask = getAsk(app, askId);
  if (ask.status !== "pending") return { toast: "已经处理过了", card: askCard(app, ask) };
  const text = typeof action.formValue === "object" && action.formValue ? String((action.formValue as { text?: unknown }).text ?? "").trim() : "";
  const fromValue = typeof action.value === "object" && action.value ? String((action.value as { action?: unknown }).action ?? "") : "";
  const opt = /^opt_(\d+)$/.exec(action.name ?? "")?.[1] ?? /^ask:(\d+)$/.exec(fromValue)?.[1];
  let input: Parameters<typeof answerAsk>[2];
  if (ask.kind === "approval") {
    if (action.name !== "approve" && action.name !== "reject") return { toast: "请点批准或拒绝" };
    input = { approved: action.name === "approve", text, by };
  } else if (opt !== undefined) input = { choice: Number(opt), text, by };
  else if (text) input = { text, by };
  else return { toast: "请选一个选项或写下回答" };
  run(app.db, "update card_interactions set handled_at = datetime('now'), handled_by = ? where id = ?", by, interactionId);
  const done = await answerAsk(app, askId, input);
  return { toast: ask.kind === "approval" ? (input.approved ? "已批准" : "已拒绝") : ask.kind === "suggestion" ? "收到，接着做" : "已回答", card: askCard(app, done) };
}
