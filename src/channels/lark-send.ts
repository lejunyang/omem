import { createReadStream, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import { currentBot } from "../core/bot-context.ts";
import type { SentPurpose } from "./lark-feedback.ts";
import { larkCardMarkdown } from "./lark-markdown.ts";

/**
 * Everything the Feishu bot can say: plain or Markdown text, replies (in a
 * topic or not), reactions, images and files, interactive cards with buttons,
 * selects, inputs and forms — optionally restricted to certain people — and
 * in-place card updates (used for live progress while an agent works).
 *
 * Agents reach this through the lark_* tools; the bot channel uses it for
 * replies and progress cards. The client is the bot's (tenant) identity.
 */
// The SDK client is untyped here on purpose: only a handful of calls are used.
type LarkClient = any;
/**
 * Connected bots by id: "main" (lark.appId) and each of lark.bots, every one with its own app
 * identity. Calls go through the bot of the current work (core/bot-context.ts) unless told.
 */
const bots = new Map<string, { client: LarkClient; openId: string | null; name: string }>();
export function setLarkBotClient(id: string, c: LarkClient | null, openId?: string | null, name = id) {
  if (c) bots.set(id, { client: c, openId: openId ?? null, name });
  else bots.delete(id);
}
export function setLarkClient(c: LarkClient | null, openId?: string | null, name?: string) {
  setLarkBotClient("main", c, openId, name ?? bots.get("main")?.name ?? "main");
}
export function larkBotInfo(id: string) {
  return bots.get(id) ?? null;
}
/** `bot`: "main" or one of lark.bots; without it, the bot of the current work. */
export function larkClientFor(bot?: string | null): LarkClient {
  const id = bot || currentBot();
  const b = bots.get(id);
  if (!b) throw new HttpError(503, id === "main" ? "飞书机器人未连接：在 omem setup → 渠道 里配置飞书机器人并重启服务" : `飞书机器人 ${id} 未连接`);
  return b.client;
}
export function larkClient(): LarkClient {
  return larkClientFor();
}
/** The current bot's own open_id (ids are per app). */
export function larkBotOpenId() {
  return bots.get(currentBot())?.openId ?? null;
}
/** The owner's open_id in the current bot's app. */
export function larkOwnerOpenId(app: App, bot = currentBot()) {
  return bot === "main" ? app.config.lark.ownerOpenId : app.config.lark.bots.find((b) => b.id === bot)?.ownerOpenId;
}

/**
 * Messages omem's bots posted (recent ones). Another omem bot that receives one as an event leaves
 * it alone: a hand-off between bots goes through omem itself (lark-bots.ts), not through Feishu.
 */
const posted = new Set<string>();
export function postedByOmem(messageId: string) {
  return posted.has(messageId);
}
function remember(messageId: string | undefined) {
  if (!messageId) return;
  posted.add(messageId);
  if (posted.size > 2000) posted.delete(posted.values().next().value!);
}

const check = (r: { code?: number; msg?: string; data?: any } | undefined, what: string) => {
  if (r && typeof r.code === "number" && r.code !== 0) throw new Error(`${what}失败（${r.code}）：${r.msg}`);
  return r?.data ?? r;
};

// ---- cards ----------------------------------------------------------------------

export type CardOption = { text: string; value: string };
export type CardField =
  | { type: "input"; name: string; label?: string; placeholder?: string; required?: boolean; multiline?: boolean; default?: string }
  | { type: "select" | "multi_select"; name: string; label?: string; placeholder?: string; options: CardOption[]; required?: boolean; default?: string }
  | { type: "person" | "multi_person"; name: string; label?: string; placeholder?: string; required?: boolean }
  | { type: "date" | "datetime"; name: string; label?: string; placeholder?: string; required?: boolean }
  | { type: "checkbox"; name: string; label: string; checked?: boolean };
export type CardButton = { text: string; value?: string; style?: "primary" | "danger" | "default"; url?: string; confirm?: string };
export type CardBlock =
  | { markdown: string }
  | { fields: { label: string; value: string }[] }
  | { buttons: CardButton[] }
  | { form: { name?: string; fields: CardField[]; submit?: string; cancel?: string } }
  | { image: string; alt?: string }
  | { note: string }
  | { hr: true }
  /** Folded section (collapsible panel), closed by default: long detail under a short answer. */
  | { fold: { title: string; markdown: string; open?: boolean } }
  /** A card element the host built itself (a table or chart, src/channels/lark-ui.ts); never model output as is. */
  | { element: Record<string, unknown> };
export type CardSpec = {
  title?: string;
  subtitle?: string;
  /** Header colour: blue wathet turquoise green yellow orange red carmine violet purple indigo grey */
  color?: string;
  blocks: CardBlock[];
  wide?: boolean;
};

const plain = (content: string) => ({ tag: "plain_text", content });

/** Text shown as is in card Markdown: its special characters only stay literal as HTML entities (a backslash would show). */
export function cardText(s: string) {
  return s.replace(/[&<>*_~`#:[\]()|]/g, (c) => `&#${c.codePointAt(0)};`);
}

/** Display width for laying out buttons: CJK and other wide characters take two units. */
export function textWidth(s: string) {
  return Array.from(s).reduce((n, c) => n + (c.codePointAt(0)! > 0xff ? 2 : 1), 0);
}

/** What one row of buttons can take on a phone, in `textWidth` units; a button's own padding counts as 6. */
const ROW_WIDTH = 40;

/**
 * Buttons in rows that fit a phone, in their order, the rows as even as the count allows (3 + 3 rather
 * than 4 + 2); each row still wraps by itself (`flow`) on a narrower screen. A button too wide for a
 * row has one of its own and fills it.
 */
export function buttonRows(buttons: { text: string; button: Record<string, unknown> }[]): Record<string, unknown>[] {
  const cost = (b: { text: string }) => textWidth(b.text) + 6;
  const pack = (cap: number) => {
    const rows: (typeof buttons)[] = [];
    let used = 0;
    for (const b of buttons) {
      const row = rows.at(-1);
      if (row && row.length < cap && used + cost(b) <= ROW_WIDTH) {
        row.push(b);
        used += cost(b);
      } else {
        rows.push([b]);
        used = cost(b);
      }
    }
    return rows;
  };
  const fewest = pack(Infinity);
  const even = pack(Math.ceil(buttons.length / Math.max(1, fewest.length)));
  return (even.length === fewest.length ? even : fewest).map((row) => ({
    tag: "column_set",
    flex_mode: "flow",
    columns: row.map((b) => ({ tag: "column", width: "auto", elements: [row.length === 1 && cost(b) > ROW_WIDTH ? { ...b.button, width: "fill" } : b.button] })),
  }));
}

/** `<at>` tags for people a card is for (bot-side open_id or user_id of the app that posts it). */
export function cardMentions(ids: (string | null | undefined)[]) {
  return [...new Set(ids.filter((id): id is string => !!id))].map((id) => `<at id=${id}></at>`).join(" ");
}

/**
 * A Feishu chat where the bot talks with one person only (no one else to point a card at): the owner's
 * private chat with a bot, or a chat its conversation was told is not a group (ThreadSettings.group).
 */
export function larkPrivateChat(app: App, chatId: string) {
  return !!one(app.db, "select 1 from kv where key like 'lark_owner_chat%' and value = ?", chatId) ||
    !!one(app.db, "select 1 from conversations where (channel = 'lark' or channel like 'lark:%') and (external_id = ? or instr(external_id, ?) = 1) and json_extract(settings, '$.group') = 0 limit 1", chatId, `${chatId}#`);
}

/** The same card with its people @-ed at the top, unless the card already @s them. */
export function mentionInCard(card: Record<string, unknown>, ids: (string | null | undefined)[]): Record<string, unknown> {
  const json = JSON.stringify(card);
  const line = cardMentions(ids.filter((id) => id && !json.includes(`<at id=${id}>`)));
  if (!line) return card;
  const body = (card.body ?? {}) as { elements?: unknown[] };
  return { ...card, body: { ...body, elements: [{ tag: "markdown", content: line }, ...(body.elements ?? [])] } };
}

function field(f: CardField): Record<string, unknown> {
  const ph = "placeholder" in f && f.placeholder ? { placeholder: plain(f.placeholder) } : {};
  const req = "required" in f && f.required ? { required: true } : {};
  // The question is a line of its own above every kind of field (formFields), so they line up alike.
  const fill = { width: "fill" };
  switch (f.type) {
    case "input":
      return { tag: "input", name: f.name, ...ph, ...req, ...fill, ...(f.multiline ? { input_type: "multiline_text", rows: 3 } : {}), ...(f.default ? { default_value: f.default } : {}) };
    case "select":
    case "multi_select":
      return {
        tag: f.type === "select" ? "select_static" : "multi_select_static",
        name: f.name,
        ...ph,
        ...req,
        ...fill,
        options: f.options.map((o) => ({ text: plain(o.text), value: o.value })),
        ...(f.default ? { initial_option: f.default } : {}),
      };
    case "person":
    case "multi_person":
      return { tag: f.type === "person" ? "select_person" : "multi_select_person", name: f.name, ...ph, ...req, ...fill };
    case "date":
      return { tag: "date_picker", name: f.name, ...ph, ...req, ...fill };
    case "datetime":
      return { tag: "picker_datetime", name: f.name, ...ph, ...req, ...fill };
    case "checkbox":
      return { tag: "checker", name: f.name, text: { tag: "plain_text", content: f.label }, checked: !!f.checked };
  }
}

/**
 * A form's questions one under another: each label in bold right above its field, a gap before the
 * next question, numbered when there are several (unless the labels carry numbers already).
 */
function formFields(fields: CardField[]): Record<string, unknown>[] {
  const asked = fields.filter((f) => f.type !== "checkbox" && f.label);
  const number = asked.length > 1 && !asked.some((f) => /^\s*(\d+|[一二三四五六七八九十]+)\s*[.、．)）]/.test(f.label!));
  const out: Record<string, unknown>[] = [];
  let n = 0;
  for (const f of fields) {
    const label = f.type !== "checkbox" && f.label ? f.label : null;
    if (label) {
      const required = "required" in f && f.required ? " <font color='red'>*</font>" : "";
      out.push({ tag: "markdown", content: `**${number ? `${++n}. ` : ""}${cardText(label)}**${required}`, ...(out.length ? { margin: "12px 0px 0px 0px" } : {}) });
    }
    out.push(field(f));
  }
  return out;
}

function button(b: CardButton, i: number, inForm = false): Record<string, unknown> {
  const base: Record<string, unknown> = { tag: "button", name: `btn_${i}`, text: plain(b.text), type: b.style === "danger" ? "danger" : b.style === "primary" ? "primary" : "default" };
  if (b.confirm) base.confirm = { title: plain("确认"), text: plain(b.confirm) };
  if (b.url) return { ...base, behaviors: [{ type: "open_url", default_url: b.url }] };
  if (inForm) return { ...base, form_action_type: "submit" };
  return { ...base, behaviors: [{ type: "callback", value: { action: b.value ?? b.text } }] };
}

/** Build a Card 2.0 JSON from a small, safe description. */
export function buildCard(spec: CardSpec): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  let n = 0;
  for (const b of spec.blocks) {
    if ("markdown" in b) elements.push({ tag: "markdown", content: b.markdown.slice(0, 20000) });
    else if ("note" in b) elements.push({ tag: "markdown", content: `<font color='grey'>${b.note}</font>`, text_size: "notation" });
    else if ("hr" in b) elements.push({ tag: "hr" });
    else if ("fold" in b)
      elements.push({
        tag: "collapsible_panel",
        expanded: !!b.fold.open,
        header: { title: { tag: "markdown", content: b.fold.title }, icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" }, icon_position: "right", icon_expanded_angle: -180 },
        border: { color: "grey", corner_radius: "5px" },
        elements: [{ tag: "markdown", content: b.fold.markdown.slice(0, 20000) }],
      });
    else if ("image" in b) elements.push({ tag: "img", img_key: b.image, alt: plain(b.alt ?? "") });
    else if ("element" in b) elements.push(b.element);
    else if ("fields" in b)
      elements.push({
        tag: "column_set",
        flex_mode: "bisect",
        columns: b.fields.map((f) => ({ tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content: `<font color='grey'>${f.label}</font>\n**${f.value}**` }] })),
      });
    else if ("buttons" in b) elements.push(...buttonRows(b.buttons.map((btn) => ({ text: btn.text, button: button(btn, n++) }))));
    else if ("form" in b) {
      const f = b.form;
      elements.push({
        tag: "form",
        name: f.name ?? "form",
        // A question sits close to its field (questions are kept apart by their own margin).
        vertical_spacing: f.fields.some((x) => x.type !== "checkbox" && x.label) ? "4px" : "8px",
        elements: [
          ...formFields(f.fields),
          {
            tag: "column_set",
            flex_mode: "flow",
            margin: "12px 0px 0px 0px",
            columns: [
              { tag: "column", width: "auto", elements: [{ ...button({ text: f.submit ?? "提交", style: "primary" }, n++, true), name: "submit" }] },
              ...(f.cancel ? [{ tag: "column", width: "auto", elements: [{ ...button({ text: f.cancel }, n++, true), form_action_type: "reset", name: "reset" }] }] : []),
            ],
          },
        ],
      });
    }
  }
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: spec.wide ? "fill" : "default" },
    ...(spec.title ? { header: { title: plain(spec.title), ...(spec.subtitle ? { subtitle: plain(spec.subtitle) } : {}), template: spec.color ?? "blue" } } : {}),
    body: { elements },
  };
}

