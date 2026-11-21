import { capabilityAccess, type Capability } from "./capabilities.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, now } from "../core/util.ts";
import { findSpace } from "../core/spaces.ts";
import { readLarkSecrets } from "../channels/lark-setup.ts";
import { accessToken } from "./connections.ts";
import { can, isOwner, spacesWith } from "./permissions.ts";
import { authFetch } from "./providers.ts";

/**
 * Who may see a source beyond its space (docs/v2/multi-user.md, “原件级可见性”):
 *
 * - `restricted`: only the people recorded in source_viewers, the space's managers and the owner — a
 *   private chat put into a project space, say.
 * - A space with `settings.larkAccess` (“按来源权限过滤”): a Feishu document there is seen in full only
 *   by those Feishu says may view it, asked with their own connection and kept for a day
 *   (`source_access`); without a connection, not at all. Search shows such a hit's title only until
 *   the person's access is known.
 *
 * Neither ever leaves this server (core/federation.ts) or goes into a share link (core/shares.ts).
 */
const DAY_MS = 86400_000;

type Row = { id: string; space_id: string; kind: string; visibility: string; meta: string };
const rowOf = (app: App, id: string) => one<Row>(app.db, "select id, space_id, kind, visibility, meta from sources where id = ?", id);
const larkAccessSpace = (app: App, spaceId: string) => !!findSpace(app, spaceId)?.settings.larkAccess;
const docToken = (r: Row) => (r.kind === "doc" ? (json<{ documentId?: string }>(r.meta, {}).documentId ?? null) : null);

export function setVisibility(app: App, sourceId: string, visibility: "space" | "restricted", viewers: string[] = []) {
  if (!rowOf(app, sourceId)) throw new HttpError(404, "原件不存在");
  run(app.db, "update sources set visibility = ? where id = ?", visibility, sourceId);
  for (const v of viewers) run(app.db, "insert into source_viewers(source_id,user_id,evidence,at) values(?,?,'granted',?) on conflict(source_id,user_id) do nothing", sourceId, v, now());
}
export const viewersOf = (app: App, sourceId: string) => all<{ user_id: string }>(app.db, "select user_id from source_viewers where source_id = ?", sourceId).map((r) => r.user_id);

/** SQL for the restricted flag on a list of sources already scoped by space.
 * Work files and chats have no additional external document permission to check. */
export function restrictedSourceFilter(app: App, userId: string) {
  const manages = spacesWith(app, userId, "space.manage");
  if (!manages) return { sql: "1", params: [] };
  return {
    sql: "(sources.visibility != 'restricted' or sources.space_id in (select value from json_each(?)) or exists (select 1 from source_viewers v where v.source_id=sources.id and v.user_id=?))",
    params: [JSON.stringify(manages), userId],
  };
}

/** Source text a plugin may receive. The caller checks space capabilities; unknown document access stays private. */
export function readableSourceIds(app: App, userId: string, ids: string[], spaceId?: string) {
  const restricted = restrictedSourceFilter(app, userId);
  return new Set(all<{ id: string }>(app.db, `select sources.id from sources join spaces on spaces.id=sources.space_id
    where sources.id in (select value from json_each(?)) and ${restricted.sql}
    ${spaceId ? "and sources.space_id=? and sources.deleted_at is null" : ""}
    and (coalesce(json_extract(spaces.settings,'$.larkAccess'),0)=0 or sources.kind!='doc'
      or coalesce(json_extract(sources.meta,'$.documentId'),'')=''
      or exists(select 1 from source_access a where a.source_id=sources.id and a.user_id=? and a.allowed=1 and a.checked_at>?))`,
    JSON.stringify(ids), ...restricted.params, ...(spaceId ? [spaceId] : []), userId, new Date(Date.now()-DAY_MS).toISOString()).map(r => r.id));
}

/** Hidden IDs for a space's catalog and annotation queue, without checking individual rows. */
export function hiddenSourceIds(app: App, userId: string, spaceId: string) {
  if (isOwner(app, userId) || can(app, userId, "space.manage", spaceId)) return undefined;
  return new Set(all<{ id: string }>(app.db, `select id from sources where space_id=? and visibility='restricted'
    and not exists(select 1 from source_viewers v where v.user_id=? and v.source_id=sources.id)`, spaceId, userId).map(s => s.id));
}

/** Not to be sent elsewhere (another server, a share link): restricted, or under the Feishu access check. */
export function keptHereIds(app: App, ids: string[]) {
  const rows = all<Row & { larkAccess: unknown }>(app.db, `select s.id, s.space_id, s.visibility, s.kind, s.meta,
    json_extract(p.settings, '$.larkAccess') larkAccess from sources s join spaces p on p.id = s.space_id
    where s.id in (select value from json_each(?))`, JSON.stringify(ids));
  return new Set(rows.filter(r => r.visibility === "restricted" || (r.larkAccess && docToken(r))).map(r => r.id));
}
export function keptHere(app: App, sourceId: string) {
  return keptHereIds(app, [sourceId]).has(sourceId);
}

