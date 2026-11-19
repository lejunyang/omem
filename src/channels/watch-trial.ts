import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { audit } from "../auth/permissions.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { addMessage, type WatchBrief, type WatchDecision, type WatchRule } from "../agents/threads.ts";
import type { Content, Delivery, Target } from "./lark-send.ts";

/**
 * A watched group the handler may reply in learns what the owner wants before it speaks on its own:
 *
 * - setup: the handler drafts what the watch is for (`brief`: kinds of messages to handle, kinds to
 *   leave, what a reply must have to be worth sending) and the owner confirms or edits it on a card
 *   only they see (an ephemeral card in the group when they are in it, else their private chat).
 * - trial: replies are drafts on such a card (edit and send, or say why not). Asking for direct replies
 *   does not skip this: after `PROMOTE_AFTER` drafts in a row sent as drafted, the host asks once whether
 *   replies may go out by themselves (`wantsAuto` only changes the wording). The owner disliking a reply
 *   that went out by itself puts the group back on drafts.
 * - learning: every decision is kept on the watch (`log`); the handler and the prefilter read the latest
 *   ones, and after a few corrections the handler redrafts the brief, which goes to the owner again.
 *
 * The host only keeps the record and the cards; what to reply stays the handler's, whether to send the owner's.
 */
export const WATCH_DROP_REASONS = { "not-ours": "不该回", "owner-decides": "该我来定", wrong: "结论不对或没依据", useless: "没帮上忙", self: "我自己回" } as const;
type DropReason = keyof typeof WATCH_DROP_REASONS;
/** Drafts in a row sent unchanged before the host asks about direct replies. */
export const PROMOTE_AFTER = 5;
/** Corrections (not sent, edited, disliked) since the brief before the handler is asked to redraft it. */
export const REVISE_AFTER = 3;
const LOG_MAX = 30;
const ASK_AGAIN_MS = 30 * 86400_000;

const lark = () => import("./lark-watch.ts");

function chatName(app: App, chatId: string) {
  return one<{ title: string }>(app.db, "select title from conversations where channel = 'lark-watch' and external_id = ? order by updated_at desc limit 1", chatId)?.title ?? chatId;
}
function watchConversation(app: App, chatId: string) {
  return one<{ id: string }>(app.db, "select id from conversations where channel = 'lark-watch' and external_id = ? order by updated_at desc limit 1", chatId)?.id ?? null;
}

/** The chat a run handles as a watch (its conversation is a watched group's), or null. */
export function watchedChatOfRun(app: App, runId: string | null | undefined) {
  if (!runId) return null;
  const conv = one<{ c: string | null }>(app.db, "select coalesce(json_extract(input, '$.conversationId'), json_extract(input, '$.threadId')) c from runs where id = ?", runId)?.c;
  if (!conv) return null;
  const row = one<{ channel: string; external_id: string | null }>(app.db, "select channel, external_id from conversations where id = ?", conv);
  return row?.channel === "lark-watch" && row.external_id ? row.external_id.split("#")[0] : null;
}

export async function logWatchDecision(app: App, chatId: string, d: Omit<WatchDecision, "at">) {
  const { watchRule, setWatchRule } = await lark();
  const w = watchRule(app, chatId);
  if (!w) return;
  setWatchRule(app, chatId, { ...w, log: [...(w.log ?? []), { at: now(), ...d }].slice(-LOG_MAX) });
}

/** A card only the owner sees: ephemeral in the group when they are in it, else in their private chat. */
async function ownerCard(app: App, chatId: string, card: Record<string, unknown>, purpose: "watch-brief" | "watch-draft" | "watch-promote", payload: Record<string, unknown>, runId: string | null = null) {
  const send = await import("./lark-send.ts");
  const owner = send.larkOwnerOpenId(app, "main");
  let messageId: string | undefined;
  const { ownerInChat } = await import("./lark-guest.ts");
  if (owner && (await ownerInChat(app, chatId).catch(() => false))) messageId = (await send.sendEphemeral(chatId, owner, card, null).catch(() => null))?.messageId;
  const inGroup = !!messageId;
  if (!messageId) {
    const dm = one<{ value: string }>(app.db, "select value from kv where key = 'lark_owner_chat'")?.value;
    if (!dm && !owner) throw new HttpError(400, "主机器人还不知道你是谁，没法发只给你看的卡片");
    messageId = (await send.sendLark(dm ? { chatId: dm, bot: "main", runId, purpose: "card" } : { userId: owner!, bot: "main", runId, purpose: "card" }, { card })).messageId;
  }
  send.recordInteraction(app, { messageId, chatId: inGroup ? chatId : null, conversationId: watchConversation(app, chatId), runId, purpose, allowed: owner ? [owner] : [], payload, bot: "main" });
  return { messageId, inGroup };
}

