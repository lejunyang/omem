import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { getSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { can } from "../auth/permissions.ts";
import { sourceVisible } from "../auth/visibility.ts";
import { homeSpaces, PRIORITY, queueRecheck } from "./homing.ts";

/**
 * Whether the readers of a space can open what its Wiki pages cite (docs/v2/archive-routing.md §5).
 * A reader is anyone with `space.read` there; a cited source is out of reach for a reader who may
 * not see it (its space, or the source's own visibility). Read-only; the Wiki check and the web use it.
 */
export type ReachEntry = {
  sourceId: string;
  /** Empty when the asker may not see the source either. */
  title: string;
  space: string;
  pages: { slug: string; title: string }[];
  /** Readers of the space who cannot open it. */
  blocked: string[];
  /** Readers for whom Feishu has to be asked (a space filtering by document permission). */
  unknown: string[];
  /** In the owner's personal space and open to be judged again (queueUnreachable sends it). */
  rejudgeable: boolean;
};

/** Active users who may read the space (the owner included). */
export function spaceReaders(app: App, spaceId: string) {
  return all<{ id: string }>(app.db, "select id from users where status = 'active' and disabled_at is null order by id").map((u) => u.id).filter((u) => can(app, u, "space.read", spaceId));
}

export function citationReach(app: App, spaceId: string, viewer: string = OWNER) {
  getSpace(app, spaceId);
  const readers = spaceReaders(app, spaceId);
  const homes = new Set(homeSpaces(app));
  const rows = all<{ sid: string; slug: string; title: string }>(app.db,
    `select distinct coalesce(a.source_id, pc.source_id) sid, p.slug, p.title from page_cites pc join pages p on p.id = pc.page_id
       left join source_aliases a on a.alias_id = pc.source_id where p.space_id = ? order by p.slug`, spaceId);
  const bySource = new Map<string, { slug: string; title: string }[]>();
  for (const r of rows) bySource.set(r.sid, [...(bySource.get(r.sid) ?? []), { slug: r.slug, title: r.title }]);
  const entries: ReachEntry[] = [];
  for (const [sid, pages] of bySource) {
    const s = one<{ space_id: string; title: string; kind: string; deleted_at: string | null }>(app.db, "select space_id, title, kind, deleted_at from sources where id = ?", sid);
    // Missing and deleted originals are the Wiki check's other finding (a dead citation).
    if (!s || s.deleted_at) continue;
    const blocked: string[] = [];
    const unknown: string[] = [];
    for (const u of readers) {
      const v = sourceVisible(app, u, sid);
      if (v === false) blocked.push(u);
      else if (v === "check") unknown.push(u);
    }
    if (!blocked.length && !unknown.length) continue;
    const seen = sourceVisible(app, viewer, sid) === true;
    entries.push({ sourceId: sid, title: seen ? s.title : "", space: s.space_id, pages: pages.slice(0, 20), blocked, unknown, rejudgeable: homes.has(s.space_id) && !["code", "conversation", "activity"].includes(s.kind) });
  }
  entries.sort((a, b) => b.pages.length - a.pages.length);
  return { space: spaceId, readers, entries, citedSources: bySource.size };
}

/** Send the cited sources out of reach that sit in the owner's personal space to be judged again, first in line. */
export function queueUnreachable(app: App, spaceId: string) {
  const ids = citationReach(app, spaceId).entries.filter((e) => e.rejudgeable).map((e) => e.sourceId);
  return { queued: queueRecheck(app, ids, `被空间 ${spaceId} 的页面引用，读者打不开`, PRIORITY.unreachable), found: ids.length };
}
