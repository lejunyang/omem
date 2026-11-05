import { addAskSink, answerAsk, getAsk, isImmediateAsk, type Ask } from "../agents/asks.ts";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import { larkOpenIdOf, OWNER } from "../core/users.ts";
import { resolveCitationsSync } from "./common.ts";
import { bindInteraction, buildCard, closeInteraction, getInteraction, larkOwnerOpenId, recordInteraction, sendLark, updateLarkCard, type Target } from "./lark-send.ts";
import { botOfChannel } from "../core/bot-context.ts";
import { getTask } from "../agents/code-tasks.ts";

/**
 * Asks in Feishu: a card in the conversation's chat or topic (or the person's private chat with
 * the bot when the ask has no Feishu conversation). Options are buttons; a text box takes a free
 * answer or a refusal's reason. Answered anywhere, the card turns into a record of the answer.
 */
const TITLE: Record<Ask["kind"], string> = { question: "需要你回答", approval: "需要你批准", suggestion: "" };
/**
 * How long a card click waits for its answer before Feishu is told it is being handled (its limit is
 * about 3 s). Shorter than the whole callback's CALLBACK_WAIT_MS (lark-actions.ts), so a slow answer still
 * comes back with the updated card instead of a bare toast.
 */
export const ANSWER_WAIT_MS = 800;

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

