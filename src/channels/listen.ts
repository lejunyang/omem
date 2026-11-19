import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";
import { captureSpace } from "../core/capture-space.ts";
import { addMessage, chatSettings, createThread, findThread, setChatSettings, updateThread, type WatchBrief, type WatchRule } from "../agents/threads.ts";
import { findAgentSpec } from "../agents/specs.ts";

/**
 * 「关注」: what the assistant keeps an eye on, with a context of its own. Three anchors, one model:
 *
 * - place: one or several Feishu groups (an on-call group, the groups of a requirement);
 * - item: a matter, an item with the groups and conversations linked to it (flows/follow.ts reads its
 *   changes; with replies on it also answers about the matter in those groups);
 * - default: the built-in “someone looks for you” (mentions/), every private chat and @ of the owner.
 *
 * Each has a brief (what to handle, what to leave, what a reply must have; the owner confirms it), a set
 * of knobs instead of fixed rules, one handling conversation (channel `listen`, key = its id) that reads
 * its groups in one context, and cases (reply_samples.context_id) and lessons (listen-coach) of its own.
 * A group may be in several 关注 at once: each gets the messages, only one replies to a message (`lead`).
 *
 * The chat index lives in chat_settings (channel `lark-watch`: `contexts`, `spaceId`), so capture and the
 * “someone looks for you” path find a chat's 关注 with one lookup.
 */
