import type { App } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { ensureAutoFollow } from "./auto-follow.ts";
import type { AgentWork } from "./agent-work.ts";
import { handOwnerTasksToFollow, updateTask } from "./code-tasks.ts";
import { getRun, runUser } from "./runs.ts";
import { getThread } from "./threads.ts";
import { longTaskForRun } from "./supervisor-code.ts";

/** A split can arrive in batches. Only an explicit round estimate/budget is evidence of size. */
export function followCodePlan(app: App, rootId: string, additionalTasks = 0, estimate = 0) {
  const auto = app.config.longTasks.auto;
  if (!auto.code) return null;
  const root = getRun(app, rootId);
  if (!root.spaceId || root.input.branches || root.input.syncOnly || root.output.appliedAt || root.output.discardedAt || root.output.supersededBy) return null;
  const inherited = longTaskForRun(app, rootId);
  if (inherited) return inherited;
  // Coding on a study's item (its fixes) is followed by the study's own follow-up (found above) or, when the owner turned
  // that off, not at all: the study's flow link must not give every fix a follow-up of its own.
  const item = root.input.itemId;
  if (typeof item === "string" && one(app.db, "select 1 from study_directions where item_id=? limit 1", item)) return null;
  const planned = one<{ n: number }>(app.db, "select count(*) n from code_tasks where work_id=?", rootId)!.n;
  const work = root.output.work as { budgetBy?: string; budget: number } | undefined;
  const rounds = Math.max(estimate, Number(root.input.maxRounds ?? 0), work?.budgetBy ? work.budget : 0);
  const parent = root.parentId ? one<{ kind: string; threadId: string | null }>(app.db, `select kind,
    coalesce(json_extract(input,'$.conversationId'),json_extract(input,'$.threadId')) threadId from runs where id=?`, root.parentId) : null;
  if (planned + additionalTasks < auto.minTasks && rounds < auto.minRounds) {
    const linked = typeof item === "string" && one(app.db, `select 1 from item_materials where item_id=? and kind='req'
      union all select 1 from item_flows where item_id=? and ended_at is null limit 1`, item, item);
    const fromStage = !root.input.contextItemId && (parent?.kind === "flow-stage" || parent?.kind === "flow-runner");
    if (!linked && !fromStage) return null;
  }
  const spaceId = root.spaceId;
  return withinTx(app.db, () => {
    const task = ensureAutoFollow(app, { kind: "code", sourceId: root.id, spaceId, userId: runUser(app, root.id),
      threadId: parent?.threadId, goal: String(root.input.task || root.title) });
    if (!task) return null;
    run(app.db, `update code_tasks set origin=json_set(origin,'$.goal',?) where work_id=? and kind='build'
      and json_extract(origin,'$.goal') is null`, task.goal, root.id);
    for (const { seq } of all<{ seq: number }>(app.db, `select seq from code_tasks where work_id=? and state='assistant'
      and json_extract(origin,'$.questionId') is null`, root.id)) updateTask(app, root.id, seq, {});
    handOwnerTasksToFollow(app, root.id);
    return task;
  });
}

export function followAgentWork(app: App, work: AgentWork, goal: string) {
  if (!app.config.longTasks.auto.agentWork || longTaskForRun(app, work.askRunId)) return;
  const thread = getThread(app, work.workConversationId);
  const origin = getThread(app, work.rootConversationId);
  return ensureAutoFollow(app, { kind: "agentWork", sourceId: work.askRunId, spaceId: thread.spaceId, userId: thread.userId,
    threadId: origin.userId === thread.userId ? origin.id : thread.id, goal });
}

/** Only look at live work on restart. Finished history stays history. */
export function backfillCodeFollow(app: App) {
  const auto = app.config.longTasks.auto;
  if (auto.code) {
    const roots = all<{ id: string }>(app.db, `select coalesce(json_extract(c.input,'$.continueFrom'),c.id) id
      from runs r join runs c on c.id=case r.kind when 'code' then r.id when 'review' then json_extract(r.input,'$.codeRunId')
        when 'ask' then case json_extract(r.input,'$.handoff.kind') when 'code-tasks' then json_extract(r.input,'$.handoff.workId') end end
      where r.status in ('queued','running') and c.kind='code'
      union
      select coalesce(json_extract(c.input,'$.continueFrom'),c.id) from runs c indexed by runs_done_code_verdict
      where c.kind='code' and c.status='done' and json_extract(c.output,'$.verdict') in
        ('awaiting-plan','awaiting-design','awaiting-owner','awaiting-assistant','awaiting-peer','awaiting-peer-code',
         'paused','changes-requested','sync-conflict')
      -- A previous round can still carry its waiting verdict after the work advanced or was discarded.
      and not exists (select 1 from runs n where n.kind='code'
        and json_extract(n.input,'$.continueFrom')=coalesce(json_extract(c.input,'$.continueFrom'),c.id)
        and ((n.created_at,n.rowid)>(c.created_at,c.rowid)
          or json_extract(n.output,'$.discardedAt') is not null or json_extract(n.output,'$.appliedAt') is not null))`);
    for (const { id } of roots) followCodePlan(app, id);
  }
  if (auto.agentWork) {
    const live = all<{ work: string }>(app.db, `select distinct json_extract(root.output,'$.agentWork') work
      from runs r join runs root on root.id=coalesce(json_extract(r.input,'$.agentWorkId'), json_extract(r.input,'$.coordinate.workId'))
      where r.status in ('queued','running') and json_extract(root.output,'$.agentWork.askRunId')=root.id`);
    for (const row of live) {
      const work: AgentWork = JSON.parse(row.work);
      if (work.supersededBy) continue;
      const request = one<{ text: string }>(app.db, `select text from messages where conversation_id=? and role='user'
        and json_extract(meta,'$.agentWork')=1 order by rowid limit 1`, work.workConversationId);
      followAgentWork(app, work, request?.text ?? work.title);
    }
  }
}
