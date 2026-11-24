import { instanceOfThread } from "../situations/instances.ts";
import type { App } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
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
 * - situation: a recurring situation, with a separate conversation for each instance;
 * - default: the built-in “someone looks for you” (mentions/), every private chat and @ of the owner.
 *
 * Each has a brief (what to handle, what to leave, what a reply must have; the owner confirms it), a set
 * of knobs instead of fixed rules, an ordinary watch conversation (channel `listen`, key = its id) that reads
 * its groups in one context, and cases (reply_samples.context_id) and lessons (listen-coach) of its own.
 * A group may be in several 关注 at once: each gets the messages, only one replies to a message (`lead`).
 *
 * The chat index lives in chat_settings (channel `lark-watch`: `contexts`, `spaceId`), so capture and the
 * “someone looks for you” path find a chat's 关注 with one lookup.
 */
export type ListenKind = "place" | "item" | "situation" | "default";
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
  /** Planned: read what the other 关注 are discussing (read only, never posting across). Stored and accepted, nothing reads it yet; the web does not show it. */
  seeOthers: boolean;
  /** A matter's 关注: push it on about once a day — off / suggest (three suggestions at most) / act (the read-only part done at once) (listen-assist.ts). */
  assist?: "off" | "suggest" | "act";
  /** Minutes new messages are collected before the handler looks. */
  batchMinutes: number;
  /** false: every batch goes to the handler unscreened. */
  prefilter?: boolean;
  /**
   * 快速通道 (docs/v2/first-look.md, channels/listen-first-look.ts): each message is looked at as it comes
   * — screened, the `probes` run, a fast model's first look — and the batch runs at once only when that
   * asks to look deeper. `firstTo`: where the first look's message goes; unset, settings `firstLook.to`.
   */
  firstLook?: boolean;
  probes?: string[];
  firstTo?: "chat" | "dm" | "ephemeral";
};
export type ListenContext = {
  id: string;
  kind: ListenKind;
  userId: string;
  recognize?: string;
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
  /** Where its lessons are (fixed at the first write, so a rename keeps them). */
  playbookFile?: string;
  /** A matter's 关注 made because a flow started on the item (listen-items.ts): it ends with the flow, until the owner takes it on. */
  byFlow?: boolean;
  /** Groups a rule handed over with their first message (`context` action `adopt`), and when: let go when their problems are closed and they went quiet. */
  adopted?: Record<string, string>;
  /**
   * A matter's 关注: its groups are its items' linked chats (listen-items.ts), with the ones the owner added
   * here and without the ones they took out here. Kept apart so the next sync with the items keeps both.
   */
  added?: string[];
  dropped?: string[];
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
  item: { reply: "none", listen: "relevant", assist: "act" },
  situation: { reply: "none", meetings: "off", backlog: "off" },
  default: { listen: "addressed" },
};
/** Who replies when several 关注 got the same message: the most specific. */
const PRIORITY: Record<ListenKind, number> = { item: 0, situation: 0, place: 1, default: 2 };

type Row = {
  id: string; kind: ListenKind; user_id: string; name: string; chats: string; item_id: string | null; spec: string; space_id: string | null;
  conversation_id: string | null; settings: string; status: "active" | "paused"; expires_at: string | null; created_at: string; updated_at: string;
};
type Stored = { recognize?: string; note?: string; brief?: WatchBrief; knobs?: Partial<ListenKnobs>; since?: string; playbookAt?: string; playbookFile?: string; byFlow?: boolean; adopted?: Record<string, string>; added?: string[]; dropped?: string[] };

