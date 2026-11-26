import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { cancelRun } from "../agents/runs.ts";
import { atomic, itemFlow, type ItemFlow } from "../flows/store.ts";
import type { Proposal, FindingInput, TrialReport, ReviseStudyFinding } from "./schema.ts";
import { cleanupStudyWorkspaces } from "./workspace.ts";

/** `features`: the headings of the study's feature list this trial covers (coverage counts them). */
export type PlannedTrial = { object: string; check: string; prior?: string; features?: string[] };
export type Direction = { id: string; item_id: string; round: number; goal: string; approach: string; acceptance: string; env: string; estimate: string; state: "proposed" | "confirmed" | "active" | "done" | "dropped"; conclusion: string; note: string; plan: string; removed: string; baseline: string; third_party: number; allow_code: number; workspace_run_id: string | null; created_at: string; updated_at: string };
export type Trial = { fix_of: string | null; work_id: string | null; id: string; item_id: string; direction_id: string; round: number; seq: number; object: string; check: string; env: string; state: "queued" | "running" | "reported" | "skipped"; result: TrialReport["result"] | null; summary: string; evidence: string; run_id: string | null; attempts: number; prior: string | null; findings: string; unsure: number; failures: number; escalated: number; commits: string; peer: string | null; peer_run: string | null; peer_seen: string | null; features: string; created_at: string; updated_at: string };
export type Finding = { round: number; flow_started_at: string | null; id: string; item_id: string; kind: FindingInput["kind"]; title: string; repro: string; trials: string; state: "new" | "confirmed" | "rejected" | "later" | "duplicate"; state_reason: string; same_as: string | null; work_id: string | null; fixed_at: string | null; fixed_note: string; revised: string | null; fix_queued_at: string | null; fix_note: string; created_at: string; updated_at: string };
export const directions = (app: App, item: string) => all<Direction>(app.db, "select * from study_directions where item_id=? order by created_at,rowid", item);
export const trials = (app: App, item: string) => all<Trial>(app.db, "select * from study_trials where item_id=? order by direction_id,seq", item);
export const findings = (app: App, item: string) => all<Finding>(app.db, "select * from study_findings where item_id=? order by created_at,rowid", item);
export const findDirection = (app: App, id: string) => one<Direction>(app.db, "select * from study_directions where id=?", id);
export const isOpenDirection = (d: Direction) => d.state === "confirmed" || d.state === "active";
export function direction(app: App, id: string) {
  const d = findDirection(app, id);
  if (!d) throw new HttpError(404, "没有这个方向");
  return d;
}
export function trial(app: App, id: string) {
  const t = one<Trial>(app.db, "select * from study_trials where id=?", id);
  if (!t) throw new HttpError(404, "没有这个试验");
  return t;
}
export const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const previous = (t: Trial) => `以前试过：${t.result}、${t.summary.split(/\r?\n/)[0]}`;
export function reconcile(plan: PlannedTrial[], history: Trial[]) {
  const kept: PlannedTrial[] = [], removed: (PlannedTrial & { prior: string })[] = [];
  for (const t of plan) {
    const same = history.filter((h) => h.result && normalize(h.object) === normalize(t.object));
    const exact = same.filter((h) => normalize(h.check) === normalize(t.check)).at(-1);
    // Only a trial that was really carried out settles the question; one that could not run is planned again, with why.
    if (exact && exact.result !== "blocked") removed.push({ ...t, prior: previous(exact) });
    else if (!kept.some((k) => normalize(k.object) === normalize(t.object) && normalize(k.check) === normalize(t.check))) kept.push({ ...t, ...(same.length ? { prior: same.map((h) => `${h.check}：${previous(h)}`).join("\n") } : {}) });
  }
  return { kept, removed };
}
export function saveProposals(app: App, p: Proposal, round: number) {
  const history = trials(app, p.item), at = now();
  return atomic(app, () => p.directions.map((d) => {
    const id = newId("sd"), checked = reconcile(d.trials, history);
    run(app.db, "insert into study_directions(id,item_id,round,goal,approach,acceptance,env,estimate,state,plan,removed,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, p.item, round, d.goal, d.approach, d.acceptance, d.env ?? "", d.estimate ?? "", "proposed", JSON.stringify(checked.kept), JSON.stringify(checked.removed), at, at);
    run(app.db, "update study_directions set third_party=? where id=?", d.thirdParty ? 1 : 0, id);
    return direction(app, id);
  }));
}
export function confirmDirection(app: App, id: string, note: string, baseline: Record<string, string> = {}, allowCode = false) {
  const d = direction(app, id), at = now();
  if (d.state !== "proposed") throw new HttpError(409, "方向已不是待选择的提案");
  atomic(app, () => {
    run(app.db, "update study_directions set state='confirmed',note=?,updated_at=? where id=?", note, at, id);
    run(app.db, "update study_directions set baseline=?,allow_code=? where id=?", JSON.stringify(baseline), allowCode ? 1 : 0, id);
    // An earlier direction with nothing left to run ends here: the owner has moved on to this one.
    run(app.db, `update study_directions set state='done',conclusion=case when conclusion='' then '试验都跑完了，小结没有写结论；本人选了新的方向' else conclusion end,updated_at=?
      where item_id=? and id!=? and state in ('confirmed','active')
        and not exists(select 1 from study_trials t where t.direction_id=study_directions.id and t.state in ('queued','running'))`, at, d.item_id, id);
    for (const [i, t] of json<PlannedTrial[]>(d.plan, []).entries()) run(app.db, `insert into study_trials(id,item_id,direction_id,round,seq,object,"check",env,state,prior,features,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)`, newId("st"), d.item_id, id, d.round, i + 1, t.object, t.check, d.env, "queued", t.prior ?? null, JSON.stringify(t.features ?? []), at, at);
  });
}
export function continuing(app: App, item: string) {
  for (const d of directions(app, item).filter(isOpenDirection)) {
    const n = one<{ n: number }>(app.db, "select count(*) n from study_trials where item_id=? and direction_id=? and fix_of is null and state in ('queued','running')", item, d.id)!.n;
    if (n) return { direction: d, remaining: n };
  }
  return null;
}
export async function closeDirection(app: App, id: string, state: "done" | "dropped", conclusion: string) {
  if (!conclusion.trim()) throw new HttpError(400, "结束方向必须写结论");
  const d = direction(app, id), at = now();
  for (const t of trials(app, d.item_id).filter((t) => t.direction_id === id && t.state === "running")) {
    if (t.run_id) cancelRun(app, t.run_id);
    if (t.peer_run) await (await import("./remote.ts")).cancelPeerTrial(app, t);
  }
  atomic(app, () => {
    run(app.db, "update study_directions set state=?,conclusion=?,updated_at=? where id=?", state, conclusion, at, id);
    run(app.db, "update study_trials set state='skipped',updated_at=? where direction_id=? and state in ('queued','running')", at, id);
  });
  await cleanupStudyWorkspaces(app, d.item_id, id);
}
function words(s: string) {
  const out = new Set<string>();
  for (const part of normalize(s).match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(part)) { if (part.length === 1) out.add(part); else for (let i = 0; i < part.length - 1; i++) out.add(part.slice(i, i + 2)); }
    else out.add(part);
  }
  return out;
}
export function similarTitle(a: string, b: string) {
  const x = words(a), y = words(b), n = [...x].filter((w) => y.has(w)).length;
  return n > 0 && n / Math.min(x.size, y.size) >= 0.5;
}
export function recordFinding(app: App, input: FindingInput) {
  if (input.same_as && input.distinct_from?.length) throw new HttpError(400, "same_as 和 distinct_from 不能同时填写");
  const evidence = [...new Set(input.trials)];
  if (!evidence.length || evidence.some((id) => !one(app.db, "select 1 from study_trials where id=? and item_id=? and result is not null", id, input.item))) throw new HttpError(400, "依据至少有一个，且必须是本研究里有结果的试验");
  const existing = findings(app, input.item), target = existing.find((f) => f.id === input.same_as);
  if (input.same_as && !target) throw new HttpError(400, "same_as 必须是本研究的发现");
  if (input.distinct_from?.some((id) => !existing.some((f) => f.id === id))) throw new HttpError(400, "distinct_from 必须是本研究的发现");
  const similar = existing.filter((f) => similarTitle(f.title, input.title) && !input.distinct_from?.includes(f.id));
  if (!target && similar.length) throw new HttpError(409, `有相近发现，先读再决定 same_as 或 distinct_from：\n${similar.slice(0, 10).map((f) => `${f.id}（${f.state}）${f.title}\n${f.repro}`).join("\n")}`);
  const at = now();
  if (target) {
    run(app.db, "update study_findings set trials=?,updated_at=? where id=?", JSON.stringify([...new Set([...json<string[]>(target.trials, []), ...evidence])]), at, target.id);
    return target.id;
  }
  const id = newId("sf");
  const flow = itemFlow(app, input.item);
  run(app.db, "insert into study_findings(id,item_id,kind,title,repro,trials,state,created_at,updated_at,round,flow_started_at) values(?,?,?,?,?,?,?,?,?,?,?)", id, input.item, input.kind, input.title, input.repro, JSON.stringify(evidence), "new", at, at, flow?.round ?? 0, flow?.startedAt ?? null);
  return id;
}
/**
 * The owner's call on a finding. "fixed" closes it: it stays confirmed, with when and by what (a
 * commit, a delegation); any other call reopens it.
 */
