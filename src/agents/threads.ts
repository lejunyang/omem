import { captureSpace } from "../core/capture-space.ts";
import { noteReply } from "./reply-outcomes.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now, truncate, localStamp } from "../core/util.ts";
import { recordCites } from "../sources/cites.ts";
import { appendToSource } from "../sources/store.ts";

/**
 * A thread is one line of conversation the assistant keeps context for: a
 * private chat, a group, a topic inside a group, a forum topic, or a web
 * conversation. It is stored in `conversations` (one row per thread) and
 * remembers which agent session it runs in, a rolling summary for cold starts,
 * and its own settings (space, agent spec, linked threads).
 *
 * Keys: `<chatId>` for a whole chat, `<chatId>#<topicId>` for a topic. Whether
 * a group's topics are separate threads is a per-chat setting (`mode`).
 */
export type ThreadSettings = {
  /** Agent spec that answers in this thread instead of the assistant. */
  spec?: string;
  /** Backend agent profile override (codex, claude…). */
  profile?: string;
  /** Temporary model/effort override for this thread (set with /model); cleared with /model off. */
  model?: string | null;
  effort?: string | null;
  /** Member commands affect only that member's turns even when the conversation is shared. */
  memberAi?: Record<string, import("./member-ai.ts").MemberAiPick>;
  /** The AI chosen when the thread's current agent session started (agents/choose-ai.ts), or the one a failed-over turn moved to; used while nothing above pins one. */
  auto?: { profile: string; model?: string; effort?: string } | null;
  memberAuto?: Record<string, NonNullable<ThreadSettings["auto"]> | null>;
  /** Other threads whose summaries are included as background. */
  links?: string[];
  /** Sources used by the summarizer for this watch conversation. */
  summaryOrigins?: { hash: string; spaces: string[] | null };
  /** Last channel message id seen in this thread (replies go under it, e.g. inside a topic). */
  lastMessageId?: string;
  /** Delivery location is independent of whether topics share a conversation. */
  lastTopicId?: string | null;
  /** Whether the chat is a group (false: a private chat with the bot), as its channel last said. */
  group?: boolean;
  /** /topic explicitly keeps this topic independent, even when the chat uses mode=chat. */
  isolatedTopic?: boolean;
  /** An in-chat review session (/review): the card being asked and whether its answer was shown. */
  review?: { cardId: string; stage: "front" | "rate"; goalId?: string; done: number } | null;
  /** Feishu chats this thread's agent may post into, and whether posts are drafts for the owner. */
  lark?: { chats: string[] | null; draft?: boolean };
  /** The version of the owner's work state (agents/work-state.ts) this thread's agent was last given. */
  itemId?: string;
  /** A personal situation transcript is indexed in the owner’s personal space. */
  situation?: string;
  instructionScene?: string;
  focusSeen?: { hash: string; turn: number };
  workStateSeen?: string | null;
  /** A demonstration's conversation (remote/demos.ts): what is shown, about which 关注 or item, and when. */
  demo?: { goal: string; contextId: string | null; itemId: string | null; startedAt: string; stoppedAt: string | null; organize: "skill" | "lessons" | "none" | null };
};
export type Thread = {
  id: string;
  spaceId: string;
  channel: string;
  key: string | null;
  title: string;
  status: "active" | "archived";
  parentId: string | null;
  summary: string;
  summaryAt: string | null;
  settings: ThreadSettings;
  agentProfile: string | null;
  agentSession: string | null;
  agentCwd: string | null;
  agentTurns: number;
  /** Who started it; turns run as the sender of their messages. */
  userId: string;
  createdAt: string;
  updatedAt: string;
};
type Row = {
  id: string;
  space_id: string;
  channel: string;
  external_id: string | null;
  title: string;
  status: string;
  parent_id: string | null;
  summary: string;
  summary_at: string | null;
  settings: string;
  agent_profile: string | null;
  agent_session: string | null;
  agent_cwd: string | null;
  agent_turns: number;
  user_id: string;
  created_at: string;
  updated_at: string;
};
const toThread = (r: Row): Thread => ({
  id: r.id,
  spaceId: r.space_id,
  channel: r.channel,
  key: r.external_id,
  title: r.title,
  status: r.status === "archived" ? "archived" : "active",
  parentId: r.parent_id,
  summary: r.summary ?? "",
  summaryAt: r.summary_at,
  settings: json(r.settings, {}),
  agentProfile: r.agent_profile,
  agentSession: r.agent_session,
  agentCwd: r.agent_cwd,
  agentTurns: r.agent_turns ?? 0,
  userId: r.user_id ?? "owner",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getThread(app: App, id: string): Thread {
  const r = one<Row>(app.db, "select * from conversations where id = ?", id);
  if (!r) throw new HttpError(404, `会话不存在：${id}`);
  return toThread(r);
}
export function findThread(app: App, id: string): Thread | null {
  const r = one<Row>(app.db, "select * from conversations where id = ? or id = ?", id, `c${id}`);
  return r ? toThread(r) : null;
}

export type ChatSettings = {
  /** chat: the whole chat is one thread. topic: each topic/thread is its own. */
  mode?: "chat" | "topic";
  spaceId?: string;
  /** Hours of silence after which a chat-mode thread starts afresh (remembering the old one). */
  idleHours?: number;
  /** Agent spec that answers in this chat by default. */
  spec?: string;
  /** Feishu posting scope for threads of this chat (watched chats). */
  lark?: { chats: string[] | null; draft?: boolean };
  /** Watched chats: which spec handles which messages, and how it may reply. */
  watch?: WatchRule;
  /** 「关注」 reading this chat (channel "lark-watch", channels/listen.ts). */
  contexts?: string[];
  /** Feishu capture (channel "lark-capture"): what happens to this chat's messages. */
  policy?: "ingest" | "involved" | "store" | "skip";
};
export type WatchRule = {
  /** The agent spec handling it, or "assistant" (the main assistant). */
  spec: string;
  /** all: every message; mention: messages that @ the owner or the bot; keyword: messages matching `pattern`. */
  on: "all" | "mention" | "keyword";
  pattern?: string;
  /** none: never post; draft: posts go to the owner for approval; auto: post directly through the bot. */
  reply: "none" | "draft" | "auto";
  spaceId?: string;
  /** What the owner wants from it, in their words. */
  note?: string;
  /** Minutes new messages are collected before the handler looks (it adjusts this); unset: 5 seconds. */
  batchMinutes?: number;
  /** Whether the decision model screens each batch before the handler starts (unset: lark.watchPrefilter, on by default). */
  prefilter?: boolean;
  /** The watch ends then (ISO); unset: until removed. */
  expiresAt?: string;
  /** When it began: messages from before are not handed over. */
  since?: string;
  /** What it is for, drafted by the handler and confirmed by the owner (channels/watch-trial.ts). */
  brief?: WatchBrief;
  /** The owner asked for direct replies; drafts come first until the owner says they may go out by themselves. */
  wantsAuto?: boolean;
  /** When the owner was last asked whether replies may go out by themselves (or said no). */
  promoteAskedAt?: string;
  /** The owner's latest decisions on this group's replies, oldest first (at most 30). */
  log?: WatchDecision[];
};
export type WatchBrief = { handle: string[]; skip: string[]; valid: string; at: string; confirmedAt?: string };
export type WatchDecision = {
  at: string;
  /** sent / edited / dropped: a draft; auto: posted by itself; disliked: the owner disliked an auto reply. */
  decision: "sent" | "edited" | "dropped" | "auto" | "disliked";
  reason?: string;
  /** Who and what it answered. */
  ask?: string;
  draft?: string;
  final?: string;
  messageId?: string;
};

export function chatSettings(app: App, channel: string, chatId: string): ChatSettings {
  return json(one<{ settings: string }>(app.db, "select settings from chat_settings where channel = ? and chat_id = ?", channel, chatId)?.settings ?? "{}", {});
}
export function setChatSettings(app: App, channel: string, chatId: string, patch: ChatSettings) {
  const next = { ...chatSettings(app, channel, chatId), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined || v === null || v === "") delete (next as Record<string, unknown>)[k];
  run(app.db, "insert into chat_settings(channel,chat_id,settings) values(?,?,?) on conflict(channel,chat_id) do update set settings = excluded.settings", channel, chatId, JSON.stringify(next));
  return next;
}

export function createThread(app: App, input: { spaceId: string; channel: string; key?: string | null; title?: string; parentId?: string | null; settings?: ThreadSettings; id?: string; userId?: string }) {
  const id = input.id ?? newId("c");
  const at = now();
  run(
    app.db,
    "insert into conversations(id,space_id,channel,title,external_id,created_at,updated_at,status,parent_id,settings,user_id) values(?,?,?,?,?,?,?,?,?,?,?)",
    id,
    input.spaceId,
    input.channel,
    input.title ?? "",
    input.key ?? null,
    at,
    at,
    "active",
    input.parentId ?? null,
    JSON.stringify(input.settings ?? {}),
    input.userId ?? "owner",
  );
  return getThread(app, id);
}

export type ThreadAddress = {
  channel: string;
  chatId: string;
  /** Topic / thread inside the chat (Feishu thread_id, Telegram message_thread_id). */
  topicId?: string | null;
  isGroup?: boolean;
  spaceId?: string;
  title?: string;
  userId?: string;
};

/**
 * Find the thread a channel message belongs to, starting a new one when the
 * chat has none, or when a chat-mode thread has been idle past its limit (the
 * new thread keeps a link to the old one so its summary carries over).
 */
export function resolveThread(app: App, addr: ThreadAddress): { thread: Thread; started: "new" | "renewed" | null } {
  const cs = chatSettings(app, addr.channel, addr.chatId);
  if (addr.topicId) {
    const isolated = one<Row>(app.db, "select * from conversations where channel = ? and external_id = ? and status = 'active' and json_extract(settings, '$.isolatedTopic') = 1 order by updated_at desc limit 1", addr.channel, `${addr.chatId}#${addr.topicId}`);
    if (isolated) return { thread: toThread(isolated), started: null };
  }
  const mode = cs.mode ?? (addr.topicId ? "topic" : "chat");
  const key = mode === "topic" && addr.topicId ? `${addr.chatId}#${addr.topicId}` : addr.chatId;
  const spaceId = cs.spaceId ?? addr.spaceId ?? (["lark", "lark-watch"].includes(addr.channel) ? captureSpace(app, addr.chatId) : "personal");
  const row = one<Row>(app.db, "select * from conversations where channel = ? and external_id = ? and status = 'active' order by updated_at desc limit 1", addr.channel, key);
  const settings: ThreadSettings = { ...(cs.spec ? { spec: cs.spec } : {}), ...(cs.lark ? { lark: cs.lark } : {}) };
  if (!row) {
    // A pinned "/resume" may have re-attached an archived thread to this key; otherwise start fresh.
    const prev = one<Row>(app.db, "select * from conversations where channel = ? and external_id = ? order by updated_at desc limit 1", addr.channel, key);
    return { thread: createThread(app, { spaceId, channel: addr.channel, key, title: addr.title, parentId: prev?.id ?? null, settings, userId: addr.userId }), started: "new" };
  }
  const t = toThread(row);
  const idleHours = cs.idleHours ?? app.config.sessions.idleHours;
  const idle = (Date.now() - Date.parse(t.updatedAt)) / 3_600_000;
  if (key === addr.chatId && idleHours > 0 && idle > idleHours) {
    archiveThread(app, t.id);
    return { thread: createThread(app, { spaceId: t.spaceId, channel: addr.channel, key, title: addr.title, parentId: t.id, settings: { ...t.settings, links: [] }, userId: t.userId }), started: "renewed" };
  }
  return { thread: t, started: null };
}

export function archiveThread(app: App, id: string) {
  run(app.db, "update conversations set status = 'archived' where id = ?", id);
}

/** Make an earlier thread the active one for a chat key (/resume). */
export function reattachThread(app: App, id: string, channel: string, key: string) {
  const t = getThread(app, id);
  run(app.db, "update conversations set status = 'archived' where channel = ? and external_id = ? and status = 'active' and id != ?", channel, key, id);
  run(app.db, "update conversations set status = 'active', channel = ?, external_id = ?, updated_at = ? where id = ?", channel, key, now(), id);
  return { ...t, status: "active" as const, channel, key };
}

export function updateThread(
  app: App,
  id: string,
  patch: Partial<{ title: string; spaceId: string; settings: ThreadSettings; summary: string; summaryAt: string; agentProfile: string | null; agentSession: string | null; agentCwd: string | null; agentTurns: number }>,
) {
  const t = getThread(app, id);
  const next = {
    title: patch.title ?? t.title,
    space_id: patch.spaceId ?? t.spaceId,
    settings: JSON.stringify(patch.settings ? { ...t.settings, ...patch.settings } : t.settings),
    summary: patch.summary ?? t.summary,
    summary_at: patch.summaryAt ?? t.summaryAt,
    agent_profile: patch.agentProfile === undefined ? t.agentProfile : patch.agentProfile,
    agent_session: patch.agentSession === undefined ? t.agentSession : patch.agentSession,
    agent_cwd: patch.agentCwd === undefined ? t.agentCwd : patch.agentCwd,
    agent_turns: patch.agentTurns ?? t.agentTurns,
  };
  run(
    app.db,
    "update conversations set title=?, space_id=?, settings=?, summary=?, summary_at=?, agent_profile=?, agent_session=?, agent_cwd=?, agent_turns=? where id=?",
    next.title,
    next.space_id,
    next.settings,
    next.summary,
    next.summary_at,
    next.agent_profile,
    next.agent_session,
    next.agent_cwd,
    next.agent_turns,
    id,
  );
  return getThread(app, id);
}

/** Forget the agent session so the next turn starts a fresh one from the summary. */
export function resetAgentSession(app: App, id: string) {
  run(app.db, "update conversations set agent_session = null, agent_cwd = null, agent_turns = 0 where id = ?", id);
}

export type ThreadMessage = { id: string; role: string; text: string; createdAt: string; meta: Record<string, unknown> };
export function threadMessages(app: App, id: string, opts: { limit?: number; after?: string | null; before?: string | null } = {}): ThreadMessage[] {
  const where = ["conversation_id = ?"];
  const params: (string | number)[] = [id];
  if (opts.after) where.push("created_at > ?") && params.push(opts.after);
  if (opts.before) where.push("created_at < ?") && params.push(opts.before);
  return all<{ id: string; role: string; text: string; created_at: string; meta: string }>(
    app.db,
    `select * from (select id, role, text, created_at, meta from messages where ${where.join(" and ")} order by created_at desc limit ?) order by created_at`,
    ...params,
    opts.limit ?? 200,
  ).map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.created_at, meta: json(m.meta, {}) }));
}

