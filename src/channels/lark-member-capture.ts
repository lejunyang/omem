import { scheduleIngest } from "../agents/jobs.ts";
import { grantedFeatures } from "../auth/features.ts";
import { asLarkUser } from "../auth/lark-user.ts";
import { accessibleSpaces, larkOpenIdOf, userName } from "../core/users.ts";
import { listConnections } from "../auth/vault.ts";
import type { App } from "../core/app.ts";
import { captureSpace } from "../core/capture-space.ts";
import { all, one, run } from "../core/db.ts";
import { json, now } from "../core/util.ts";
import { larkCli } from "./lark-cli.ts";
import { persistChatMessages, timeMs, type LarkMessage } from "./lark-messages.ts";
import { fetchMessages } from "./lark-personal.ts";

/**
 * Capture for the people who connected Feishu with “我的消息” (docs/v2/multi-user.md, “多用户采集与
 * 去重”), with their own token: their recently active chats go to their personal space, or to a space
 * the chat is bound to when they may capture there. A chat that already has a copy in a space they
 * can read (a group the owner or the bot captures into a project space) is not read again: they are
 * only recorded as able to see it (source_viewers). Their cursors are their own (kv), so the owner's
 * capture is untouched; rules, watches and subscriptions stay the owner's.
 */
const CHATS = 30;
const LOOKBACK_MS = 3 * 86400_000;

type Cursor = { lastTime: number; lastIds: string[] };
const cursorKey = (userId: string, chatId: string) => `lark_member_cursor:${userId}:${chatId}`;
function cursor(app: App, userId: string, chatId: string): Cursor | null {
  return json<Cursor | null>(one<{ value: string }>(app.db, "select value from kv where key = ?", cursorKey(userId, chatId))?.value, null);
}
function saveCursor(app: App, userId: string, chatId: string, messages: LarkMessage[], prev: Cursor | null) {
  const last = messages.length ? Math.max(...messages.map((m) => timeMs(m.create_time))) : (prev?.lastTime ?? Date.now());
  const value: Cursor = { lastTime: last, lastIds: messages.filter((m) => timeMs(m.create_time) === last).map((m) => m.message_id) };
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", cursorKey(userId, chatId), JSON.stringify(value));
}
const newer = (messages: LarkMessage[], c: Cursor | null) => (c ? messages.filter((m) => timeMs(m.create_time) > c.lastTime || (timeMs(m.create_time) === c.lastTime && !c.lastIds.includes(m.message_id))) : messages);

/** A copy of this chat in a space the person reads: reading it again would only duplicate it. */
function readableCopy(app: App, userId: string, chatId: string) {
  const readable = accessibleSpaces(app, userId) ?? [];
  const copies = all<{ id: string; space_id: string }>(app.db, "select id, space_id from sources where origin_key = ? and deleted_at is null", `lark:chat:${chatId}`);
  return copies.find((c) => readable.includes(c.space_id) && !c.space_id.startsWith("personal")) ?? null;
}

/** One person's pass; returns how many messages were kept. */
export async function captureForMember(app: App, userId: string) {
  return asLarkUser(app, userId, async () => {
    const v = await larkCli(["im", "+chat-list", "--as", "user", "--types", "p2p,group", "--sort", "active_time", "--page-size", String(CHATS), "--format", "json"]);
    const chats = ((v.data?.chats ?? []) as { chat_id: string; name?: string; chat_mode?: string }[]).slice(0, CHATS);
    const me = larkOpenIdOf(app, userId);
    const endMs = Date.now();
    const touched = new Map<string, Set<string>>();
    let kept = 0;
    for (const chat of chats) {
      try {
        const copy = readableCopy(app, userId, chat.chat_id);
        if (copy) {
          run(app.db, "insert into source_viewers(source_id,user_id,evidence,at) values(?,?,?,?) on conflict(source_id,user_id) do update set at = excluded.at", copy.id, userId, "member-capture", now());
          continue;
        }
        const prev = cursor(app, userId, chat.chat_id);
        const fresh = newer(await fetchMessages(["+chat-messages-list", "--chat-id", chat.chat_id, "--order", "asc"], prev?.lastTime ?? endMs - LOOKBACK_MS, endMs, { pages: 5 }), prev);
        if (fresh.length) {
          const spaceId = captureSpace(app, chat.chat_id, userId);
          const r = persistChatMessages(app, { chatId: chat.chat_id, spaceId, name: chat.name || chat.chat_id, messages: fresh, owner: me, userId });
          if (r.id && r.status !== "unchanged") touched.set(spaceId, (touched.get(spaceId) ?? new Set()).add(r.id));
          kept += fresh.length;
        }
        saveCursor(app, userId, chat.chat_id, fresh, prev);
      } catch (e) {
        console.warn(`[omem] 读取 ${userName(app, userId)} 的飞书会话失败 ${chat.name ?? chat.chat_id}：${(e as Error).message}`);
      }
    }
    for (const [spaceId, ids] of touched) scheduleIngest(app, spaceId, [...ids], `${userName(app, userId)}的飞书新消息`);
    return kept;
  });
}

/** Everyone (but the owner, whose capture is lark-personal.ts) with a working connection that has “我的消息”. */
export async function pollMembers(app: App) {
  let people = 0;
  for (const c of listConnections(app)) {
    if (c.provider !== "lark" || c.userId === "owner" || c.status !== "active" || !grantedFeatures("lark", c.scopes).includes("messages")) continue;
    try {
      await captureForMember(app, c.userId);
      people++;
    } catch (e) {
      console.warn(`[omem] ${userName(app, c.userId)} 的飞书采集失败：${(e as Error).message}`);
    }
  }
  return people;
}
