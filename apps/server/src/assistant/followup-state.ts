import type {
  WikiPageBrief,
  KnowledgeMaterial,
} from "../../../../packages/contracts/src/knowledge.js";
import type { Store } from "../store.js";
import type { DevelopmentQueue } from "../development/queue.js";
import { KnowledgeRepository } from "../knowledge/repository.js";
import type { ResearchTool } from "../knowledge/agent-research.js";

/** Execution state is original host observation, not another model's summary.
 * One source per follow; unchanged state reuses its revision. Never include the
 * generated article itself here, which would cause a maintenance feedback loop. */
export function captureFollowupState(
  store: Store,
  repository: KnowledgeRepository,
  plan: WikiPageBrief,
  development: DevelopmentQueue,
) {
  if (plan.workflow !== "requirement-followup") return;
  const linked = new Set(
    store.db
      .prepare(
        "SELECT task_id FROM requirement_tasks WHERE page_key=? AND task_id IS NOT NULL",
      )
      .all(plan.key)
      .map((r) => String(r.task_id)),
  );
  const tasks = store
    .tasks()
    .filter(
      (t) =>
        t.ownerId === "owner" &&
        (linked.has(String(t.id)) ||
          (!!t.projectId &&
            (plan.contextIds ?? []).includes(String(t.projectId)))),
    );
  const runs = development
    .list()
    .filter((t) => t.key === plan.key)
    .map((t) => ({
      taskId: t.id,
      state: t.job.state,
      phase: t.run?.state ?? "queued",
      error: t.job.lastError ?? t.run?.error ?? null,
      applied: t.run?.state === "applied",
      published: false,
      reviewedFingerprint: t.run?.reviewedFingerprint ?? null,
      checks:
        t.run?.checks.map((c) => ({
          name: c.name,
          exitCode: c.exitCode,
          at: c.at,
          sourceFingerprint: c.sourceFingerprint,
        })) ?? [],
      result: t.run
        ? (store.db
            .prepare(
              "SELECT material_key,revision_id FROM development_results WHERE run_id=?",
            )
            .get(t.run.id) ?? null)
        : null,
    }));
  const state = { tasks, development: runs };
  const capture = store.capture(
    {
      source: "hook",
      externalId: `followup-state:${plan.key}`,
      title: `${plan.title}：实际事项与执行状态`,
      parts: [
        {
          type: "text",
          text: `# 实际事项与执行状态\n\n以下是本系统保存的当前事项与执行记录，不是讨论里的计划或模型评审意见。事项已创建与事项已完成分开；waiting 表示尚在等待，followUp.next_check_at 是检查时间，不是截止日期。检查只证明所列命令和受检版本，不代表发布。已存在的事项沿用 id 和 version，不能重复创建。\n\n~~~json\n${JSON.stringify(state, null, 2)}\n~~~`,
        },
      ],
      context: { application: "omem.followup-state", runId: plan.key },
      provenance: {
        collectorId: "omem.followup-state",
        actorId: "host",
        actorType: "system",
        actorVerifiedBy: "host-execution",
        sourceUri: null,
        eventId: null,
        eventAt: null,
        timezone: null,
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    },
    { learning: false, notify: false },
  );
  repository.attachInput(plan.key, capture.revision.sourceId, "followup-state");
}

/** Every phase reads its fixed input, including an independent review. */
export function followupStateTools(
  materials: KnowledgeMaterial[],
): ResearchTool[] {
  const states = materials.filter(
    (m) => m.namespace === "hook" && m.key.startsWith("hook:followup-state:"),
  );
  if (!states.length) return [];
  return [
    {
      name: "read_followup_state",
      readOnly: true,
      description:
        "Read the fixed host snapshot of actual personal tasks, waiting/check-in times, coding phase and check records. Read before claiming a task has not been created or asking the owner about an execution result. Citation evidence is the returned materialKey and original line range; use read_material/read_fragments for exact references. A completed code check is not publication.",
      shape: {},
      run: () =>
        states.map((m) => ({
          materialKey: m.key,
          revisionId: m.revisionId,
          text: m.text,
          startLine: 1,
          endLine: m.lineCount,
        })),
    },
  ];
}