export function setFindingState(app: App, item: string, id: string, state: "confirmed" | "rejected" | "later" | "fixed", reason = "") {
  const f = findings(app, item).find((f) => f.id === id);
  if (!f) throw new HttpError(404, "没有这条发现");
  if (state === "fixed") {
    if (f.state === "duplicate" || f.state === "rejected") throw new HttpError(409, "不算或重复的发现不用标改好");
    run(app.db, "update study_findings set state='confirmed',fixed_at=?,fixed_note=?,updated_at=? where id=? and item_id=?", now(), reason, now(), id, item);
  } else run(app.db, "update study_findings set state=?,state_reason=?,fixed_at=null,fixed_note='',updated_at=? where id=? and item_id=?", state, reason, now(), id, item);
}
/** Closed by a change that passed review and whose failed trials passed when run again (studies/fixes.ts). */
export function markFixedByChange(app: App, f: Pick<Finding, "id" | "item_id" | "fixed_at" | "state">, note: string) {
  if (f.fixed_at || !["new", "confirmed", "later"].includes(f.state)) return;
  run(app.db, "update study_findings set state='confirmed',fixed_at=?,fixed_note=?,updated_at=? where id=? and fixed_at is null", now(), note, now(), f.id);
}
/**
 * Someone re-describes a finding (the owner in a conversation, through the assistant): the first
 * wording is kept once, so what the summary wrote can still be compared.
 */