// ---- a decided card ---------------------------------------------------------------

/**
 * How a card that asked for a decision (an approval, a draft to send, a rule's script, a guest, a
 * meeting) ends once someone decided: who and when, the decision and their words, and what came of it
 * in one line. Output meant for the agent (JSON, command output, notes to it) never goes on the card as
 * is: only its first line, the rest in a closed fold, cut short.
 */
export type Decided = {
  /** What was decided, in a few words: 已批准, 已拒绝, 确认发送… */
  verdict: string;
  /** Who decided (a name, or 本人). */
  by?: string | null;
  /** When (ISO); shown in `timeZone`. */
  at?: string | null;
  timeZone?: string;
  /** Their words with it (a reason, a remark). */
  words?: string | null;
  /** What came of it: a sentence, or a tool's whole output ("失败：…" when it failed). */
  result?: string | null;
  /** The result is ours (a sentence written for the person), not a tool's output: shown whole. */
  plain?: boolean;
};

/** The longest first line kept as a result's summary; longer ones are cut and the rest folded. */
const SUMMARY_MAX = 120;
const OUTPUT_MAX = 1500;

/** A result as one line and the rest (output for the agent, folded on the card). */
export function resultSummary(result: string): { ok: boolean; summary: string; rest: string } {
  const text = result.trim();
  const failed = /^失败[：:]/.test(text);
  const body = failed ? text.replace(/^失败[：:]\s*/, "") : text;
  const [first, ...more] = body.split("\n");
  let summary = first.trim().replace(/[：:]\s*$/, "");
  let rest = more.join("\n").trim();
  if (summary.length > SUMMARY_MAX) {
    rest = body;
    summary = truncate(summary, SUMMARY_MAX);
  }
  return { ok: !failed, summary: summary || (failed ? "执行失败" : "已完成"), rest };
}

