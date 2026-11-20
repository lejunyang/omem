import { decideScene, describeScene } from "../core/decision-log.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";
import { receive } from "../agents/inbox.ts";
import { rulesNaming } from "../rules/store.ts";
import { ownerContextParts } from "../agents/owner-now.ts";
import { chatListened, contextOfConversation, contextsOfChat, expireContexts, LISTEN_CHANNEL, listContexts, type ListenContext } from "./listen.ts";
import { briefText, lessonsText } from "./watch-trial.ts";
import { followProblemMessages, problemsText } from "./listen-problems.ts";

/**
 * Feishu messages of the groups 「关注」 read (channels/listen.ts). Messages arrive from the bot (real
 * time, when the bot is in the group) or from the owner's capture (polling, any chat the owner is in).
 * Each message is handled once, and handed to every 关注 the group is in (its own conversation, batched by
 * that 关注's window; a message that @s the owner or the bot shortens it). When several got it, the most
 * specific one that may reply is its `lead`: the others read it and only that one answers in the group.
 */
export { DEFAULT_BATCH_MINUTES } from "./listen.ts";

/** A message that @s the owner or the bot is looked at within this, whatever the batch window. */
const MENTION_MS = 30_000;

export type ChatMessage = { id: string; time: string; sender: string; senderId?: string; text: string; topicId?: string; mentions?: string[] };

type Who = { ownerOpenId?: string; botOpenId?: string | null; ownerName?: string };

function mentioned(m: ChatMessage, who: Who) {
  const ids = m.mentions ?? [];
  return (!!who.ownerOpenId && ids.includes(who.ownerOpenId)) || (!!who.botOpenId && ids.includes(who.botOpenId)) || (!!who.ownerName && m.text.includes(`@${who.ownerName}`));
}

