import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { findSpace, getSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { can } from "../auth/permissions.ts";
import { sourceVisible } from "../auth/visibility.ts";
import { homeSpaces, PRIORITY, queueRecheck, yielder } from "./homing.ts";

/**
 * Whether the readers of a space can open what its Wiki pages cite (docs/v2/archive-routing.md §5).
 * A reader is anyone with `space.read` there; a cited source is out of reach for a reader who may
 * not see it (its space, or the source's own visibility). Read-only; the Wiki check and the web use it.
 *
 * A space may cite thousands of sources: space-level readability is worked out once per (reader,
 * space), only sources with their own visibility are asked one by one, and the work yields to the
 * event loop as it goes.
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

type Row = { id: string; space_id: string; title: string; kind: string; deleted_at: string | null; visibility: string };

export async function citationReach(app: App, spaceId: string, viewer: string = OWNER) {
  getSpace(app, spaceId);
  const tick = yielder();
  const readers = spaceReaders(app, spaceId);
  const homes = new Set(homeSpaces(app));
  const rows = all<{ sid: string; slug: string; title: string }>(app.db,
    `select distinct coalesce(a.source_id, pc.source_id) sid, p.slug, p.title from pages p join page_cites pc on pc.page_id = p.id
       left join source_aliases a on a.alias_id = pc.source_id where p.space_id = ? order by p.slug`, spaceId);
  const bySource = new Map<string, { slug: string; title: string }[]>();
  for (const r of rows) bySource.set(r.sid, [...(bySource.get(r.sid) ?? []), { slug: r.slug, title: r.title }]);
  await tick();
  // Who of the readers (and the asker) may read each space at all, worked out once per space.
  const people = [...new Set([...readers, viewer])];
  const spaceCache = new Map<string, { denied: Set<string>; perDoc: boolean }>();
  const spaceOf = (space: string) => {
    let c = spaceCache.get(space);
    if (!c) {
      c = { denied: new Set(people.filter((u) => !can(app, u, "space.read", space))), perDoc: !!findSpace(app, space)?.settings.larkAccess };
      spaceCache.set(space, c);
    }
    return c;
  };
  const entries: ReachEntry[] = [];
  const ids = [...bySource.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const found = all<Row>(app.db, `select id, space_id, title, kind, deleted_at, visibility from sources where id in (${part.map(() => "?").join(",")})`, ...part);
    for (const s of found) {
      // Missing and deleted originals are the Wiki check's other finding (a dead citation).
      if (s.deleted_at) continue;
      const sp = spaceOf(s.space_id);
      // Only a source with its own visibility (restricted, or under a Feishu permission filter) is asked per person.
      const own = s.visibility === "restricted" || sp.perDoc;
      const seen = (u: string) => (own ? sourceVisible(app, u, s.id) : !sp.denied.has(u));
      const blocked: string[] = [];
      const unknown: string[] = [];
      for (const u of readers) {
        const v = seen(u);
        if (v === false) blocked.push(u);
        else if (v === "check") unknown.push(u);
      }
      if (!blocked.length && !unknown.length) continue;
      entries.push({ sourceId: s.id, title: seen(viewer) === true ? s.title : "", space: s.space_id, pages: bySource.get(s.id)!.slice(0, 20), blocked, unknown, rejudgeable: homes.has(s.space_id) && !["code", "conversation", "activity"].includes(s.kind) });
    }
    await tick();
  }
  entries.sort((a, b) => b.pages.length - a.pages.length);
  return { space: spaceId, readers, entries, citedSources: bySource.size };
}

/** Send the cited sources out of reach that sit in the owner's personal space to be judged again, first in line. */
export async function queueUnreachable(app: App, spaceId: string) {
  const ids = (await citationReach(app, spaceId)).entries.filter((e) => e.rejudgeable).map((e) => e.sourceId);
  const tick = yielder();
  let queued = 0;
  for (let i = 0; i < ids.length; i += 200) {
    queued += queueRecheck(app, ids.slice(i, i + 200), `被空间 ${spaceId} 的页面引用，读者打不开`, PRIORITY.unreachable);
    await tick();
  }
  return { queued, found: ids.length };
}