/** What is known now: true / false, or "check" when Feishu has to be asked (sourceReadable does). */
export function sourceVisible(app: App, userId: string, sourceId: string): boolean | "check" {
  if (isOwner(app, userId)) return true;
  const r = rowOf(app, sourceId);
  if (!r || !can(app, userId, "sources.view", r.space_id)) return false;
  if (r.visibility === "restricted" && !can(app, userId, "space.manage", r.space_id) && !one(app.db, "select 1 from source_viewers where source_id = ? and user_id = ?", sourceId, userId)) return false;
  if (larkAccessSpace(app, r.space_id) && docToken(r)) {
    const c = one<{ allowed: number; checked_at: string }>(app.db, "select allowed, checked_at from source_access where source_id = ? and user_id = ?", sourceId, userId);
    if (c && Date.now() - Date.parse(c.checked_at) < DAY_MS) return !!c.allowed;
    return "check";
  }
  return true;
}

/** When asking Feishu failed (not an answer: expired connection, missing scope, network), per person and source. */
const failedAt = new Map<string, number>();
const RETRY_MS = 10 * 60_000;

/**
 * Ask Feishu, as the person, whether they may view the document. Its answer is kept a day; a failed
 * call is not an answer: they are kept out for now and Feishu is asked again after a while.
 */
async function askFeishu(app: App, userId: string, r: Row) {
  const key = `${userId}:${r.id}`;
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) return false;
  let allowed: boolean | null = null;
  try {
    const token = await accessToken(app, userId, "lark");
    if (token) {
      const brand = readLarkSecrets(app.home)[app.config.lark.appId ?? ""]?.brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
      const res = await authFetch(`${brand}/open-apis/drive/v1/permissions/${encodeURIComponent(docToken(r)!)}/members/auth?type=docx&action=view`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      const v = (await res.json()) as { code?: number; data?: { auth_result?: boolean } };
      if (v.code === 0) allowed = !!v.data?.auth_result;
    }
  } catch {
    allowed = null;
  }
  if (allowed === null) {
    failedAt.set(key, Date.now());
    return false;
  }
  failedAt.delete(key);
  run(app.db, "insert into source_access(source_id,user_id,allowed,checked_at) values(?,?,?,?) on conflict(source_id,user_id) do update set allowed = excluded.allowed, checked_at = excluded.checked_at", r.id, userId, allowed ? 1 : 0, now());
  return allowed;
}

/** Whether this person may read the source now, asking Feishu when that is what decides. */
export async function sourceReadable(app: App, userId: string, sourceId: string): Promise<boolean> {
  const v = sourceVisible(app, userId, sourceId);
  if (v !== "check") return v;
  return askFeishu(app, userId, rowOf(app, sourceId)!);
}

export async function requireReadable(app: App, userId: string, sourceId: string) {
  if (!(await sourceReadable(app, userId, sourceId))) throw new HttpError(403, "这份原件只对部分人开放（受限，或要你在飞书里有阅读权限）");
}

/**
 * Search hits as this person may see them: restricted ones they may not see dropped; Feishu documents
 * whose access is not known yet keep their title, without the text (and are checked in the background).
 */
export function visibleHits<H extends { sourceId?: string; snippet: string; type?: string; spaceId?: string }>(app: App, userId: string, hits: H[]): H[] {
  if (isOwner(app, userId)) return hits;
  const access = capabilityAccess(app, userId);
  const types: Record<string, Capability> = { page: "wiki.view", memory: "memories.view", requirement: "requirements.view" };
  const out: H[] = [];
  for (const h of hits) {
    if (h.spaceId && !access.source(types[h.type ?? ""] ?? "sources.view", h.spaceId)) continue;
    if (!h.sourceId) {
      out.push(h);
      continue;
    }
    const v = sourceVisible(app, userId, h.sourceId);
    if (v === true) out.push(h);
    else if (v === "check") {
      out.push({ ...h, snippet: "（要先核对你在飞书里对这篇文档的阅读权限，读它时会核对）" });
      void sourceReadable(app, userId, h.sourceId).catch(() => {});
    }
  }
  return out;
}

/** For search (SearchOptions.visible): whether a source may be shown at all; one to check is shown by title. None for the owner. */
export function hitFilter(app: App, userId: string) {
  if (isOwner(app, userId)) return undefined;
  return (sourceId: string) => sourceVisible(app, userId, sourceId) !== false;
}

/** Restricted by hand (not the Feishu access check, which only decides who reads the text). */
export const isRestricted = (app: App, sourceId: string) => rowOf(app, sourceId)?.visibility === "restricted";