const lines = (s: unknown) => String(s ?? "").split(/\n+/).map((x) => x.replace(/^\s*[-*•\d.、）)]+\s*/, "").trim()).filter(Boolean);
const listMd = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n") || "（没写）";

function replyMode(w: WatchRule) {
  if (w.reply === "none") return "只看不回";
  if (w.reply === "auto") return "直接回复";
  return w.wantsAuto ? `试运行：回复先给你看，连续 ${PROMOTE_AFTER} 条照发后问你要不要直接发` : "回复先给你看";
}

/** The brief as the handler and the prefilter read it. */
export function briefText(w: WatchRule) {
  const b = w.brief;
  if (!b) return "";
  return [
    `盯群说明（${b.confirmedAt ? "本人确认过" : "本人还没确认，先照它做，回复只发草稿"}）：`,
    `- 要处理：${b.handle.join("；") || "（没写）"}`,
    `- 不处理：${b.skip.join("；") || "（没写）"}`,
    `- 值得回复的结论：${b.valid}`,
  ].join("\n");
}

/** The owner's latest decisions on this group's replies, newest last, for the handler and the prefilter. */
export function lessonsText(w: WatchRule, limit = 10) {
  const log = (w.log ?? []).slice(-limit);
  if (!log.length) return "";
  const said = (d: WatchDecision) => {
    const to = d.ask ? `回 ${truncate(d.ask, 60)}` : "";
    const draft = truncate(d.draft ?? d.final ?? "", 120);
    if (d.decision === "dropped") return `不发（${d.reason ? WATCH_DROP_REASONS[d.reason as DropReason] ?? d.reason : "没说原因"}）${to}：${draft}`;
    if (d.decision === "edited") return `改了再发${to}：原稿「${truncate(d.draft ?? "", 80)}」→ 发出「${truncate(d.final ?? "", 80)}」`;
    if (d.decision === "disliked") return `本人不满意这条自动回复${to}：${draft}`;
    if (d.decision === "auto") return `自动发出${to}：${draft}`;
    return `照发${to}：${draft}`;
  };
  return `本人最近对这个群的回复的决定（旧的在前）：\n${log.map((d) => `- ${d.at.slice(5, 16).replace("T", " ")} ${said(d)}`).join("\n")}`;
}

/** Corrections since the brief was written: enough of them and the handler is asked to redraft it. */
export function correctionsSinceBrief(w: WatchRule) {
  const since = w.brief?.at ?? "";
  return (w.log ?? []).filter((d) => d.at > since && (d.decision === "dropped" || d.decision === "edited" || d.decision === "disliked")).length;
}

function briefCardSpec(name: string, w: WatchRule, revised: boolean) {
  const b = w.brief!;
  return {
    title: revised ? `盯「${name}」的说明按你最近的决定改了` : `盯「${name}」之前跟你对一下`,
    color: "orange",
    blocks: [
      { markdown: `${w.note ? `你说的：${truncate(w.note, 300)}\n` : ""}回复方式：${replyMode(w)}。下面是我打算怎么盯，可以直接改，每行一条。` },
      {
        form: {
          name: "watch_brief",
          fields: [
            { type: "input" as const, name: "handle", label: "要处理哪些消息", multiline: true, default: b.handle.join("\n").slice(0, 1500) },
            { type: "input" as const, name: "skip", label: "哪些不处理", multiline: true, default: b.skip.join("\n").slice(0, 1500) },
            { type: "input" as const, name: "valid", label: "什么样的结论才值得发出来", multiline: true, default: b.valid.slice(0, 1000) },
          ],
          submit: "按这个盯",
        },
      },
      { buttons: [{ text: "不盯了", value: "stop" }] },
      { note: "只有你能看到这张卡片。确认之前回复都只发草稿给你。" },
    ],
  };
}

