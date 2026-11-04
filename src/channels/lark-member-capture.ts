import { scheduleIngest } from "../agents/jobs.ts";
import { grantedFeatures } from "../auth/features.ts";
import { asLarkUser } from "../auth/lark-user.ts";
import { larkOpenIdOf, personalSpaceId, userName } from "../core/users.ts";
import { findConnection, listConnections } from "../auth/vault.ts";
import type { App } from "../core/app.ts";
import { captureSpace, sharedCopyFor } from "../core/capture-space.ts";
import { one, run } from "../core/db.ts";
import { json } from "../core/util.ts";
import { larkCli } from "./lark-cli.ts";
import { persistChatMessages, timeMs, type LarkMessage } from "./lark-messages.ts";
import { captureCalendar, captureMinutes, captureRecentDocs, fetchMessages } from "./lark-personal.ts";

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
        // A copy in a shared space they read: reading it again would only duplicate it.
        if (sharedCopyFor(app, userId, `lark:chat:${chat.chat_id}`, "member-capture")) continue;
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
    // Their calendar, minutes and the documents they opened lately, as for the owner, into their space.
    const who = { userId, spaceId: personalSpaceId(userId) };
    const features = grantedFeatures("lark", findConnection(app, userId, "lark")?.scopes ?? []);
    if (features.includes("calendar")) await captureCalendar(app, touched, who).catch((e) => console.warn(`[omem] ${userName(app, userId)} 的飞书日程读取失败：${(e as Error).message}`));
    if (features.includes("minutes")) await captureMinutes(app, touched, who).catch((e) => console.warn(`[omem] ${userName(app, userId)} 的妙记读取失败：${(e as Error).message}`));
    if (features.includes("docs") && app.config.lark.capture.recentDocs) await captureRecentDocs(app, touched, who).catch((e) => console.warn(`[omem] ${userName(app, userId)} 最近打开的飞书文档读取失败：${(e as Error).message}`));
    for (const [spaceId, ids] of touched) scheduleIngest(app, spaceId, [...ids], `${userName(app, userId)}的飞书新消息、日程或妙记`);
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
