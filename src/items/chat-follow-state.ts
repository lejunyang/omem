import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { accessibleSpaces, canWrite } from "../core/users.ts";
import { now } from "../core/util.ts";
import { sourceVisible } from "../auth/visibility.ts";
import { itemContext } from "../channels/listen.ts";
import { rootOf } from "./tree.ts";

export function larkChatOfUri(uri: string) {
  return /^lark:(oc_[\w-]+)(?:@\d{4}-\d{2})?$/.exec(uri)?.[1];
}

type SourceCopy = { id: string; space_id: string; captured_at: string };
/** Prefer the item's own space, then a writable and earlier copy. */
export function mainMaterialCopy<S extends SourceCopy>(app: App, item: { spaceId: string; userId: string }, copies: S[]) {
  return [...copies].sort((a, b) =>
    Number(b.space_id === item.spaceId) - Number(a.space_id === item.spaceId) ||
    Number(canWrite(app, item.userId, b.space_id)) - Number(canWrite(app, item.userId, a.space_id)) ||
    a.captured_at.localeCompare(b.captured_at) || a.id.localeCompare(b.id))[0];
}

type PlaceRef = { kind: string; ref: string };
/** The same Feishu chat may be a material by transcript, source copy or topic. */
export function materialChat(app: App, m: PlaceRef, userId?: string): string | undefined {
  if (m.kind === "source") {
    const s = one<{ uri: string; deleted_at: string | null }>(app.db, "select uri,deleted_at from sources where id=? and kind='chat'", m.ref);
    if (s && (!userId || !s.deleted_at && sourceVisible(app, userId, m.ref) === true)) return larkChatOfUri(s.uri);
  } else if (m.kind === "conversation") {
    const c = one<{ channel: string; external_id: string | null; user_id: string; space_id: string }>(app.db,
      "select channel,external_id,user_id,space_id from conversations where id=?", m.ref);
    const spaces = userId ? accessibleSpaces(app, userId) : null;
    if (c?.channel.startsWith("lark") && c.external_id?.startsWith("oc_")
      && (!userId || c.user_id === userId && (!spaces || spaces.includes(c.space_id)))) return c.external_id.split("#")[0];
  }
}

export function chatMaterials(app: App, itemIds: string[], userId: string) {
  return all<PlaceRef & { item_id: string; added_by: string }>(app.db, `select item_id,kind,ref,added_by from item_materials
    where item_id in (select value from json_each(?)) and kind in ('source','conversation') order by id`, JSON.stringify(itemIds))
    .flatMap(m => {
      const chat = materialChat(app, m, userId);
      return chat ? [{ ...m, chat }] : [];
    });
}

export type ChatFollowState = {
  chat_id: string; state: "active" | "idle" | "removed"; empty_batches: number; last_batch: string | null;
  after_ms: number; checked_at: number | null; clues: string | null; evidence: string | null;
};
export type ChatEvidence = { id: string; source: string; anchor: string; lines: number[] };

export function chatFollowStates(app: App, itemId: string) {
  return new Map(all<ChatFollowState>(app.db, "select * from item_chat_follow where item_id=?", itemId).map(state => [state.chat_id, state]));
}

export function chatFollowChoices(app: App, itemId: string) {
  const ctx = itemContext(app, rootOf(app, itemId));
  return { added: new Set(ctx?.added), dropped: new Set(ctx?.dropped) };
}

export function setMaterialChatFollow(app: App, itemId: string, chat: string, state: "active" | "removed") {
  run(app.db, `insert into item_chat_follow(item_id,chat_id,state,updated_at) values(?,?,?,?)
    on conflict(item_id,chat_id) do update set state=excluded.state,updated_at=excluded.updated_at,
      empty_batches=0,last_batch=null,after_ms=0,checked_at=null,clues=null,evidence=null`, itemId, chat, state, now());
  // Turning a place on again starts at the end, even if the next patrol has not removed its old cursor.
  run(app.db, `delete from item_follow_cursors where item_id=? and exists (
    select 1 from sources s where s.id=item_follow_cursors.source_id and (s.uri=? or s.uri glob ? or
      s.uri glob 'conversation:*' and exists(select 1 from conversations c where c.id=substr(s.uri,14)
        and c.channel like 'lark%' and (c.external_id=? or c.external_id glob ?))))`,
  itemId, `lark:${chat}`, `lark:${chat}@*`, chat, `${chat}#*`);
}