export function reviseFinding(app: App, input: ReviseStudyFinding) {
  const f = findings(app, input.item).find((f) => f.id === input.finding);
  if (!f) throw new HttpError(404, "没有这条发现");
  if (!input.title && !input.repro && !input.kind && !input.state) throw new HttpError(400, "要改标题、正文、类型或状态中的至少一项");
  if (input.title || input.repro || input.kind) {
    const first = f.revised ?? JSON.stringify({ kind: f.kind, title: f.title, repro: f.repro });
    run(app.db, "update study_findings set kind=?,title=?,repro=?,revised=?,updated_at=? where id=?", input.kind ?? f.kind, input.title ?? f.title, input.repro ?? f.repro, first, now(), f.id);
  }
  if (input.state) setFindingState(app, input.item, f.id, input.state, input.reason ?? "");
  const after = findings(app, input.item).find((x) => x.id === f.id)!;
  return `${after.id}（${after.fixed_at ? "已改好" : after.state}）${after.title}`;
}

/** A flow that proposes directions or runs trials keeps a ledger. */
export const isStudy = (f: ItemFlow) => f.definition.stages.some((d) => d.tools?.includes("propose_directions") || typeof d.by === "object" && "object" in d.by && ["trials", "fixes"].includes(d.by.object));
/** Findings keep their creation round; merges and later owner decisions do not create another. */
export function idleRounds(app: App, item: string, includeCurrent = false, at = now()) {
  const f = itemFlow(app, item);
  if (!f || !isStudy(f)) return 0;
  const rows = all<{ round: number; ended_at: string }>(app.db, "select round,ended_at from item_flow_rounds where item_id=? and started_at=? order by round", item, f.startedAt);
  if (includeCurrent && !rows.some((r) => r.round === f.round)) rows.push({ round: f.round, ended_at: at });
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (one(app.db, "select 1 from study_findings where item_id=? and flow_started_at=? and round=? limit 1", item, f.startedAt, rows[i].round)) break;
    count++;
  }
  return count;
}
export function assertOwner(app: App, item: string, user: string) {
  if (getItem(app, item).userId !== user) throw new HttpError(403, "只有事项本人能修改研究");
}
