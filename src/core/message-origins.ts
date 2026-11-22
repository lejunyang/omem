import { sha256 } from "./util.ts";
import type { Thread } from "../agents/threads.ts";
import type { App } from "./app.ts";
import { all, one, run, withinTx } from "./db.ts";

/** A message can have archived copies in several spaces. Look up only the incoming message ids. */
export function archivedMessageSpaces(app: Pick<App, "db">, messageIds: string[]) {
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

export type Origins = string[] | null;

/** Null is a material whose origin is unknown, including when it is mixed with known materials. */
export function mergeOrigins(a: Origins, b: Origins): Origins {
  return a && b ? [...new Set([...a, ...b])] : null;
}

function externalIds(meta: Record<string, unknown>): string[] {
  return Array.isArray(meta.externalIds) ? meta.externalIds : typeof meta.externalId === "string" ? [meta.externalId] : [];
}

/** Include both the queued text's origin and any archives found since it was queued. */
export function watchSourceSpaces(app: Pick<App, "db">, watchSpace: string | null, batch: { meta: Record<string, unknown> }[]) {
  const archived = archivedMessageSpaces(app, batch.flatMap(({ meta }) => externalIds(meta)));
  const spaces = new Set<string>();
  if (watchSpace) spaces.add(watchSpace);
  for (const { meta } of batch) {
    const ids = externalIds(meta);
    const completeArchive = ids.length > 0 && ids.every(id => archived.has(id));
    if (meta.needsSourceArchive && !completeArchive) return null;
    const queued = meta.sourceSpaces;
    if (Array.isArray(queued) && queued.length && queued.every(id => typeof id === "string" && id)) {
      for (const id of queued) spaces.add(id);
    } else if (!completeArchive) return null;
    for (const id of ids) for (const space of archived.get(id) ?? []) spaces.add(space);
    if (meta.watchMaterialSpaces === null) return null;
    if (Array.isArray(meta.watchMaterialSpaces)) for (const space of meta.watchMaterialSpaces) spaces.add(space);
  }
  return [...spaces];
}

/** The provenance belongs to the exact summary injected into the prompt. Older summaries have none. */
export function summaryOrigins(t: Pick<Thread, "summary" | "settings">): Origins {
  if (!t.summary) return [];
  const saved = t.settings.summaryOrigins;
  return saved && saved.hash === sha256(t.summary) ? saved.spaces : null;
}

/** Record additional prompt material on the original turn's message before handing it to the agent.
 * It stays with the transcript across failed steering claims, retries and resumed sessions. */
export function recordWatchMaterial(app: App, anchor: string, spaces: Origins) {
  withinTx(app.db, () => {
    const row = one<{ saved: string | null }>(app.db, "select meta -> '$.watchMaterialSpaces' saved from messages where id=?", anchor);
    if (!row) throw new Error("关注运行的消息已不存在");
    const merged = mergeOrigins(row.saved === null ? [] : JSON.parse(row.saved), spaces);
    run(app.db, "update messages set meta=json_set(meta,'$.watchMaterialSpaces',json(?)) where id=?", JSON.stringify(merged), anchor);
  });
}

/** An explicit message read becomes material for the watch turn that received it. */
export function recordReadMessages(app: App, runId: string | null | undefined, space: string,
  messages: { meta: Record<string, unknown> }[], summary?: Pick<Thread, "summary" | "settings">) {
  if (!runId || (!messages.length && !summary?.summary)) return;
  const turn = one<{ anchor: string | null }>(app.db, `select coalesce(r.input ->> '$.messageIds[0]', r.input ->> '$.messageId') anchor
    from runs r join conversations c on c.id=(r.input ->> '$.conversationId')
    where r.id=? and r.kind='ask' and c.channel='listen'`, runId);
  if (!turn?.anchor) return;
  const origins = watchSourceSpaces(app, space, messages);
  recordWatchMaterial(app, turn.anchor, summary ? mergeOrigins(origins, summaryOrigins(summary)) : origins);
}

/** A follow-up search can quote earlier batches from session history or its summary. Walk only this
 * conversation's metadata in the read worker, stopping at the first unknown or unauthorized origin. */
export function watchRunSourceSpaces(app: Pick<App, "db">, runId: string, granted?: readonly string[]) {
  const turn = one<{ conversation: string; space: string; watchSpace: string | null; linked: number;
    ids: string; steered: string }>(app.db,
    `select c.id conversation, c.space_id space, w.space_id watchSpace,
            (c.parent_id is not null or coalesce(json_array_length(c.settings, '$.links'), 0) > 0) linked,
            coalesce(json_extract(r.input, '$.messageIds'), json_array(json_extract(r.input, '$.messageId'))) ids,
            coalesce(json_extract(r.output, '$.steered'), '[]') steered
       from runs r join conversations c on c.id = json_extract(r.input, '$.conversationId')
       left join listen_contexts w on w.id = c.external_id
      where r.id = ? and r.kind = 'ask' and c.channel = ?`, runId, "listen");
  if (!turn) return undefined;
  // Linked summaries have no message-level provenance.
  if (turn.linked) return null;
  const origins = new Set([turn.space]);
  if (turn.watchSpace) origins.add(turn.watchSpace);
  if (granted && [...origins].some(space => !granted.includes(space))) return null;
  const ids = [...new Set<string>([...JSON.parse(turn.ids), ...JSON.parse(turn.steered)])];
  const last = one<{ n: number; at: string | null }>(app.db,
    `select count(*) n, max(m.created_at) at from json_each(?) i cross join messages m on m.id=i.value
      where m.conversation_id=? and m.role='user'`,
    JSON.stringify(ids), turn.conversation);
  if (!last?.at || last.n !== ids.length) return null;
  const batch: { meta: Record<string, unknown> }[] = [];
  function includeBatch() {
    const spaces = watchSourceSpaces(app, null, batch);
    batch.length = 0;
    if (!spaces || (granted && spaces.some(s => !granted.includes(s)))) return false;
    for (const space of spaces) origins.add(space);
    return true;
  }
  // Meeting actions are transcript entries only. Summaries and cold starts omit commands.
  // An explicit read of such an entry records the material on the turn that received it.
  for (const row of app.db.prepare(`select meta from messages where conversation_id=? and created_at<=? and role='user'
      and not (run_id is null and meta ->> '$.command' is 1 and meta ->> '$.transcriptOnly' is 1)
      order by created_at desc`).iterate(turn.conversation, last.at)) {
    batch.push({ meta: JSON.parse(String(row.meta)) });
    if (batch.length === 200 && !includeBatch()) return null;
  }
  return includeBatch() ? [...origins] : null;
}
