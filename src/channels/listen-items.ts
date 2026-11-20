import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, truncate, zonedParts } from "../core/util.ts";
import { accessibleSpaces } from "../core/users.ts";
import { getItem, isClosed } from "../items/store.ts";
import { descendantIds, rootOf } from "../items/tree.ts";
import { itemContext, listContexts, saveContext, type ContextInput, type ListenContext, type ListenKnobs } from "./listen.ts";

/**
 * A matter's 「关注」 (kind `item`, channels/listen.ts): the item and the groups it goes on in. Its groups
 * are the item's linked chats (items/places.ts: a captured chat or a Feishu conversation as a material),
 * kept in step on each pass of flows/follow.ts, which also pauses it once the item is closed. While it is
 * on, follow.ts notes what changes in those places (role item-follow) even with no flow; with replies on,
 * its handler also answers about the matter in its groups. A flow starting on an item makes one
 * (`byFlow`), which ends with the flow until the owner takes it on (setItemListening, set_chat_watch with `item`).
 *
 * Only top-level items have one (docs/v2/status.md “工作线”): a work item under a line goes on in the line's 关注,
 * whose groups are the line's and those of everything under it. A flow starting on a work item makes or
 * keeps the top-level one; a 关注 a work item had before it was hung under a line folds into it.
 */

/** Chats that are no group (a private chat, a bot's): an item's 关注 never reads those. */
const PRIVATE = new Set(["p2p", "bot", "own-bot"]);