/** Send the brief to the owner to confirm (a new watch, or the handler redrafted it). */
export async function askBrief(app: App, chatId: string, revised: boolean) {
  const { watchRule } = await lark();
  const w = watchRule(app, chatId);
  if (!w?.brief) return null;
  const { buildCard } = await import("./lark-send.ts");
  return ownerCard(app, chatId, buildCard(briefCardSpec(chatName(app, chatId), w, revised) as never), "watch-brief", { chatId, at: w.brief.at });
}

/** The owner confirmed (maybe edited) the brief, or stopped the watch. Returns the card to show instead. */
export async function decideBrief(app: App, p: { chatId: string; at: string }, act: string, form: Record<string, unknown> | null, by: string) {
  const { buildCard, decidedBlocks } = await import("./lark-send.ts");
  const { watchRule, setWatchRule } = await lark();
  const name = chatName(app, p.chatId);
  const decided = { by, at: now(), timeZone: app.config.timezone };
  const w = watchRule(app, p.chatId);
  if (!w) return buildCard({ title: `已经不盯「${name}」了`, color: "grey", blocks: decidedBlocks({ ...decided, verdict: "这张卡片过期了" }) });
  if (act === "stop") {
    setWatchRule(app, p.chatId, null);
    audit(app, OWNER, "lark.watch.stop", p.chatId, {});
    return buildCard({ title: `不再盯「${name}」`, color: "grey", blocks: decidedBlocks({ ...decided, verdict: "不盯了" }) });
  }
  if (!form) throw new HttpError(400, "没有收到填写的内容");
  const brief: WatchBrief = {
    handle: lines(form.handle).length ? lines(form.handle) : w.brief?.handle ?? [],
    skip: lines(form.skip),
    valid: String(form.valid ?? "").trim() || w.brief?.valid || "",
    at: w.brief?.at ?? now(),
    confirmedAt: now(),
  };
  setWatchRule(app, p.chatId, { ...w, brief });
  const conv = watchConversation(app, p.chatId);
  if (conv) addMessage(app, conv, "user", `（本人确认了盯群说明）\n${briefText({ ...w, brief })}`, null, { command: true });
  return buildCard({
    title: `按这个盯「${name}」`,
    color: "green",
    blocks: [{ markdown: `**要处理**\n${listMd(brief.handle)}\n**不处理**\n${listMd(brief.skip)}\n**值得发的结论**：${brief.valid}\n回复方式：${replyMode(w)}` }, ...decidedBlocks({ ...decided, verdict: "确认" })],
  });
}

export type WatchDraft = { chatId: string; runId: string | null; target: Target; content: Content; delivery?: Delivery; draft: string; ask?: string };

const textOf = (c: Content) => ("markdown" in c ? c.markdown : "text" in c ? c.text : "post" in c ? c.post.markdown : "");
function withText(c: Content, text: string): Content {
  if ("post" in c) return { post: { ...c.post, markdown: text } };
  if ("markdown" in c) return { ...c, markdown: text };
  return { text };
}

/** What a reply answers: the group message it replies to, as “who：what”. */
function askOf(app: App, chatId: string, replyTo: string | undefined) {
  if (!replyTo) return undefined;
  const conv = watchConversation(app, chatId);
  const m = conv ? one<{ text: string; meta: string }>(app.db, "select text, meta from messages where conversation_id = ? and json_extract(meta, '$.externalId') = ? limit 1", conv, replyTo) : undefined;
  if (!m) return undefined;
  const who = String(json<{ speaker?: string }>(m.meta, {}).speaker ?? "");
  return `${who ? `${who}：` : ""}${truncate(m.text.replace(/\n（飞书消息[\s\S]*$/, "").replace(/\s+/g, " "), 200)}`;
}

