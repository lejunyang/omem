import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { audit } from "../auth/permissions.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import { addMessage, type WatchBrief } from "../agents/threads.ts";
import type { Content, Delivery, Target } from "./lark-send.ts";
import { contextOfConversation, getContext, requireContext, saveContext, type ListenContext } from "./listen.ts";

/**
 * A 关注 that may reply in its groups learns what the owner wants before it speaks on its own:
 *
 * - setup: the handler drafts what the 关注 is for (`brief`: kinds of messages to handle, kinds to leave,
 *   what a reply must have to be worth sending) and the owner confirms or edits it on a card only they
 *   see (an ephemeral card in the group when they are in it, else their private chat).
 * - trial: replies are drafts on such a card (edit and send, or say why not). Asking for direct replies
 *   does not skip this: after `promoteAfter` drafts in a row sent as drafted the host asks once whether
 *   replies may go out by themselves. The owner disliking a reply that went out by itself puts the 关注
 *   back on drafts.
 * - learning: every decision is a case (reply_samples with `context_id`); the handler and the screening
 *   read the latest ones, listen-coach files them into scenes, and after a few corrections the handler
 *   redrafts the brief, which goes to the owner again.
 *
 * The host only keeps the record and the cards; what to reply stays the handler's, whether to send the owner's.
 */
export const WATCH_DROP_REASONS = { "not-ours": "不该回", "owner-decides": "该我来定", wrong: "结论不对或没依据", useless: "没帮上忙", self: "我自己回" } as const;
type DropReason = keyof typeof WATCH_DROP_REASONS;
/** Corrections (not sent, edited, disliked, marked wrong on the web) since the brief before the handler is asked to redraft it. */
export const REVISE_AFTER = 3;
const ASK_AGAIN_MS = 30 * 86400_000;

type CaseRow = { id: string; decision: string | null; reason: string | null; ask: string; asker_name: string; draft: string | null; final: string | null; owner_reply: string | null; verdict: string | null; note: string | null; scene: string | null; created_at: string; decided_at: string | null; reply_id: string | null };

const caseSource = (c: ListenContext) => (c.kind === "item" ? "item" : c.kind === "default" ? "mention" : "watch");

