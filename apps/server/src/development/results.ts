import { existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store.js";
import {
  KnowledgeRepository,
  materialFromRevision,
} from "../knowledge/repository.js";
import type { DevelopmentRun } from "./runner.js";

export function ensureDevelopmentResults(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS development_results(
    run_id TEXT PRIMARY KEY,requirement_key TEXT NOT NULL,source_id TEXT NOT NULL,
    material_key TEXT NOT NULL,revision_id TEXT NOT NULL,event_id TEXT NOT NULL,learning_job_id TEXT);`);
}

export function developmentResult(store: Store, id: string) {
  ensureDevelopmentResults(store);
  const row = store.db
    .prepare("SELECT * FROM development_results WHERE run_id=?")
    .get(id);
  if (!row) return null;
  const repository = new KnowledgeRepository(store);
  const article = repository.get(String(row.requirement_key));
  const material = materialFromRevision(store, String(row.revision_id));
  return {
    materialKey: String(row.material_key),
    revisionId: String(row.revision_id),
    sourceId: String(row.source_id),
    citedByRequirement: !!article?.dependencies.some(
      (d) =>
        d.kind === "material" &&
        d.key === row.material_key &&
        d.digest === material?.digest,
    ),
    learningJob: row.learning_job_id
      ? store.jobs.get(String(row.learning_job_id))
      : null,
    meaning:
      "已保存执行记录；需求是否已更新以正文引用为准，记忆是否生效需读取学习任务及应用记录。",
  };
}

// Read a bounded excerpt without loading an arbitrarily large command log.
function excerpt(path: string, bytes: number, tail = false) {
  if (!existsSync(path)) return "未保存此文件。";
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size,
      length = Math.min(size, bytes),
      buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, tail ? size - length : 0);
    return (
      buffer.subarray(0, read).toString("utf8") +
      (size > bytes
        ? `\n[仅保留${tail ? "末尾" : "开头"} ${bytes} 字节；完整文件：${path}]`
        : "")
    );
  } finally {
    closeSync(fd);
  }
}

/** Capture observed execution, not an assertion that the user's requirement is done.
 * The same run has one source; each completed/resumed/application event is a revision.
 * Call inside the durable completion transaction so a restart can retry just this step. */
export function captureDevelopmentResult(
  store: Store,
  run: DevelopmentRun,
  event: { id: string; state: string; error?: string | null },
) {
  ensureDevelopmentResults(store);
  const previous = store.db
    .prepare("SELECT event_id FROM development_results WHERE run_id=?")
    .get(run.id);
  if (previous?.event_id === event.id) return developmentResult(store, run.id)!;
  const repository = new KnowledgeRepository(store),
    plan = repository.pages().find((p) => p.key === run.requirementKey)?.plan;
  if (!plan) throw Error("无法回流开发结果：需求计划不存在");
  const phase =
    run.state === "applied"
      ? "已应用到登记仓库，尚未提交、推送或部署"
      : run.state === "ready"
        ? "独立副本已完成本地检查与评审，尚未应用到登记仓库"
        : "实现尚未完成，保留工作副本等待处理";
  const checks = run.checks.slice(-20);
  const sections = [
    `# ${plan.title}：开发进展\n\n${phase}。\n\n这是宿主执行记录。检查退出码是执行事实，评审判断是模型意见；不代表每项业务验收或发布已完成。`,
    `## 本次工作\n\n项目：${run.project.name}\n需求：${plan.title}\n固定需求版本：${run.requirementRevision}\n工作阶段：${run.state}\n后台操作状态：${event.state}\n执行时间：${run.updatedAt}\n尝试次数：${run.attempt}\n起点提交：${run.base}\n副本提交：${run.head ?? "尚未记录"}\n评审版本：${run.reviewedFingerprint ?? "尚未评审通过"}\n工作副本：${run.checkout}\n登记仓库：${run.project.repository}`,
    event.error || run.error
      ? `## 尚待处理\n\n${event.error ?? run.error}`
      : "",
    `## 实际检查\n\n${checks.length ? checks.map((c) => `### ${c.name}\n\n时间：${c.at}\n退出码：${c.exitCode}\n受检版本：${c.sourceFingerprint}\n\n~~~text\n${excerpt(c.log, 3500, true)}\n~~~`).join("\n\n") : "尚无宿主检查结果。"}${run.checks.length > checks.length ? "\n\n只展示最近 20 次检查，完整历史仍在任务记录中。" : ""}`,
    `## 独立评审意见\n\n${run.review ? JSON.stringify(run.review, null, 2) : "尚无独立评审意见。"}\n\n以上为评审模型的结论，应结合检查范围和补丁判断；不能作为另一份独立事实。`,
    `## 评审补丁\n\n${run.reviewedFingerprint ? `~~~diff\n${excerpt(join(run.directory, "changes.patch"), 70000)}\n~~~` : "尚无已评审通过的补丁。"}`,
  ].filter(Boolean);
  return store.tx(() => {
    const capture = store.capture(
      {
        source: "hook",
        externalId: `development:${run.id}`,
        title: `${plan.title}：开发进展`,
        parts: sections.map((text) => ({ type: "text" as const, text })),
        context: {
          application: "omem.development",
          runId: run.id,
          event: event.id,
        },
        provenance: {
          collectorId: "omem.development",
          actorId: "development-runner",
          actorType: "system",
          actorVerifiedBy: "host-execution",
          sourceUri: null,
          eventId: event.id,
          eventAt: run.updatedAt,
          timezone: null,
          quoted: false,
          forwarded: false,
          producerKind: "original",
        },
      },
      { contextIds: plan.contextIds, notify: false },
    );
    const material = materialFromRevision(store, capture.revision.id)!;
    store.db
      .prepare(
        `INSERT INTO development_results VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      revision_id=excluded.revision_id,event_id=excluded.event_id,learning_job_id=excluded.learning_job_id`,
      )
      .run(
        run.id,
        run.requirementKey,
        capture.revision.sourceId,
        material.key,
        capture.revision.id,
        event.id,
        capture.job?.id ?? null,
      );
    repository.attachInput(
      run.requirementKey,
      capture.revision.sourceId,
      "development-result",
    );
    repository.refresh();
    return developmentResult(store, run.id)!;
  });
}