/** The groups an item goes on in, with those of everything under it, as its person may see them. */
export function itemChats(app: App, itemId: string): string[] {
  const item = getItem(app, itemId), allowed = accessibleSpaces(app, item.userId);
  const out = new Set<string>();
  const ids = [itemId, ...descendantIds(app, itemId)];
  for (const m of all<{ kind: string; ref: string }>(app.db, `select kind, ref from item_materials where item_id in (${ids.map(() => "?").join(",")}) and kind in ('source','conversation') order by id`, ...ids)) {
    let chat: string | undefined;
    if (m.kind === "source") {
      const s = one<{ uri: string; space_id: string }>(app.db, "select uri, space_id from sources where id = ? and kind = 'chat' and deleted_at is null", m.ref);
      if (s && (!allowed || allowed.includes(s.space_id)) && s.uri.startsWith("lark:oc_")) chat = s.uri.slice(5);
    } else {
      const c = one<{ channel: string; external_id: string | null; user_id: string }>(app.db, "select channel, external_id, user_id from conversations where id = ?", m.ref);
      if (c && c.user_id === item.userId && c.channel.startsWith("lark") && c.external_id?.startsWith("oc_")) chat = c.external_id.split("#")[0];
    }
    if (!chat) continue;
    const kind = one<{ kind: string }>(app.db, "select kind from lark_cursors where chat_id = ?", chat)?.kind;
    if (!kind || !PRIVATE.has(kind)) out.add(chat);
  }
  return [...out];
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The groups a matter's 关注 reads: its items' linked chats, with what the owner added there and without what they took out. */
export function contextChats(app: App, itemId: string, c?: Pick<ListenContext, "added" | "dropped"> | null): string[] {
  const dropped = new Set(c?.dropped ?? []);
  return [...new Set([...itemChats(app, itemId), ...(c?.added ?? [])])].filter((x) => !dropped.has(x));
}

/**
 * The owner sets which groups a matter's 关注 reads (the line page's 人和群, PUT /api/listen/:id, set_chat_watch):
 * what the items do not link is kept as added, what they link but is left out as dropped, so the next sync
 * with the items keeps the choice. An added group must be a group capture knows (not a private chat).
 */
export function itemChatsPatch(app: App, itemId: string, chats: string[]): { chats: string[]; added: string[]; dropped: string[] } {
  const want = [...new Set(chats.map((x) => x.trim()).filter(Boolean))];
  const base = itemChats(app, itemId);
  const added = want.filter((x) => !base.includes(x));
  for (const chat of added) {
    const kind = one<{ kind: string }>(app.db, "select kind from lark_cursors where chat_id = ?", chat)?.kind;
    const known = kind !== undefined || !!one(app.db, "select 1 from sources where uri = ? and kind = 'chat' and deleted_at is null", `lark:${chat}`);
    if (!/^oc_[\w-]+$/.test(chat) || !known) throw new HttpError(400, `没有采集过这个群：${chat}`);
    if (kind && PRIVATE.has(kind)) throw new HttpError(400, `${chat} 是私聊，关注只读群`);
  }
  return { chats: want, added, dropped: base.filter((x) => !want.includes(x)) };
}

/** Make the item's 关注 or change it; its groups are always the item's (with the owner's additions and removals). */
function upsertItemContext(app: App, itemId: string, patch: Partial<ContextInput>): ListenContext {
  const item = getItem(app, itemId);
  const prev = itemContext(app, itemId);
  return saveContext(app, {
    id: prev?.id,
    kind: "item",
    itemId,
    chats: contextChats(app, itemId, prev),
    ...(prev ? {} : { name: item.title, spaceId: item.spaceId, expiresAt: null }),
    ...patch,
  });
}

/** Keep an item 关注's groups the item's own (the chat index follows through saveContext); a closed matter's stops. */
export function syncItemContext(app: App, c: ListenContext): ListenContext {
  if (c.kind !== "item" || !c.itemId) return c;
  // A work item's own 关注 folds into its line's (foldChildContexts), never kept in step on its own.
  if (one(app.db, "select 1 from items where id = ? and parent_id is not null", c.itemId)) return c;
  const status = one<{ status: string }>(app.db, "select status from items where id = ?", c.itemId)?.status;
  if (status && isClosed(status)) return c.status === "active" ? saveContext(app, { id: c.id, kind: "item", status: "paused" }) : c;
  let chats: string[];
  try {
    chats = contextChats(app, c.itemId, c);
  } catch {
    // The item is gone: its 关注 keeps what it had; nothing follows it any more.
    return c;
  }
  return same(chats, c.chats) ? c : saveContext(app, { id: c.id, kind: "item", chats });
}

/** Every active item 关注 (follow.ts calls this on each pass). */
export function syncItemContexts(app: App) {
  let changed = 0;
  for (const c of listContexts(app, { kind: "item", activeOnly: true })) if (syncItemContext(app, c) !== c) changed++;
  return changed;
}

/**
 * The owner turns a matter's 关注 on or off. On: made or made active again (named after the item, in the
 * item's space when new), the owner's own from now on (it no longer ends with a flow). Off: paused, its
 * cases and lessons kept. Null when there was nothing to turn off.
 */
export function setItemListening(app: App, itemId: string, on: boolean, knobs?: Partial<ListenKnobs>): ListenContext | null {
  getItem(app, itemId);
  // A work item under a line is followed in the line's 关注.
  const root = rootOf(app, itemId);
  if (on) return upsertItemContext(app, root, { status: "active", byFlow: false, ...(knobs ? { knobs } : {}) });
  const prev = itemContext(app, root);
  return prev ? saveContext(app, { id: prev.id, kind: "item", status: "paused", byFlow: false, ...(knobs ? { knobs } : {}) }) : null;
}

/**
 * A flow started on the item: the 关注 of its top-level item (itself, or the line it hangs under) is made
 * if missing (only reading), or kept in step; one the owner turned off stays off.
 */
export function flowStarted(app: App, itemId: string): ListenContext | null {
  const root = rootOf(app, itemId);
  const prev = itemContext(app, root);
  if (prev && !prev.byFlow) return prev.status === "active" ? syncItemContext(app, prev) : prev;
  if (prev?.status === "active") return syncItemContext(app, prev);
  return upsertItemContext(app, root, { status: "active", byFlow: true });
}

/** A flow ended: a 关注 that was only there for flows pauses once none runs on the line or under it. */
export function flowEnded(app: App, itemId: string) {
  const root = rootOf(app, itemId);
  const c = itemContext(app, root);
  if (!c?.byFlow || c.status !== "active") return;
  const ids = [root, ...descendantIds(app, root)];
  if (one(app.db, `select 1 from item_flows where ended_at is null and item_id in (${ids.map(() => "?").join(",")}) limit 1`, ...ids)) return;
  saveContext(app, { id: c.id, kind: "item", status: "paused" });
}

/** At startup: the top-level items of those whose flow runs now get their 关注 (idempotent). */
export function migrateItemContexts(app: App) {
  let made = 0;
  const roots = new Set(all<{ item_id: string }>(app.db, "select item_id from item_flows where ended_at is null").map((r) => rootOf(app, r.item_id)));
  for (const id of roots) {
    if (itemContext(app, id)) continue;
    try {
      upsertItemContext(app, id, { status: "active", byFlow: true });
      made++;
    } catch (e) {
      console.warn(`[omem] 没能给事项 ${id} 建关注：${(e as Error).message}`);
    }
  }
  return made;
}

/** A line's 关注 after its items changed (one hung under it or taken out): its groups follow. */
export function syncRootContext(app: App, rootId: string) {
  const c = itemContext(app, rootId);
  return c && c.status === "active" ? syncItemContext(app, c) : c;
}

const FOLDED = "已并进";
/**
 * A 关注 a work item had of its own before it was hung under a line (idempotent; at startup and right
 * after an item gets a parent): its cases and problems go to the top-level item's 关注 (made if missing,
 * only reading), and it is paused with a note saying where it went.
 */
export function foldChildContexts(app: App) {
  let folded = 0;
  for (const c of listContexts(app, { kind: "item" })) {
    if (!c.itemId || c.note?.startsWith(FOLDED)) continue;
    if (!one(app.db, "select 1 from items where id = ? and parent_id is not null", c.itemId)) continue;
    const root = rootOf(app, c.itemId);
    try {
      let top = itemContext(app, root);
      if (!top) top = upsertItemContext(app, root, { status: c.status === "active" ? "active" : "paused", byFlow: !!c.byFlow, knobs: { reply: "none" } });
      run(app.db, "update reply_samples set context_id = ? where context_id = ?", top.id, c.id);
      run(app.db, "update listen_problems set context_id = ? where context_id = ?", top.id, c.id);
      const was = c.note ? ` 原来的说明：${c.note}` : "";
      saveContext(app, { id: c.id, kind: "item", status: "paused", note: `${FOLDED}「${truncate(top.name, 40)}」（${top.id}）：这件事归到了上层，案例和在跟的问题都在那边。${was}` });
      if (top.status === "active") syncItemContext(app, top);
      folded++;
    } catch (e) {
      console.warn(`[omem] 没能把事项 ${c.itemId} 的关注并到上层：${(e as Error).message}`);
    }
  }
  return folded;
}

const STAGE_STATE: Record<string, string> = { doing: "进行中", gated: "等本人确认", blocked: "卡住", stale: "待复核" };

/** A few lines on where the matter stands, for its handler: the item, its flow's stage, the latest changes. */
/**
 * The line a matter's 关注 is on has launched and is being watched (items/lifecycle.ts, phase `watching`):
 * one line for whoever reads its groups (the handler, item-follow) on what still matters. Empty otherwise.
 */
export function watchingNote(app: App, itemId: string): string {
  let root: string;
  try { root = rootOf(app, itemId); } catch { return ""; }
  const r = one<{ phase: string | null; watch_until: string | null }>(app.db, "select phase, watch_until from items where id = ?", root);
  if (r?.phase !== "watching") return "";
  const until = r.watch_until ? (() => { const p = zonedParts(r.watch_until!, app.config.timezone); return `，观察到 ${p.month} 月 ${p.day} 日`; })() : "";
  return `这件事已经上线，在观察期${until}：只关心报错、用户反馈和数据异常，普通讨论不用处理。`;
}

export function itemStateText(app: App, itemId: string): string {
  let item;
  try {
    item = getItem(app, itemId);
  } catch {
    return "";
  }
  const flow = one<{ definition: string; ended_at: string | null }>(app.db, "select definition, ended_at from item_flows where item_id = ?", itemId);
  let stage = "";
  if (flow && !flow.ended_at) {
    const names = new Map(((JSON.parse(flow.definition) as { stages?: { id: string; name: string }[] }).stages ?? []).map((s) => [s.id, s.name]));
    const at = one<{ stage_id: string; state: string }>(app.db, "select stage_id, state from item_stages where item_id = ? and state in ('doing','gated','blocked','stale') order by since desc limit 1", itemId);
    stage = at ? `，流程走到「${names.get(at.stage_id) ?? at.stage_id}」（${STAGE_STATE[at.state]}）` : "，流程在走";
  }
  const changes = all<{ type: string; status: string; summary: string; due: string | null }>(app.db, "select type, status, summary, due from item_changes where item_id = ? order by at desc, id desc limit 3", itemId);
  return [
    "## 这件事现在的样子",
    "",
    `- 事项 ${item.id}「${truncate(item.title, 80)}」[${item.kind}/${item.status}]，截止 ${item.dueAt ?? "未定"}${stage}`,
    ...(changes.length ? [`- 最近的变化：${changes.map((c) => `[${c.type}/${c.status}] ${truncate(c.summary, 80)}${c.due ? `（${c.due}）` : ""}`).join("；")}`] : []),
    "- 群里有人问这件事的进展、范围、时间，按这些和 read_item 查到的回答；提议还没被本人定下的，不说成已经定了。",
  ].join("\n");
}
