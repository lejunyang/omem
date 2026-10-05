/** One synthetic cross-source requirement, real Traex/Sol research and independent review. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/server/src/store.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
import { KnowledgePipeline } from "../apps/server/src/knowledge/pipeline.js";
import {
  requirementBrief,
  requirementHandoff,
} from "../apps/server/src/knowledge/requirements.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import {
  profileSchema,
  type CaptureInput,
} from "../packages/contracts/src/index.js";
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "Requirement acceptance",
  transport: model.transport,
  command: model.command,
  args: model.args,
  model: model.model,
  effort: model.effort,
  idleTimeoutMs: model.idleTimeoutMs,
  timeoutMs: model.timeoutMs,
  maxDurationMs: model.maxDurationMs,
});
assert.equal(profile.model, "gpt-5.6-sol");
const directory = mkdtempSync(join(tmpdir(), "omem-requirement-")),
  store = new Store(join(directory, "data"));
const repository = new KnowledgeRepository(store);
const project = store.contexts.create({
  name: "工单自动分派（合成验收）",
  kind: "project",
  description: "工单主题与队列匹配、人工兜底、提醒",
});
for (const [source, path, text] of [
  [
    "manual",
    "requirement",
    "# 自动分派需求\n2026-10-01 负责人小林。billing 分派 finance，outage 分派 operations；未知主题进入 general，由值班人员人工分类。分派成功不能算处理完成。非目标：自动解决工单。期望 10 月 12 日演示。",
  ],
  [
    "chat",
    "discussion",
    "2026-10-02 小周提议：未知主题直接拒绝。\n2026-10-03 小林回复：不同意，仍保留 general，避免丢单；演示前请小周补处理完成的独立入口。提醒功能是否本期加入待会议决定。",
  ],
  [
    "manual",
    "meeting",
    "# 10 月 4 日会议纪要\n确认未知主题进入 general，周五前小周补 completeTicket 和对应验收。本期不做自动提醒；10 月 12 日仅内部演示，不承诺上线。运维尚未评估发布窗口。",
  ],
  [
    "file",
    "src/route.ts",
    "export const queues: Record<string,string> = {billing:'finance',outage:'operations'};\nexport function routeTicket(topic:string) {\n  return {queue:queues[topic] ?? 'general', state:'waiting'};\n}\n// No completion or reminder implementation in this snapshot.\n",
  ],
] as const) {
  const capture = store.capture(
    {
      source,
      externalId: path,
      title: path,
      parts: [{ type: "text", text }],
      context:
        source === "file"
          ? ({
              filePath: path,
              captureFormat: "verbatim-v1",
            } as CaptureInput["context"])
          : {},
    },
    { learning: false, notify: false },
  );
  store.setSourceContexts(capture.revision.sourceId, [project.id]);
}
store.capture(
  {
    source: "manual",
    externalId: "other",
    title: "另一个分派项目",
    parts: [{ type: "text", text: "未知主题一律拒绝，本项目已经上线。" }],
    context: {},
  },
  { learning: false, notify: false },
);
const pipeline = new KnowledgePipeline(
  repository,
  new RoleRuntimeGateway(new RoleBundleRegistry(), join(directory, "agents")),
  profile,
  { log: console.log },
);
const reportDirectory = ".repo-review/runtime/research";
try {
  const start = Date.now(),
    brief = requirementBrief({
      key: "requirement:synthetic-routing",
      title: "自动分派需求跟进",
      goal: "弄清当前验收口径、实现差距、负责人和演示范围，给出可执行交接。",
      contextIds: [project.id],
    });
  const [article] = await pipeline.writePage(brief);
  assert.ok(article);
  const handoff = requirementHandoff(repository, brief.key);
  const body = handoff.markdown;
  assert.match(body, /general/);
  assert.match(body, /小周/);
  assert.match(body, /completeTicket/);
  assert.ok(handoff.materials.every((m) => m.key !== "manual:other"));
  const writer = article.generation.trace,
    reviewer = article.review.trace;
  assert.equal(writer.roleId, "implementation-planner");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(
    join(reportDirectory, "requirement-followup.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        seconds: (Date.now() - start) / 1000,
        model: profile.model,
        article,
        handoff,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(reportDirectory, "requirement-followup.md"), body);
  console.log(
    JSON.stringify({
      passed: true,
      title: article.document.title,
      seconds: (Date.now() - start) / 1000,
      writer: writer.roleId,
      reviewer: reviewer.roleId,
      materials: handoff.materials.length,
      report: join(reportDirectory, "requirement-followup.md"),
    }),
  );
} finally {
  await pipeline.stop();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
