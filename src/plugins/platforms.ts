import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { canWrite } from "../core/users.ts";
import { overrideFeatures } from "../auth/features.ts";
import { loginProvider } from "../auth/providers.ts";
import { pluginConnection } from "../auth/connections.ts";
import { upsertSource } from "../sources/store.ts";
import type { PlatformDoc, PlatformReader, PlatformWatch, PluginPlatform } from "./types.ts";

/**
 * Platform packs (docs/v2/connectors.md): plugins that give a connected platform its features (each with
 * its scopes) and readers (one thing on the platform → a source). People keep things in sync with
 * watches: a reader and a target (a Figma project, a GitHub repository's issues), a space, and the
 * reader's position; the `platform-sync` schedule brings each watch up to date as the person who
 * made it, with their connection, into a space they may write.
 */
const packs = new Map<string, PluginPlatform & { plugin: string }>();

export function registerPlatform(plugin: string, def: PluginPlatform) {
  if (packs.has(def.provider)) throw new Error(`平台 ${def.provider} 已经由插件 ${packs.get(def.provider)!.plugin} 提供`);
  const kinds = new Set<string>();
  for (const r of def.readers) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(r.kind) || kinds.has(r.kind)) throw new Error(`读取器类型不合法或重复：${r.kind}`);
    if (!r.read && !r.changes) throw new Error(`读取器 ${r.kind} 既不能读也不能列出变化`);
    kinds.add(r.kind);
  }
  const entry = { ...def, plugin };
  packs.set(def.provider, entry);
  const undoFeatures = def.features?.length ? overrideFeatures(def.provider, def.features) : null;
  return () => {
    if (packs.get(def.provider) === entry) packs.delete(def.provider);
    undoFeatures?.();
  };
}
export const platformOf = (provider: string) => packs.get(provider) ?? null;
export const platformList = () => [...packs.values()];
export function readerOf(provider: string, kind: string): PlatformReader {
  const p = packs.get(provider);
  const r = p?.readers.find((x) => x.kind === kind);
  if (!r) throw new HttpError(400, p ? `${label(provider)}没有 ${kind} 这种内容；有：${p.readers.map((x) => x.kind).join("、")}` : `${label(provider)}还没有平台包，只能用通用的只读请求`);
  return r;
}
const label = (provider: string) => loginProvider(provider)?.label ?? provider;
/** The platform's own name in uris and origin keys: `figma` for `connect-figma`. */
export const platformName = (provider: string) => provider.replace(/^connect-/, "");
export const sourceUri = (provider: string, kind: string, id: string) => `${platformName(provider)}:${kind}/${id}`;

/** Keep what a reader gave as a source in a space this person may write. */
export function savePlatformDoc(app: App, input: { userId: string; spaceId: string; provider: string; kind: string; id: string; doc: PlatformDoc }) {
  if (!canWrite(app, input.userId, input.spaceId)) throw new HttpError(403, `无权写空间 ${input.spaceId}`);
  if (!input.doc.text.trim()) throw new HttpError(400, `${input.doc.title || input.id} 没有正文`);
  const uri = sourceUri(input.provider, input.kind, input.id);
  const r = upsertSource(app, {
    spaceId: input.spaceId,
    kind: input.doc.kind ?? "doc",
    uri,
    title: input.doc.title.slice(0, 300) || uri,
    text: input.doc.text,
    meta: { originKey: uri, provider: platformName(input.provider), url: input.doc.url, platformUpdatedAt: input.doc.updatedAt, capturedBy: input.userId },
  });
  return { id: r.id, created: r.status === "created", changed: r.status !== "unchanged", uri };
}

// ---- watches -------------------------------------------------------------------

type Row = { id: string; user_id: string; provider: string; kind: string; target: string; title: string; space_id: string; cursor: string | null; last_run_at: string | null; last_error: string | null; created_at: string };
const toWatch = (r: Row): PlatformWatch => ({ id: r.id, provider: r.provider, kind: r.kind, target: r.target, title: r.title, spaceId: r.space_id, lastRunAt: r.last_run_at, lastError: r.last_error });

