import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, now, truncate } from "../core/util.ts";

/**
 * What a run is working on (docs/v2/awareness.md), kept as keys in `run_scope`: the Feishu chat and
 * topic it answers in or was triggered from (`chat`), the omem conversation (`conversation`), the
 * messages that started it (`message`), and the items it was given or touched through a tool
 * (`item`). The host derives them from the run's input when it starts and from the item tools it
 * calls; the model never states them. Runs sharing a key are told about each other (relatedNote),
 * and the owner's words inside a background run's keys are checked before it posts (owner-moves.ts).
 */
export type ScopeKind = "chat" | "conversation" | "item" | "message";
export type ScopeKey = { kind: ScopeKind; key: string; topic: string };

/** How long after it ended a run still counts as “just done” for the runs sharing its scope. */
export const RECENT_MINUTES = 30;
/** Runs that are bookkeeping, not work anyone would do twice. */
const IGNORED_KINDS = ["thread-summary", "wake", "memory-review", "replay", "replay-arm", "replay-judge", "role-merge", "profile-review", "speaking-review", "sync", "learn-feed"];

type RunRow = { id: string; kind: string; input: string; lane: string | null; parent_id: string | null; user_id: string | null; created_at: string };

/** The chat (and topic) a conversation lives in, when it is a Feishu one (`oc_…` or `oc_…#omt_…`). */
export function chatOfConversation(app: App, conversationId: string): { chatId: string; topic: string } | null {
  const c = one<{ channel: string; external_id: string | null }>(app.db, "select channel, external_id from conversations where id = ?", conversationId);
  if (!c?.external_id || !c.channel.startsWith("lark") || !c.external_id.startsWith("oc_")) return null;
  const [chatId, topic] = c.external_id.split("#");
  return { chatId, topic: topic ?? "" };
}

/** The keys a run's input names (see the module comment); nothing the model wrote. */
export function deriveScope(app: App, r: RunRow): ScopeKey[] {
  if (IGNORED_KINDS.includes(r.kind)) return [];
  const inp = json<Record<string, any>>(r.input, {});
  const out: ScopeKey[] = [];
  const add = (kind: ScopeKind, key: unknown, topic: unknown = "") => {
    if (typeof key !== "string" || !key) return;
    const t = typeof topic === "string" ? topic : "";
    if (!out.some((k) => k.kind === kind && k.key === key && k.topic === t)) out.push({ kind, key, topic: t });
  };
  const conversation = (id: unknown) => {
    if (typeof id !== "string" || !id) return;
    add("conversation", id);
    const chat = chatOfConversation(app, id);
    if (chat) add("chat", chat.chatId, chat.topic);
  };
  // Someone looking for the owner: the chat they wrote in, not the owner's own chat the reminder goes to.
  const mention = inp.mention as { chatId?: string; topicId?: string | null; messageIds?: string[] } | undefined;
  if (mention) {
    add("chat", mention.chatId, mention.topicId ?? "");
    for (const m of mention.messageIds ?? []) add("message", m);
  } else if (r.kind === "ask" || r.kind === "agent") conversation(inp.conversationId);
  conversation(inp.threadId);
  if (r.kind === "mention") {
    add("chat", inp.chatId, inp.topicId ?? "");
    for (const m of (inp.messageIds as string[] | undefined) ?? []) add("message", m);
  }
  const silent = inp.silent as { chatId?: string; messageId?: string; topicId?: string | null } | undefined;
  if (silent) { add("chat", silent.chatId, silent.topicId ?? ""); add("message", silent.messageId); }
  const replyAt = inp.replyAt as { chatId?: string; messageId?: string } | undefined;
  if (replyAt) { add("chat", replyAt.chatId); add("message", replyAt.messageId); }
  const triggers = (inp.triggers as { messageId?: string | null; topicId?: string | null }[] | undefined) ?? [];
  for (const t of triggers) add("message", t.messageId ?? undefined);
  // A rule's agent may post only into the chat that triggered it.
  const chats = (inp.lark as { chats?: string[] | null } | undefined)?.chats;
  if (Array.isArray(chats) && chats.length && chats.length <= 3) for (const c of chats) add("chat", c, triggers[0]?.topicId ?? silent?.topicId ?? "");
  for (const k of ["itemId", "item_id"]) add("item", inp[k]);
  // A conversation turn: the Feishu messages it answers (a reply to one of them is about this turn).
  const ids = (inp.messageIds as string[] | undefined) ?? [];
  if (r.kind === "ask" && ids.length) {
    for (const m of all<{ ext: string | null }>(app.db, `select json_extract(meta, '$.externalId') ext from messages where id in (${ids.map(() => "?").join(",")})`, ...ids)) add("message", m.ext ?? undefined);
  }
  // New material from chats (the ingest role writes items and notifies from them).
  const sources = (inp.sourceIds as string[] | undefined) ?? [];
  if (sources.length && sources.length <= 20) {
    for (const s of all<{ uri: string }>(app.db, `select uri from sources where id in (${sources.map(() => "?").join(",")}) and kind = 'chat' and uri like 'lark:oc_%'`, ...sources)) add("chat", s.uri.slice(5));
  }
  return out;
}