/** When a message was sent, in ms (the bot gives ms as a string, capture may give ISO or seconds); null when unknown. */
function sentMs(t: string | undefined) {
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** Who a message is for, as the handler should read it: the owner (theirs to answer or decide), someone else, or nobody in particular. */
function addressee(m: ChatMessage, who: Who) {
  const ids = m.mentions ?? [];
  if (who.ownerOpenId && ids.includes(who.ownerOpenId)) return "，@了本人";
  if (ids.some((id) => id !== who.botOpenId)) return "，@了别人";
  return "";
}

const BACKLOG_MS = { off: 0, "24h": 24 * 3600_000, "72h": 72 * 3600_000 } as const;

/** Whether this 关注 takes the message: its listen mode and keyword, and the time it began (with its backlog). */
function takes(c: ListenContext, m: ChatMessage, who: Who, at: number | null) {
  if (at !== null && at < Date.parse(c.since) - BACKLOG_MS[c.knobs.backlog]) return false;
  if (c.knobs.listen === "addressed" && !mentioned(m, who)) return false;
  if (c.knobs.pattern) {
    try {
      if (!new RegExp(c.knobs.pattern, "i").test(m.text)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Hand new messages of a group to the 关注 reading it. Returns how many messages were handed over. */
export async function routeWatchedMessages(app: App, chatId: string, chatName: string, messages: ChatMessage[], opts: { botOpenId?: string | null; ownerId?: string } = {}) {
  // A problem 有人找你 is following here (listen-problems.ts): its follow-up looks at the new messages a while later.
  followProblemMessages(app, chatId, messages, opts);
  if (!chatListened(app, chatId)) return 0;
  await expireContexts(app);
  // A matter's 关注 that only reads is followed by flows/follow.ts (item-follow notes what changed): its
  // handler is not also run on every batch. With replies on, it reads the groups here like a place.
  const ctxs = contextsOfChat(app, chatId).filter((c) => c.kind !== "item" || c.knobs.reply !== "none");
  if (!ctxs.length) return 0;
  // Capture (lark-cli) sees people with its own ids: the owner as capture knows them.
  const who = { ownerOpenId: opts.ownerId ?? app.config.lark.ownerOpenId, botOpenId: opts.botOpenId };
  let n = 0;
  for (const m of messages) {
    // Each message once, whichever path saw it first.
    if (one(app.db, "select 1 from handled_messages where channel = 'lark' and message_id = ?", m.id)) continue;
    // Never react to our own posts (the bot's open_id in real time, its app id when captured).
    if (m.senderId && (m.senderId === opts.botOpenId || m.senderId === app.config.lark.appId)) continue;
    const at = sentMs(m.time);
    const takers = ctxs.filter((c) => takes(c, m, who, at));
    if (!takers.length) continue;
    const lead = takers.find((c) => c.knobs.reply !== "none");
    // No 关注 here replies (only reading ones): “someone looks for you” still handles what is for the owner.
    run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values('lark',?,?,?)", m.id, lead ? lead.id : `read:${takers[0].id}`, now());
    const addressed = mentioned(m, who);
    const to = addressee(m, who);
    const before = at !== null && at < Date.parse(takers[0].since);
    for (const c of takers) {
      if (!c.conversationId) continue;
      // A rule already handed this message to this 关注 (rules/actions.ts, action `context`).
      if (one(app.db, "select 1 from handled_messages where channel = ? and message_id = ?", `listen:${c.id}`, m.id)) continue;
      const batch = c.knobs.batchMinutes * 60_000;
      const others = takers.filter((x) => x.id !== c.id).map((x) => x.name);
      const r = await receive(app, {
        conversationId: c.conversationId,
        channel: LISTEN_CHANNEL,
        speaker: m.sender,
        text: `${m.text}
（飞书消息 ${m.id}${m.topicId ? `，话题 ${m.topicId}` : ""}，群「${chatName}」 ${chatId}${to}${before ? "，关注开始前发的" : ""}）`,
        externalMessageId: m.id,
        meta: {
          chatId,
          // Addressed to the owner or the bot: never screened out (prefilterBatch).
          ...(addressed ? { addressed: true } : {}),
          ...(to === "，@了本人" ? { toOwner: true } : {}),
          ...(before ? { backlog: true } : {}),
          ...(lead && lead.id !== c.id ? { lead: lead.id, leadName: lead.name } : {}),
          ...(others.length ? { alsoIn: others } : {}),
        },
        mergeMs: addressed ? Math.min(batch, MENTION_MS) : batch,
        // A busy group must not keep pushing the batch back: the window starts with its first message.
        fixedWindow: true,
      });
      if (r.runId && c.id === takers[0].id) run(app.db, "update handled_messages set run_id = ? where channel = 'lark' and message_id = ?", r.runId, m.id);
    }
    n++;
  }
  return n;
}

/**
 * A message that @s the bot is answered where it was asked (lark-bot.ts), by one run: the 关注 on the
 * chat do not take it as well. Recorded as handled, so the owner's capture seeing it later leaves it too.
 */
export function answeredDirectly(app: App, chatId: string, messageId: string) {
  if (!chatListened(app, chatId)) return false;
  run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values('lark',?,'direct',?)", messageId, now());
  return true;
}

/** What the owner wants from a group, for the run that answers someone @-ing the bot there. */
export function watchPurpose(app: App, chatId: string) {
  const ctxs = contextsOfChat(app, chatId);
  if (!ctxs.length) return "";
  const lines = ctxs.map((c) => `「${c.name}」：${c.note ?? "（没有写目的）"}${c.brief ? `\n${briefText(c)}` : ""}`);
  return `本人关注着这个群：\n${lines.join("\n")}\n这条消息 @ 了你，由你在这里回答，关注那一路不再处理它；群里别的消息仍由那一路看。`;
}

/** Rules bring omem's bot into a chat with this (lark-invite.ts, shared with `lark_invite`). */
export { inviteOwnBot } from "./lark-invite.ts";

/** Groups that a 关注 reads, for the rules page (each place 关注, by its first group). */
export function listWatches(app: App) {
  return listContexts(app, { kind: "place", activeOnly: true }).map((c) => ({
    contextId: c.id,
    chatId: c.chats[0],
    chats: c.chats,
    name: c.name,
    note: c.note,
    spec: c.spec,
    reply: c.knobs.reply,
    batchMinutes: c.knobs.batchMinutes,
    expiresAt: c.expiresAt ?? undefined,
    conversationId: c.conversationId,
  }));
}

/** Batches a 关注's handler already looked at today (screened-out ones not counted). */
function handledToday(app: App, conversationId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'ask' and lane = ? and created_at >= ? and status in ('done','running') and json_extract(output, '$.prefiltered') is null", conversationId, start.toISOString())?.n ?? 0;
}

/**
 * Before a 关注's batch goes to its handler (a full agent run), the decision model asks whether there is
 * anything an assistant can usefully step in on, given the brief, the lessons and the group: most batches
 * of a busy group end with the handler saying nothing. Only for `listen: relevant` (addressed ones are few
 * already, `all` hands everything), unless the 关注 turned screening off, and only with a decision model.
 * Messages that @ the owner or the bot always go through; so does a batch when the model fails. The day's
 * limit (`perDay`) applies whatever the mode. Returns why the batch is skipped, or null to hand it over.
 */
export async function prefilterBatch(app: App, conversationId: string, batch: { id?: string; text: string; meta: Record<string, unknown> }[], signal?: AbortSignal, log?: { ref: string; reason: (text: string) => void }): Promise<string | null> {
  const ctx = contextOfConversation(app, conversationId);
  if (!ctx) return null;
  const done = handledToday(app, conversationId);
  if (done >= ctx.knobs.perDay && !batch.some((m) => m.meta.addressed)) return `今天已经处理了 ${done} 批，到了这个关注每天的上限（${ctx.knobs.perDay}）`;
  if (ctx.knobs.listen !== "relevant" || !(ctx.knobs.prefilter ?? app.config.lark.watchPrefilter !== false)) return null;
  if (batch.some((m) => m.meta.addressed)) return null;
  const { decisionReady } = await import("../core/decision.ts");
  const batchChats = [...new Set(batch.map((m) => m.meta.chatId).filter((x): x is string => typeof x === "string"))];
  const problems = problemsText(app, ctx.id, batchChats.length ? batchChats : ctx.chats);
  if (!decisionReady(app)) return null;
  const { findThread, threadMessages } = await import("../agents/threads.ts");
  const t = findThread(app, conversationId);
  const history = threadMessages(app, conversationId, { limit: 80 });
  const inBatch = new Set(batch.map((m) => m.id).filter(Boolean));
  const before = history.filter((m) => !inBatch.has(m.id));
  const said = before.filter((m) => m.role === "assistant" && !m.meta.prefiltered).slice(-3);
  // What the owner said in this conversation (replies to its notes, instructions): no speaker of their own.
  const owner = before.filter((m) => m.role === "user" && typeof m.meta.speaker !== "string" && !m.meta.command).slice(-5);
  const group = before.filter((m) => typeof m.meta.speaker === "string").slice(-10);
  const batchText = batch.map((m) => `${String(m.meta.speaker ?? "?")}：${m.text.slice(0, 600)}`).join("\n");
  const { playbookText } = await import("./watch-trial.ts");
  try {
    const r = await decideScene(app, "watch", {
      关注: `${ctx.name}（${ctx.chats.length} 个群）`,
      关注的目的: ctx.note ?? "（没写）",
      关注说明: briefText(ctx) || "（没写）",
      经验: (await playbookText(app, ctx, batchText)) || "（还没有）",
      本人对回复的决定: lessonsText(app, ctx, 8) || "（还没有）",
      本人在这里的指示: owner.map((m) => m.text.slice(0, 400)).join("\n") || "（无）",
      管这些群的规则: ctx.chats.map((c) => rulesNaming(app, c, null)).filter(Boolean).join("\n") || "（无）",
      ...ownerContextParts(app, { chatId: ctx.chats[0] }),
      相关的记忆: (await memoriesFor(app, `${ctx.name} ${ctx.note ?? ""}\n${batchText}`.slice(0, 2000), ctx.spaceId ?? undefined)) || "（无）",
      之前的摘要: t?.summary || "（无）",
      最近的处理: said.map((m) => m.text.slice(0, 400)).join("\n---\n") || "（无）",
      在跟的问题: problems || "（无）",
      这一批之前的群聊: group.map((m) => `${String(m.meta.speaker)}：${m.text.slice(0, 200)}`).join("\n") || "（无）",
      这一批消息: batchText,
    }, {
      type: "yesno",
      instructions: "这是本人让助手关注的一个或几个群新来的一批消息。助手在这里的用处由关注的目的、说明和经验决定：不一定是找本人的事，也可能是替群里的人解答问题、查东西、排查报上来的问题、跟进之前处理过的事。判断这一批里有没有助手能有效介入的：有人提出新的问题或求助、要查什么、报了问题或异常、和关注的目的相关，选“要看”。对“在跟的问题”里的事，只有这一批给它带来了新东西才选“要看”：等的人回复了或说处理完了、补了信息、数据或截图、提问的人说还不行或有新现象、出现新的卡点、看起来已经解决要确认收尾；已经结了的问题有人又说没解决，也选“要看”。只是闲聊、客套、“稍等”“收到”、进度播报、系统通知、重复已知的情况，没人需要帮忙，选“不用看”。只落在说明里“不处理”那类的、本人的决定和经验里不想要的那类，选“不用看”。拿不准选“要看”。",
      yes: "要看",
      no: "不用看",
    }, { signal, ref: log?.ref });
    if (!r) return null;
    // The 关注's own strictness: the least probability that it concerns the brief for it to be looked at.
    const pYes = r.probabilities.yes;
    const look = ctx.knobs.strictness !== undefined && typeof pYes === "number" ? pYes >= ctx.knobs.strictness : r.taken === "yes";
    if (r.lowered) log?.reason(`预筛：${describeScene(r, { yes: "要看", no: "不用看" })}`);
    if (look) return null;
    return describeScene(r, { yes: "要看", no: "不用看" });
  } catch {
    return null;
  }
}

/** The owner's memories closest to the groups and the batch (instructions and lessons included), a few lines. */
export async function memoriesFor(app: App, text: string, spaceId?: string, limit = 5) {
  try {
    const { nearMemories } = await import("../memory/passive.ts");
    const hits = await nearMemories(app, { text, spaces: [...new Set(["personal", ...(spaceId ? [spaceId] : [])])], userId: "owner", threshold: app.config.memory.passive.threshold, limit });
    return hits.map(({ memory: m }) => `- ${m.subject ? `${m.subject}：` : ""}${m.content.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  } catch {
    return "";
  }
}

/** Chats any 关注 reads (capture always keeps them). */
export function listenedChats(app: App): string[] {
  return all<{ chat_id: string }>(app.db, "select chat_id from chat_settings where channel = 'lark-watch' and json_extract(settings, '$.contexts') is not null").map((r) => r.chat_id);
}

/** A group's name as capture knows it. */
export function groupName(app: App, chatId: string) {
  return one<{ name: string }>(app.db, "select name from lark_cursors where chat_id = ?", chatId)?.name
    || one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null limit 1", `lark:${chatId}`)?.title
    || chatId;
}

/**
 * A new 关注 starts with what its groups said before: the last three days (or its backlog window, if
 * longer) of each group, at most 200 messages a group. Within the backlog window the messages go through like new ones (open questions may
 * still be answered); the rest is background in the conversation, summarized right away.
 */
export async function seedContext(app: App, c: ListenContext) {
  if (!c.conversationId) return 0;
  const since = Date.parse(c.since);
  const backlogFrom = since - BACKLOG_MS[c.knobs.backlog];
  const from = Math.min(since - 72 * 3600_000, backlogFrom);
  const background: string[] = [];
  let routed = 0;
  for (const chatId of c.chats) {
    const name = groupName(app, chatId);
    const rows = all<{ message_id: string; sender_id: string | null; sender_name: string; sender_kind: string; content: string; create_ms: number; thread_id: string | null }>(
      app.db,
      "select message_id, sender_id, sender_name, sender_kind, content, create_ms, thread_id from lark_messages where chat_id = ? and create_ms >= ? and create_ms < ? and sender_kind != 'system' order by create_ms desc limit 200",
      chatId, from, since,
    ).reverse();
    const recent = c.knobs.backlog === "off" ? [] : rows.filter((r) => r.create_ms >= backlogFrom && r.sender_kind !== "app");
    if (recent.length) routed += await routeWatchedMessages(app, chatId, name, recent.map((r) => ({ id: r.message_id, time: String(r.create_ms), sender: r.sender_name || "?", senderId: r.sender_id ?? undefined, text: r.content, topicId: r.thread_id ?? undefined })));
    const recentIds = new Set(recent.map((r) => r.message_id));
    const rest = rows.filter((r) => !recentIds.has(r.message_id));
    if (rest.length) background.push(`## 群「${name}」\n${rest.map((r) => `${new Date(r.create_ms).toISOString().slice(5, 16).replace("T", " ")} ${r.sender_name || "?"}：${r.content.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`);
  }
  if (background.length) {
    const { addMessage } = await import("../agents/threads.ts");
    addMessage(app, c.conversationId, "user", `（关注开始前各群最近的消息，只作背景，不用逐条处理）\n\n${background.join("\n\n")}`, null, { speaker: "关注开始前的消息", backlog: true });
    const { maybeSummarize } = await import("../agents/sessions.ts");
    maybeSummarize(app, c.conversationId, 1);
  }
  return routed;
}

/**
 * A group handed to an Agent profile by the owner's own word (`/watch`, a rule's “盯群” action): the place
 * 关注 of that group alone is made or updated. The profile's instructions say what to do, so no brief is asked.
 */
export async function watchChat(app: App, chatId: string, w: { spec: string; on: "all" | "mention" | "keyword"; pattern?: string; reply: "none" | "draft" | "auto"; note?: string }) {
  const { saveContext } = await import("./listen.ts");
  const prev = contextsOfChat(app, chatId).find((c) => c.kind === "place" && c.chats.length === 1);
  return saveContext(app, {
    id: prev?.id,
    kind: "place",
    chats: [chatId],
    spec: w.spec,
    note: w.note ?? prev?.note,
    knobs: { listen: w.on === "mention" ? "addressed" : "relevant", pattern: w.on === "keyword" ? w.pattern : undefined, reply: w.reply },
    status: "active",
  }, (id) => groupName(app, id));
}

/** Stop the place 关注 of a group (by 关注 id, or every place 关注 with that group). */
export async function unwatchChat(app: App, idOrChat: string) {
  const { getContext, saveContext } = await import("./listen.ts");
  const ctxs = idOrChat.startsWith("oc_") ? contextsOfChat(app, idOrChat).filter((c) => c.kind === "place") : [getContext(app, idOrChat)].filter((c): c is ListenContext => !!c);
  for (const c of ctxs) saveContext(app, { id: c.id, kind: c.kind, status: "paused" });
  return ctxs.length;
}
