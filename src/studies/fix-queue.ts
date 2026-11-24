import type { App } from "../core/app.ts";
import type { AppEvent } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { HttpError, now } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { can } from "../auth/permissions.ts";
import { canWrite } from "../core/users.ts";
import { codeWork } from "../agents/code-works.ts";
import { getRun } from "../agents/runs.ts";
import { assertOwner, findings, markFixedByChange, type Finding } from "./store.ts";
import { studyScope } from "./scope.ts";
import { queueFindingFix } from "./fix.ts";

/**
 * The study's own fix queue (docs/v2/studies.md “交给改”): the owner (on the page, or through the
 * assistant) hands over several findings at once, whatever their round or kind, even after the flow's
 * rounds are over. The host delegates them one at a time, in the order handed over, with the AI the
 * study's scope names for coding and review; each change goes through omem's own review. A change
 * that passes review closes its finding as fixed (the reviewer is the judge); one that does not stays
 * with the owner and the queue moves on. One at a time: the changes start from the same baseline of
 * the same repositories, and the owner applies them one after another.
 */
const settled = (f: Finding) => ["rejected", "duplicate"].includes(f.state) || !!f.fixed_at;

export function queueFixes(app: App, itemId: string, ids: string[], note: string | undefined, user: string) {
  assertOwner(app, itemId, user);
  if (!can(app, user, "code.delegate")) throw new HttpError(403, "没有交办编码的权限");
  if (!canWrite(app, user, getItem(app, itemId).spaceId)) throw new HttpError(403, "事项空间不可写");
  const scope = studyScope(app, itemId);
  if (!scope.allowCode) throw new HttpError(409, "先在研究范围里打开可以改代码");
  if (!scope.repos.length) throw new HttpError(409, "先在研究范围里登记仓库");
  const all_ = findings(app, itemId), at = now();
  const picked = [...new Set(ids)].map((id) => all_.find((f) => f.id === id) ?? (() => { throw new HttpError(404, `没有这条发现：${id}`); })());
  const blocked = picked.filter((f) => settled(f) || !!f.work_id && codeWork(app, f.work_id)?.stage.group === "active");
  if (blocked.length) throw new HttpError(409, `这些不能交给改（不算、重复、已改好或正在改）：${blocked.map((f) => f.title).join("；")}`);
  for (const f of picked) run(app.db, "update study_findings set fix_queued_at=coalesce(fix_queued_at,?),fix_note=?,updated_at=? where id=?", at, note?.trim() ?? "", at, f.id);
  return picked.length;
}
export function unqueueFix(app: App, itemId: string, id: string, user: string) {
  assertOwner(app, itemId, user);
  const f = findings(app, itemId).find((f) => f.id === id);
  if (!f) throw new HttpError(404, "没有这条发现");
  run(app.db, "update study_findings set fix_queued_at=null,updated_at=? where id=?", now(), id);
}
/** Where a finding stands in the queue, for the page and read_ledger. */
export function queuePosition(app: App, itemId: string, id: string) {
  const waiting = findings(app, itemId).filter((f) => f.fix_queued_at).sort((a, b) => a.fix_queued_at!.localeCompare(b.fix_queued_at!) || a.created_at.localeCompare(b.created_at));
  const i = waiting.findIndex((f) => f.id === id);
  return i < 0 ? null : i + 1;
}

/**
 * Settle what review decided, then hand over the next one. Changes started any other way (the
 * page's “去改”, the flow's “改” stage) are settled here too: passing review closes the finding.
 * Callers hold the item's study lock (studyOperation).
 */
export async function tickFixQueue(app: App, itemId: string) {
  for (const f of findings(app, itemId)) {
    if (!f.work_id || f.fixed_at || settled(f)) continue;
    const w = codeWork(app, f.work_id);
    // Only once per change: a finding the owner reopened after its change ended is theirs to call.
    if (w?.stage.key === "done" && f.updated_at <= workEndedAt(app, f.work_id)) markFixedByChange(app, f, `交办 ${f.work_id} 评审通过`);
  }
  // One change in flight per study, whoever started it.
  if (findings(app, itemId).some((f) => f.work_id && codeWork(app, f.work_id)?.stage.group === "active")) return null;
  const queue = findings(app, itemId).filter((f) => f.fix_queued_at).sort((a, b) => a.fix_queued_at!.localeCompare(b.fix_queued_at!) || a.created_at.localeCompare(b.created_at));
  for (const f of queue) {
    run(app.db, "update study_findings set fix_queued_at=null,updated_at=? where id=?", now(), f.id);
    if (settled(f)) continue;
    try {
      return await queueFindingFix(app, itemId, f.id, f.fix_note || undefined);
    } catch (e) {
      // Not deliverable now (code changes turned off, no repository): it leaves the queue with why.
      run(app.db, "update study_findings set fix_note=?,updated_at=? where id=?", `没能交办：${(e as Error).message}`, now(), f.id);
    }
  }
  return null;
}
/** When the last run of a change (its rounds and their reviews) finished. */
function workEndedAt(app: App, root: string) {
  return all<{ at: string | null }>(app.db, `with recursive owned(id) as (
    select id from runs where id=? or json_extract(input,'$.continueFrom')=? union select r.id from runs r join owned o on r.parent_id=o.id
  ) select max(finished_at) at from runs where id in (select id from owned)`, root, root)[0]?.at ?? "";
}

/** Items whose findings wait in the queue or have a change not yet settled. */
function pendingItems(app: App) {
  return all<{ item_id: string }>(app.db, `select distinct item_id from study_findings
    where fix_queued_at is not null or (work_id is not null and fixed_at is null and state in ('new','confirmed','later'))`).map((r) => r.item_id);
}
const attached = new WeakSet<App>();
/** A delegation's or review's run ending moves the queues on; so does starting the host. */
export function attachFixQueue(app: App) {
  if (attached.has(app)) return;
  attached.add(app);
  const tick = async (ids: string[]) => {
    const { studyOperation } = await import("../flows/engine.ts");
    for (const id of ids) {
      try { getItem(app, id); await studyOperation(app, id, () => tickFixQueue(app, id)); }
      catch (e) { console.warn(`[omem] 研究的修改队列推进失败：${(e as Error).message}`); }
    }
  };
  const listener = (e: AppEvent) => {
    if (e.type !== "run" || !["done", "failed", "cancelled"].includes(e.status)) return;
    let kind: string;
    try { kind = getRun(app, e.runId).kind; } catch { return; }
    if (kind !== "code" && kind !== "review") return;
    const ids = pendingItems(app);
    if (ids.length) void tick(ids);
  };
  // Changes that ended while the host was down are settled shortly after it starts.
  const startup = setTimeout(() => { try { void tick(pendingItems(app)); } catch { /* closed meanwhile */ } }, 5000);
  startup.unref();
  app.events.on("event", listener);
  app.events.once("close", () => { clearTimeout(startup); app.events.off("event", listener); attached.delete(app); });
}
