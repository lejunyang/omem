import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { accessibleSpaces, OWNER } from "../core/users.ts";
import { itemFlow } from "../flows/store.ts";
import { isStudy } from "../studies/store.ts";

/** Facts for completed rounds only; the brief's existing watermark owns delivery. */
export function studyBrief(app: App, since: string, until: string) {
  const allowed = accessibleSpaces(app, OWNER);
  const items = all<{ id: string; title: string; space_id: string }>(app.db, "select i.id,i.title,i.space_id from item_flows f join items i on i.id=f.item_id where i.user_id=?", OWNER)
    .filter(i => allowed === null || allowed.includes(i.space_id));
  const blocks: string[] = [];
  const text = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[\[\]<>]/g, "");
  for (const i of items) {
    const f = itemFlow(app, i.id);
    if (!f || !isStudy(f)) continue;
    const rounds = all<{ round: number; ended_at: string }>(app.db,
      "select round,ended_at from item_flow_rounds where item_id=? and started_at=? and ended_at>? and ended_at<=? order by round", i.id, f.startedAt, since, until);
    for (const r of rounds) {
      const dirs = all<{ goal: string }>(app.db, `select goal from study_directions d where item_id=? and created_at>=? and created_at<=?
        and ((round=? and state!='proposed' and conclusion!='本轮未选') or exists (select 1 from study_trials t where t.item_id=d.item_id and t.direction_id=d.id and t.round=?)) order by created_at,id`, i.id, f.startedAt, r.ended_at, r.round, r.round);
      const results = all<{ result: string; n: number }>(app.db, "select result,count(*) n from study_trials where item_id=? and round=? and created_at>=? and updated_at<=? and result is not null group by result", i.id, r.round, f.startedAt, r.ended_at);
      const counts = new Map(results.map(t => [t.result, t.n]));
      const findings = all<{ title: string }>(app.db, "select title from study_findings where item_id=? and flow_started_at=? and round=? and created_at<=? order by created_at,id limit 5", i.id, f.startedAt, r.round, r.ended_at);
      const total = one<{ n: number }>(app.db, "select count(*) n from study_findings where item_id=? and flow_started_at=? and round=? and created_at<=?", i.id, f.startedAt, r.round, r.ended_at)!.n;
      const pending = one<{ n: number }>(app.db, "select count(*) n from study_findings where item_id=? and state in ('new','later')", i.id)!.n;
      const choosing = !!one(app.db, "select 1 from study_directions where item_id=? and state='proposed' limit 1", i.id);
      blocks.push([
        `### [${text(i.title)}](#/items/${i.id}) · 第 ${r.round} 轮`,
        `方向（目标）：${dirs.map(d => text(d.goal)).join("；") || "本轮没有方向"}`,
        `试验：通过 ${counts.get("passed") ?? 0}；没通过 ${counts.get("failed") ?? 0}；跑不了 ${counts.get("blocked") ?? 0}；说不清 ${counts.get("unclear") ?? 0}。`,
        `本轮新发现：${findings.map(f => text(f.title)).join("；") || "无"}${total > 5 ? `；另有 ${total - 5} 条` : ""}。`,
        `等本人：${pending} 条发现还没判定（含以后再说）；${choosing ? "有方向等着选" : "没有方向等着选"}。`,
      ].join("\n"));
    }
  }
  return blocks.length ? `## 上一轮的探索\n\n${blocks.join("\n\n")}` : "";
}