export function listThreads(app: App, opts: { channel?: string; spaceId?: string; query?: string; limit?: number; includeArchived?: boolean; userId?: string } = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.userId) where.push("c.user_id = ?") && params.push(opts.userId);
  if (!opts.includeArchived) where.push("c.status = 'active'");
  if (opts.channel) where.push("c.channel = ?") && params.push(opts.channel);
  if (opts.spaceId) where.push("c.space_id = ?") && params.push(opts.spaceId);
  if (opts.query) where.push("(c.title like ? or c.summary like ?)") && params.push(`%${opts.query}%`, `%${opts.query}%`);
  return all<Row & { messages: number }>(
    app.db,
    `select c.*, (select count(*) from messages m where m.conversation_id = c.id) messages from conversations c ${where.length ? "where " + where.join(" and ") : ""} order by c.updated_at desc limit ?`,
    ...params,
    opts.limit ?? 30,
  ).map((r) => ({ ...toThread(r), messages: r.messages }));
}

/** One line per thread for prompts and commands. */
export function describeThread(t: Thread & { messages?: number }, timeZone?: string) {
  const where = t.key ? `${t.channel}:${t.key}` : t.channel;
  return `${t.id}「${t.title || "(无标题)"}」${where} · ${localStamp(t.updatedAt, timeZone)}${t.messages !== undefined ? ` · ${t.messages} 条` : ""}${t.status === "archived" ? " · 已归档" : ""}${t.summary ? `\n  ${truncate(t.summary.replace(/\s+/g, " "), 160)}` : ""}`;
}