/** A reply the handler of a watched group wants to post, as a draft card for the owner. Text replies only. */
export async function draftWatchReply(app: App, d: Omit<WatchDraft, "draft" | "ask">) {
  const text = textOf(d.content);
  const ask = askOf(app, d.chatId, d.target.replyTo);
  const { watchRule } = await lark();
  const w = watchRule(app, d.chatId);
  const sentInRow = streak(w);
  const { buildCard } = await import("./lark-send.ts");
  const card = buildCard({
    title: `在「${chatName(app, d.chatId)}」回复吗？`,
    color: "orange",
    blocks: [
      { markdown: ask ? `回复 ${ask}` : "发到群里" },
      { form: { name: "watch_reply", fields: [{ type: "input" as const, name: "reply", label: "回复内容（可以直接改）", multiline: true, default: text.slice(0, 2000) }], submit: "发送" } },
      { buttons: (Object.keys(WATCH_DROP_REASONS) as DropReason[]).map((r) => ({ text: r === "self" ? WATCH_DROP_REASONS[r] : `不发：${WATCH_DROP_REASONS[r]}`, value: `drop:${r}` })) },
      { note: `只有你能看到这张卡片。${w?.wantsAuto ? `连续照发 ${PROMOTE_AFTER} 条后会问你要不要直接发（现在 ${sentInRow} 条）。` : ""}` },
    ],
  });
  const payload: WatchDraft = { ...d, draft: text, ask };
  await ownerCard(app, d.chatId, card, "watch-draft", payload as never, d.runId);
}

/** Drafts sent unchanged since the last correction or the last time the owner was asked. */
function streak(w: WatchRule | null) {
  if (!w) return 0;
  let n = 0;
  for (const d of [...(w.log ?? [])].reverse()) {
    if (w.promoteAskedAt && d.at <= w.promoteAskedAt) break;
    if (d.decision === "sent") n++;
    else if (d.decision !== "auto") break;
  }
  return n;
}

/** The owner answered a draft card. Returns the card to show instead. */
export async function decideWatchDraft(app: App, p: WatchDraft, act: string, edited: string | null, by: string) {
  const { buildCard, decidedBlocks, deliverLark } = await import("./lark-send.ts");
  const decided = { by, at: now(), timeZone: app.config.timezone };
  const conv = watchConversation(app, p.chatId);
  const dropped = act === "drop" || act.startsWith("drop:");
  const text = (edited ?? p.draft).trim();
  if (dropped || !text) {
    const reason = act.slice(5) || undefined;
    await logWatchDecision(app, p.chatId, { decision: "dropped", reason, ask: p.ask, draft: p.draft });
    const why = reason && reason in WATCH_DROP_REASONS ? WATCH_DROP_REASONS[reason as DropReason] : "";
    if (conv) addMessage(app, conv, "user", `（本人没发这条草稿${why ? `：${why}` : ""}）\n${truncate(p.draft, 400)}`, null, { command: true });
    return buildCard({ title: "没有发", color: "grey", blocks: [{ markdown: truncate(p.draft, 1500) }, ...decidedBlocks({ ...decided, verdict: why ? `决定不发（${why}）` : "决定不发" })] });
  }
  const unchanged = text === p.draft.trim();
  await deliverLark({ ...p.target, runId: p.runId, conversationId: conv }, unchanged ? p.content : withText(p.content, text), p.delivery);
  await logWatchDecision(app, p.chatId, { decision: unchanged ? "sent" : "edited", ask: p.ask, draft: p.draft, ...(unchanged ? {} : { final: text }) });
  if (conv) addMessage(app, conv, "user", unchanged ? "（本人确认，草稿已发出）" : `（本人改过后发出）\n${truncate(text, 400)}`, null, { command: true });
  if (unchanged) await maybeAskPromotion(app, p.chatId).catch((e) => console.warn(`[omem] 盯群回复升档询问失败：${(e as Error).message}`));
  return buildCard({ title: "已发送", color: "green", blocks: [{ markdown: truncate(text, 1500) }, ...decidedBlocks({ ...decided, verdict: unchanged ? "确认发送" : "改过后发送" })] });
}