/** Month-day hour:minute in the given time zone. */
export function shortTime(at: string, timeZone?: string) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** The colour of a decided card's header: green when it went through, red when it failed, grey otherwise. */
export function decidedColor(d: Pick<Decided, "result">, through: boolean) {
  if (d.result && !resultSummary(d.result).ok) return "red";
  return through ? "green" : "grey";
}

/** The blocks that end a decided card (put after what the card asked; no buttons). */
export function decidedBlocks(d: Decided): CardBlock[] {
  const who = [d.by, d.at ? shortTime(d.at, d.timeZone) : ""].filter(Boolean).join(" · ");
  const blocks: CardBlock[] = [{ note: `${who ? `${cardText(who)}　` : ""}${cardText(d.verdict)}${d.words?.trim() ? `：${cardText(truncate(d.words.trim(), 300))}` : ""}` }];
  if (!d.result?.trim()) return blocks;
  if (d.plain) {
    blocks.push({ markdown: truncate(d.result.trim(), 1500) });
    return blocks;
  }
  const r = resultSummary(d.result);
  blocks.push({ markdown: `${r.ok ? "<font color='green'>完成</font>" : "<font color='red'>失败</font>"}　${cardText(r.summary)}` });
  if (r.rest) blocks.push({ fold: { title: r.ok ? "完整输出" : "错误详情", markdown: `\`\`\`\n${truncate(r.rest, OUTPUT_MAX).replace(/```/g, "'''")}\n\`\`\`` } });
  return blocks;
}

