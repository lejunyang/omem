import { addAskSink, addViewSink, answerAsk, getAsk, isImmediateAsk, uiLink, type Ask } from "../agents/asks.ts";
import { viewCardBlocks, viewColor, viewSummary, viewTarget } from "./lark-ui.ts";
import { fieldsText, normalizeAnswers, type UiField } from "../agents/ui-blocks.ts";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { HttpError, truncate } from "../core/util.ts";
import { larkOpenIdOf, OWNER, userName } from "../core/users.ts";
import { resolveCitationsSync } from "./common.ts";
import { bindInteraction, buildCard, buttonRows, cardMentions, cardText, closeInteraction, decidedBlocks, decidedColor, getInteraction, larkOwnerOpenId, larkPrivateChat, recordInteraction, resultSummary, sendLark, textWidth, updateLarkCard, type CardBlock, type CardField, type Target } from "./lark-send.ts";
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

function button(text: string, name: string, kind: "primary" | "danger" | "default", inForm: boolean, value: string): Record<string, unknown> {
  return inForm
    ? { tag: "button", name, text: { tag: "plain_text", content: text }, type: kind, form_action_type: "submit" }
    : { tag: "button", name, text: { tag: "plain_text", content: text }, type: kind, behaviors: [{ type: "callback", value: { action: value } }] };
}
const row = (buttons: Record<string, unknown>[]) => ({ tag: "column_set", flex_mode: "flow", columns: buttons.map((b) => ({ tag: "column", width: "auto", elements: [b] })) });

/** An option label that fits on its button on a phone (eight CJK characters). */
const SHORT = 16;

/** A long option: its full text, numbered, wrapping beside the button that picks it. */
function optionRow(label: string, i: number, inForm: boolean, suggestion: boolean) {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [{ tag: "markdown", content: `**${i + 1}.** ${cardText(label)}` }] },
      { tag: "column", width: "auto", vertical_align: "center", elements: [button(suggestion ? "继续" : "选择", `opt_${i}`, i === 0 ? "primary" : "default", inForm, `ask:${i}`)] },
    ],
  };
}

/**
 * One layout for all of a card's options: short ones are buttons in rows that fit a phone; when any
 * is too long for a button, every option is a numbered line with its own button, in order.
 */
function optionRows(ask: Ask) {
  const inForm = withText(ask);
  const short = ask.options.every((o) => textWidth(o.label) <= SHORT && !/[\r\n]/.test(o.label));
  if (!short) return ask.options.map((o, i) => optionRow(o.label, i, inForm, ask.kind === "suggestion"));
  return buttonRows(ask.options.map((o, i) => ({ text: o.label, button: button(o.label, `opt_${i}`, i === 0 ? "primary" : "default", inForm, `ask:${i}`) })));
}

/** Next-step suggestions always take the owner's own words too: a box under the buttons (or instead of them). */
const withText = (ask: Ask) => ask.allowText || ask.kind === "suggestion";

/** A question that lists several points to answer (1. … 2. …, ①②) gets a box for several lines. */
const manyPoints = (question: string) => (question.match(/^\s*(?:\d+\s*[.、．)）]|[①-⑩])/gm) ?? []).length >= 2;