export type ListenKind = "place" | "item" | "default";
export type ListenKnobs = {
  /** addressed: only messages for the owner or the bot; relevant: what the screening finds related to the brief; all: everything. */
  listen: "addressed" | "relevant" | "all";
  /** Only messages matching this (a regular expression), before any screening. */
  pattern?: string;
  /** answer: only what can be answered at once; investigate: look into what is worth it (skills, logs, code). */
  depth: "answer" | "investigate";
  /** none: never post; draft: the owner sees each reply first; auto: post directly. */
  reply: "none" | "draft" | "auto";
  /** The owner asked for direct replies: drafts first until they say the replies may go out by themselves. */
  wantsAuto?: boolean;
  /** Drafts in a row sent as drafted before the host asks about going direct. */
  promoteAfter: number;
  promoteAskedAt?: string;
  /** Messages that ask the owner or need their decision: tell the owner only / draft for the owner / may answer. */
  ownerAsks: "notify" | "draft" | "answer";
  /** Messages for someone else or another bot: leave them / handle them too. */
  othersAsks: "leave" | "handle";
  /** Questions from before the 关注 began that nobody answered yet: not handled / the last 24 or 72 hours. */
  backlog: "off" | "24h" | "72h";
  /** Least probability that a batch concerns the brief for it to be looked at; unset: the decision settings' default. */
  strictness?: number;
  /** Batches handled a day at most. */
  perDay: number;
  /** A meeting in its groups (or, for the default, one the owner joins): ask whether to listen / listen / leave it. */
  meetings: "off" | "ask" | "listen";
  /** Meeting topics the owner said not to ask about again (“这个会以后不用问”, channels/listen-meetings.ts). */
  meetingSkip?: string[];
  /** Read what the other 关注 are discussing (read only, never posting across). */
  seeOthers: boolean;
  /** Minutes new messages are collected before the handler looks. */
  batchMinutes: number;
  /** false: every batch goes to the handler unscreened. */
  prefilter?: boolean;
};
export type ListenContext = {
  id: string;
  kind: ListenKind;
  name: string;
  chats: string[];
  itemId: string | null;
  spec: string;
  spaceId: string | null;
  conversationId: string | null;
  note?: string;
  brief?: WatchBrief;
  knobs: ListenKnobs;
  status: "active" | "paused";
  /** When it began: what came before is context, and is handled only within `backlog`. */
  since: string;
  /** When listen-coach last wrote its lessons. */
  playbookAt?: string;
  /** A matter's 关注 made because a flow started on the item (listen-items.ts): it ends with the flow, until the owner takes it on. */
  byFlow?: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const LISTEN_CHANNEL = "listen";
export const DEFAULT_CONTEXT_ID = "listen_default";
export const DEFAULT_BATCH_MINUTES = 10;
export const DEFAULT_KNOBS: ListenKnobs = {
  listen: "relevant",
  depth: "investigate",
  reply: "draft",
  promoteAfter: 5,
  ownerAsks: "notify",
  othersAsks: "leave",
  backlog: "24h",
  perDay: 20,
  meetings: "ask",
  seeOthers: false,
  batchMinutes: DEFAULT_BATCH_MINUTES,
};
const KIND_KNOBS: Record<ListenKind, Partial<ListenKnobs>> = {
  place: {},
  item: { reply: "none", listen: "relevant" },
  default: { listen: "addressed" },
};
/** Who replies when several 关注 got the same message: the most specific. */
const PRIORITY: Record<ListenKind, number> = { item: 0, place: 1, default: 2 };

type Row = {
  id: string; kind: ListenKind; name: string; chats: string; item_id: string | null; spec: string; space_id: string | null;
  conversation_id: string | null; settings: string; status: "active" | "paused"; expires_at: string | null; created_at: string; updated_at: string;
};
type Stored = { note?: string; brief?: WatchBrief; knobs?: Partial<ListenKnobs>; since?: string; playbookAt?: string; byFlow?: boolean };

function toContext(r: Row): ListenContext {
  const s = json<Stored>(r.settings, {});
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    chats: json<string[]>(r.chats, []),
    itemId: r.item_id,
    spec: r.spec,
    spaceId: r.space_id,
    conversationId: r.conversation_id,
    note: s.note,
    brief: s.brief,
    knobs: { ...DEFAULT_KNOBS, ...KIND_KNOBS[r.kind], ...s.knobs },
    status: r.status,
    since: s.since ?? r.created_at,
    playbookAt: s.playbookAt,
    ...(s.byFlow ? { byFlow: true } : {}),
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getContext(app: App, id: string): ListenContext | null {
  const r = one<Row>(app.db, "select * from listen_contexts where id = ?", id);
  return r ? toContext(r) : null;
}
export function requireContext(app: App, id: string): ListenContext {
  const c = getContext(app, id);
  if (!c) throw new HttpError(404, `没有这个关注：${id}`);
  return c;
}

const live = (c: ListenContext, at = now()) => c.status === "active" && (!c.expiresAt || c.expiresAt > at);

export function listContexts(app: App, opts: { kind?: ListenKind; activeOnly?: boolean } = {}): ListenContext[] {
  const rows = all<Row>(app.db, `select * from listen_contexts ${opts.kind ? "where kind = ?" : ""} order by kind, created_at`, ...(opts.kind ? [opts.kind] : []));
  return rows.map(toContext).filter((c) => !opts.activeOnly || live(c));
}

/** The active 关注 a group is in (places and matters), the one that replies first. */
export function contextsOfChat(app: App, chatId: string): ListenContext[] {
  return all<Row>(app.db, "select * from listen_contexts where kind != 'default' and exists (select 1 from json_each(listen_contexts.chats) where value = ?)", chatId)
    .map(toContext)
    .filter((c) => live(c))
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt.localeCompare(b.createdAt));
}

/** Whether any 关注 reads this group (one indexed lookup: the chat index). */
export function chatListened(app: App, chatId: string) {
  return (chatSettings(app, "lark-watch", chatId).contexts ?? []).length > 0;
}

export function contextOfConversation(app: App, conversationId: string | null | undefined): ListenContext | null {
  if (!conversationId) return null;
  const r = one<Row>(app.db, "select * from listen_contexts where conversation_id = ?", conversationId);
  return r ? toContext(r) : null;
}

/** Where the handler may post: its groups (none when it only reads), as drafts unless replies are direct. */
export function larkScopeOf(c: ListenContext) {
  return { chats: c.knobs.reply === "none" ? [] : c.chats, draft: c.knobs.reply !== "auto" };
}

export type ContextInput = {
  id?: string;
  kind: ListenKind;
  name?: string;
  chats?: string[];
  itemId?: string | null;
  spec?: string;
  spaceId?: string | null;
  note?: string;
  brief?: WatchBrief;
  knobs?: Partial<ListenKnobs>;
  status?: "active" | "paused";
  since?: string;
  playbookAt?: string;
  /** true: made for a flow (ends with it); false: the owner's own from now on. */
  byFlow?: boolean;
  expiresAt?: string | null;
  /** An existing conversation to keep (a watch moved here). */
  conversationId?: string;
};

/** Create or update a 关注; its conversation, posting scope and the chat index follow. */
export function saveContext(app: App, input: ContextInput, chatName: (chatId: string) => string = (id) => id): ListenContext {
  const prev = input.id ? getContext(app, input.id) : null;
  const kind = prev?.kind ?? input.kind;
  const chats = [...new Set(input.chats ?? prev?.chats ?? [])];
  if (kind === "place" && !chats.length) throw new HttpError(400, "关注至少要有一个群");
  if (kind === "item" && !(input.itemId ?? prev?.itemId)) throw new HttpError(400, "事情型关注要关联一个事项");
  const spec = input.spec ?? prev?.spec ?? "assistant";
  if (spec !== "assistant" && !findAgentSpec(app, spec)) throw new HttpError(400, `没有 Agent 档案 ${spec}：先建好处理它的 Agent（说明怎么处理、用哪些技能和工具），或交给 assistant`);
  const knobs = { ...(prev?.knobs ?? { ...DEFAULT_KNOBS, ...KIND_KNOBS[kind] }), ...input.knobs };
  if (knobs.pattern) {
    try {
      new RegExp(knobs.pattern);
    } catch {
      throw new HttpError(400, `关键词不是有效的正则：${knobs.pattern}`);
    }
  }
  if (knobs.strictness !== undefined && (knobs.strictness < 0.5 || knobs.strictness > 0.95)) throw new HttpError(400, "strictness 在 0.5 到 0.95 之间");
  const at = now();
  const id = prev?.id ?? input.id ?? (kind === "default" ? DEFAULT_CONTEXT_ID : newId("ctx"));
  const name = (input.name ?? prev?.name ?? (chats.length ? chats.map(chatName).join("、") : "关注")).slice(0, 80);
  const stored: Stored = {
    note: input.note ?? prev?.note,
    brief: input.brief ?? prev?.brief,
    knobs: diffKnobs(knobs, kind),
    since: input.since ?? prev?.since ?? at,
    playbookAt: input.playbookAt ?? prev?.playbookAt,
    ...((input.byFlow ?? prev?.byFlow) ? { byFlow: true } : {}),
  };
  const spaceId = input.spaceId === undefined ? (prev?.spaceId ?? null) : input.spaceId;
  const expiresAt = input.expiresAt === undefined ? (prev?.expiresAt ?? null) : input.expiresAt;
  const status = input.status ?? prev?.status ?? "active";
  tx(app.db, () => {
    run(
      app.db,
      `insert into listen_contexts(id,kind,name,chats,item_id,spec,space_id,conversation_id,settings,status,expires_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(id) do update set name = excluded.name, chats = excluded.chats, item_id = excluded.item_id, spec = excluded.spec, space_id = excluded.space_id,
         conversation_id = coalesce(excluded.conversation_id, listen_contexts.conversation_id), settings = excluded.settings, status = excluded.status,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      id, kind, name, JSON.stringify(chats), input.itemId ?? prev?.itemId ?? null, spec, spaceId, input.conversationId ?? prev?.conversationId ?? null,
      JSON.stringify(stored), status, expiresAt, prev?.createdAt ?? at, at,
    );
  });
  const ctx = getContext(app, id)!;
  if (kind !== "default") ensureConversation(app, ctx);
  indexChats(app, [...new Set([...(prev?.chats ?? []), ...chats])]);
  return getContext(app, id)!;
}

/** Only what differs from the defaults is stored, so a better default reaches old 关注. */
function diffKnobs(k: ListenKnobs, kind: ListenKind): Partial<ListenKnobs> {
  const base = { ...DEFAULT_KNOBS, ...KIND_KNOBS[kind] } as Record<string, unknown>;
  return Object.fromEntries(Object.entries(k).filter(([key, v]) => v !== undefined && base[key] !== v)) as Partial<ListenKnobs>;
}

/** The handling conversation of a 关注: made on first need, its posting scope and title kept in step. */
function ensureConversation(app: App, ctx: ListenContext) {
  const spaceId = ctx.spaceId ?? (ctx.chats[0] ? captureSpace(app, ctx.chats[0]) : "personal");
  const settings = { lark: larkScopeOf(ctx), ...(ctx.spec !== "assistant" ? { spec: ctx.spec } : {}), listen: ctx.id };
  const t = ctx.conversationId ? findThread(app, ctx.conversationId) : null;
  if (t) {
    run(app.db, "update conversations set channel = ?, external_id = ?, status = 'active' where id = ?", LISTEN_CHANNEL, ctx.id, t.id);
    const { spec: _drop, ...rest } = t.settings as Record<string, unknown>;
    updateThread(app, t.id, { title: ctx.name, settings: { ...rest, ...settings } as never });
    return t.id;
  }
  const created = createThread(app, { spaceId, channel: LISTEN_CHANNEL, key: ctx.id, title: ctx.name, settings: settings as never });
  run(app.db, "update listen_contexts set conversation_id = ? where id = ?", created.id, ctx.id);
  return created.id;
}

/**
 * chat_settings(`lark-watch`) of these groups: which 关注 read them, and the space their material goes to
 * (a place's: a matter's 关注 lives in the item's space, which does not move where its groups are kept).
 */
function indexChats(app: App, chats: string[]) {
  for (const chatId of chats) {
    const mine = contextsOfChat(app, chatId);
    const place = mine.find((c) => c.kind === "place" && c.spaceId);
    setChatSettings(app, "lark-watch", chatId, { contexts: mine.length ? mine.map((c) => c.id) : undefined, spaceId: place?.spaceId ?? undefined, watch: undefined, lark: undefined, spec: undefined, mode: undefined, idleHours: undefined });
  }
}

export function removeContext(app: App, id: string) {
  const c = requireContext(app, id);
  if (c.kind === "default") throw new HttpError(400, "默认的“有人找你”不能删除，可以在设置里关掉");
  run(app.db, "delete from listen_contexts where id = ?", id);
  if (c.conversationId) run(app.db, "update conversations set status = 'archived' where id = ?", c.conversationId);
  indexChats(app, c.chats);
}

/** 关注 past their time stop (heartbeat); the owner is told. */
export async function expireContexts(app: App, at = now()) {
  const due = listContexts(app).filter((c) => c.status === "active" && c.expiresAt && c.expiresAt <= at);
  if (!due.length) return 0;
  const { notify } = await import("../core/notify.ts");
  const { localStamp } = await import("../core/util.ts");
  for (const c of due) {
    saveContext(app, { id: c.id, kind: c.kind, status: "paused" });
    notify(app, { title: `不再关注「${c.name}」了`, body: `到了设定的时间（${localStamp(c.expiresAt!, app.config.timezone)}）。还要继续就再说一声，或在 连接 → 飞书会话 里打开。` });
  }
  return due.length;
}

/** The built-in “someone looks for you”: its brief, cases and lessons hang on this row. */
export function defaultContext(app: App): ListenContext {
  return getContext(app, DEFAULT_CONTEXT_ID) ?? saveContext(app, { kind: "default", name: "有人找你" });
}

/** A matter's 关注, made when needed (a flow starts, the owner turns it on). */
export function itemContext(app: App, itemId: string): ListenContext | null {
  const r = one<Row>(app.db, "select * from listen_contexts where kind = 'item' and item_id = ? order by created_at limit 1", itemId);
  return r ? toContext(r) : null;
}

/**
 * Groups watched the old way (chat_settings `lark-watch.watch`) become place 关注, keeping their
 * conversation; their decision log becomes cases. Idempotent: a moved watch leaves no `watch` behind.
 */
export function migrateWatches(app: App) {
  const rows = all<{ chat_id: string; settings: string }>(app.db, "select chat_id, settings from chat_settings where channel = 'lark-watch' and json_extract(settings, '$.watch') is not null");
  let moved = 0;
  for (const r of rows) {
    const w = json<{ watch?: WatchRule & { log?: { at: string; decision: string; reason?: string; ask?: string; draft?: string; final?: string; messageId?: string }[] } }>(r.settings, {}).watch;
    if (!w) continue;
    const conv = one<{ id: string; title: string }>(app.db, "select id, title from conversations where channel = 'lark-watch' and external_id = ? order by updated_at desc limit 1", r.chat_id);
    const listen: ListenKnobs["listen"] = w.on === "mention" ? "addressed" : "relevant";
    const ctx = saveContext(app, {
      kind: "place",
      name: conv?.title || r.chat_id,
      chats: [r.chat_id],
      spec: w.spec,
      spaceId: w.spaceId ?? null,
      note: w.note,
      brief: w.brief,
      knobs: {
        listen,
        ...(w.on === "keyword" && w.pattern ? { pattern: w.pattern } : {}),
        reply: w.reply,
        ...(w.wantsAuto ? { wantsAuto: true } : {}),
        ...(w.promoteAskedAt ? { promoteAskedAt: w.promoteAskedAt } : {}),
        batchMinutes: w.batchMinutes ?? DEFAULT_BATCH_MINUTES,
        ...(w.prefilter !== undefined ? { prefilter: w.prefilter } : {}),
        // An old watch never looked back: keep it that way.
        backlog: "off",
      },
      since: w.since,
      expiresAt: w.expiresAt ?? null,
      conversationId: conv?.id,
    });
    for (const d of w.log ?? []) {
      run(
        app.db,
        `insert into reply_samples(id,handle_run,channel,chat_id,chat_kind,chat_name,asker_name,ask,last_ms,draft,decision,final,reason,decided_at,created_at,context_id,source,reply_id)
         values(?,null,'lark',?,'group',?,?,?,?,?,?,?,?,?,?,?,'watch',?)`,
        newId("rs"), r.chat_id, ctx.name, (d.ask ?? "").split("：")[0] ?? "", d.ask ?? "", Date.parse(d.at) || Date.now(), d.draft ?? null,
        d.decision, d.final ?? null, d.reason ?? null, d.at, d.at, ctx.id, d.messageId ?? null,
      );
    }
    moved++;
  }
  return moved;
}

/** Note in a 关注's conversation that the host did something there (no turn of its own). */
export function noteInContext(app: App, ctx: ListenContext, text: string) {
  if (ctx.conversationId && findThread(app, ctx.conversationId)) addMessage(app, ctx.conversationId, "user", text, null, { command: true });
}