// ---- sending ----------------------------------------------------------------------

export type Target = {
  chatId?: string;
  userId?: string;
  /** What userId is: the open_id in this bot app (default), or the tenant-wide user_id. */
  userIdType?: "open_id" | "user_id";
  replyTo?: string;
  inThread?: boolean;
  uuid?: string;
  /** One of lark.bots; the main bot when absent. */
  bot?: string | null;
  /** What the message is, for the record of what bots posted (lark-feedback.ts); cards default to "card", the rest to "answer". */
  purpose?: SentPurpose;
  /** The run that wrote it, when known. */
  runId?: string | null;
  conversationId?: string | null;
};

/**
 * Every message a bot posts is reported here (lark-feedback.ts keeps them, so reactions find their
 * run). Set once the bots start; tests and tools without it simply do not record.
 */
/** `topicRoot`: this reply opened a topic under that message (it is now the topic's root). */
type SentListener = (s: { messageId: string; chatId: string | null; runId: string | null; conversationId: string | null; purpose: SentPurpose; bot: string; topicRoot?: { root: string; topicId: string } }) => void;
let sentListener: SentListener | null = null;
export function onLarkSent(fn: SentListener | null) {
  sentListener = fn;
}
function reportSent(to: Target, content: Content | null, d: { message_id?: string; chat_id?: string; thread_id?: string } | undefined) {
  if (!sentListener || !d?.message_id) return;
  try {
    sentListener({
      messageId: d.message_id,
      chatId: d.chat_id ?? to.chatId ?? null,
      runId: to.runId ?? null,
      conversationId: to.conversationId ?? null,
      purpose: to.purpose ?? (content && !("card" in content) ? "answer" : "card"),
      bot: to.bot || currentBot(),
      ...(to.replyTo && to.inThread && d.thread_id ? { topicRoot: { root: to.replyTo, topicId: d.thread_id } } : {}),
    });
  } catch (e) {
    console.warn(`[omem] 记录机器人发出的消息失败：${(e as Error).message}`);
  }
}
export type Content =
  | { text: string }
  | { markdown: string; title?: string; /** Small grey line under the text (the run id under an answer). */ note?: string }
  | { card: Record<string, unknown> }
  | { image: string }
  | { file: string };