/** Enough drafts sent as they were: ask once whether this group's replies may go out by themselves. */
export async function maybeAskPromotion(app: App, chatId: string) {
  const { watchRule, setWatchRule } = await lark();
  const w = watchRule(app, chatId);
  if (!w || w.reply !== "draft" || streak(w) < PROMOTE_AFTER) return false;
  if (!w.wantsAuto && w.promoteAskedAt && Date.now() - Date.parse(w.promoteAskedAt) < ASK_AGAIN_MS) return false;
  setWatchRule(app, chatId, { ...w, promoteAskedAt: now() });
  const { buildCard } = await import("./lark-send.ts");
  const card = buildCard({
    title: `「${chatName(app, chatId)}」的回复以后直接发吗？`,
    color: "blue",
    blocks: [
      { markdown: `最近 ${PROMOTE_AFTER} 条草稿你都照发了。直接发以后，回复不再先给你看；你对哪条自动回复点了不满意的表情，这个群就改回先给你看。` },
      { buttons: [{ text: "以后直接发", value: "auto", style: "primary" }, { text: "还是先给我看", value: "draft" }] },
      { note: "只有你能看到这张卡片" },
    ],
  });
  await ownerCard(app, chatId, card, "watch-promote", { chatId });
  return true;
}

export async function decidePromotion(app: App, p: { chatId: string }, act: string, by: string) {
  const { buildCard, decidedBlocks } = await import("./lark-send.ts");
  const { watchRule, setWatchRule } = await lark();
  const w = watchRule(app, p.chatId);
  const decided = { by, at: now(), timeZone: app.config.timezone };
  const name = chatName(app, p.chatId);
  if (!w) return buildCard({ title: `已经不盯「${name}」了`, color: "grey", blocks: decidedBlocks({ ...decided, verdict: "这张卡片过期了" }) });
  const auto = act === "auto";
  setWatchRule(app, p.chatId, { ...w, reply: auto ? "auto" : "draft", wantsAuto: false, promoteAskedAt: now() });
  audit(app, OWNER, "lark.watch.reply", p.chatId, { reply: auto ? "auto" : "draft" });
  return buildCard({ title: auto ? `「${name}」的回复以后直接发` : `「${name}」的回复还是先给你看`, color: auto ? "green" : "grey", blocks: decidedBlocks({ ...decided, verdict: auto ? "以后直接发" : "还是先给我看" }) });
}

/** The owner disliked a message the bot posted: if a watch posted it by itself, that group goes back to drafts. */
export async function dislikedWatchReply(app: App, messageId: string) {
  const { setWatchRule } = await lark();
  const rows = all<{ chat_id: string; settings: string }>(app.db, "select chat_id, settings from chat_settings where channel = 'lark-watch' and instr(settings, ?) > 0", messageId);
  for (const r of rows) {
    const w = json<{ watch?: WatchRule }>(r.settings, {}).watch;
    const posted = w?.log?.find((d) => d.messageId === messageId && d.decision === "auto");
    if (!w || !posted) continue;
    const back = w.reply === "auto";
    setWatchRule(app, r.chat_id, { ...w, reply: back ? "draft" : w.reply, promoteAskedAt: now(), log: [...(w.log ?? []), { at: now(), decision: "disliked" as const, ask: posted.ask, final: posted.final, messageId }].slice(-LOG_MAX) });
    if (back) {
      audit(app, OWNER, "lark.watch.reply", r.chat_id, { reply: "draft", messageId });
      notify(app, { title: `「${chatName(app, r.chat_id)}」的回复改回先给你看`, body: `你对一条自动发出的回复表示了不满意：${truncate(posted.final ?? "", 200)}\n之后的回复先作为草稿给你，草稿卡片上可以选为什么不发。`, urgency: "later" });
    }
  }
}

/** A reply a watch posted by itself, kept for the dislike above and for the handler's record. */
export async function noteAutoReply(app: App, chatId: string, messageId: string, content: Content, replyTo?: string) {
  await logWatchDecision(app, chatId, { decision: "auto", ask: askOf(app, chatId, replyTo), final: textOf(content) || "（卡片或文件）", messageId });
}
