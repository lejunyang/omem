import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { now } from "../core/util.ts";

/**
 * Where a piece of work is followed now ("home"). A piece of work is a line of runs: the run that
 * started it (an ask the owner sent, a rule's agent…) and everything started from it — coding
 * rounds and their hand-offs, multi-agent rounds and coordination turns, wake-ups and the turns
 * they start all hang off it through `parent_id`. Its home starts where it was asked; when the
 * owner carries on with the same work somewhere else (replies to one of its messages there, or
 * their turn there steers one of its runs), the home moves there, and everything the work says by
 * itself from then on — results, hand-offs, coordination replies, wake-ups — goes there.
 *
 * Kept on the line's first run (`output.home`): { conversationId, anchor, movedAt }. `anchor` is
 * the work's latest Feishu message in its home, the only message a later post may quote; a work
 * without one posts without quoting rather than quoting whatever the chat said last.
 * (`output.codeReportTo` is the older form, a coding delegation's home without a time.)
 */
export type Home = {
  /** The line's first run, where the home is kept. */
  root: string;
  title: string;
  /** The conversation the work was asked in (null: started outside any conversation). */
  startedIn: string | null;
  conversationId: string;
  /** The work's latest Feishu message in its home conversation, if known. */
  anchor: string | null;
  /** When the owner moved it (absent: never moved; "" an older move without a time). */
  movedAt?: string;
};

type Stored = { conversationId: string; anchor?: string | null; movedAt?: string };

/** The first run of the line a run belongs to (itself when nothing started it). */
export function lineRoot(app: App, runId: string): string | null {
  let id: string | null = runId;
  let last: string | null = null;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const r: { parent_id: string | null } | undefined = one<{ parent_id: string | null }>(app.db, "select parent_id from runs where id = ?", id);
    if (!r) break;
    last = id;
    id = r.parent_id;
  }
  return last;
}

const live = (app: App, id: string | null | undefined): id is string =>
  !!id && !!one(app.db, "select 1 from conversations where id = ? and status = 'active'", id);

export function homeOf(app: App, runId: string | null | undefined): Home | null {
  if (!runId) return null;
  const root = lineRoot(app, runId);
  if (!root) return null;
  const r = one<{ title: string; input: string; output: string | null }>(app.db, "select title, input, output from runs where id = ?", root)!;
  const input = JSON.parse(r.input || "{}") as { conversationId?: string; threadId?: string };
  const out = (r.output ? JSON.parse(r.output) : {}) as { home?: Stored; codeReportTo?: string };
  const startedIn = input.conversationId ?? input.threadId ?? null;
  // A home whose conversation is gone (archived, deleted) falls back to where the work started.
  const stored = out.home && live(app, out.home.conversationId) ? out.home : undefined;
  const legacy = !stored && live(app, out.codeReportTo) ? out.codeReportTo : undefined;
  const conversationId = stored?.conversationId ?? legacy ?? (live(app, startedIn) ? startedIn : null);
  if (!conversationId) return null;
  let anchor = stored?.anchor ?? null;
  // Nothing posted yet: the owner's own message that started it, where it started.
  if (!anchor && conversationId === startedIn)
    anchor = one<{ id: string | null }>(app.db, "select json_extract(meta, '$.externalId') id from messages where run_id = ? and conversation_id = ? and role = 'user' and json_extract(meta, '$.externalId') is not null order by created_at desc limit 1", root, conversationId)?.id ?? null;
  return { root, title: r.title, startedIn, conversationId, anchor, ...(stored?.movedAt !== undefined ? { movedAt: stored.movedAt } : legacy ? { movedAt: "" } : {}) };
}

function store(app: App, root: string, home: Stored) {
  run(app.db, "update runs set output = json_set(coalesce(output, '{}'), '$.home', json(?)) where id = ?", JSON.stringify(home), root);
}