/**
 * Markdown goes as a single-element card: Feishu renders it fully only inside cards. Every card's
 * Markdown is written the way Feishu renders bold (lark-markdown.ts), whoever built the card.
 */
function payload(c: Content): { msg_type: string; content: string } {
  if ("text" in c) return { msg_type: "text", content: JSON.stringify({ text: c.text }) };
  if ("markdown" in c || "card" in c) return { msg_type: "interactive", content: JSON.stringify(asCard(c)) };
  if ("image" in c) return { msg_type: "image", content: JSON.stringify({ image_key: c.image }) };
  return { msg_type: "file", content: JSON.stringify({ file_key: c.file }) };
}

/**
 * Turns `@名字` in Markdown the bots post into real mentions (lark-people.ts realMentions, set by the
 * bot channel at start): one place for every answer, follow-up, rule reply and notice, so no path
 * leaves a plain “@名字”. Given the chat (or the message replied to) the text goes to.
 */
type MentionResolver = (markdown: string, where: { chatId?: string; replyTo?: string }) => Promise<string>;
let mentionResolver: MentionResolver | null = null;
export function setMentionResolver(f: MentionResolver | null) {
  mentionResolver = f;
}

export async function sendLark(to: Target, content: Content): Promise<{ messageId: string; threadId?: string }> {
  const c = larkClientFor(to.bot);
  if (mentionResolver && "markdown" in content && content.markdown.includes("@") && (to.chatId || to.replyTo)) {
    const original = content.markdown;
    content = { ...content, markdown: await mentionResolver(original, { chatId: to.chatId, replyTo: to.replyTo }).catch(() => original) };
  }
  const p = payload(content);
  let r;
  if (to.replyTo) r = await c.im.message.reply({ path: { message_id: to.replyTo }, data: { ...p, reply_in_thread: !!to.inThread, ...(to.uuid ? { uuid: to.uuid } : {}) } });
  else if (to.chatId) r = await c.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: to.chatId, ...p, ...(to.uuid ? { uuid: to.uuid } : {}) } });
  else if (to.userId) r = await c.im.message.create({ params: { receive_id_type: to.userIdType ?? "open_id" }, data: { receive_id: to.userId, ...p } });
  else throw new HttpError(400, "需要 chatId、userId 或 replyTo");
  const d = check(r, "发送飞书消息");
  remember(d?.message_id);
  reportSent(to, content, d);
  return { messageId: d?.message_id, threadId: d?.thread_id };
}

