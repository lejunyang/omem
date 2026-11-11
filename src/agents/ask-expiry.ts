import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { isAwaited, lapseAsk } from "./asks.ts";

/**
 * Open asks (agents/asks.ts) that nobody is going to answer any more lapse, so “等你回答” lists only
 * what still waits and the Feishu card stops taking clicks (it turns into a lapsed record):
 *
 * - the owner went on in the same conversation: questions asked there earlier whose asking run has
 *   ended and that no `wait_answer` holds (lapseAfterMessage; a run still waiting decides itself and
 *   can take its question back with `withdraw_ask`);
 * - what it was asked for ended: the delegation it came from was confirmed, discarded or superseded,
 *   or every item it was done for is closed (lapseWorkAsks, lapseItemAsks);
 * - nobody answered for `asks.staleDays` days (0 keeps them).
 *
 * The host's own decision cards (a `handler`: review plans, a delegation's tasks…) are kept open while
 * their work goes on — it would ask again — and only lapse with their work; command approvals and a
 * delegation's task cards settle themselves (OWN_EXPIRY). sweepStaleAsks applies all of it to what is already in the
 * database: at start (the first start after an upgrade clears what piled up) and with each heartbeat.
 */
export const LAPSE_REASON = {
  message: "本人在对话里接着说了别的，没有再等这个回答",
  work: "发起它的交办已经结束",
  item: "它所属的事项已经关闭",
  stale: (days: number) => `${days} 天没有人回答`,
};

type Open = { id: string; run_id: string | null; conversation_id: string | null; user_id: string; kind: string; handler: string | null; created_at: string; shown_at: string | null };
const OPEN_COLUMNS = "id, run_id, conversation_id, user_id, kind, json_extract(context, '$.handler') handler, created_at, shown_at";

function runActive(app: App, runId: string | null) {
  if (!runId) return false;
  const s = one<{ status: string }>(app.db, "select status from runs where id = ?", runId)?.status;
  return s === "running" || s === "queued";
}

/** Still waited for right now: an agent inside `wait_answer`, or its run still working. */
const held = (app: App, a: Open) => isAwaited(a.id) || runActive(app, a.run_id);

/**
 * The owner wrote in a conversation (after asks.ts took what answers it): the questions asked there
 * earlier that nobody waits for any more lapse. Only the owner's own questions of agents (not the
 * host's decision cards, not approvals, whose cards are in the private chat) and only those shown.
 */
export function lapseAfterMessage(app: App, conversationId: string, userId: string) {
  let n = 0;
  for (const a of all<Open>(app.db, `select ${OPEN_COLUMNS} from asks where conversation_id = ? and user_id = ? and status = 'pending' and kind = 'question' and shown_at is not null and json_extract(context, '$.handler') is null`, conversationId, userId)) {
    if (held(app, a)) continue;
    if (lapseAsk(app, a.id, LAPSE_REASON.message)) n++;
  }
  return n;
}

/** The first run of the delegation (or branch review) a run belongs to, when it is one. */
function workRoot(app: App, runId: string): string | null {
  const r = one<{ id: string; kind: string; parent_id: string | null; root: string | null }>(app.db, "select id, kind, parent_id, json_extract(input, '$.continueFrom') root from runs where id = ?", runId);
  if (!r) return null;
  if (r.kind === "code") return r.root ?? r.id;
  // A review of one of its rounds belongs to it too.
  if (r.parent_id) {
    const p = one<{ id: string; kind: string; root: string | null }>(app.db, "select id, kind, json_extract(input, '$.continueFrom') root from runs where id = ?", r.parent_id);
    if (p?.kind === "code") return p.root ?? p.id;
  }
  return null;
}

/** A delegation that no longer waits on anyone: confirmed (not just partly), discarded, or taken over by a later one. */
function workEnded(app: App, rootId: string) {
  return all<{ o: string | null }>(app.db, "select output o from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?)", rootId, rootId).some((r) => {
    const o = JSON.parse(r.o ?? "{}") as { appliedAt?: unknown; discardedAt?: unknown; supersededBy?: unknown };
    return !!(o.appliedAt || o.discardedAt || o.supersededBy);
  });
}

function roundIds(app: App, rootId: string) {
  return all<{ id: string }>(app.db, "select id from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?)", rootId, rootId).map((r) => r.id);
}

/** Every run of a delegation and the reviews of its rounds. */
function workRunIds(app: App, rootId: string) {
  const rounds = roundIds(app, rootId);
  const reviews = rounds.length ? all<{ id: string }>(app.db, `select id from runs where parent_id in (${rounds.map(() => "?").join(",")})`, ...rounds).map((r) => r.id) : [];
  return [...new Set([...rounds, ...reviews])];
}

/** The work a host card names in its context (rootId / workId / codeRunId), when it names one. */
function contextRoot(app: App, askId: string): string | null {
  const c = one<{ w: string | null; r: string | null; c: string | null }>(app.db, "select json_extract(context, '$.workId') w, json_extract(context, '$.rootId') r, json_extract(context, '$.codeRunId') c from asks where id = ?", askId);
  const id = c?.w ?? c?.r ?? c?.c ?? null;
  return id ? workRoot(app, id) : null;
}