/** Keep the full option readable even when the client truncates button text. */
function optionRow(label: string, i: number, inForm: boolean, suggestion: boolean) {
  const text = label.replace(/&/g, "&amp;").replace(/([\\`*_{}\[\]()#+.!|>~-])/g, "\\$1").replace(/</g, "&lt;");
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content: `${i + 1}. ${text}` }] },
      button(suggestion ? "继续" : "选择", `opt_${i}`, i === 0 ? "primary" : "default", inForm, `ask:${i}`),
    ],
  };
}

function optionRows(ask: Ask) {
  const rows: Record<string, unknown>[] = [];
  const short: ReturnType<typeof button>[] = [];
  const flush = () => {
    if (short.length) rows.push({ tag: "column_set", flex_mode: "flow", columns: short.splice(0) });
  };
  ask.options.forEach((o, i) => {
    // Reserve room for two buttons on a phone; CJK and other wide characters take two units.
    const width = Array.from(o.label).reduce((n, c) => n + (c.codePointAt(0)! > 0xff ? 2 : 1), 0);
    if (width <= 12 && !/[\r\n]/.test(o.label)) {
      short.push(button(o.label, `opt_${i}`, i === 0 ? "primary" : "default", ask.allowText, `ask:${i}`));
      if (short.length === 2) flush();
    } else {
      flush();
      rows.push(optionRow(o.label, i, ask.allowText, ask.kind === "suggestion"));
    }
  });
  flush();
  return rows;
}

/** A decision needs its question up front; the investigation stays in the run and a closed fold. */
function questionBlocks(app: App, ask: Ask) {
  const row = one<{ context: string | null }>(app.db, "select context from asks where id = ?", ask.id);
  const ctx = JSON.parse(row?.context ?? "{}") as { handler?: string; workId?: string; seq?: number };
  if (ctx.handler !== "code-task" || !ctx.workId || !ctx.seq) return ask.question ? [{ markdown: resolveCitationsSync(app, ask.question) }] : [];
  const task = getTask(app, ctx.workId, ctx.seq);
  const base = (app.config.webUrl || app.baseUrl).replace(/\/$/, "");
  return [
    { markdown: resolveCitationsSync(app, `**T${task.seq} · ${task.title}**\n\n${truncate(task.question ?? "", 1200)}`) },
    ...(base ? [{ markdown: `[查看修改项、评审和修复记录](${base}/#/runs/${encodeURIComponent(ctx.workId)})` }] : [{ note: `完整记录：运行 ${ctx.workId} · T${task.seq}` }]),
    { fold: { title: "完成标准与处理记录", markdown: resolveCitationsSync(app, ask.question) } },
  ];
}

export function askCard(app: App, ask: Ask): Record<string, unknown> {
  if (ask.status !== "pending") {
    const immediate = isImmediateAsk(ask) && ask.status === "answered";
    const how = ask.status === "cancelled" ? "已失效（在对话或网页上接着处理了）" : immediate ? ask.result ?? "已处理" : ask.kind === "approval" ? (ask.approved ? `已批准${ask.answer ? `：${ask.answer}` : ""}` : `已拒绝${ask.answer ? `：${ask.answer}` : ""}`) : `已选：${ask.answer ?? ""}`;
    return buildCard({ color: "grey", ...(ask.kind === "suggestion" ? {} : { title: immediate ? "已处理" : TITLE[ask.kind] }), blocks: [...(ask.question ? [{ markdown: resolveCitationsSync(app, truncate(ask.question, 1500)) }] : []), { note: how }, ...(ask.result && !immediate ? [{ markdown: resolveCitationsSync(app, ask.result) }] : [])] });
  }
  const card = buildCard({ ...(ask.kind === "suggestion" ? {} : { title: TITLE[ask.kind], color: ask.kind === "approval" ? "orange" : "blue" }), blocks: questionBlocks(app, ask) });
  const elements = (card.body as { elements: unknown[] }).elements;
  const choices =
    ask.kind === "approval"
      ? [{ tag: "column_set", flex_mode: "flow", columns: [button("批准", "approve", "primary", ask.allowText, "approve"), button("拒绝", "reject", "danger", ask.allowText, "reject")] }]
      : optionRows(ask);
  if (ask.allowText) {
    elements.push({
      tag: "form",
      name: "ask",
      elements: [
        ...(ask.kind === "approval" ? [] : choices),
        { tag: "input", name: "text", placeholder: { tag: "plain_text", content: ask.kind === "approval" ? "理由或附言（可不填）" : ask.options.length ? "也可以写别的回答" : "你的回答" } },
        ...(ask.kind === "approval" ? choices : ask.kind === "question" ? [{
          tag: "column_set", flex_mode: "flow", columns: [button(ask.options.length ? "用文字回答" : "回答", "answer", ask.options.length ? "default" : "primary", true, "")],
        }] : []),
      ],
    });
  } else elements.push(...choices);
  return card;
}

/** Where an ask goes in Feishu, or null when this channel is not the one to show it. */
function targetFor(app: App, ask: Ask, ownerOpenId: string | undefined): { target: Target; chatId: string | null; bot: string } | null {
  if (ask.kind === "approval" && (ask.tool?.startsWith("lark_doc_") || ask.tool === "lark_write")) {
    const openId = ask.userId === OWNER ? ownerOpenId : larkOpenIdOf(app, ask.userId);
    return openId ? { target: { userId: openId, bot: "main" }, chatId: null, bot: "main" } : null;
  }
  if (ask.conversationId) {
    const t = one<{ channel: string; external_id: string | null; last: string | null; topic: string | null }>(app.db, "select channel, external_id, json_extract(settings, '$.lastTopicId') topic, json_extract(settings, '$.lastMessageId') last from conversations where id = ?", ask.conversationId);
    // The host's own decisions about background work (a review plan, a finished review) reach the
    // person in Feishu even when the work was asked for elsewhere; an agent's question stays in its chat.
    const hostAsk = !!one(app.db, "select 1 from asks where id = ? and json_extract(context, '$.handler') is not null", ask.id);
    if (t && t.channel !== "lark" && !t.channel.startsWith("lark:") && !hostAsk) return null;
    if (t?.external_id && (t.channel === "lark" || t.channel.startsWith("lark:"))) {
      // The card goes through the bot of the conversation (lark.bots), whose ids it then uses.
      const bot = botOfChannel(t.channel);
      const [chatId, topic] = t.external_id.split("#");
      return { target: (t.topic ?? topic) && t.last ? { replyTo: t.last, inThread: true, bot } : { chatId, bot }, chatId, bot };
    }
  }
  // No Feishu conversation: the person's private chat with the bot (suggestions only live under a reply).
  if (ask.kind === "suggestion") return null;
  const openId = ask.userId === OWNER ? ownerOpenId : larkOpenIdOf(app, ask.userId);
  return openId ? { target: { userId: openId, bot: "main" }, chatId: null, bot: "main" } : null;
}

/** A user's tenant-wide user_id (known from the main bot's id for them), for cards of the other bots. */
function larkUserIdOf(app: App, userId: string) {
  const openId = larkOpenIdOf(app, userId);
  return openId ? one<{ user_id: string | null }>(app.db, "select user_id from lark_people where bot_open_id = ?", openId)?.user_id ?? undefined : undefined;
}

export function registerLarkAsks(app: App, ownerOpenId: () => string | undefined) {
  addAskSink({
    async show(app, ask) {
      const to = targetFor(app, ask, ownerOpenId());
      if (!to) return false;
      // Who may answer, in the posting bot's ids (the owner's open_id there; others by their main-bot id or user_id).
      const who = ask.userId === OWNER ? larkOwnerOpenId(app, to.bot) : to.bot === "main" ? larkOpenIdOf(app, ask.userId) : larkUserIdOf(app, ask.userId);
      const id = recordInteraction(app, { messageId: null, chatId: to.chatId, conversationId: ask.conversationId, runId: ask.runId, purpose: "ask", allowed: who ? [who] : [], payload: { askId: ask.id }, bot: to.bot });
      const card = askCard(app, ask);
      const bind = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const node = value as Record<string, unknown>;
        if (node.tag === "button") {
          node.name = `${node.name}__${id}`;
          for (const behavior of (node.behaviors ?? []) as { type: string; value?: Record<string, unknown> }[]) {
            if (behavior.type === "callback") behavior.value = { ...behavior.value, interactionId: id };
          }
        }
        for (const child of Object.values(node)) if (child && typeof child === "object") {
          if (Array.isArray(child)) child.forEach(bind);
          else bind(child);
        }
      };
      bind(card);
      try {
        const sent = await sendLark(to.target, { card });
        bindInteraction(app, id, sent.messageId);
        // A click may have completed while the send request was still returning.
        const current = getAsk(app, ask.id);
        if (current.status !== "pending") await updateLarkCard(sent.messageId, askCard(app, current), to.bot).catch(() => {});
      } catch (error) {
        if (!getInteraction(app, id)?.messageId) run(app.db, "update card_interactions set status = 'expired' where id = ?", id);
        throw error;
      }
      return true;
    },
    async closed(app, ask) {
      // The card that reached Feishu: a send that failed leaves an expired row without a message.
      const row = one<{ id: string; message_id: string | null }>(app.db, "select id, message_id from card_interactions where purpose = 'ask' and json_extract(payload, '$.askId') = ? and message_id is not null order by status = 'open' desc, created_at desc limit 1", ask.id);
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
  // Feishu waits about 3 s for this answer, and some answers take longer (confirming a delegation
  // pushes its branches): past ANSWER_WAIT_MS the click is acknowledged and the work goes on; the card
  // is updated again when the ask closes.
  const answering = answerAsk(app, askId, { ...input, deferEffects: !!ask.handler || ask.kind === "approval" });
  const done = await Promise.race([answering, new Promise<null>((ok) => setTimeout(() => ok(null), ANSWER_WAIT_MS))]);
  if (!done) {
    answering.catch((e) => console.warn(`[omem] 卡片回答 ${askId} 处理失败：${(e as Error).message}`));
    return { toast: "收到，正在处理，完成后卡片会更新", card: askCard(app, getAsk(app, askId)) };
  }
  if (isImmediateAsk(done)) return { toast: done.result ?? "已处理", card: askCard(app, done) };
  if (ask.handler || ask.kind === "approval") return { toast: "收到，正在处理，完成后卡片会更新", card: askCard(app, done) };
  return { toast: ask.kind === "suggestion" ? "收到，接着做" : "已回答", card: askCard(app, done) };
}