/** Bind /topic to the real Feishu topic before allowing its AI task to start. */
export async function openLarkTopic(messageId: string): Promise<{ topicId: string; messageId: string }> {
  const sent = await sendLark({ replyTo: messageId, inThread: true, uuid: `topic-${messageId}` }, { text: "这项任务在本话题中开始，使用独立上下文。" });
  if (!sent.threadId || !sent.messageId) throw new Error("飞书未返回话题 ID，任务尚未启动。请在支持话题回复的聊天中重试。");
  return { topicId: sent.threadId, messageId: sent.messageId };
}

/** A bot-side id from `resolveMention`: open_id (ou_…) or user_id. */
const idField = (id: string) => (id.startsWith("ou_") ? "open_id" : "user_id");

/**
 * A card in a group that only one member sees (Feishu's ephemeral card: cards only, one person per
 * call, both the bot and that person in the group; it cannot be a reply or open a topic).
 */
export async function sendEphemeral(chatId: string, person: string, card: Record<string, unknown>, bot?: string | null): Promise<{ messageId: string }> {
  const r = await larkClientFor(bot).request({ method: "POST", url: "/open-apis/ephemeral/v1/send", data: { chat_id: chatId, [idField(person)]: person, msg_type: "interactive", card: larkCardMarkdown(card) } });
  const d = check(r, "发送仅部分人可见的卡片");
  reportSent({ chatId, bot, purpose: "card" }, null, d);
  return { messageId: d?.message_id };
}