export function addWatch(app: App, userId: string, input: { provider: string; kind: string; target: string; title?: string; spaceId: string }) {
  const r = readerOf(input.provider, input.kind);
  if (!findSpace(app, input.spaceId)) throw new HttpError(404, `没有空间 ${input.spaceId}`);
  if (!canWrite(app, userId, input.spaceId)) throw new HttpError(403, `无权写空间 ${input.spaceId}`);
  const target = input.target.trim();
  if (!target || target.length > 500) throw new HttpError(400, `要盯的${r.label}要写它的 id：${r.id}`);
  const id = newId("pw");
  run(
    app.db,
    `insert into platform_watches(id,user_id,provider,kind,target,title,space_id,created_at) values(?,?,?,?,?,?,?,?)
     on conflict(user_id, provider, kind, target) do update set title = excluded.title, space_id = excluded.space_id`,
    id, userId, input.provider, input.kind, target, (input.title ?? "").slice(0, 200), input.spaceId, now(),
  );
  return toWatch(one<Row>(app.db, "select * from platform_watches where user_id = ? and provider = ? and kind = ? and target = ?", userId, input.provider, input.kind, target)!);
}
export const listWatches = (app: App, userId: string | null, provider?: string) =>
  all<Row>(app.db, `select * from platform_watches where (? is null or user_id = ?) and (? is null or provider = ?) order by created_at`, userId, userId, provider ?? null, provider ?? null).map(toWatch);
export const removeWatch = (app: App, userId: string, id: string) => run(app.db, "delete from platform_watches where id = ? and user_id = ?", id, userId).changes > 0;

/** At most this many things read for one watch in one pass; the rest next time (the cursor waits). */
const PER_PASS = 50;
let syncing: Promise<unknown> | null = null;

/**
 * Bring watches up to date: each one due (its pack's interval since the last run), or the one asked for.
 * A container reads what changed since its cursor; the cursor moves only past what was kept, so a
 * failure is retried next time. One pass at a time.
 */
export function syncWatches(app: App, opts: { id?: string; force?: boolean } = {}) {
  if (syncing && !opts.id) return syncing;
  const p = (async () => {
    const report = { watches: 0, saved: 0, failed: 0 };
    for (const r of all<Row>(app.db, "select * from platform_watches where (? is null or id = ?) order by last_run_at is not null, last_run_at", opts.id ?? null, opts.id ?? null)) {
      const pack = packs.get(r.provider);
      if (!pack) continue;
      const every = (pack.syncMinutes ?? 60) * 60_000;
      if (!opts.force && !opts.id && r.last_run_at && Date.now() - Date.parse(r.last_run_at) < every) continue;
      report.watches++;
      try {
        report.saved += await syncOne(app, r);
        run(app.db, "update platform_watches set last_run_at = ?, last_error = null where id = ?", now(), r.id);
      } catch (e) {
        report.failed++;
        run(app.db, "update platform_watches set last_run_at = ?, last_error = ? where id = ?", now(), String((e as Error).message).slice(0, 500), r.id);
      }
    }
    return report;
  })();
  if (!opts.id) {
    syncing = p;
    void p.finally(() => (syncing = null));
  }
  return p;
}

async function syncOne(app: App, w: Row) {
  const c = pluginConnection(app, w.user_id, w.provider);
  if (!c) throw new Error(`没有可用的${label(w.provider)}连接（没连接或要重新授权）`);
  const reader = readerOf(w.provider, w.kind);
  const keep = async (kind: string, id: string) => {
    const doc = await readerOf(w.provider, kind).read!(c, id);
    if (!doc?.text.trim()) return 0;
    return savePlatformDoc(app, { userId: w.user_id, spaceId: w.space_id, provider: w.provider, kind, id: doc.id ?? id, doc }).changed ? 1 : 0;
  };
  if (!reader.changes) return keep(w.kind, w.target);
  const { items, cursor } = await reader.changes(c, w.target, w.cursor);
  // More than one pass holds: stop at an item that says where it is, and go on from there next time.
  const cut = items.length > PER_PASS ? items.slice(0, PER_PASS).findLastIndex((it) => it.cursor) : -1;
  const batch = cut >= 0 ? items.slice(0, cut + 1) : items;
  let saved = 0;
  for (const it of batch) saved += await keep(it.kind, it.id);
  run(app.db, "update platform_watches set cursor = ? where id = ?", cut >= 0 ? items[cut].cursor! : cursor, w.id);
  return saved;
}
