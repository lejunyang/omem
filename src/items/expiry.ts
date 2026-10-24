import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now, truncate } from "../core/util.ts";
import { getItem, isClosed, itemEvents, listItems, upsertItem, type Item, type ItemKind } from "./store.ts";

/**
 * Items close themselves, so the owner never has to tick off what they already handled.
 *
 * - Expiry: an open item with no progress for its kind's period (todo 14 days, decision 7, …)
 *   becomes "expired" — not done: nobody said it was. Progress is the owner touching it or
 *   new evidence on its timeline; agent notes without evidence do not hold it open. A due or
 *   reminder time still ahead holds it; a reminder expires a day after its time. New evidence
 *   reopens it (items/store.ts), and the owner can keep or reopen it from the item or the digest.
 * - Handled elsewhere: when the owner said something in the item's source chat afterwards,
 *   or reacted to the message, the item-keeper role reads that and closes it as done with the
 *   reason (a DONE reaction closes it without a model). Each piece of evidence is judged once.
 * - Items already past their deadline when this arrived (the backlog) wait for the owner to
 *   look at the preview and apply it once, rather than vanishing on the first sweep.
 */

const DAY = 86_400_000;
export const kindLabel: Record<ItemKind, string> = { todo: "待办", decision: "待决定", watch: "关注", waiting: "等待回复", reminder: "提醒" };

const kv = (app: App, key: string) => one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value ?? null;
const setKv = (app: App, key: string, value: string) => run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", key, value);

function day(app: App, iso: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: app.config.timezone, month: "numeric", day: "numeric" }).format(new Date(iso));
}

/** The last time the item made progress: created, touched by the owner, or new evidence recorded. */
export function lastActivity(app: App, item: Item): string {
  const e = one<{ at: string | null }>(
    app.db,
    "select max(at) at from item_events where item_id = ? and kind not in ('reminded', 'reminder-failed') and (actor = 'user' or source_refs != '[]')",
    item.id,
  )?.at;
  return e && e > item.createdAt ? e : item.createdAt;
}

/** text: why it closes then, e.g. “7 天没有新进展（关注的默认期限）”. */
export type Expiry = { at: string; text: string };

/** When an open item expires, and why then. Null for closed items or when expiry is off. */
export function itemExpiry(app: App, item: Item): Expiry | null {
  const cfg = app.config.items;
  if (!cfg.expiry || isClosed(item.status)) return null;
  const days = cfg.days;
  if (item.kind === "reminder") {
    const reminded = [...itemEvents(app, item.id)].reverse().find((e) => e.kind === "reminded")?.at;
    const anchor = item.remindAt ?? item.dueAt ?? reminded;
    if (anchor) return { at: new Date(Date.parse(anchor) + days.reminder * DAY).toISOString(), text: `提醒时间过后 ${days.reminder} 天` };
  }
  const period = days[item.kind === "reminder" ? "todo" : item.kind];
  const base = Date.parse(lastActivity(app, item)) + period * DAY;
  const anchor = item.dueAt ?? item.remindAt;
  const held = anchor ? Date.parse(anchor) + DAY : 0;
  if (held > base) return { at: new Date(held).toISOString(), text: `${item.dueAt ? "截止" : "提醒"}时间过后 1 天` };
  return { at: new Date(base).toISOString(), text: `${period} 天没有新进展（${kindLabel[item.kind]}的默认期限）` };
}

/** When expiry began on this library; deadlines before it are the backlog. */
export function expirySince(app: App) {
  return kv(app, "item_expiry_since") ?? "1970-01-01T00:00:00.000Z";
}
export const backlogApplied = (app: App) => kv(app, "item_expiry_backlog") !== null;

export type DueItem = { item: Item; expiry: Expiry; lastActivity: string; backlog: boolean };

/** Open items whose deadline has passed (`within` days ahead to include those about to). */
export function dueItems(app: App, opts: { at?: Date; withinDays?: number; userId?: string } = {}): DueItem[] {
  const at = (opts.at ?? new Date()).getTime() + (opts.withinDays ?? 0) * DAY;
  const since = expirySince(app);
  const backlog = backlogApplied(app);
  const out: DueItem[] = [];
  for (const item of listItems(app, { status: "active", userId: opts.userId, limit: 100_000 })) {
    const expiry = itemExpiry(app, item);
    if (!expiry || Date.parse(expiry.at) > at) continue;
    out.push({ item, expiry, lastActivity: lastActivity(app, item), backlog: !backlog && expiry.at < since });
  }
  return out.sort((a, b) => a.expiry.at.localeCompare(b.expiry.at));
}