/** Buzz people about a message the bot sent (in-app urgent; they must be in its chat). */
export async function urgentLark(messageId: string, people: string[], bot?: string | null) {
  const groups = new Map<string, string[]>();
  for (const p of people) groups.set(idField(p), [...(groups.get(idField(p)) ?? []), p]);
  for (const [type, ids] of groups)
    check(await larkClientFor(bot).im.message.urgentApp({ path: { message_id: messageId }, params: { user_id_type: type as "open_id" | "user_id" }, data: { user_id_list: ids } }), "加急");
}

/** Who sees a message beyond posting it: members only (`onlyTo`), and who is buzzed (`urgent`). */
export type Delivery = { onlyTo?: { name: string; id: string }[]; urgent?: { name: string; id: string }[] };

/** Card form of any text content (members-only messages must be cards), its Markdown as Feishu renders it. */
export function asCard(content: Content): Record<string, unknown> {
  if ("card" in content) return larkCardMarkdown(content.card);
  if ("markdown" in content) return larkCardMarkdown(buildCard({ title: content.title, blocks: [{ markdown: content.markdown }, ...(content.note ? [{ note: content.note }] : [])] }));
  if ("text" in content) return larkCardMarkdown(buildCard({ blocks: [{ markdown: content.text }] }));
  throw new HttpError(400, "图片和文件不能只给部分人看");
}

/** Send with what `Delivery` asks for; returns the ids of what was posted. */
export async function deliverLark(to: Target, content: Content, d: Delivery = {}): Promise<{ messageId: string; threadId?: string; ephemeral?: string[] }> {
  if (d.onlyTo?.length) {
    const chatId = to.chatId;
    if (!chatId) throw new HttpError(400, "只给部分人看的消息要发在群里（chat_id）");
    const card = asCard(content);
    const ids: string[] = [];
    for (const p of d.onlyTo) ids.push((await sendEphemeral(chatId, p.id, card, to.bot)).messageId);
    return { messageId: ids[0], ephemeral: ids };
  }
  const sent = await sendLark(to, content);
  if (d.urgent?.length) await urgentLark(sent.messageId, d.urgent.map((p) => p.id), to.bot);
  return sent;
}

export async function updateLarkCard(messageId: string, card: Record<string, unknown>, bot?: string | null) {
  check(await larkClientFor(bot).im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(larkCardMarkdown(card)) } }), "更新卡片");
}

/** emoji_type: OnIt, DONE, THUMBSUP, OK, Get, CheckMark, CrossMark, Typing, SMILE … */
export async function reactLark(messageId: string, emoji = "OnIt", bot?: string | null) {
  const d = check(await larkClientFor(bot).im.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } }), "添加表情");
  return d?.reaction_id as string | undefined;
}
export async function unreactLark(messageId: string, reactionId: string, bot?: string | null) {
  await larkClientFor(bot).im.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } }).catch(() => {});
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff"]);
/** Upload a local file; images become image messages, everything else a file message. */
/** Keys are per app: upload with the bot that will send it. */
export async function uploadLark(path: string, bot?: string | null): Promise<Content> {
  const c = larkClientFor(bot);
  if (statSync(path).size > 30 * 1024 * 1024) throw new HttpError(400, "文件超过 30MB，飞书机器人无法直接发送");
  if (IMAGE_EXT.has(extname(path).toLowerCase())) {
    const d = check(await c.im.image.create({ data: { image_type: "message", image: createReadStream(path) } }), "上传图片");
    return { image: d?.image_key ?? d };
  }
  const ext = extname(path).slice(1).toLowerCase();
  const type = ["pdf", "doc", "xls", "ppt", "mp4", "opus"].includes(ext) ? ext : ext === "docx" ? "doc" : ext === "xlsx" ? "xls" : ext === "pptx" ? "ppt" : "stream";
  const d = check(await c.im.file.create({ data: { file_type: type, file_name: basename(path), file: createReadStream(path) } }), "上传文件");
  return { file: d?.file_key ?? d };
}

// ---- interactions ---------------------------------------------------------------