/** Record a run's keys when it starts (runs.ts kick). Never fails the run. */
export function recordRunStart(app: App, runId: string) {
  try {
    const r = one<RunRow>(app.db, "select id, kind, input, lane, parent_id, user_id, created_at from runs where id = ?", runId);
    if (!r) return;
    for (const k of deriveScope(app, r)) addScope(app, runId, k.kind, k.key, k.topic, "input");
    run(app.db, "insert or ignore into run_scope(run_id, kind, key, topic, via, at) values(?, 'run', ?, '', 'input', ?)", runId, runId, now());
  } catch (e) {
    console.warn(`[omem] 记录运行 ${runId} 的范围失败：${(e as Error).message}`);
  }
}

/** Keys of a run started before this table existed (or created by a test without the queue): derived once on first use. */
function ensureScope(app: App, runId: string) {
  if (!one(app.db, "select 1 from run_scope where run_id = ? limit 1", runId)) recordRunStart(app, runId);
}

export function addScope(app: App, runId: string, kind: ScopeKind, key: string, topic = "", via: "input" | "tool" = "tool") {
  if (!key) return;
  run(app.db, "insert or ignore into run_scope(run_id, kind, key, topic, via, at) values(?,?,?,?,?,?)", runId, kind, key, topic, via, now());
}

export function scopeOf(app: App, runId: string): ScopeKey[] {
  ensureScope(app, runId);
  return all<ScopeKey>(app.db, "select kind, key, topic from run_scope where run_id = ? and kind != 'run'", runId);
}

export type RelatedRun = {
  id: string;
  kind: string;
  title: string;
  status: string;
  who: string;
  where: string;
  startedAt: string | null;
  finishedAt: string | null;
  conclusion: string;
  shared: string[];
};

const KIND_LABEL: Record<string, string> = {
  ask: "对话", agent: "Agent", heartbeat: "定时巡检", mention: "有人找你（分诊）", ingest: "整理新材料", "rule-fire": "规则", "rule-script": "规则脚本",
  code: "编码交办", review: "评审", dream: "整理记忆", "item-settle": "事项收尾", guest: "访客提问", "lark-command": "私聊指令", "wiki-write": "写 Wiki", "wiki-plan": "规划 Wiki",
};

/** Who did it, in a word: the profile, the built-in role, or the kind of run. */
function whoOf(kind: string, input: Record<string, unknown>, roles: string | null) {
  if (input.mention) return `有人找你的处理（${String(input.spec ?? "assistant") === "assistant" ? "主助手" : String(input.spec)}）`;
  if (typeof input.spec === "string" && input.spec !== "assistant") return `${input.spec}${input.rule ? "（规则）" : input.wake ? "（唤醒）" : ""}`;
  if (input.rule) return "主助手（规则）";
  if (input.wake) return "唤醒";
  if (kind === "ask") {
    const r = (roles ?? "").split("|").filter(Boolean);
    return r.length && r[0] !== "assistant" ? r[0] : "主助手（对话）";
  }
  return KIND_LABEL[kind] ?? kind;
}

/** A chat by name (the captured chat's title, else the capture cursor's name). */
export function chatName(app: App, chatId: string) {
  return one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null order by updated_at desc limit 1", `lark:${chatId}`)?.title
    ?? one<{ name: string }>(app.db, "select name from lark_cursors where chat_id = ?", chatId)?.name
    ?? chatId;
}

function whereOf(app: App, keys: ScopeKey[]) {
  const conv = keys.find((k) => k.kind === "conversation");
  if (conv) {
    const c = one<{ title: string; channel: string }>(app.db, "select title, channel from conversations where id = ?", conv.key);
    if (c) return `会话「${truncate(c.title || conv.key, 40)}」（${conv.key}）`;
  }
  const chat = keys.find((k) => k.kind === "chat");
  if (chat) return `飞书「${truncate(chatName(app, chat.key), 40)}」${chat.topic ? `的话题 ${chat.topic}` : ""}`;
  const item = keys.find((k) => k.kind === "item");
  if (item) return `事项 ${item.key}`;
  return "";
}

