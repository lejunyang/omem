/**
 * Keeping a space's wiki current without anyone asking. Two things are noticed from data the host
 * already has, and handed to the ordinary job machinery (runs, roles, the owner's AI settings):
 *
 *  - pages whose cited originals changed or went away → a `wiki-lint` run (role wiki-linter) for a
 *    bounded batch of them;
 *  - pages left at the top level or folders holding too many pages → a `wiki-organize` run
 *    (role wiki-organizer).
 *
 * The host only decides *when* and *how much*: a changed original must have been quiet for a
 * while, a page is not looked at again within a day, a space gets at most one automatic check
 * every few hours and a batch is capped. What to do about a page is the role's judgment.
 */
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { createRun } from "../agents/runs.ts";
import { json } from "../core/util.ts";
import { getSpace } from "../core/spaces.ts";
import { listPages, organizeNeeds, staleDetail } from "./store.ts";

/** A changed original is looked at once it has been quiet this long (a document still being edited is not). */
export const SETTLE_MS = 30 * 60_000;
/** A page already looked at is not looked at again within this time, whatever changes. */
export const PAGE_COOLDOWN_MS = 24 * 3_600_000;
/** At most one automatic check per space within this time (manual checks count too). */
export const SPACE_GAP_MS = 3 * 3_600_000;
/** Pages per automatic check; the rest wait for the next one. */
export const BATCH = 10;
/** Folder upkeep: a pass at most this often while there is work, and after a pass that moved nothing, a week. */
export const ORGANIZE_GAP_MS = 6 * 3_600_000;
export const ORGANIZE_IDLE_GAP_MS = 7 * 86_400_000;
/** Originals that only grow (chat lines are appended, never rewritten): a cited line does not change when more are added. */
export const APPEND_ONLY = new Set(["chat", "conversation", "activity", "meeting"]);

type Checked = Record<string, string>;
const key = (spaceId: string) => `wiki-checked:${spaceId}`;
const readChecked = (app: App, spaceId: string): Checked => json<Checked>(one<{ value: string }>(app.db, "select value from kv where key = ?", key(spaceId))?.value, {});
function writeChecked(app: App, spaceId: string, checked: Checked, live: Set<string>) {
  const keep = Object.fromEntries(Object.entries(checked).filter(([slug]) => live.has(slug)));
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key(spaceId), JSON.stringify(keep));
}

/**
 * Pages worth an automatic check right now: a cited original changed (or was deleted), it has been
 * quiet for SETTLE_MS, the page has not been looked at within PAGE_COOLDOWN_MS. Oldest change first.
 * `settled: false` leaves out the quiet-time condition: the pages that will be checked once it has passed.
 */
export function pagesToCheck(app: App, spaceId: string, at = Date.now(), opts: { settled?: boolean } = {}) {
  const checked = readChecked(app, spaceId);
  const out: { slug: string; since: number }[] = [];
  for (const p of staleDetail(app, spaceId)) {
    const relevant = p.sources.filter((s) => s.deleted || !APPEND_ONLY.has(s.kind));
    if (!relevant.length) continue;
    if (opts.settled !== false && relevant.some((s) => !s.deleted && at - Date.parse(s.updatedAt) < SETTLE_MS)) continue;
    const last = checked[p.slug] ? Date.parse(checked[p.slug]) : 0;
    if (at - last < PAGE_COOLDOWN_MS) continue;
    out.push({ slug: p.slug, since: Math.min(...relevant.map((s) => Date.parse(s.updatedAt))) });
  }
  return out.sort((a, b) => a.since - b.since).map((x) => x.slug);
}

const busy = (app: App, kind: string, spaceId: string) => !!one(app.db, "select 1 from runs where kind = ? and space_id = ? and status in ('queued','running')", kind, spaceId);
const lastRun = (app: App, kind: string, spaceId: string) => one<{ at: string; output: string | null; status: string }>(app.db, "select created_at at, output, status from runs where kind = ? and space_id = ? order by created_at desc limit 1", kind, spaceId);