function toContext(r: Row): ListenContext {
  const s = json<Stored>(r.settings, {});
  return {
    id: r.id,
    kind: r.kind,
    userId: r.user_id,
    ...(s.recognize ? { recognize: s.recognize } : {}),
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
    playbookFile: s.playbookFile,
    ...(s.byFlow ? { byFlow: true } : {}),
    ...(s.adopted && Object.keys(s.adopted).length ? { adopted: s.adopted } : {}),
    ...(s.added?.length ? { added: s.added } : {}),
    ...(s.dropped?.length ? { dropped: s.dropped } : {}),
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

/**
 * A 关注 by its id, or by the name the owner calls it (“把退款值班的关注改成只看 @ 我的”): the one with that
 * name, else the one whose name contains it. Several or none: an error naming the candidates, so the
 * caller can ask or pass the id.
 */
export function contextByIdOrName(app: App, key: string): ListenContext {
  const byId = getContext(app, key.trim());
  if (byId) return byId;
  // “「退款值班」的关注”, “退款值班关注”, “退款值班”: the name itself.
  const k = key.trim().replace(/(?<=.)的?关注$/, "").trim().replace(/^「(.*)」$/, "$1").trim();
  const every = listContexts(app);
  const exact = every.filter((c) => c.name === k);
  if (exact.length === 1) return exact[0];
  const near = every.filter((c) => c.name.toLowerCase().includes(k.toLowerCase()));
  if (near.length === 1) return near[0];
  const named = (list: ListenContext[]) => list.slice(0, 20).map((c) => `${c.id}「${c.name}」${c.status === "active" ? "" : "（已暂停）"}`).join("、");
  if (near.length) throw new HttpError(400, `有 ${near.length} 个关注的名字里有「${k}」，传 id 指明是哪个：${named(near)}`);
  throw new HttpError(404, `没有叫「${k}」的关注。现有的：${named(every) || "（没有）"}`);
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
  if (r) return toContext(r);
  const i = instanceOfThread(app, conversationId);
  const c = i && getContext(app, i.contextId);
  return c && c.userId === i.userId ? { ...c, conversationId, itemId: i.itemId, spaceId: i.spaceId } : null;
}

/** Where the handler may post: its groups (none when it only reads), as drafts unless replies are direct. */
export function larkScopeOf(c: ListenContext) {
  return { chats: c.knobs.reply === "none" ? [] : c.chats, draft: c.knobs.reply !== "auto" };
}

export type ContextInput = {
  id?: string;
  kind: ListenKind;
  recognize?: string;
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
  playbookFile?: string;
  /** true: made for a flow (ends with it); false: the owner's own from now on. */
  byFlow?: boolean;
  adopted?: Record<string, string>;
  /** A matter's 关注: groups added / taken out by the owner beyond its items' (an empty list clears it). */
  added?: string[];
  dropped?: string[];
  expiresAt?: string | null;
  /** An existing conversation to keep (a watch moved here). */
  conversationId?: string;
};

/** Create or update a 关注; its conversation, posting scope and the chat index follow. */
export function saveContext(app: App, input: ContextInput, chatName: (chatId: string) => string = (id) => id): ListenContext {
  const prev = input.id ? getContext(app, input.id) : null;
  const kind = prev?.kind ?? input.kind;
  const chats = kind === "situation" ? [] : [...new Set(input.chats ?? prev?.chats ?? [])];
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
  const storedKnobs = diffKnobs(knobs, kind);
  // An explicit choice stays explicit even when it equals the current default.
  const wasSet = prev && json<Stored>(one<{ settings: string }>(app.db, "select settings from listen_contexts where id=?", prev.id)?.settings, {}).knobs?.assist !== undefined;
  if (kind === "item" && (input.knobs?.assist !== undefined || wasSet)) storedKnobs.assist = knobs.assist;
  const stored: Stored = {
    recognize: input.recognize ?? prev?.recognize,
    note: input.note ?? prev?.note,
    brief: input.brief ?? prev?.brief,
    knobs: storedKnobs,
    since: input.since ?? prev?.since ?? at,
    playbookAt: input.playbookAt ?? prev?.playbookAt,
    playbookFile: input.playbookFile ?? prev?.playbookFile,
    ...((input.byFlow ?? prev?.byFlow) ? { byFlow: true } : {}),
    ...(() => {
      // Adopted groups no longer among its groups (the owner removed one) are not adopted any more.
      const adopted = Object.fromEntries(Object.entries(input.adopted ?? prev?.adopted ?? {}).filter(([c]) => chats.includes(c)));
      return Object.keys(adopted).length ? { adopted } : {};
    })(),
    ...(() => {
      const added = input.added ?? prev?.added ?? [], dropped = input.dropped ?? prev?.dropped ?? [];
      return { ...(added.length ? { added } : {}), ...(dropped.length ? { dropped } : {}) };
    })(),
  };
  const spaceId = input.spaceId === undefined ? (prev?.spaceId ?? null) : input.spaceId;
  const expiresAt = input.expiresAt === undefined ? (prev?.expiresAt ?? null) : input.expiresAt;
  const status = input.status ?? prev?.status ?? "active";
  withinTx(app.db, () => {
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
  if (kind !== "default" && kind !== "situation") ensureConversation(app, ctx);
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
  const settings = { lark: larkScopeOf(ctx), spec: ctx.spec !== "assistant" ? ctx.spec : undefined, listen: ctx.id };
  const t = ctx.conversationId ? findThread(app, ctx.conversationId) : null;
  if (t) {
    run(app.db, "update conversations set channel = ?, external_id = ?, status = 'active' where id = ?", LISTEN_CHANNEL, ctx.id, t.id);
    const { spec: _drop, ...rest } = t.settings as Record<string, unknown>;
    updateThread(app, t.id, { title: ctx.name, settings: { ...rest, ...settings } as never });
    return t.id;
  }
  const userId = ctx.itemId ? one<{ user_id: string }>(app.db, "select user_id from items where id=?", ctx.itemId)?.user_id : undefined;
  const created = createThread(app, { spaceId, userId, channel: LISTEN_CHANNEL, key: ctx.id, title: ctx.name, settings: settings as never });
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

/** Only settings, not activity times. Keep the stored form to restore absent fields too. */
export function contextRevision(app: App, id: string) {
  const r = one<Row>(app.db, "select * from listen_contexts where id = ?", id);
  if (!r) return null;
  const { created_at: _created, updated_at: _updated, settings, ...fields } = r;
  return { ...fields, settings: json<Stored>(settings, {}) };
}

export function restoreContextRevision(app: App, id: string, prior: ReturnType<typeof contextRevision>) {
  const current = requireContext(app, id);
  if (!prior) return removeContext(app, id);
  run(app.db, `update listen_contexts set name=?, chats=?, item_id=?, spec=?, space_id=?, conversation_id=?, settings=?, status=?, expires_at=?, updated_at=? where id=?`,
    prior.name, prior.chats, prior.item_id, prior.spec, prior.space_id, prior.conversation_id, JSON.stringify(prior.settings), prior.status, prior.expires_at, now(), id);
  const restored = requireContext(app, id);
  if (restored.kind !== "default") ensureConversation(app, restored);
  indexChats(app, [...new Set([...current.chats, ...restored.chats])]);
}

/** A place's groups adopted from rules go back this long after their last message or problem, once none is open. */
export const ADOPT_RELEASE_MS = 3 * 86400_000;

/** A rule hands a group's first message over with `adopt`: the group joins the 关注 (no-op when it is already one of its groups). */
export function adoptChat(app: App, c: ListenContext, chatId: string): boolean {
  if (c.kind !== "place" || c.chats.includes(chatId)) return false;
  saveContext(app, { id: c.id, kind: c.kind, chats: [...c.chats, chatId], adopted: { ...(c.adopted ?? {}), [chatId]: now() } });
  return true;
}

/** Adopted groups whose problems are all closed and that went quiet go back (heartbeat, with expireContexts). */
export function releaseAdopted(app: App, at = Date.now()) {
  const out: { context: string; chat: string }[] = [];
  for (const c of listContexts(app, { kind: "place" })) {
    const keep = { ...(c.adopted ?? {}) };
    for (const [chatId, since] of Object.entries(c.adopted ?? {})) {
      if (one(app.db, "select 1 from listen_problems where context_id = ? and chat_id = ? and state != 'closed'", c.id, chatId)) continue;
      const lastProblem = one<{ at: string | null }>(app.db, "select max(updated_at) at from listen_problems where context_id = ? and chat_id = ?", c.id, chatId)?.at;
      const lastMessage = one<{ ms: number | null }>(app.db, "select max(create_ms) ms from lark_messages where chat_id = ?", chatId)?.ms ?? 0;
      const last = Math.max(Date.parse(since), lastProblem ? Date.parse(lastProblem) : 0, lastMessage);
      if (at - last < ADOPT_RELEASE_MS) continue;
      delete keep[chatId];
      out.push({ context: c.id, chat: chatId });
    }
    if (Object.keys(keep).length === Object.keys(c.adopted ?? {}).length) continue;
    const chats = c.chats.filter((x) => !(x in (c.adopted ?? {})) || x in keep);
    // The last group of a place cannot go: it stays until another comes or the owner removes the 关注.
    if (!chats.length) continue;
    saveContext(app, { id: c.id, kind: c.kind, chats, adopted: keep });
  }
  return out;
}

/** 关注 past their time stop (heartbeat); the owner is told. */
export async function expireContexts(app: App, at = now()) {
  const due = listContexts(app).filter((c) => c.status === "active" && c.expiresAt && c.expiresAt <= at);
  if (!due.length) return 0;
  const { notify } = await import("../core/notify.ts");
  const { localStamp } = await import("../core/util.ts");
  for (const c of due) {
    if (c.kind === "situation") await (await import("../situations/settings.ts")).saveSituation(app, c.userId, { id: c.id, status: "paused" });
    else saveContext(app, { id: c.id, kind: c.kind, status: "paused" });
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
  if (ctx.conversationId && findThread(app, ctx.conversationId)) addMessage(app, ctx.conversationId, "user", text, null, { command: true, transcriptOnly: true });
}