/** A case of this 关注 (reply_samples): what was asked, what the assistant drafted or posted. */
export function recordCase(app: App, c: ListenContext, x: { chatId: string; chatName: string; runId: string | null; asker?: string; ask: string; replyTo?: string; draft?: string; decision?: "auto" | "quiet"; final?: string; replyId?: string; reason?: string }) {
  const id = newId("rs");
  const at = now();
  run(
    app.db,
    `insert into reply_samples(id,handle_run,channel,chat_id,chat_kind,chat_name,asker_name,ask,message_ids,last_ms,draft,decision,final,reason,decided_at,created_at,context_id,source,reply_id)
     values(?,?,'lark',?,'group',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, x.runId, x.chatId, x.chatName, x.asker ?? "", x.ask, JSON.stringify(x.replyTo ? [x.replyTo] : []), Date.now(), x.draft ?? null,
    x.decision ?? null, x.final ?? null, x.reason ?? null, x.decision ? at : null, at, c.id, caseSource(c), x.replyId ?? null,
  );
  return id;
}

function decideCase(app: App, id: string, decision: "sent" | "edited" | "dropped" | "disliked", patch: { final?: string | null; reason?: string | null; replyId?: string | null } = {}) {
  run(app.db, "update reply_samples set decision = ?, final = coalesce(?, final), reason = coalesce(?, reason), reply_id = coalesce(?, reply_id), decided_at = ? where id = ?", decision, patch.final ?? null, patch.reason ?? null, patch.replyId ?? null, now(), id);
}

const casesOf = (app: App, c: ListenContext, limit: number) =>
  all<CaseRow>(app.db, "select id, decision, reason, ask, asker_name, draft, final, owner_reply, verdict, note, scene, created_at, decided_at, reply_id from reply_samples where context_id = ? order by created_at desc limit ?", c.id, limit);

/** The 关注 a run handles (its conversation is a 关注's), or null. */
export function contextOfRun(app: App, runId: string | null | undefined): ListenContext | null {
  if (!runId) return null;
  const conv = one<{ c: string | null }>(app.db, "select coalesce(json_extract(input, '$.conversationId'), json_extract(input, '$.threadId')) c from runs where id = ?", runId)?.c;
  return contextOfConversation(app, conv);
}

function chatName(app: App, chatId: string) {
  return one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null limit 1", `lark:${chatId}`)?.title
    ?? one<{ name: string }>(app.db, "select name from lark_cursors where chat_id = ?", chatId)?.name ?? chatId;
}

/** A card only the owner sees: ephemeral in that group when they are in it, else in their private chat. */
async function ownerCard(app: App, chatId: string | null, card: Record<string, unknown>, purpose: "watch-brief" | "watch-draft" | "watch-promote", payload: Record<string, unknown>, conversationId: string | null, runId: string | null = null) {
  const send = await import("./lark-send.ts");
  const owner = send.larkOwnerOpenId(app, "main");
  let messageId: string | undefined;
  const { ownerInChat } = await import("./lark-guest.ts");
  if (owner && chatId && (await ownerInChat(app, chatId).catch(() => false))) messageId = (await send.sendEphemeral(chatId, owner, card, null).catch(() => null))?.messageId;
  const inGroup = !!messageId;
  if (!messageId) {
    const dm = one<{ value: string }>(app.db, "select value from kv where key = 'lark_owner_chat'")?.value;
    if (!dm && !owner) throw new HttpError(400, "主机器人还不知道你是谁，没法发只给你看的卡片");
    messageId = (await send.sendLark(dm ? { chatId: dm, bot: "main", runId, purpose: "card" } : { userId: owner!, bot: "main", runId, purpose: "card" }, { card })).messageId;
  }
  send.recordInteraction(app, { messageId, chatId: inGroup ? chatId : null, conversationId, runId, purpose, allowed: owner ? [owner] : [], payload, bot: "main" });
  return { messageId, inGroup };
}

const lines = (s: unknown) => String(s ?? "").split(/\n+/).map((x) => x.replace(/^\s*[-*•\d.、）)]+\s*/, "").trim()).filter(Boolean);
const listMd = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n") || "（没写）";

function replyMode(c: ListenContext) {
  const k = c.knobs;
  if (k.reply === "none") return "只看不回";
  if (k.reply === "auto") return "直接回复";
  return k.wantsAuto ? `试运行：回复先给你看，连续 ${k.promoteAfter} 条照发后问你要不要直接发` : "回复先给你看";
}

/** The brief as the handler and the screening read it. */
export function briefText(c: Pick<ListenContext, "brief">) {
  const b = c.brief;
  if (!b) return "";
  return [
    `关注说明（${b.confirmedAt ? "本人确认过" : "本人还没确认，先照它做，回复只发草稿"}）：`,
    `- 要处理：${b.handle.join("；") || "（没写）"}`,
    `- 不处理：${b.skip.join("；") || "（没写）"}`,
    `- 值得回复的结论：${b.valid}`,
  ].join("\n");
}

/** The owner's latest decisions on this 关注's replies, newest last, for the handler and the screening. */
export function lessonsText(app: App, c: ListenContext, limit = 10) {
  const rows = casesOf(app, c, limit).filter((d) => d.decision || d.owner_reply || d.verdict).reverse();
  if (!rows.length) return "";
  const said = (d: CaseRow) => {
    const to = d.ask ? `回 ${truncate(`${d.asker_name ? `${d.asker_name}：` : ""}${d.ask}`, 60)}` : "";
    const draft = truncate(d.draft ?? d.final ?? "", 120);
    const verdict = d.verdict ? `；本人后来标了“${VERDICTS[d.verdict as Verdict] ?? d.verdict}”${d.note ? `：${truncate(d.note, 80)}` : ""}` : "";
    const own = d.owner_reply ? `；本人自己回了：${truncate(d.owner_reply, 100)}` : "";
    if (d.decision === "dropped") return `不发（${d.reason ? WATCH_DROP_REASONS[d.reason as DropReason] ?? d.reason : "没说原因"}）${to}：${draft}${own}${verdict}`;
    if (d.decision === "edited") return `改了再发${to}：原稿「${truncate(d.draft ?? "", 80)}」→ 发出「${truncate(d.final ?? "", 80)}」${verdict}`;
    if (d.decision === "disliked") return `本人不满意这条自动回复${to}：${draft}${verdict}`;
    if (d.decision === "auto") return `自动发出${to}：${draft}${verdict}`;
    if (d.decision === "quiet") return `没回${to}（${d.reason ?? "没说原因"}）${own}${verdict}`;
    if (d.decision === "sent") return `照发${to}：${draft}${verdict}`;
    return `${to}${own}${verdict}`;
  };
  return `本人最近对这里的回复的决定（旧的在前）：\n${rows.map((d) => `- ${(d.decided_at ?? d.created_at).slice(5, 16).replace("T", " ")} ${said(d)}`).join("\n")}`;
}

export const VERDICTS = { "should-reply": "该回", "should-not": "不该回", wrong: "回得不对" } as const;
export type Verdict = keyof typeof VERDICTS;

/** Corrections since the brief was written: enough of them and the handler is asked to redraft it. */
export function correctionsSinceBrief(app: App, c: ListenContext) {
  const since = c.brief?.at ?? "";
  return one<{ n: number }>(app.db, "select count(*) n from reply_samples where context_id = ? and coalesce(decided_at, created_at) > ? and (decision in ('dropped','edited','disliked') or verdict is not null)", c.id, since)?.n ?? 0;
}

/** The lessons listen-coach wrote for this 关注 (a work file), for the handler and the screening. */
export async function playbookText(app: App, c: ListenContext, _about = "", max = 4000) {
  const { playbookPath } = await import("./listen-cases.ts");
  const row = one<{ text: string }>(app.db, "select text from sources where uri = ? and deleted_at is null order by captured_at desc limit 1", `work/${playbookPath(c)}`);
  return row ? truncate(row.text.trim(), max) : "";
}

function briefCardSpec(c: ListenContext, revised: boolean) {
  const b = c.brief!;
  return {
    title: revised ? `关注「${c.name}」的说明按你最近的决定改了` : `关注「${c.name}」之前跟你对一下`,
    color: "orange",
    blocks: [
      { markdown: `${c.note ? `你说的：${truncate(c.note, 300)}\n` : ""}回复方式：${replyMode(c)}。下面是我打算怎么做，可以直接改，每行一条。` },
      {
        form: {
          name: "watch_brief",
          fields: [
            { type: "input" as const, name: "handle", label: "要处理哪些消息", multiline: true, default: b.handle.join("\n").slice(0, 1500) },
            { type: "input" as const, name: "skip", label: "哪些不处理", multiline: true, default: b.skip.join("\n").slice(0, 1500) },
            { type: "input" as const, name: "valid", label: "什么样的结论才值得发出来", multiline: true, default: b.valid.slice(0, 1000) },
          ],
          submit: "按这个来",
        },
      },
      { buttons: [{ text: "不关注了", value: "stop" }] },
      { note: "只有你能看到这张卡片。确认之前回复都只发草稿给你。在 连接 → 飞书会话 里可以改更多设置。" },
    ],
  };
}

/** Send the brief to the owner to confirm (a new 关注, or the handler redrafted it). */
export async function askBrief(app: App, contextId: string, revised: boolean) {
  const c = getContext(app, contextId);
  if (!c?.brief) return null;
  const { buildCard } = await import("./lark-send.ts");
  return ownerCard(app, c.chats[0] ?? null, buildCard(briefCardSpec(c, revised) as never), "watch-brief", { contextId, at: c.brief.at }, c.conversationId);
}

/** The owner confirmed (maybe edited) the brief, or stopped the 关注. Returns the card to show instead. */
export async function decideBrief(app: App, p: { contextId: string; at: string }, act: string, form: Record<string, unknown> | null, by: string) {
  const { buildCard, decidedBlocks } = await import("./lark-send.ts");
  const decided = { by, at: now(), timeZone: app.config.timezone };
  const c = getContext(app, p.contextId);
  if (!c || c.status !== "active") return buildCard({ title: "已经不关注了", color: "grey", blocks: decidedBlocks({ ...decided, verdict: "这张卡片过期了" }) });
  if (act === "stop") {
    saveContext(app, { id: c.id, kind: c.kind, status: "paused" });
    audit(app, OWNER, "lark.watch.stop", c.id, {});
    return buildCard({ title: `不再关注「${c.name}」`, color: "grey", blocks: decidedBlocks({ ...decided, verdict: "不关注了" }) });
  }
  if (!form) throw new HttpError(400, "没有收到填写的内容");
  const brief: WatchBrief = {
    handle: lines(form.handle).length ? lines(form.handle) : c.brief?.handle ?? [],
    skip: lines(form.skip),
    valid: String(form.valid ?? "").trim() || c.brief?.valid || "",
    at: c.brief?.at ?? now(),
    confirmedAt: now(),
  };
  const next = saveContext(app, { id: c.id, kind: c.kind, brief });
  if (c.conversationId) addMessage(app, c.conversationId, "user", `（本人确认了关注说明）\n${briefText(next)}`, null, { command: true });
  return buildCard({
    title: `按这个关注「${c.name}」`,
    color: "green",
    blocks: [{ markdown: `**要处理**\n${listMd(brief.handle)}\n**不处理**\n${listMd(brief.skip)}\n**值得发的结论**：${brief.valid}\n回复方式：${replyMode(next)}` }, ...decidedBlocks({ ...decided, verdict: "确认" })],
  });
}

export type WatchDraft = { contextId: string; caseId: string; chatId: string; runId: string | null; target: Target; content: Content; delivery?: Delivery; draft: string; ask?: string };

const textOf = (c: Content) => ("markdown" in c ? c.markdown : "text" in c ? c.text : "post" in c ? c.post.markdown : "");
function withText(c: Content, text: string): Content {
  if ("post" in c) return { post: { ...c.post, markdown: text } };
  if ("markdown" in c) return { ...c, markdown: text };
  return { text };
}

/** What a reply answers: the group message it replies to, its speaker and text, and how it was marked. */
export function askOf(app: App, c: ListenContext, replyTo: string | undefined) {
  if (!replyTo || !c.conversationId) return undefined;
  const m = one<{ text: string; meta: string }>(app.db, "select text, meta from messages where conversation_id = ? and json_extract(meta, '$.externalId') = ? limit 1", c.conversationId, replyTo);
  if (!m) return undefined;
  const meta = json<{ speaker?: string; toOwner?: boolean; lead?: string; leadName?: string }>(m.meta, {});
  return { who: String(meta.speaker ?? ""), text: truncate(m.text.replace(/\n（飞书消息[\s\S]*$/, "").replace(/\s+/g, " "), 200), toOwner: !!meta.toOwner, lead: meta.lead, leadName: meta.leadName };
}

/**
 * Before a 关注's handler posts in a group: another 关注 leads on that message (the most specific one that
 * replies), or replied to it already. Returns why not, or null to go on; claims the message otherwise.
 */
export function claimReply(app: App, c: ListenContext, replyTo: string | undefined) {
  if (!replyTo) return null;
  const a = askOf(app, c, replyTo);
  if (a?.lead && a.lead !== c.id && getContext(app, a.lead)?.status === "active") return `这条消息由关注「${a.leadName ?? a.lead}」负责回复，你这里不用在群里再回；有它没有的发现，用 notify 告诉本人`;
  const held = one<{ rule: string }>(app.db, "select rule from handled_messages where channel = 'listen-reply' and message_id = ?", replyTo);
  if (held && held.rule !== c.id) return `关注「${getContext(app, held.rule)?.name ?? held.rule}」已经回了这条消息，不用再回`;
  run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values('listen-reply',?,?,?)", replyTo, c.id, now());
  return null;
}

/** The reply goes as a draft whatever the mode: the 关注 is on drafts, or it answers something put to the owner and `ownerAsks` says draft. */
export function mustDraft(app: App, c: ListenContext, replyTo: string | undefined) {
  if (c.knobs.reply !== "auto") return true;
  return c.knobs.ownerAsks === "draft" && !!askOf(app, c, replyTo)?.toOwner;
}

/** A reply the handler of a 关注 wants to post, as a draft card for the owner. Text replies only. */
export async function draftWatchReply(app: App, d: { contextId: string; chatId: string; runId: string | null; target: Target; content: Content; delivery?: Delivery }) {
  const c = requireContext(app, d.contextId);
  const text = textOf(d.content);
  const a = askOf(app, c, d.target.replyTo);
  const ask = a ? `${a.who ? `${a.who}：` : ""}${a.text}` : undefined;
  const caseId = recordCase(app, c, { chatId: d.chatId, chatName: chatName(app, d.chatId), runId: d.runId, asker: a?.who, ask: a?.text ?? "", replyTo: d.target.replyTo, draft: text });
  const sentInRow = streak(app, c);
  const { buildCard } = await import("./lark-send.ts");
  const card = buildCard({
    title: `在「${chatName(app, d.chatId)}」回复吗？`,
    color: "orange",
    blocks: [
      { markdown: ask ? `回复 ${ask}` : "发到群里" },
      { form: { name: "watch_reply", fields: [{ type: "input" as const, name: "reply", label: "回复内容（可以直接改）", multiline: true, default: text.slice(0, 2000) }], submit: "发送" } },
      { buttons: (Object.keys(WATCH_DROP_REASONS) as DropReason[]).map((r) => ({ text: r === "self" ? WATCH_DROP_REASONS[r] : `不发：${WATCH_DROP_REASONS[r]}`, value: `drop:${r}` })) },
      { note: `只有你能看到这张卡片（关注「${c.name}」）。${c.knobs.wantsAuto ? `连续照发 ${c.knobs.promoteAfter} 条后会问你要不要直接发（现在 ${sentInRow} 条）。` : ""}` },
    ],
  });
  const payload: WatchDraft = { ...d, caseId, draft: text, ask };
  await ownerCard(app, d.chatId, card, "watch-draft", payload as never, c.conversationId, d.runId);
}

/** Drafts sent unchanged since the last correction or the last time the owner was asked. */
function streak(app: App, c: ListenContext) {
  let n = 0;
  for (const d of casesOf(app, c, 50)) {
    if (c.knobs.promoteAskedAt && (d.decided_at ?? d.created_at) <= c.knobs.promoteAskedAt) break;
    if (d.decision === "sent") n++;
    else if (d.decision && d.decision !== "auto" && d.decision !== "quiet") break;
  }
  return n;
}

/** The owner answered a draft card. Returns the card to show instead. */
export async function decideWatchDraft(app: App, p: WatchDraft, act: string, edited: string | null, by: string) {
  const { buildCard, decidedBlocks, deliverLark } = await import("./lark-send.ts");
  const decided = { by, at: now(), timeZone: app.config.timezone };
  const c = getContext(app, p.contextId);
  const conv = c?.conversationId ?? null;
  const dropped = act === "drop" || act.startsWith("drop:");
  const text = (edited ?? p.draft).trim();
  if (dropped || !text) {
    const reason = act.slice(5) || null;
    decideCase(app, p.caseId, "dropped", { reason });
    const why = reason && reason in WATCH_DROP_REASONS ? WATCH_DROP_REASONS[reason as DropReason] : "";
    if (conv) addMessage(app, conv, "user", `（本人没发这条草稿${why ? `：${why}` : ""}）\n${truncate(p.draft, 400)}`, null, { command: true });
    return buildCard({ title: "没有发", color: "grey", blocks: [{ markdown: truncate(p.draft, 1500) }, ...decidedBlocks({ ...decided, verdict: why ? `决定不发（${why}）` : "决定不发" })] });
  }
  const unchanged = text === p.draft.trim();
  const sent = await deliverLark({ ...p.target, runId: p.runId, conversationId: conv }, unchanged ? p.content : withText(p.content, text), p.delivery);
  decideCase(app, p.caseId, unchanged ? "sent" : "edited", { final: unchanged ? null : text, replyId: sent.messageId });
  if (conv) addMessage(app, conv, "user", unchanged ? "（本人确认，草稿已发出）" : `（本人改过后发出）\n${truncate(text, 400)}`, null, { command: true });
  if (unchanged && c) await maybeAskPromotion(app, c.id).catch((e) => console.warn(`[omem] 关注回复升档询问失败：${(e as Error).message}`));
  return buildCard({ title: "已发送", color: "green", blocks: [{ markdown: truncate(text, 1500) }, ...decidedBlocks({ ...decided, verdict: unchanged ? "确认发送" : "改过后发送" })] });
}

/** Enough drafts sent as they were: ask once whether this 关注's replies may go out by themselves. */
export async function maybeAskPromotion(app: App, contextId: string) {
  const c = getContext(app, contextId);
  if (!c || c.knobs.reply !== "draft" || streak(app, c) < c.knobs.promoteAfter) return false;
  if (!c.knobs.wantsAuto && c.knobs.promoteAskedAt && Date.now() - Date.parse(c.knobs.promoteAskedAt) < ASK_AGAIN_MS) return false;
  saveContext(app, { id: c.id, kind: c.kind, knobs: { promoteAskedAt: now() } });
  const { buildCard } = await import("./lark-send.ts");
  const card = buildCard({
    title: `关注「${c.name}」的回复以后直接发吗？`,
    color: "blue",
    blocks: [
      { markdown: `最近 ${c.knobs.promoteAfter} 条草稿你都照发了。直接发以后，回复不再先给你看；你对哪条自动回复点了不满意的表情，就改回先给你看。` },
      { buttons: [{ text: "以后直接发", value: "auto", style: "primary" }, { text: "还是先给我看", value: "draft" }] },
      { note: "只有你能看到这张卡片" },
    ],
  });
  await ownerCard(app, c.chats[0] ?? null, card, "watch-promote", { contextId: c.id }, c.conversationId);
  return true;
}

export async function decidePromotion(app: App, p: { contextId: string }, act: string, by: string) {
  const { buildCard, decidedBlocks } = await import("./lark-send.ts");
  const c = getContext(app, p.contextId);
  const decided = { by, at: now(), timeZone: app.config.timezone };
  if (!c) return buildCard({ title: "已经不关注了", color: "grey", blocks: decidedBlocks({ ...decided, verdict: "这张卡片过期了" }) });
  const auto = act === "auto";
  saveContext(app, { id: c.id, kind: c.kind, knobs: { reply: auto ? "auto" : "draft", wantsAuto: false, promoteAskedAt: now() } });
  audit(app, OWNER, "lark.watch.reply", c.id, { reply: auto ? "auto" : "draft" });
  return buildCard({ title: auto ? `「${c.name}」的回复以后直接发` : `「${c.name}」的回复还是先给你看`, color: auto ? "green" : "grey", blocks: decidedBlocks({ ...decided, verdict: auto ? "以后直接发" : "还是先给我看" }) });
}

/** The owner disliked a message the bot posted: if a 关注 posted it by itself, that 关注 goes back to drafts. */
export async function dislikedWatchReply(app: App, messageId: string) {
  const row = one<{ id: string; context_id: string | null; decision: string | null; final: string | null }>(app.db, "select id, context_id, decision, final from reply_samples where reply_id = ? and context_id is not null", messageId);
  if (!row?.context_id || row.decision !== "auto") return;
  const c = getContext(app, row.context_id);
  if (!c) return;
  decideCase(app, row.id, "disliked");
  if (c.knobs.reply !== "auto") return;
  saveContext(app, { id: c.id, kind: c.kind, knobs: { reply: "draft", promoteAskedAt: now() } });
  audit(app, OWNER, "lark.watch.reply", c.id, { reply: "draft", messageId });
  notify(app, { title: `关注「${c.name}」的回复改回先给你看`, body: `你对一条自动发出的回复表示了不满意：${truncate(row.final ?? "", 200)}\n之后的回复先作为草稿给你，草稿卡片上可以选为什么不发。`, urgency: "later" });
}

/** A reply a 关注 posted by itself, kept for the dislike above and for its cases. */
export function noteAutoReply(app: App, c: ListenContext, chatId: string, messageId: string, content: Content, replyTo?: string) {
  const a = askOf(app, c, replyTo);
  recordCase(app, c, { chatId, chatName: chatName(app, chatId), runId: null, asker: a?.who, ask: a?.text ?? "", replyTo, decision: "auto", final: textOf(content) || "（卡片或文件）", replyId: messageId });
}