/** Queue the checks and the folder upkeep that are due, for every space with a wiki. Cheap to call often. */
export function runWikiUpkeep(app: App, at = Date.now()) {
  const made: { kind: string; spaceId: string; runId: string; pages?: number }[] = [];
  const spaces = all<{ space_id: string }>(app.db, "select distinct space_id from pages").map((r) => r.space_id);
  for (const spaceId of spaces) {
    let space;
    try {
      space = getSpace(app, spaceId);
    } catch {
      continue;
    }
    if (space.kind === "worktree") continue;
    // 1. Pages whose originals changed.
    if (space.settings.autoLint !== false && !busy(app, "wiki-lint", spaceId)) {
      const last = lastRun(app, "wiki-lint", spaceId);
      if (!last || at - Date.parse(last.at) >= SPACE_GAP_MS) {
        const slugs = pagesToCheck(app, spaceId, at).slice(0, BATCH);
        if (slugs.length) {
          const checked = readChecked(app, spaceId);
          for (const s of slugs) checked[s] = new Date(at).toISOString();
          writeChecked(app, spaceId, checked, new Set(listPages(app, spaceId).map((p) => p.slug)));
          const r = createRun(app, { kind: "wiki-lint", spaceId, title: `检查受影响页面（${slugs.length} 页，原件变了）`, input: { pages: slugs, auto: true } });
          made.push({ kind: "wiki-lint", spaceId, runId: r.id, pages: slugs.length });
        }
      }
    }
    // 2. Pages without a fitting folder.
    if (space.settings.autoOrganize !== false && !busy(app, "wiki-organize", spaceId)) {
      const needs = organizeNeeds(listPages(app, spaceId));
      if (needs.loose.length || needs.crowded.length) {
        const last = lastRun(app, "wiki-organize", spaceId);
        const idle = last?.status === "done" && (json<{ moved?: number }>(last.output, {}).moved ?? 1) === 0;
        if (!last || at - Date.parse(last.at) >= (idle ? ORGANIZE_IDLE_GAP_MS : ORGANIZE_GAP_MS)) {
          const r = createRun(app, { kind: "wiki-organize", spaceId, title: needs.crowded.length ? `整理 Wiki 目录（${needs.crowded[0].folder}/ 太挤）` : `整理 Wiki 目录（${needs.loose.length} 页在顶层）`, input: { auto: true } });
          made.push({ kind: "wiki-organize", spaceId, runId: r.id });
        }
      }
    }
  }
  return made;
}

/** The last automatic check of a space and what is waiting, for the Wiki page. */
export function upkeepStatus(app: App, spaceId: string, at = Date.now()) {
  const last = lastRun(app, "wiki-lint", spaceId);
  const lastRow = one<{ id: string; status: string; created_at: string; input: string }>(app.db, "select id, status, created_at, input from runs where kind = 'wiki-lint' and space_id = ? order by created_at desc limit 1", spaceId);
  const space = getSpace(app, spaceId);
  const due = pagesToCheck(app, spaceId, at);
  const stale = staleDetail(app, spaceId);
  return {
    auto: space.settings.autoLint !== false,
    lastCheck: lastRow ? { id: lastRow.id, status: lastRow.status, at: lastRow.created_at, auto: !!json<{ auto?: boolean }>(lastRow.input, {}).auto } : null,
    /** Pages that will be checked (maybe after their original has been quiet for a while). */
    waiting: pagesToCheck(app, spaceId, at, { settled: false }).length,
    /** Pages stale only because a chat grew: not checked automatically. */
    appendOnly: stale.filter((p) => p.sources.every((s) => !s.deleted && APPEND_ONLY.has(s.kind))).length,
    running: busy(app, "wiki-lint", spaceId),
    nextAt: last && due.length ? new Date(Math.max(at, Date.parse(last.at) + SPACE_GAP_MS)).toISOString() : null,
  };
}

const started = new WeakSet<App>();
/**
 * Watch for changed originals (debounced: the first change arms a timer, the rest wait for it) and
 * look again hourly, so cooldowns that ran out and a restart in the middle are picked up.
 */
export function startWikiUpkeep(app: App, opts: { debounceMs?: number; everyMs?: number; firstMs?: number } = {}) {
  if (started.has(app)) return () => {};
  started.add(app);
  const debounce = opts.debounceMs ?? SETTLE_MS;
  let armed: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    try {
      const made = runWikiUpkeep(app);
      if (made.length) console.log(`[omem] Wiki 自动维护：${made.map((m) => `${m.spaceId} ${m.kind}${m.pages ? ` ${m.pages} 页` : ""}`).join("；")}`);
    } catch (e) {
      console.warn("[omem] Wiki 自动维护失败：", (e as Error).message);
    }
  };
  const onEvent = (e: { type: string; entity?: string }) => {
    if (e.type !== "changed" || e.entity !== "source" || armed) return;
    armed = setTimeout(() => {
      armed = undefined;
      tick();
    }, debounce);
    armed.unref();
  };
  app.events.on("event", onEvent);
  const first = setTimeout(tick, opts.firstMs ?? 3 * 60_000);
  const every = setInterval(tick, opts.everyMs ?? 3_600_000);
  first.unref();
  every.unref();
  return () => {
    app.events.off("event", onEvent);
    clearTimeout(armed);
    clearTimeout(first);
    clearInterval(every);
    started.delete(app);
  };
}