/**
 * The owner carries on with this work in `conversationId`: it is followed there from now on.
 * `anchor`: the owner's message there (later posts reply to it). True when it moved.
 */
export function moveHome(app: App, runId: string, conversationId: string, anchor?: string | null, opts: { pin?: boolean } = {}): boolean {
  const h = homeOf(app, runId);
  if (!h || !live(app, conversationId)) return false;
  // `pin`: also when it is already home, as a move: what the work would otherwise route elsewhere
  // (a work topic of its own) comes here too.
  if (h.conversationId === conversationId && opts.pin && h.movedAt === undefined) {
    store(app, h.root, { conversationId, anchor: anchor ?? h.anchor, movedAt: now() });
    return true;
  }
  if (h.conversationId === conversationId) {
    if (anchor) store(app, h.root, { conversationId, anchor, ...(h.movedAt ? { movedAt: h.movedAt } : {}) });
    return false;
  }
  store(app, h.root, { conversationId, anchor: anchor ?? null, movedAt: now() });
  return true;
}

/** A message of this work was posted in `conversationId`: when that is its home, later posts quote it. */
export function noteAnchor(app: App, runId: string | null | undefined, conversationId: string, messageId: string | undefined) {
  if (!runId || !messageId) return;
  const h = homeOf(app, runId);
  if (!h || h.conversationId !== conversationId) return;
  store(app, h.root, { conversationId, anchor: messageId, ...(h.movedAt ? { movedAt: h.movedAt } : {}) });
}

/** The only message a post of this work into `conversationId` may quote (null: post without quoting). */
export function replyAnchor(app: App, runId: string | null | undefined, conversationId: string): string | null {
  const h = homeOf(app, runId);
  if (!h || h.conversationId !== conversationId || !h.anchor) return null;
  return rootOfOtherTopic(app, h.anchor, h.root) ? null : h.anchor;
}

/**
 * Where something planned for `planned` (at `plannedAt`) goes: the work's home when the owner moved
 * the work elsewhere after it was planned, else where it was planned.
 */
export function homeFor(app: App, runId: string | null | undefined, planned: string, plannedAt: string): string {
  const h = homeOf(app, runId);
  if (!h || h.conversationId === planned || !h.movedAt || h.movedAt <= plannedAt) return planned;
  return h.conversationId;
}

/** The run (of a work) a Feishu message was posted for, or the run the owner's message started. */
export function runOfLarkMessage(app: App, messageId: string, chatId: string): string | null {
  // A quote is always in the same chat (its main stream or one of its topics).
  return one<{ run_id: string | null }>(app.db, "select run_id from lark_sent where message_id = ? and run_id is not null", messageId)?.run_id
    ?? one<{ run_id: string | null }>(
      app.db,
      "select m.run_id from conversations c join messages m on m.conversation_id = c.id where (c.external_id = ? or c.external_id like ? || '#%') and m.run_id is not null and (json_extract(m.meta, '$.externalId') = ? or json_extract(m.meta, '$.larkMessageId') = ?) order by m.created_at desc limit 1",
      chatId, chatId, messageId, messageId,
    )?.run_id
    ?? null;
}

/**
 * A message became the root of a topic (a reply in a thread under it). In Feishu a reply to a
 * topic's root lands in that topic, so a work quoting it in the main stream would end up in a topic
 * meant for something else — except the work that opened it (its own progress topic).
 */
export function noteTopicRoot(app: App, messageId: string, by: { runId: string | null; conversationId: string | null }) {
  const opener = by.runId ? lineRoot(app, by.runId) : null;
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do nothing", `lark_topic_root:${messageId}`, JSON.stringify({ line: opener, conversationId: by.conversationId }));
}

function rootOfOtherTopic(app: App, messageId: string, root: string) {
  const v = one<{ value: string }>(app.db, "select value from kv where key = ?", `lark_topic_root:${messageId}`)?.value;
  if (!v) return false;
  return (JSON.parse(v) as { line: string | null }).line !== root;
}
