import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { truncate } from "../core/util.ts";

/**
 * What the owner is doing, as far as omem can see, for the runs that decide whether to tell them
 * something (the patrol, the triage of someone looking for them): the meeting they are in, the
 * meetings they sat in today, the chats they spoke in during the last hour. What was said where
 * the owner was is not news to them. Facts only; the judgement is the agent's.
 */

/** A meeting still going on is looked for this far back (one that never reported its end stops counting). */
const MEETING_MAX_MS = 4 * 3600_000;
const SPOKE_MS = 3600_000;

const hm = (app: App, iso: string | number) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false, timeZone: app.config.timezone, hour: "2-digit", minute: "2-digit" });

/** The name a chat goes by: its conversation's title, or the title of what was captured from it. */
function chatName(app: App, chatId: string) {
  return (
    one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null limit 1", `lark:${chatId}`)?.title ??
    one<{ title: string }>(app.db, "select title from conversations where channel = 'lark-watch' and external_id = ? limit 1", chatId)?.title ??
    chatId
  );
}

export function ownerNow(app: App, at = Date.now()): string {
  const day = new Date(at).toLocaleDateString("sv-SE", { timeZone: app.config.timezone });
  const meetings = all<{ topic: string; status: string; started_at: string; ended_at: string | null }>(
    app.db,
    "select topic, status, started_at, ended_at from lark_meetings where started_at > ? order by started_at",
    new Date(at - 24 * 3600_000).toISOString(),
  ).filter((m) => new Date(m.started_at).toLocaleDateString("sv-SE", { timeZone: app.config.timezone }) === day);
  const live = meetings.filter((m) => !m.ended_at && ["seen", "asked", "joined", "listening"].includes(m.status) && at - Date.parse(m.started_at) < MEETING_MAX_MS);
  const over = meetings.filter((m) => m.ended_at);
  const spoke = all<{ chat_id: string; last: number }>(
    app.db,
    "select chat_id, max(create_ms) last from lark_messages where sender_kind = 'owner' and create_ms > ? group by chat_id order by last desc limit 6",
    at - SPOKE_MS,
  );
  return [
    ...live.map((m) => `- 正在开会：「${truncate(m.topic || "无标题", 40)}」（${hm(app, m.started_at)} 开始）。会上说的、会上共享的文档里的内容，本人此刻正在听。`),
    over.length ? `- 今天开过的会：${over.map((m) => `「${truncate(m.topic || "无标题", 30)}」${hm(app, m.started_at)}–${hm(app, m.ended_at!)}`).join("、")}。` : "",
    spoke.length ? `- 最近一小时本人在这些会话里说过话：${spoke.map((s) => `「${truncate(chatName(app, s.chat_id), 30)}」（${Math.max(1, Math.round((at - s.last) / 60_000))} 分钟前）`).join("、")}。` : "",
  ].filter(Boolean).join("\n");
}

/**
 * How the owner uses a chat, from what is on record: how much they wrote there lately, and what
 * they asked the assistant to do there. For a run handling something from that chat on its own.
 */
export function ownerInChat(app: App, chatId: string, at = Date.now()): string {
  const since = at - 14 * 86400_000;
  const wrote = one<{ n: number; last: number | null }>(app.db, "select count(*) n, max(create_ms) last from lark_messages where chat_id = ? and sender_kind = 'owner' and create_ms > ?", chatId, since);
  const asks = all<{ title: string; created_at: string }>(
    app.db,
    `select r.title, r.created_at from runs r join conversations c on c.id = json_extract(r.input, '$.conversationId')
      where r.kind = 'ask' and r.user_id = 'owner' and (c.external_id = ? or c.external_id like ?) and (c.channel = 'lark' or c.channel like 'lark:%') and r.created_at > ?
      order by r.created_at desc limit 4`,
    chatId, `${chatId}#%`, new Date(since).toISOString(),
  );
  return [
    wrote?.n ? `- 近 14 天本人在这里发了 ${wrote.n} 条消息，最近一次 ${new Date(wrote.last!).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}。` : "- 近 14 天本人没有在这里发过言。",
    asks.length ? `- 这里有人 @ 过助手（最近 ${asks.length} 次）：${asks.map((a) => `“${truncate(a.title.replace(/\s+/g, " "), 40)}”`).join("、")}。` : "",
  ].filter(Boolean).join("\n");
}