/** The backlog the owner closed by hand is told apart, so the next digest does not report it as news. */
function expire(app: App, d: DueItem, by: "sweep" | "backlog" = "sweep") {
  upsertItem(app, d.item.id, { status: "expired", note: `${by === "backlog" ? "本人收尾积压" : "自动过期"}：${d.expiry.text}，最后一次进展在 ${day(app, d.lastActivity)}。有新进展会重新打开，也可以在事项页恢复。` }, "agent");
}

/** The hourly sweep: expire what is due, except the backlog the owner has not reviewed yet. */
export function expireDue(app: App, at = new Date()) {
  if (!app.config.items.expiry) return [];
  const due = dueItems(app, { at }).filter((d) => !d.backlog);
  for (const d of due) expire(app, d);
  return due.map((d) => d.item.id);
}

/** The owner reviewed the backlog: expire all of it (minus what they keep) and let the sweep take over. */
export function applyBacklog(app: App, keep: string[] = []) {
  const due = dueItems(app).filter((d) => d.backlog && !keep.includes(d.item.id));
  for (const id of keep) keepItem(app, id, "user");
  for (const d of due) expire(app, d, "backlog");
  setKv(app, "item_expiry_backlog", now());
  return due.map((d) => d.item.id);
}

/** "Keep it": counts as progress, so its period starts again; an expired item opens again. */
export function keepItem(app: App, id: string, actor: "user" | "agent" = "user") {
  const item = getItem(app, id);
  const reopen = isClosed(item.status);
  return upsertItem(app, id, { note: reopen ? "本人恢复了这个事项" : "本人保留：期限从现在重新计算", ...(reopen ? { status: item.kind === "waiting" ? "waiting" : "open" } : {}) }, actor);
}

// ------------------------------------------------------------ handled elsewhere

export type Candidate = { item: Item; lines: { atMs: number; text: string; ref: string }[]; latestMs: number; reactions: string[] };

const isDoneReaction = (r: string) => /^(DONE|CHECKMARK|CHECK|已完成)$/i.test(r);

/**
 * Open items whose source chat shows the owner acting on them since the last look: later
 * lines in the same chat/topic, or reactions on the cited message (read through lark-cli,
 * at most once a day per item and `maxReactionChecks` per sweep). DONE closes right away.
 */
export async function handledCandidates(app: App, opts: { maxReactionChecks?: number; userId?: string } = {}): Promise<Candidate[]> {
  if (!app.config.items.infer) return [];
  const { ownerFollowUp, ownerReactions } = await import("../channels/notify-gate.ts");
  const since = expirySince(app);
  const backlog = backlogApplied(app);
  let reactionChecks = opts.maxReactionChecks ?? 15;
  const out: Candidate[] = [];
  for (const item of listItems(app, { status: "active", userId: opts.userId, limit: 100_000 })) {
    if (!backlog && item.createdAt < since) continue;
    const chatRefs = item.sourceRefs.filter((r) => r.startsWith("src:"));
    if (!chatRefs.length) continue;
    const f = ownerFollowUp(app, chatRefs);
    if (!f.triggers.length) continue;
    const check = one<{ evidence_ms: number; reactions_at: string | null }>(app.db, "select evidence_ms, reactions_at from item_checks where item_id = ?", item.id);
    let reactions: string[] = [];
    const ids = f.triggers.map((t) => t.messageId).filter((x): x is string => !!x);
    const reactionsDue = ids.length && reactionChecks > 0 && Date.now() - Date.parse(item.createdAt) > 3600_000 && (!check?.reactions_at || Date.now() - Date.parse(check.reactions_at) > DAY);
    if (reactionsDue) {
      reactionChecks--;
      for (const id of ids.slice(0, 3)) reactions.push(...((await ownerReactions(app, id)) ?? []));
      run(app.db, "insert into item_checks(item_id, checked_at, evidence_ms, reactions_at) values(?,?,0,?) on conflict(item_id) do update set reactions_at = excluded.reactions_at", item.id, now(), now());
      const done = reactions.find(isDoneReaction);
      if (done) {
        upsertItem(app, item.id, { status: "done", note: `推断已处理：本人对来源消息回了 ${done} 表情。不对的话在事项页恢复。` }, "agent");
        continue;
      }
    }
    const fresh = f.latestMs > (check?.evidence_ms ?? 0);
    if (fresh || reactions.length) out.push({ item, lines: f.lines, latestMs: f.latestMs, reactions });
  }
  return out;
}

