import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { OWNER, personalSpaceId } from "./users.ts";
import { can } from "../auth/permissions.ts";
import { findSpace } from "./spaces.ts";
import { json } from "./util.ts";
import { chatSettings } from "../agents/threads.ts";

type Settings = ReturnType<typeof chatSettings>;
const subscriptionsOf = (app: App) => json<{ chatId: string; spaceId: string }[]>(one<{ value: string }>(app.db, "select value from kv where key='lark_subscriptions'")?.value, []);
const mappedGroups = (app: App) => (findSpace(app, "personal")?.settings.larkGroups ?? {}) as Record<string, string>;
/** The order bindings win in: the chat's own (`/space`), its watch rule, a subscription, the old personal-space map. */
const bindingChain = (settings: Settings, watched: Settings, subscribed: string | undefined, mapped: string | undefined) => [settings.spaceId, watched.spaceId, watched.watch?.spaceId, subscribed, mapped];

/** Shared by conversations, collection and rules. Explicit settings precede inferred locations. */
export function chatBinding(app: App, chatId: string): string | undefined {
  const chain = bindingChain(chatSettings(app, "lark", chatId), chatSettings(app, "lark-watch", chatId), subscriptionsOf(app).find((s) => s.chatId === chatId)?.spaceId, mappedGroups(app)[chatId]);
  return chain.find((id) => id && findSpace(app, id));
}

/** `captureSpace` for the owner over many chats at once (the settings list): a few queries, not several per chat. */
export function ownerCaptureSpaces(app: App, chatIds: string[]): Map<string, string> {
  const settingsOf = (channel: string) => new Map(all<{ chat_id: string; settings: string }>(app.db, "select chat_id, settings from chat_settings where channel = ?", channel).map((r) => [r.chat_id, json<Settings>(r.settings, {})]));
  const bound = settingsOf("lark");
  const watched = settingsOf("lark-watch");
  const subs = new Map(subscriptionsOf(app).map((s) => [s.chatId, s.spaceId]));
  const mapped = mappedGroups(app);
  const spaces = new Set(all<{ id: string }>(app.db, "select id from spaces").map((s) => s.id));
  // One indexed lookup per unbound chat (sources_uri); a `like` over sources would scan the whole table.
  const existing = app.db.prepare("select space_id from sources where uri = ? and deleted_at is null order by captured_at");
  const def = spaces.has(app.config.lark.capture.space) ? app.config.lark.capture.space : "personal";
  return new Map(
    chatIds.map((id) => {
      const binding = bindingChain(bound.get(id) ?? {}, watched.get(id) ?? {}, subs.get(id), mapped[id]).find((s) => s && spaces.has(s));
      const copy = binding ? undefined : (existing.all(`lark:${id}`) as { space_id: string }[]).find((r) => spaces.has(r.space_id))?.space_id;
      return [id, binding ?? copy ?? def];
    }),
  );
}
/**
 * Where a chat's capture goes. `userId`: whose capture it is (docs/v2/multi-user.md, “采集进哪个空间”):
 * a binding or an existing copy of the chat counts only in a space that person may capture into
 * (`capture.route`), otherwise their own personal space — someone else's capture of a shared private
 * chat never lands in the owner's personal space.
 */
export function captureSpace(app: App, chatId?: string, userId: string = OWNER): string {
  const mayRoute = (space: string) => userId === OWNER || can(app, userId, "capture.route", space);
  if (chatId) {
    const bound = chatBinding(app, chatId);
    if (bound && mayRoute(bound)) return bound;
    const existing = all<{ space_id: string }>(app.db, "select space_id from sources where uri=? and deleted_at is null order by captured_at", `lark:${chatId}`);
    const usable = existing.find((r) => findSpace(app, r.space_id) && mayRoute(r.space_id));
    if (usable) return usable.space_id;
  }
  if (userId !== OWNER) return personalSpaceId(userId);
  const def = app.config.lark.capture.space;
  return findSpace(app, def) ? def : "personal";
}

/** A message can have archived copies in several spaces. Look up only the incoming message ids. */
export function archivedMessageSpaces(app: App, messageIds: string[]) {
  const spaces = new Map<string, string[]>();
  if (!messageIds.length) return spaces;
  const rows = all<{ message_id: string; space_id: string }>(app.db, `
    with ids as (select value from json_each(?))
    select m.message_id, s.space_id from lark_messages m join sources s on s.id = m.source_id
      where m.message_id in (select value from ids)
    union
    select l.message_id, s.space_id from lark_message_lines l join sources s on s.id = l.source_id
      where l.message_id in (select value from ids)`, JSON.stringify(messageIds));
  for (const row of rows) {
    const known = spaces.get(row.message_id);
    if (known) known.push(row.space_id);
    else spaces.set(row.message_id, [row.space_id]);
  }
  return spaces;
}

/** Snapshot incoming messages together, before rules or watches wait to handle them. */
export function messageSourceSpaces(app: App, messages: { id?: string; chatId?: string }[]) {
  const archived = archivedMessageSpaces(app, messages.flatMap(m => m.id ? [m.id] : []));
  const bindings = new Map<string, string>();
  return messages.map(({ id, chatId }) => {
    const stored = id && archived.get(id);
    if (stored) return stored;
    if (!chatId) return undefined;
    const space = bindings.get(chatId) ?? captureSpace(app, chatId);
    bindings.set(chatId, space);
    return [space];
  });
}

/**
 * Someone other than the owner capturing a thing (by origin_key) that already has a copy in a shared
 * space they read: it is not stored again for them; they are recorded as able to see it
 * (source_viewers, docs/v2/multi-user.md “采集前先查”). Returns that copy, or null.
 */
export function sharedCopyFor(app: App, userId: string, originKey: string, evidence: string) {
  if (userId === OWNER) return null;
  const readable = new Set(all<{ id: string }>(app.db, "select id from spaces").map((s) => s.id).filter((s) => can(app, userId, "space.read", s)));
  const copy = all<{ id: string; space_id: string }>(app.db, "select id, space_id from sources where origin_key = ? and deleted_at is null", originKey).find((c) => readable.has(c.space_id) && !c.space_id.startsWith("personal"));
  if (!copy) return null;
  run(app.db, "insert into source_viewers(source_id,user_id,evidence,at) values(?,?,?,?) on conflict(source_id,user_id) do update set at = excluded.at", copy.id, userId, evidence, new Date().toISOString());
  return copy;
}
