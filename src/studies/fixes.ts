import { finishStage } from "../flows/plugin-gates.ts";
import type { App } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { json, newId, now } from "../core/util.ts";
import { codeWork } from "../agents/code-works.ts";
import { cancelRun, getRun } from "../agents/runs.ts";
import type { Item } from "../items/store.ts";
import { studyStageCarrier, type FlowStage } from "../flows/definitions.ts";
import { changeStage, type ItemFlow, type StageRow } from "../flows/store.ts";
import { direction, findings, markFixedByChange, trial, trials } from "./store.ts";
import { findingFix, fixVerified, queueFindingFix } from "./fix.ts";
import { studyScope } from "./scope.ts";
import { startTrial, type TrialAI } from "./trials.ts";
import { pushSummary } from "./push.ts";

export const isFixes = (d: FlowStage) => typeof d.by === "object" && "object" in d.by && d.by.object === "fixes";
export function fixModelStage(f: ItemFlow, d: FlowStage): FlowStage {
  const t = f.definition.stages.find((s) => typeof s.by === "object" && "object" in s.by && s.by.object === "trials");
  const own = typeof d.by === "object" && "object" in d.by && d.by.object === "fixes" ? d.by : undefined;
  return { ...d, ai: t ? t.ai : d.ai, escalate: undefined, by: studyStageCarrier(own ?? { object: "fixes" }, f.definition.stages) };
}
export function eligibleFixes(app: App, f: ItemFlow, d: FlowStage) {
  if (!studyScope(app, f.itemId).allowCode) return [];
  return findings(app, f.itemId).filter((v) => v.flow_started_at === f.startedAt && v.round === f.round && v.kind === "defect" && ["new", "confirmed"].includes(v.state) && !v.work_id && !v.fixed_at && json<string[]>(v.trials, []).some((id) => {
    const t = trial(app, id);
    return t.item_id === f.itemId && t.result === "failed" && !!direction(app, t.direction_id).allow_code;
  })).slice(0, d.budget?.fixes ?? 2);
}
/** Review passed and the change waits for the owner: "done" whether the owner is to apply it in place or to confirm its own branch. */
const approvedWork = (app: App, id: string) => codeWork(app, id)?.stage.key === "done";
/** Changes the owner started by hand that passed review and whose failed trials were never run again: verified here, whatever the round. */
export function unverifiedFixes(app: App, f: ItemFlow) {
  const reruns = trials(app, f.itemId).filter((t) => t.fix_of);
  return findings(app, f.itemId).filter((v) => v.work_id && v.flow_started_at === f.startedAt && !reruns.some((t) => t.fix_of === v.id && t.work_id === v.work_id) && approvedWork(app, v.work_id)
    && json<string[]>(v.trials, []).some((id) => trial(app, id).result === "failed")).slice(0, 5);
}
/** Count occupied time once when a parent and its review run overlap; queued time is excluded. */
export function fixMinutes(app: App, s: StageRow, at: Date) {
  if (s.doneAt) at = new Date(Math.min(at.getTime(), Date.parse(s.doneAt)));
  const works = (s.control.fixIds ?? []).flatMap((id) => {
    const f = all<{ work_id: string | null }>(app.db, "select work_id from study_findings where id=?", id)[0];
    return f?.work_id ? codeWork(app, f.work_id)?.roundList.map((r) => r.id) ?? [] : [];
  });
  const ids = [...works, ...trials(app, s.itemId).filter((t) => t.fix_of && s.control.fixIds?.includes(t.fix_of)).flatMap((t) => t.run_id ? [t.run_id] : [])];
  if (!ids.length) return 0;
  const rows = all<{ started_at: string | null; finished_at: string | null }>(app.db, `with recursive owned(id) as (
    select id from runs where id in (${ids.map(() => "?").join(",")}) union select r.id from runs r join owned o on r.parent_id=o.id
  ) select started_at,finished_at from runs where id in (select id from owned)`, ...ids);
  const intervals = rows.flatMap((r) => r.started_at ? [[Math.max(Date.parse(r.started_at), Date.parse(s.enteredAt ?? r.started_at)), Math.min(at.getTime(), r.finished_at ? Date.parse(r.finished_at) : at.getTime())]] : []).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  let end = 0, used = 0;
  for (const [start, stop] of intervals) { used += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return used / 60000;
}
export async function cancelFixReruns(app: App, item: string, ids?: string[]) {
  for (const t of trials(app, item).filter((t) => t.fix_of && (!ids || ids.includes(t.fix_of)) && ["queued", "running"].includes(t.state))) {
    if (t.run_id) cancelRun(app, t.run_id);
    run(app.db, "update study_trials set state='skipped',result=null,summary='重跑没跑完，留给本人',updated_at=? where id=?", now(), t.id);
  }
}
export async function tickFixes(app: App, item: Item, f: ItemFlow, d: FlowStage, s: StageRow, at: Date, chooseAI: TrialAI) {
  const c = { ...s.control };
  if (!c.fixIds) c.fixIds = [...unverifiedFixes(app, f), ...eligibleFixes(app, f, d)].map((v) => v.id);
  const save = (note: string) => {
    changeStage(app, item.id, d.id, "doing", { control: c, by: c.runId ?? c.fixWorkId ?? null, waitingOn: null }, { actor: "host" }, note);
    return true;
  };
  const finish = async (empty = false) => {
    await cancelFixReruns(app, item.id, c.fixIds);
    const results = c.fixIds!.flatMap((id) => {
      const v = findings(app, item.id).find((v) => v.id === id)!;
      if (!v.work_id) return [];
      const fix = findingFix(app, v), w = codeWork(app, v.work_id);
      return [`${v.title}：${fix?.verified === "passed" ? "改后通过" : fix?.verified === "failed" ? "改后仍然失败" : w?.stage.group === "active" ? "还在改" : fix?.reruns.length ? "改后没验证清楚，等你看" : "评审没过，等你看"}`];
    });
    await finishStage(app, item.id, d.id, empty ? "skipped" : "done", { by: null, waitingOn: null, control: { ...c, reported: true, runId: undefined, trialId: undefined } }, { actor: "host" }, [empty ? "这一轮没有要改的" : `改了 ${results.length} 条\n${results.map((v) => `- ${v}`).join("\n")}`, pushSummary(app, f)].filter(Boolean).join("\n"));
    return true;
  };
  if (!c.fixIds.length) return finish(true);
  c.usedMinutes = fixMinutes(app, { ...s, control: c }, at);
  if (d.budget?.minutes !== undefined && c.usedMinutes >= d.budget.minutes) return finish();
  if (c.runId && c.trialId) {
    const r = getRun(app, c.runId), t = trial(app, c.trialId);
    if (["queued", "running"].includes(r.status)) return false;
    if (t.state === "running") run(app.db, "update study_trials set state='reported',result=?,summary=?,updated_at=? where id=?", r.status === "failed" ? "blocked" : "unclear", r.error ?? "运行结束了，没有交结果", now(), t.id);
    c.runId = undefined; c.trialId = undefined;
    return save("重跑结果已收下");
  }
  const id = c.fixIds[c.fixIndex ?? 0];
  if (!id) return finish();
  const v = findings(app, item.id).find((v) => v.id === id)!;
  if (!v.work_id) {
    // Recheck authorization and eligibility if the owner changed the ledger while we waited.
    if (!eligibleFixes(app, f, { ...d, budget: { ...d.budget, fixes: 20 } }).some((v) => v.id === id)) {
      c.fixIndex = (c.fixIndex ?? 0) + 1;
      return save("发现或范围已调整，跳过这条");
    }
    const queued = await queueFindingFix(app, item.id, id);
    c.fixWorkId = queued!.workId;
    return save(`开始改：${v.title}`);
  }
  const w = codeWork(app, v.work_id);
  if (w?.stage.group === "active") return false;
  const approved = w?.stage.key === "done";
  if (!approved) {
    c.fixIndex = (c.fixIndex ?? 0) + 1; c.fixWorkId = undefined;
    return save(`${v.title}：评审没过，等你看`);
  }
  let reruns = trials(app, item.id).filter((t) => t.fix_of === id && t.work_id === v.work_id);
  if (!reruns.length) {
    const at = now();
    for (const t of json<string[]>(v.trials, []).map((id) => trial(app, id)).filter((t) => t.result === "failed")) {
      const seq = Math.max(0, ...trials(app, item.id).filter((r) => r.direction_id === t.direction_id).map((r) => r.seq)) + 1;
      run(app.db, `insert into study_trials(id,item_id,direction_id,round,seq,object,"check",env,state,fix_of,work_id,created_at,updated_at)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?)`, newId("st"), item.id, t.direction_id, f.round, seq, t.object, t.check, t.env, "queued", id, v.work_id, at, at);
    }
    reruns = trials(app, item.id).filter((t) => t.fix_of === id && t.work_id === v.work_id);
  }
  const t = reruns.find((t) => t.state === "queued");
  if (!t) {
    // Every failed trial passed on the change that passed review: the finding is closed as fixed.
    const verified = fixVerified(app, v).verified, passed = verified === "passed";
    if (passed) markFixedByChange(app, v, `交办 ${v.work_id} 评审通过，原来没通过的试验在改动上重跑都通过`);
    // Review passing had closed it; a failed trial still failing on the change reopens it.
    if (verified === "failed") run(app.db, "update study_findings set fixed_at=null,fixed_note='',state_reason=?,updated_at=? where id=?", `交办 ${v.work_id} 评审通过了，但原来没通过的试验改后重跑仍然没通过`, now(), v.id);
    c.fixIndex = (c.fixIndex ?? 0) + 1; c.fixWorkId = undefined;
    return save(`${v.title}：重跑已结束${passed ? "，标为已改好" : ""}`);
  }
  if (c.waitUntil && Date.parse(c.waitUntil) > at.getTime()) return false;
  const model = fixModelStage(f, d);
  const picked = await chooseAI(app, f, { ...model, id: d.id, escalate: undefined }, { ...s, control: { ...c, escalated: false } }, at);
  if (picked.waitUntil) { c.waitUntil = picked.waitUntil; return save(`模型额度用完，等到 ${picked.waitUntil} 重跑`); }
  c.waitUntil = undefined;
  const r = await startTrial(app, item, f, d, t, picked.execution, model);
  if (trial(app, t.id).state === "running") { c.runId = r.id; c.trialId = t.id; c.execution = picked.execution; }
  return save(`改后重跑：${t.object} × ${t.check}`);
}