/** Remember that this evidence was looked at, so the same lines are not judged again. */
export function markChecked(app: App, c: Candidate) {
  run(
    app.db,
    "insert into item_checks(item_id, checked_at, evidence_ms) values(?,?,?) on conflict(item_id) do update set checked_at = excluded.checked_at, evidence_ms = max(item_checks.evidence_ms, excluded.evidence_ms)",
    c.item.id,
    now(),
    c.latestMs,
  );
}

export function candidatesTask(app: App, cs: Candidate[]) {
  return cs
    .map((c) => {
      const i = c.item;
      const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
      return [
        `### ${i.id} [${i.kind}/${i.status}] ${i.title}`,
        `建于 ${i.createdAt.slice(0, 16).replace("T", " ")}${i.waitingOn ? `；等待 ${i.waitingOn}` : ""}${i.dueAt ? `；截止 ${i.dueAt}` : ""}；来源 ${i.sourceRefs.join(" ")}`,
        i.detail ? `详情：${truncate(i.detail, 300)}` : "",
        c.reactions.length ? `本人对来源消息回了表情：${c.reactions.join("、")}` : "",
        c.lines.length ? `本人之后在同一会话里说的话：\n${c.lines.map((l) => `- ${fmt(l.atMs)} ${truncate(l.text, 200)}（${l.ref}）`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

// ------------------------------------------------------------------ digest

/**
 * What closed by itself since the last digest, and what will close in the next day, for one
 * person. Nothing to say → null (no notification).
 */
export function digestFor(app: App, userId: string, at = new Date()) {
  const last = kv(app, `item_digest:${userId}`) ?? new Date(at.getTime() - DAY).toISOString();
  const closed = all<{ id: string; title: string; status: string; text: string }>(
    app.db,
    `select i.id, i.title, i.status, e.text from items i join item_events e on e.item_id = i.id
      where i.user_id = ? and i.status in ('expired', 'done', 'cancelled') and i.closed_at > ? and e.actor = 'agent'
        and e.id = (select max(id) from item_events where item_id = i.id)
        and (e.text like '自动过期%' or e.text like '推断%')
      order by i.closed_at`,
    userId,
    last,
  );
  // Tomorrow's, minus what the previous digest already announced (its window ended a day after it).
  const shown = Date.parse(last) + DAY;
  const soon = dueItems(app, { at, withinDays: 1, userId }).filter((d) => !d.backlog && Date.parse(d.expiry.at) > Math.max(at.getTime(), shown));
  return closed.length || soon.length ? { since: last, closed, soon } : null;
}

export function markDigestSent(app: App, userId: string, at = new Date()) {
  setKv(app, `item_digest:${userId}`, at.toISOString());
}

/** One line per item, ready for a card or the in-app notification. */
export function digestBody(app: App, d: NonNullable<ReturnType<typeof digestFor>>) {
  const expired = d.closed.filter((c) => c.status === "expired");
  const handled = d.closed.filter((c) => c.status !== "expired");
  return [
    handled.length ? `**看起来已经处理了（${handled.length}）**\n${handled.map((c) => `- ${c.title}：${truncate(c.text.split("\n")[0].replace(/^推断(已处理|不再需要)：/, "").replace(/。?不对的话在事项页恢复。$/, ""), 80)}`).join("\n")}` : "",
    expired.length ? `**没有新进展，已自动过期（${expired.length}）**\n${expired.map((c) => `- ${c.title}`).join("\n")}` : "",
    d.soon.length ? `**明天会自动过期（${d.soon.length}）**\n${d.soon.map((s) => `- ${s.item.title}：${s.expiry.text}`).join("\n")}` : "",
    "不用管就是按上面处理；要留下的点“保留”或“恢复”。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