export function ensureConversation(app: App, input: { id?: string; spaceId: string; channel?: string; externalId?: string; title?: string }) {
  if (input.id) {
    const c = one<{ id: string }>(app.db, "select id from conversations where id = ?", input.id);
    if (c) return c.id;
  }
  if (input.externalId) {
    const c = one<{ id: string }>(app.db, "select id from conversations where channel = ? and external_id = ?", input.channel ?? "web", input.externalId);
    if (c) return c.id;
  }
  const id = input.id ?? newId("c");
  run(app.db, "insert into conversations(id,space_id,channel,title,external_id,created_at,updated_at) values(?,?,?,?,?,?,?)", id, input.spaceId, input.channel ?? "web", input.title ?? "", input.externalId ?? null, now(), now());
  return id;
}

export function addMessage(app: App, conversationId: string, role: "user" | "assistant", text: string, runId?: string | null, meta: Record<string, unknown> = {}) {
  const id = newId("msg");
  run(app.db, "insert into messages(id,conversation_id,role,text,run_id,meta,created_at) values(?,?,?,?,?,?,?)", id, conversationId, role, text, runId ?? null, JSON.stringify(meta), now());
  // Which sources answers cite (a light ranking boost, sources/cites.ts).
  if (role === "assistant") recordCites(app, text, `msg:${id}`);
  if (role === "assistant" && runId && !meta.command) noteReply(app, { runId, channel: "conversation", conversationId });
  run(
    app.db,
    "update conversations set updated_at = ?, title = case when title = '' and ? = 'user' and ? = 0 then ? else title end where id = ?",
    now(),
    role,
    meta.command ? 1 : 0,
    truncate(text.replace(/\s+/g, " "), 40),
    conversationId,
  );
  // Keep one-turn approvals in the conversation, not as reusable instructions in the search index.
  if (meta.command || meta.itemStepApproval) return id;
  // Conversations are part of the library too: "what did I tell you last week" must be searchable.
  const conv = one<{ space_id: string; title: string; channel: string; situation: string | null }>(app.db, "select space_id,title,channel,json_extract(settings, '$.situation') situation from conversations where id = ?", conversationId);
  if (conv)
    appendToSource(app, {
      spaceId: conv.situation ? "personal" : conv.space_id,
      kind: "conversation",
      uri: `conversation:${conversationId}`,
      title: `对话：${conv.title || truncate(text, 40)}`,
      lines: ["", `**${role === "user" ? "本人" : "助理"}**（${now().slice(0, 16).replace("T", " ")}，msg:${id}）：${text}`],
      meta: { conversationId, channel: conv.channel },
    });
  return id;
}

export function conversationMessages(app: App, conversationId: string, limit = 200) {
  return all<{ id: string; role: string; text: string; run_id: string | null; meta: string; created_at: string }>(
    app.db,
    "select * from (select * from messages where conversation_id = ? order by created_at desc limit ?) order by created_at",
    conversationId,
    limit,
  ).map((m) => ({ id: m.id, role: m.role, text: m.text, runId: m.run_id, meta: json(m.meta, {}), createdAt: m.created_at }));
}

