import type { Store } from "../store.js";
import type { AssistantWork } from "../assistant/work.js";
import { readableMemory } from "../memory/service.js";

type InboxItem = {
  id: unknown;
  revision_id: unknown;
  state: unknown;
  error?: unknown;
  resources: { revisionId?: string }[];
};
const activeJobs = new Set(["queued", "leased", "running", "retry_wait"]);

/** A view of actual jobs and applications. Classifier labels never mean facts
 * have been applied, and project membership never means a page cited a message. */
export class MessageUnderstanding {
  constructor(
    readonly store: Store,
    readonly work: AssistantWork,
  ) {}
  read<T extends InboxItem>(items: T[]) {
    const repository = this.work.pages.repository;
    const materials = new Map(repository.materials().map((m) => [m.key, m]));
    const plans = new Map(repository.pages().map((p) => [p.key, p.plan!]));
    const follows = this.work.catalog().requirements.map((f) => ({
      ...f,
      citedSourceIds: new Set(
        (repository.get(f.key)?.dependencies ?? [])
          .filter((d) => d.kind === "material")
          .flatMap((d) => {
            const m = materials.get(d.key);
            return m ? [m.sourceId] : [];
          }),
      ),
      selectedSourceIds: new Set(
        repository.materialsForPlan(plans.get(f.key)!).map((m) => m.sourceId),
      ),
    }));
    return items.map((item) => ({
      ...item,
      understanding: this.forItem(item, follows),
    }));
  }
  private forItem(
    item: InboxItem,
    follows: (ReturnType<AssistantWork["catalog"]>["requirements"][number] & {
      citedSourceIds: Set<string>;
      selectedSourceIds: Set<string>;
    })[],
  ) {
    const revision = item.revision_id
      ? this.store.revision(String(item.revision_id))
      : null;
    if (!revision)
      return {
        stage: "saving",
        label: "尚未保存完整原文",
        results: [],
        questions: [],
        projects: [],
        requirements: [],
        feedback: [],
      };
    const contexts = this.store.contexts.forSource(revision.sourceId);
    const assignment = this.store.contexts.assignment(revision.sourceId);
    const job = this.store.db
      .prepare(
        `SELECT j.* FROM jobs j WHERE kind='extract_claims'
      AND EXISTS (SELECT 1 FROM json_each(j.input_refs) r WHERE json_extract(r.value,'$.revisionId')=?)
      ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1`,
      )
      .get(revision.id);
    const review =
      job &&
      this.store.db
        .prepare(
          "SELECT * FROM jobs WHERE parent_job_id=? AND kind='verify_proposals' ORDER BY created_at DESC LIMIT 1",
        )
        .get(String(job.id));
    const output =
      job?.result_ref &&
      this.store.db
        .prepare("SELECT output_json FROM role_outputs WHERE id=?")
        .get(String(job.result_ref));
    const batch = output ? JSON.parse(String(output.output_json)) : null;
    const questions = (batch?.abstentions ?? [])
      .filter(
        (a: any) => !["duplicate", "no_durable_value"].includes(a.reason_code),
      )
      .map((a: any) => String(a.detail));
    if (assignment?.status === "ambiguous" && assignment.question)
      questions.unshift(assignment.question);
    const results = this.store.db
      .prepare(
        `SELECT DISTINCT p.*,a.entity_id,a.entity_type,a.entity_version,
      COALESCE(m.status,t.status) AS entity_status, m.version AS memory_version, t.version AS task_version
      FROM proposals p JOIN json_each(p.evidence) e
      JOIN fragments f ON f.id=json_extract(e.value,'$.fragment_revision_id')
      LEFT JOIN application_receipts a ON a.proposal_id=p.id
      LEFT JOIN memories m ON m.id=a.entity_id AND a.entity_type='memory'
      LEFT JOIN tasks t ON t.id=a.entity_id AND a.entity_type='task'
      WHERE f.revision_id=? OR EXISTS (
        SELECT 1 FROM message_feedback mf WHERE mf.source_id=? AND mf.revision_id=f.revision_id
      ) ORDER BY p.created_at DESC LIMIT 30`,
      )
      .all(revision.id, revision.sourceId)
      .map((p) => {
        const body = JSON.parse(String(p.body));
        const currentVersion =
          p.entity_type === "task" ? p.task_version : p.memory_version;
        const earlier =
          p.entity_id &&
          (p.entity_version !== currentVersion ||
            ["invalidated", "superseded", "archived"].includes(
              String(p.entity_status),
            ));
        return {
          id: String(p.id),
          kind: String(p.kind),
          operation: String(p.operation),
          text:
            p.kind === "task"
              ? [body.title, body.next_step].filter(Boolean).join("：")
              : readableMemory(String(p.kind), body),
          state: earlier ? "historical" : String(p.state),
          applied: !!p.entity_id,
          entityId: p.entity_id ? String(p.entity_id) : null,
          sourceCurrent:
            this.store.db
              .prepare("SELECT head FROM sources WHERE id=?")
              .get(revision.sourceId)?.head === revision.id,
        };
      });
    const sourceIds = new Set([
      revision.sourceId,
      ...this.store.messageFeedback.forSource(revision.sourceId).flatMap((f) => {
        const correction = this.store.revision(String(f.revisionId));
        return correction ? [correction.sourceId] : [];
      }),
      ...item.resources.flatMap((r) => {
        const related = r.revisionId && this.store.revision(r.revisionId);
        return related ? [related.sourceId] : [];
      }),
    ]);
    const requirements = follows.flatMap((f) => {
      const cited = [...sourceIds].some((id) => f.citedSourceIds.has(id));
      const selected = [...sourceIds].some((id) => f.selectedSourceIds.has(id));
      return cited || selected
        ? [
            {
              key: f.key,
              title: f.title,
              cited,
              current: f.current,
              state: f.maintenance?.state ?? "idle",
            },
          ]
        : [];
    });
    let stage = "saved",
      label = "原文已保存，尚未安排理解";
    if (job) {
      if ([job.state, review?.state].some((s) => activeJobs.has(String(s)))) {
        stage = "understanding";
        label = review ? "正在复查结论" : "正在理解消息";
      } else if ([job.state, review?.state].includes("failed")) {
        stage = "failed";
        label = "理解未完成，可重试";
      } else if (
        questions.length ||
        results.some((r) => r.state === "awaiting_decision")
      ) {
        stage = "needs_context";
        label = "需要补充或确认";
      } else if (results.some((r) => r.applied && r.state !== "historical")) {
        stage = "applied";
        label = "已更新记忆或事项";
      } else if (job.state === "succeeded") {
        stage = "read";
        label = "已阅读，本次没有新增记忆";
      }
    }
    if (item.state === "review" && !job) label = "已保存，部分内容待补读";
    return {
      stage,
      label,
      results,
      questions,
      error: job?.last_error ?? review?.last_error ?? null,
      note: (batch?.abstentions ?? [])
        .filter((a: any) =>
          ["duplicate", "no_durable_value"].includes(a.reason_code),
        )
        .map((a: any) => String(a.detail))
        .join("；"),
      projects: this.store.contexts
        .list()
        .filter((c) => contexts.includes(c.id))
        .map((c) => ({ id: c.id, name: c.name })),
      requirements,
      feedback: this.store.messageFeedback.history(revision.sourceId),
      preferences: this.store.messageFeedback
        .forSource(revision.sourceId)
        .filter((f) => f.scope === "conversation"),
    };
  }
}