/** One sentence the run came to: why it said nothing, its answer's first line, or its summary. */
export function conclusionOf(output: Record<string, unknown>, error: string | null): string {
  if (error) return `失败：${truncate(error, 100)}`;
  if (typeof output.stayQuiet === "string" && output.stayQuiet) return `没有发言：${truncate(output.stayQuiet, 100)}`;
  for (const k of ["answer", "summary"]) {
    const v = output[k];
    if (typeof v === "string") {
      const line = v.split("\n").map((l) => l.replace(/^[#>*\-\s]+|[*\s]+$/g, "")).find((l) => l.trim());
      if (line) return truncate(line, 120);
    }
  }
  return "";
}

const SHARED: Record<ScopeKind, string> = { chat: "同一个会话", conversation: "同一个会话", item: "同一个事项", message: "同一条消息" };

/**
 * The runs whose keys meet this run's: under way, or ended within RECENT_MINUTES — the same chat (and
 * topic, when both have one), conversation, triggering message or item. Not the conversation's own
 * earlier turns (same lane: its history has them), not the runs this one started, not someone else's,
 * not a background role's pass that found nothing (quiet ingest, heartbeat).
 */
export function relatedRuns(app: App, runId: string, limit = 6): RelatedRun[] {
  const self = one<RunRow>(app.db, "select id, kind, input, lane, parent_id, user_id, created_at from runs where id = ?", runId);
  if (!self) return [];
  ensureScope(app, runId);
  const cutoff = new Date(Date.now() - RECENT_MINUTES * 60_000).toISOString();
  const rows = all<{ id: string; kind: string; title: string; status: string; input: string; output: string; error: string | null; roles: string | null; started_at: string | null; finished_at: string | null; kinds: string }>(
    app.db,
    `select r.id, r.kind, r.title, r.status, r.input, r.output, r.error, r.roles, r.started_at, r.finished_at, group_concat(distinct b.kind) kinds
       from run_scope a join run_scope b on a.kind = b.kind and a.key = b.key and (a.topic = '' or b.topic = '' or a.topic = b.topic)
       join runs r on r.id = b.run_id
      where a.run_id = ? and a.kind != 'run' and b.run_id != ?
        and (r.status = 'running' or (r.status in ('done','failed') and r.finished_at > ?))
        and coalesce(r.lane, '') != coalesce(?, '#')
        and coalesce(r.parent_id, '') != ?
        and coalesce(r.user_id, 'owner') = ?
        and r.kind not in (${IGNORED_KINDS.map(() => "?").join(",")})
        and not (r.status != 'running' and r.quiet = 1 and r.kind not in ('ask', 'agent'))
      group by r.id
      order by r.status = 'running' desc, coalesce(r.finished_at, r.started_at) desc
      limit ?`,
    runId, runId, cutoff, self.lane, runId, self.user_id ?? "owner", ...IGNORED_KINDS, limit,
  );
  return rows.map((r) => {
    const input = json<Record<string, unknown>>(r.input, {});
    const keys = all<ScopeKey>(app.db, "select kind, key, topic from run_scope where run_id = ? and kind != 'run'", r.id);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      status: r.status,
      who: whoOf(r.kind, input, r.roles),
      where: whereOf(app, keys),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      conclusion: conclusionOf(json(r.output, {}), r.status === "failed" ? r.error : null),
      shared: [...new Set(r.kinds.split(",").map((k) => SHARED[k as ScopeKind]).filter(Boolean))],
    };
  });
}

const hm = (iso: string | null, tz: string) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour12: false, timeZone: tz, hour: "2-digit", minute: "2-digit" }) : "");

/** The section “同时在办的相关工作”, or "" when nothing shares this run's scope. */
export function relatedNote(app: App, runId: string): string {
  const list = relatedRuns(app, runId);
  if (!list.length) return "";
  const tz = app.config.timezone;
  return [
    "# 同时在办的相关工作",
    "",
    `宿主按会话、触发消息和事项找出的、和你这次范围有交集的其他运行（正在进行，或 ${RECENT_MINUTES} 分钟内结束）：`,
    ...list.map((r) => [
      `- ${r.id} · ${r.who}${r.where ? ` · ${r.where}` : ""} · ${r.status === "running" ? `进行中（${hm(r.startedAt, tz)} 开始）` : `${hm(r.finishedAt, tz)} ${r.status === "failed" ? "失败" : "结束"}`} · 「${truncate(r.title, 60)}」（${r.shared.join("、")}）`,
      ...(r.conclusion ? [`  结论：${r.conclusion}`] : []),
    ].join("\n")),
  ].join("\n");
}