/** Items a run was done for: a material of theirs (the delegation's first run) or named in its input. */
function itemsOfRun(app: App, runId: string): { id: string; status: string }[] {
  const root = workRoot(app, runId);
  const runs = [...new Set([runId, ...(root ? [root] : [])])];
  const marks = runs.map(() => "?").join(",");
  return all<{ id: string; status: string }>(app.db, `select distinct i.id, i.status from items i where i.id in (
      select item_id from item_materials where kind = 'run' and ref in (${marks})
      union select json_extract(input, '$.itemId') from runs where id in (${marks}) and json_extract(input, '$.itemId') is not null)`, ...runs, ...runs);
}

const CLOSED = new Set(["done", "cancelled", "expired"]);
/**
 * Host cards that settle themselves: command approvals expire on their own (command-gate.ts), and a
 * delegation's task cards are set aside for the next delegation when it ends (code-loop.ts reconcileWaiting).
 */
const OWN_EXPIRY = ["command-gate", "code-task"];
const ownExpiry = (handler: string | null) => !!handler && OWN_EXPIRY.includes(handler);

/** Lapse the open asks of these runs (but not those that settle themselves, OWN_EXPIRY). */
function lapseRuns(app: App, runIds: string[], reason: string) {
  if (!runIds.length) return 0;
  let n = 0;
  for (const a of all<Open>(app.db, `select ${OPEN_COLUMNS} from asks where status = 'pending' and run_id in (${runIds.map(() => "?").join(",")})`, ...runIds)) {
    if (ownExpiry(a.handler) || isAwaited(a.id)) continue;
    if (lapseAsk(app, a.id, reason)) n++;
  }
  return n;
}

/** A delegation ended (confirmed, discarded): whatever its runs still ask lapses. */
export function lapseWorkAsks(app: App, runId: string) {
  const root = workRoot(app, runId) ?? runId;
  return lapseRuns(app, workRunIds(app, root), LAPSE_REASON.work);
}

/**
 * An item closed: what its runs still ask lapses (when no other open item needs them), and its
 * notifications count as read — the owner dealt with it.
 */
export function lapseItemAsks(app: App, itemId: string) {
  const roots = all<{ ref: string }>(app.db, "select ref from item_materials where item_id = ? and kind = 'run'", itemId).map((r) => r.ref);
  const named = all<{ id: string }>(app.db, "select id from runs where json_extract(input, '$.itemId') = ?", itemId).map((r) => r.id);
  const runs = [...new Set([...roots, ...named].flatMap((id) => (workRoot(app, id) ? workRunIds(app, workRoot(app, id)!) : [id])))];
  const free = runs.filter((id) => itemsOfRun(app, id).every((i) => i.id === itemId || CLOSED.has(i.status)));
  const n = lapseRuns(app, free, LAPSE_REASON.item);
  run(app.db, "update notifications set read_at = ? where read_at is null and json_extract(context, '$.entityId') = ?", new Date().toISOString(), itemId);
  return n;
}

/** How many days an unanswered ask stays open (asks.staleDays; 0: no limit). */
export function staleDays(app: App) {
  return app.config.asks?.staleDays ?? DEFAULT_STALE_DAYS;
}
/** A week: past it, a question has been passed over, and whatever needs it asks again. */
export const DEFAULT_STALE_DAYS = 7;

/**
 * Everything open that should have lapsed by the rules above, from what is in the database (the owner's
 * later words in the conversation, ended delegations, closed items, age). Returns how many by reason.
 */
export function sweepStaleAsks(app: App, at = Date.now()) {
  const out = { message: 0, work: 0, item: 0, stale: 0 };
  const days = staleDays(app);
  const cutoff = days > 0 ? new Date(at - days * 86400_000).toISOString() : null;
  for (const a of all<Open>(app.db, `select ${OPEN_COLUMNS} from asks where status = 'pending' order by created_at`)) {
    if (ownExpiry(a.handler) || held(app, a)) continue;
    // 1. The delegation it came from (its run's, or the one its card names) has ended.
    const root = (a.run_id ? workRoot(app, a.run_id) : null) ?? (a.handler ? contextRoot(app, a.id) : null);
    if (root && workEnded(app, root)) {
      if (lapseAsk(app, a.id, LAPSE_REASON.work)) out.work++;
      continue;
    }
    // 2. Every item it was asked for is closed.
    const items = a.run_id ? itemsOfRun(app, a.run_id) : [];
    if (items.length && items.every((i) => CLOSED.has(i.status))) {
      if (lapseAsk(app, a.id, LAPSE_REASON.item)) out.item++;
      continue;
    }
    // The host's cards for work still going on stay: cancelled, they would only be asked again.
    if (a.handler) continue;
    // 3. The owner said something else in its conversation after it was shown.
    if (a.conversation_id && a.shown_at && (a.kind === "question" || a.kind === "suggestion") && ownerSpokeAfter(app, a.conversation_id, a.user_id, a.shown_at)) {
      if (lapseAsk(app, a.id, LAPSE_REASON.message)) out.message++;
      continue;
    }
    // 4. Left unanswered too long.
    if (cutoff && a.created_at < cutoff) {
      if (lapseAsk(app, a.id, LAPSE_REASON.stale(days))) out.stale++;
    }
  }
  return out;
}

/** The person wrote in the conversation after `since` themselves (not an answer relayed as a message, not someone else in the group). */
function ownerSpokeAfter(app: App, conversationId: string, userId: string, since: string) {
  return !!one(app.db, `select 1 from messages where conversation_id = ? and role = 'user' and created_at > ?
      and json_extract(meta, '$.fromAsk') is null and json_extract(meta, '$.speaker') is null and json_extract(meta, '$.asker') is null
      and coalesce(json_extract(meta, '$.userId'), 'owner') = ? limit 1`, conversationId, since, userId);
}