export type Interaction = {
  id: string;
  messageId: string | null;
  chatId: string | null;
  conversationId: string | null;
  runId: string | null;
  purpose: "agent" | "draft" | "model" | "ask" | "guest-approval" | "meeting-join" | "rule-script" | "command-gate" | "mention-reply";
  allowed: string[];
  payload: Record<string, unknown>;
  status: "open" | "done" | "expired";
  /** The bot that posted the card (its updates must go through the same app). */
  bot: string;
};
type IRow = { id: string; message_id: string | null; chat_id: string | null; conversation_id: string | null; run_id: string | null; purpose: string; allowed: string; payload: string; status: string; bot: string | null };
const toI = (r: IRow): Interaction => ({
  id: r.id,
  messageId: r.message_id,
  chatId: r.chat_id,
  conversationId: r.conversation_id,
  runId: r.run_id,
  purpose: r.purpose as Interaction["purpose"],
  allowed: json(r.allowed, []),
  payload: json(r.payload, {}),
  status: r.status as Interaction["status"],
  bot: r.bot ?? "main",
});

export function recordInteraction(app: App, i: Omit<Interaction, "id" | "status" | "bot"> & { bot?: string }) {
  const id = newId("ci");
  run(
    app.db,
    "insert into card_interactions(id,message_id,chat_id,conversation_id,run_id,purpose,allowed,payload,created_at,bot) values(?,?,?,?,?,?,?,?,?,?)",
    id,
    i.messageId,
    i.chatId,
    i.conversationId,
    i.runId,
    i.purpose,
    JSON.stringify(i.allowed),
    JSON.stringify(i.payload),
    now(),
    i.bot ?? currentBot(),
  );
  return id;
}
export function interactionForMessage(app: App, messageId: string): Interaction | null {
  const r = one<IRow>(app.db, "select * from card_interactions where message_id = ? order by created_at desc limit 1", messageId);
  return r ? toI(r) : null;
}
export function getInteraction(app: App, id: string): Interaction | null {
  const r = one<IRow>(app.db, "select * from card_interactions where id = ?", id);
  return r ? toI(r) : null;
}
/** A pre-registered card may be bound by its first click before the send API returns. */
export function bindInteraction(app: App, id: string, messageId: string) {
  if (!messageId || !run(app.db, "update card_interactions set message_id = ? where id = ? and (message_id is null or message_id = ?)", messageId, id, messageId).changes)
    throw new HttpError(409, "卡片与交互记录不匹配");
}
export function closeInteraction(app: App, id: string, by: string) {
  run(app.db, "update card_interactions set status = 'done', handled_at = ?, handled_by = ? where id = ?", now(), by, id);
}
export function openInteractions(app: App, conversationId: string) {
  return all<IRow>(app.db, "select * from card_interactions where conversation_id = ? and status = 'open' order by created_at desc limit 20", conversationId).map(toI);
}

/** A card action in plain words, for the agent that will handle it. */
export function describeAction(a: { tag?: string; name?: string; value?: unknown; formValue?: Record<string, unknown>; option?: string; options?: string[]; input?: string; checked?: boolean }) {
  const parts: string[] = [];
  const v = a.value && typeof a.value === "object" ? (a.value as { action?: string }).action : a.value;
  if (a.formValue && Object.keys(a.formValue).length) parts.push(`提交表单：${Object.entries(a.formValue).map(([k, val]) => `${k}=${Array.isArray(val) ? val.join(",") : String(val)}`).join("；")}`);
  else if (v !== undefined && v !== null && v !== "") parts.push(`点击按钮「${String(v)}」`);
  if (a.option) parts.push(`选择 ${a.name ?? ""}=${a.option}`);
  if (a.options?.length) parts.push(`选择 ${a.name ?? ""}=${a.options.join(",")}`);
  if (a.input) parts.push(`输入 ${a.name ?? ""}=${a.input}`);
  if (a.checked !== undefined) parts.push(`${a.checked ? "勾选" : "取消勾选"} ${a.name ?? ""}`);
  return parts.join("；") || `操作了 ${a.tag ?? "卡片"}`;
}