/** A decision needs its question up front; the investigation stays in the run and a closed fold. */
function questionBlocks(app: App, ask: Ask): CardBlock[] {
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

/**
 * `mention`: the person who has to answer, in the posting bot's ids; @-ed at the top of a card posted
 * in a group (only while it waits for them).
 */
export function askCard(app: App, ask: Ask, opts: { mention?: string | null; note?: string } = {}): Record<string, unknown> {
  if (ask.status !== "pending") return answeredCard(app, ask);
  const blocks = questionBlocks(app, ask);
  // The asking turn's answer, when it only said again what the card says (foldIntoAsk): kept, folded.
  if (opts.note) blocks.push({ fold: { title: "这一轮的说明", markdown: resolveCitationsSync(app, truncate(opts.note, 6000)) } });
  if (ask.askedBy) blocks.unshift({ note: `${cardText(userName(app, ask.askedBy))} 的助手替 ta 问你，回答会交给 ta。` });
  // What the agent showed with the question comes first, as text (docs/v2/interactive-ui.md).
  if (ask.ui?.view?.length) {
    // An interactive page is used on the web: the card only links to the question's page.
    const link = uiLink(app, ask.id);
    const web = /^https?:/.test(link);
    blocks.push(...viewCardBlocks(app, ask.ui.view, { linked: web }));
    if (web && ask.ui.view.some((c) => c.type === "page")) blocks.push({ buttons: [{ text: "打开交互页", url: link, style: "primary" }] });
  }
  const at = ask.kind === "suggestion" ? "" : cardMentions([opts.mention]);
  if (at) {
    const first = blocks[0];
    if (first && "markdown" in first) blocks[0] = { markdown: `${at} ${first.markdown}` };
    else blocks.unshift({ markdown: at });
  }
  // A form is filled in on the web page of the question; a reply in the chat still answers it.
  if (ask.ui?.fields?.length) {
    const link = uiLink(app, ask.id);
    const web = /^https?:/.test(link);
    // Fields a card can hold are filled in right here; the rest is filled in on the web page.
    const fields = cardFields(ask.ui.fields);
    const base = blocks.length;
    if (fields) {
      const picks = ask.ui.fields.filter((f): f is Extract<UiField, { type: "pick" }> => f.type === "pick");
      for (const p of picks) blocks.push({ markdown: `**${cardText(p.label)}**\n${cardText(truncate(fieldsText([p]).split("\n").slice(1).join("\n"), 2000))}` });
      if (ask.allowText) fields.push({ type: "input", name: "text", label: "补充说明（可不填）", multiline: true });
      blocks.push({ form: { name: "ask", fields, submit: ask.ui.submitLabel || "提交" } });
      if (web) blocks.push({ buttons: [{ text: "在网页上填写", url: link }] });
      const card = buildCard({ title: TITLE.question, color: "blue", blocks });
      if (JSON.stringify(card).length <= CARD_FORM_MAX) return card;
      blocks.length = base;
    }
    // Too much for a card: just the link. Without a web address the fields are listed to answer in text.
    if (web) blocks.push({ buttons: [{ text: "打开填写", url: link, style: "primary" }] }, { note: "也可以直接回复文字。" });
    else blocks.push({ markdown: `要填的：\n${cardText(truncate(fieldsText(ask.ui.fields), 3000))}` }, { note: "在 omem 网页上填写，或直接回复文字（设置 → 设备 填网页地址后这里会有链接）。" });
    return buildCard({ title: TITLE.question, color: "blue", blocks });
  }
  const card = buildCard({ ...(ask.kind === "suggestion" ? {} : { title: TITLE[ask.kind], color: ask.kind === "approval" ? "orange" : "blue" }), blocks });
  const elements = (card.body as { elements: unknown[] }).elements;
  const choices = ask.kind === "approval" ? [row([button("批准", "approve", "primary", ask.allowText, "approve"), button("拒绝", "reject", "danger", ask.allowText, "reject")])] : optionRows(ask);
  if (withText(ask)) {
    const lines = ask.kind === "question" && manyPoints(ask.question);
    const placeholder = ask.kind === "approval" ? "理由或附言（可不填）" : ask.kind === "suggestion" ? "也可以写你要它做的，或在选的项后面补充" : lines ? "可以整体回答，也可以按编号逐条写" : ask.options.length ? "也可以写别的回答" : "你的回答";
    elements.push({
      tag: "form",
      name: "ask",
      vertical_spacing: "8px",
      elements: [
        ...(ask.kind === "approval" ? [] : choices),
        { tag: "input", name: "text", width: "fill", placeholder: { tag: "plain_text", content: placeholder }, ...(lines ? { input_type: "multiline_text", rows: 3, auto_resize: true, max_rows: 8 } : {}) },
        ...(ask.kind === "approval" ? choices : ask.kind === "question" ? [row([button(ask.options.length ? "用文字回答" : "回答", "answer", ask.options.length ? "default" : "primary", true, "")])] : ask.kind === "suggestion" ? [row([button("按我写的做", "answer", "default", true, "")])] : []),
      ],
    });
  } else elements.push(...choices);
  return card;
}

/**
 * An ask once answered (or lapsed): what was asked, then who decided what and when and what came of it
 * (decidedBlocks). An approval's result is the tool's output for the agent: one line on the card, the
 * rest folded. No buttons.
 */
function answeredCard(app: App, ask: Ask): Record<string, unknown> {
  const immediate = isImmediateAsk(ask) && ask.status === "answered";
  const approval = ask.kind === "approval";
  const question = ask.question ? [{ markdown: resolveCitationsSync(app, truncate(ask.question, approval ? 800 : 1500)) }] : [];
  // Someone omem does not know shows as a bare Feishu id: leave the name out then.
  const name = ask.answeredBy ? userName(app, ask.answeredBy) : null;
  const when = { by: name && !/^o[un]_/.test(name) ? name : null, at: ask.answeredAt, timeZone: app.config.timezone };
  // Lapsed without an answer (agents/ask-expiry.ts): why, and no buttons.
  if (ask.status === "cancelled" && ask.lapsed) return buildCard({ color: "grey", ...(ask.kind === "suggestion" ? {} : { title: `${TITLE[ask.kind]} · 已失效` }), blocks: [...question, ...decidedBlocks({ verdict: `已失效：${ask.lapsed}`, at: ask.answeredAt, timeZone: app.config.timezone })] });
  if (ask.status === "cancelled") {
    // Closed with a note on how (the assistant passed on the owner's answer): say so, not just "lapsed".
    const d = ask.result ? { verdict: "已在别处处理", result: resolveCitationsSync(app, ask.result), plain: true } : { verdict: "已失效（在对话或网页上接着处理了）" };
    return buildCard({ color: "grey", ...(ask.kind === "suggestion" ? {} : { title: `${TITLE[ask.kind]} · ${ask.result ? "已在别处处理" : "已失效"}` }), blocks: [...question, ...decidedBlocks(d)] });
  }
  if (approval) {
    const d = { ...when, verdict: ask.approved ? "批准" : "拒绝", words: ask.answer, result: ask.approved ? ask.result : null };
    return buildCard({ title: ask.approved ? (d.result ? (resultSummary(d.result).ok ? "已批准并执行" : "已批准，执行失败") : "已批准") : "已拒绝", color: decidedColor(d, !!ask.approved), blocks: [...question, ...decidedBlocks(d)] });
  }
  if (immediate) return buildCard({ color: "grey", title: "已处理", blocks: [...question, ...decidedBlocks({ ...when, verdict: ask.result ?? "已处理" })] });
  const blocks: CardBlock[] = [...question, ...decidedBlocks({ ...when, verdict: ask.value ? "已填写" : `已选：${ask.answer ?? ""}`, result: ask.result ? resolveCitationsSync(app, ask.result) : null, plain: true })];
  if (ask.value && ask.answer) blocks.splice(question.length + 1, 0, { markdown: cardText(truncate(ask.answer, 3000)) });
  return buildCard({ color: "grey", ...(ask.kind === "suggestion" ? {} : { title: ask.kind === "question" ? "已回答" : TITLE[ask.kind] }), blocks });
}

/** Where an ask goes in Feishu, or null when this channel is not the one to show it. */
function targetFor(app: App, ask: Ask, ownerOpenId: string | undefined): { target: Target; chatId: string | null; bot: string } | null {
  // A command held by the command rules sends its own card to its approver (agents/command-gate.ts).
  if (ask.handler === "command-gate") return null;
  // Asked of someone else: their own private chat with the bot, never the asker's chat.
  if (ask.askedBy) {
    const openId = ask.userId === OWNER ? ownerOpenId : larkOpenIdOf(app, ask.userId);
    return openId ? { target: { userId: openId, bot: "main" }, chatId: null, bot: "main" } : null;
  }
  // Approvals that name other people's files or other people (lark_invite) go to the owner alone, never a group.
  if (ask.kind === "approval" && (ask.tool?.startsWith("lark_doc_") || ask.tool === "lark_write" || ask.tool === "lark_invite")) {
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

/** A view shown under a reply (`show`), as a card of its own after the reply. */
export function viewCard(app: App, view: { id: string; title: string; components: Parameters<typeof viewCardBlocks>[1] }) {
  const link = uiLink(app, view.id);
  const web = /^https?:/.test(link);
  const page = view.components.some((c) => c.type === "page");
  const summary = viewSummary(view.title, view.components);
  return buildCard({ ...(view.title ? { title: view.title } : {}), color: viewColor(view.components), ...(summary ? { summary } : {}), blocks: [...viewCardBlocks(app, view.components, { linked: web }), ...(web ? [{ buttons: [page ? { text: "打开交互页", url: link, style: "primary" as const } : { text: "在网页上查看", url: link }] }] : [])] });
}

/** Who may answer, in the posting bot's ids (the owner's open_id there; others by their main-bot id or user_id). */
function answererId(app: App, ask: Ask, bot: string) {
  return ask.userId === OWNER ? larkOwnerOpenId(app, bot) : bot === "main" ? larkOpenIdOf(app, ask.userId) : larkUserIdOf(app, ask.userId);
}

/** In a group the card says whose turn it is; a private chat needs no @. */
const groupMention = (app: App, chatId: string | null, who: string | null | undefined) => (chatId && !larkPrivateChat(app, chatId) ? who ?? null : null);

/** The card's buttons answer through this interaction. */
function bindCard(card: Record<string, unknown>, id: string) {
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
  return card;
}

/** Text as pieces of four characters, without markup, links and spacing: what two texts share. */
function grams(text: string) {
  const plain = text.replace(/\]\([^)]*\)/g, "]").replace(/[\s*_`|#>\-\[\]（）()，。、：:；;！!？?“”"'·…]+/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 4 <= plain.length; i++) out.add(plain.slice(i, i + 4));
  return out;
}

/** How much of `answer` the `question` already says (0–1): the share of its pieces found there. */
export function alreadySaid(answer: string, question: string) {
  const a = grams(answer);
  if (!a.size) return 1;
  const q = grams(question);
  let hit = 0;
  for (const g of a) if (q.has(g)) hit++;
  return hit / a.size;
}

/** An answer this short after a question card only points at it (“卡片已发给你”). */
const POINTS_ONLY = 30;
/** An answer saying this much of the question again repeats it. */
const REPEATS = 0.4;

/**
 * The turn's answer right after its own question in the same chat (ask_user, still waiting): when it
 * only points at the card or mostly says the question again, it goes into the card, folded, instead
 * of out as a second message saying the same. Returns the card's message id, or null to send it.
 */
export async function foldIntoAsk(app: App, runId: string, chatId: string, answer: string): Promise<string | null> {
  const ask = one<{ id: string }>(app.db, "select id from asks where run_id = ? and status = 'pending' and kind in ('question','approval') order by created_at desc limit 1", runId);
  if (!ask) return null;
  const inter = one<{ id: string; message_id: string; bot: string | null; payload: string }>(app.db,
    "select id, message_id, bot, payload from card_interactions where purpose = 'ask' and status = 'open' and message_id is not null and chat_id = ? and json_extract(payload, '$.askId') = ? order by created_at desc limit 1", chatId, ask.id);
  if (!inter) return null;
  const a = getAsk(app, ask.id);
  const plain = answer.replace(/\s+/g, "");
  if (plain.length > POINTS_ONLY && alreadySaid(answer, a.question) < REPEATS) return null;
  const bot = inter.bot ?? "main";
  await updateLarkCard(inter.message_id, bindCard(askCard(app, a, { mention: groupMention(app, chatId, answererId(app, a, bot)), note: answer }), inter.id), bot);
  run(app.db, "update card_interactions set payload = json_set(payload, '$.note', ?) where id = ?", answer, inter.id);
  return inter.message_id;
}

export function registerLarkAsks(app: App, ownerOpenId: () => string | undefined) {
  addViewSink(async (app, view) => {
    const to = viewTarget(app, view.conversationId);
    if (!to) return false;
    await sendLark(to, { card: viewCard(app, view) });
    return true;
  });
  addAskSink({
    async show(app, ask) {
      const to = targetFor(app, ask, ownerOpenId());
      if (!to) return false;
      const who = answererId(app, ask, to.bot);
      const id = recordInteraction(app, { messageId: null, chatId: to.chatId, conversationId: ask.conversationId, runId: ask.runId, purpose: "ask", allowed: who ? [who] : [], payload: { askId: ask.id }, bot: to.bot });
      const card = bindCard(askCard(app, ask, { mention: groupMention(app, to.chatId, who) }), id);
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

/** A card form much bigger than this goes to the web page instead (Feishu caps a card at about 30 KB). */
const CARD_FORM_MAX = 24_000;
/** A checklist this long is easier on the web page. */
const CARD_CHECKLIST_MAX = 12;

/**
 * A question's fields as card form fields (docs/v2/interactive-ui.md, “卡片里直接画”), or null when
 * they do not fit a card. A card cannot hide a field by another's answer: a conditional field says
 * when it applies, is never marked required there, and the host drops it when it does not apply.
 */
export function cardFields(fields: UiField[]): CardField[] | null {
  const out: CardField[] = [];
  const labelOf = (id: string) => fields.find((f) => f.id === id)?.label ?? id;
  for (const f of fields) {
    const when = f.show_if ? `（${labelOf(f.show_if.field)}${f.show_if.in ? `选了 ${f.show_if.in.join(" / ")}` : f.show_if.equals !== undefined ? `是 ${f.show_if.equals === true ? "是" : f.show_if.equals === false ? "否" : f.show_if.equals}` : "填了"} 时填）` : "";
    const label = `${f.label}${when}${f.help ? `\n${f.help}` : ""}`;
    const required = f.required && !f.show_if;
    const name = `f_${f.id}`;
    switch (f.type) {
      case "text":
      case "textarea":
        out.push({ type: "input", name, label, required, multiline: f.type === "textarea", ...(f.placeholder ? { placeholder: f.placeholder } : {}), ...(f.default ? { default: f.default } : {}) });
        break;
      case "number":
        out.push({ type: "input", name, label, required, placeholder: `数字${f.min !== undefined || f.max !== undefined ? `（${f.min ?? ""}–${f.max ?? ""}）` : ""}`, ...(f.default !== undefined ? { default: String(f.default) } : {}) });
        break;
      case "choice":
      case "multi":
        out.push({ type: f.type === "choice" ? "select" : "multi_select", name, label, required, options: f.options.map((o) => ({ text: o, value: o })), ...(f.type === "choice" && f.default ? { default: f.default } : {}) });
        break;
      case "scale":
        out.push({ type: "select", name, label, required, options: ["1", "2", "3", "4", "5"].map((o) => ({ text: o, value: o })) });
        break;
      case "date":
      case "datetime":
        out.push({ type: f.type, name, label, required });
        break;
      case "toggle":
        out.push({ type: "checkbox", name, label, checked: !!f.default });
        break;
      case "pick":
        out.push({ type: "select", name, label, required, options: f.items.map((i) => ({ text: i.title, value: i.id })) });
        break;
      case "rank":
      case "table":
        // Ordering and editing rows need the web page.
        return null;
      case "checklist":
        if (f.items.length > CARD_CHECKLIST_MAX) return null;
        f.items.forEach((it, i) => {
          out.push({ type: "select", name: `c_${f.id}__${it.id}`, label: `${i === 0 ? `${label}\n` : ""}${it.title}`, required, options: f.choices.map((c) => ({ text: c, value: c })) });
          if (f.note) out.push({ type: "input", name: `n_${f.id}__${it.id}`, placeholder: "备注（可不填）" });
        });
        break;
    }
  }
  return out.length <= 40 ? out : null;
}

/** Feishu's date pickers answer “2026-11-15 +0800” and “2026-11-15 14:00 +0800”. */
function cardTime(v: unknown, withTime: boolean) {
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?(?:\s*([+-]\d{2}):?(\d{2}))?/.exec(v.trim()) : null;
  if (!m) return v;
  if (!withTime) return m[1];
  return `${m[1]}T${m[2] ?? "00:00"}:00${m[3] ? `${m[3]}:${m[4]}` : ""}`;
}

/** What a card form sent, as the values a question's fields take. */
export function valueFromCard(fields: UiField[], form: Record<string, unknown>) {
  const value: Record<string, unknown> = {};
  for (const f of fields) {
    const v = form[`f_${f.id}`];
    switch (f.type) {
      case "checklist": {
        const map: Record<string, { choice: string; note?: string }> = {};
        for (const it of f.items) {
          const choice = form[`c_${f.id}__${it.id}`];
          const note = form[`n_${f.id}__${it.id}`];
          if (typeof choice === "string" && choice) map[it.id] = { choice, ...(typeof note === "string" && note.trim() ? { note } : {}) };
        }
        if (Object.keys(map).length) value[f.id] = map;
        break;
      }
      case "toggle":
        if (v !== undefined) value[f.id] = v === true || v === "true";
        break;
      case "scale":
        if (v !== undefined && v !== "") value[f.id] = Number(v);
        break;
      case "date":
      case "datetime":
        if (v) value[f.id] = cardTime(v, f.type === "datetime");
        break;
      default:
        if (v !== undefined && v !== null && v !== "") value[f.id] = v;
    }
  }
  return value;
}

/** A click or form submit on an ask card (lark-actions routes purpose "ask" here). */
export async function handleAskAction(app: App, interactionId: string, askId: string, action: { name?: string; value?: unknown; formValue?: unknown }, by: string) {
  const ask = getAsk(app, askId);
  if (ask.status !== "pending") return { toast: "已经处理过了", card: askCard(app, ask) };
  const text = typeof action.formValue === "object" && action.formValue ? String((action.formValue as { text?: unknown }).text ?? "").trim() : "";
  const fromValue = typeof action.value === "object" && action.value ? String((action.value as { action?: unknown }).action ?? "") : "";
  const opt = /^opt_(\d+)$/.exec(action.name ?? "")?.[1] ?? /^ask:(\d+)$/.exec(fromValue)?.[1];
  let input: Parameters<typeof answerAsk>[2];
  const form = typeof action.formValue === "object" && action.formValue ? (action.formValue as Record<string, unknown>) : null;
  if (ask.ui?.fields?.length && form && Object.keys(form).some((k) => /^[fcn]_/.test(k))) {
    // A form filled in on the card: checked here first, so a mistake keeps the card open with the reason.
    const value = valueFromCard(ask.ui.fields, form);
    try {
      normalizeAnswers(ask.ui.fields, value);
    } catch (e) {
      return { toast: e instanceof HttpError ? e.message : "填写有误" };
    }
    input = { value, text, by };
  } else if (ask.kind === "approval") {
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
