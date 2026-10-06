/** Disposable multi-source requirement -> tasks -> real coding -> independent review -> apply. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../apps/server/src/store.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
import { KnowledgePipeline } from "../apps/server/src/knowledge/pipeline.js";
import { requirementBrief } from "../apps/server/src/knowledge/requirements.js";
import { RequirementTasks } from "../apps/server/src/knowledge/requirement-tasks.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { DevelopmentRunner } from "../apps/server/src/development/runner.js";
import { captureDevelopmentResult } from "../apps/server/src/development/results.js";
import { git, saveJson } from "../apps/server/src/development/workspace.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "Development acceptance",
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
const directory = mkdtempSync(join(tmpdir(), "omem-development-")),
  source = join(directory, "project"),
  data = join(directory, "data");
mkdirSync(join(source, "src"), { recursive: true });
const original = `export function routeTicket(topic) {\n  return { queue: ({billing:'finance',outage:'operations'})[topic] ?? 'general', state: 'waiting' };\n}\n`;
writeFileSync(join(source, "src/tickets.mjs"), original);
writeFileSync(
  join(source, "AGENTS.md"),
  "# Project rules\nUse ESM JavaScript, no external runtime dependencies. Keep the public routeTicket API compatible. Do not change acceptance.cjs. Run the configured tests.\n",
);
writeFileSync(
  join(source, "src/AGENTS.md"),
  "# Ticket conventions\nAll state transition functions return a new object and preserve extra ticket fields. Never mutate the input object. completedAt must use the supplied timestamp, never Date.now or new Date.\n",
);
writeFileSync(
  join(source, "acceptance.cjs"),
  `const assert=require('node:assert/strict');\n(async()=>{const {routeTicket,completeTicket}=await import('./src/tickets.mjs');
assert.equal(routeTicket('unknown').queue,'general');assert.equal(routeTicket('billing').state,'waiting');
const input=Object.freeze({id:'T1',queue:'finance',state:'waiting',note:'preserve'});
const output=completeTicket(input,'2026-10-06T09:00:00Z');assert.notEqual(output,input);assert.equal(output.state,'done');assert.equal(output.note,'preserve');assert.equal(output.completedAt,'2026-10-06T09:00:00Z');assert.equal(input.state,'waiting');console.log('Ticket workflow accepted');})().catch(e=>{console.error(e);process.exit(1)});\n`,
);
await git(source, "init", "--quiet");
await git(source, "add", ".");
await git(
  source,
  "-c",
  "user.name=omem",
  "-c",
  "user.email=local@omem.invalid",
  "commit",
  "-qm",
  "fixture base",
);
const store = new Store(data),
  repository = new KnowledgeRepository(store);
const context = store.contexts.create({
  name: "分派功能",
  kind: "project",
  description: "工单分类与完成状态",
});
for (const [id, text] of [
  [
    "requirement",
    "# 工单完成入口\n保留 routeTicket 的现有分类行为：billing 去 finance，outage 去 operations，未知类别去 general，状态为 waiting。新增 completeTicket(ticket, completedAt)：返回新对象，将状态变为 done，保留其他字段，并将传入时间保存为 completedAt。不能修改原 ticket。验收见 acceptance.cjs。非目标：自动解决工单、通知或发布。",
  ],
  [
    "chat",
    "小周：要不要未知类别直接报错？小林：不采用，保持 general。小周负责补完成入口。",
  ],
  [
    "meeting",
    "会议结论：本轮仅实现上述完成入口并跑通本地验收，不能宣称已部署。小周等接口完成后再演示；演示时间未定。",
  ],
  ["code", original],
] as const) {
  const c = store.capture(
    {
      source: id === "chat" ? "chat" : "manual",
      externalId: id,
      title: id,
      parts: [{ type: "text", text }],
      context: {},
    },
    { learning: false, notify: false },
  );
  store.setSourceContexts(c.revision.sourceId, [context.id]);
}
const pipeline = new KnowledgePipeline(
  repository,
  new RoleRuntimeGateway(new RoleBundleRegistry(), join(directory, "agents")),
  profile,
  { log: console.log },
);
const report = ".repo-review/runtime/research/development.json";
const start = Date.now();
let passed = false;
try {
  const brief = requirementBrief({
    key: "requirement:development-acceptance",
    title: "工单完成入口",
    goal: "明确本轮验收、分工及实现入口，供编码 Agent 开始工作。",
    contextIds: [context.id],
  });
  const [article] = await pipeline.writePage(brief);
  assert.ok(article?.document.requirement);
  const tasks = new RequirementTasks(store),
    action = article.document.requirement.actions.find(
      (a) => a.certainty === "confirmed" && a.status !== "done",
    );
  assert.ok(action, "should expose a confirmed follow-up action");
  tasks.follow(brief.key, action.id, article.revision);
  assert.equal(store.tasks().length, 1);
  tasks.sync(article);
  assert.equal(store.tasks().length, 1);
  const runner = new DevelopmentRunner(data);
  await runner.register("tickets", {
    name: "Tickets",
    repository: source,
    commands: [
      {
        name: "acceptance",
        command: process.execPath,
        args: ["acceptance.cjs"],
        purpose: "test",
      },
    ],
  });
  const run = await runner.create("tickets", brief.key, store);
  console.log(`Development run: ${run.id}`);
  const result = await runner.execute(run.id, store, profile, {
    log: console.log,
  });
  assert.equal(
    result.state,
    "ready",
    JSON.stringify({ error: result.error, review: result.review }),
  );
  assert.equal(
    readFileSync(join(source, "src/tickets.mjs"), "utf8"),
    original,
    "source worktree must remain untouched before apply",
  );
  assert.notEqual(result.review?.criteria.length, 0);
  const outcome = captureDevelopmentResult(store, result, {
    id: "live-ready",
    state: "succeeded",
  });
  assert.equal(outcome.learningJob?.kind, "extract_claims");
  assert.equal(outcome.citedByRequirement, false);
  console.log("Updating the same requirement from captured execution results");
  const [updated] = await pipeline.writePage(brief);
  assert.ok(updated?.document.requirement);
  assert.notEqual(updated.revision, article.revision);
  assert.ok(
    updated.dependencies.some(
      (d) => d.kind === "material" && d.key === outcome.materialKey,
    ),
    "updated requirement must read actual execution",
  );
  assert.ok(
    updated.document.requirement.criteria.some(
      (c) => c.status === "verified" || c.status === "implemented",
    ),
    "progress must change from actual work",
  );
  assert.ok(
    updated.document.requirement.criteria.every((c) => c.status !== "released"),
    "local execution is not deployment",
  );
  tasks.sync(updated);
  const applied = await runner.apply(run.id);
  const appliedOutcome = captureDevelopmentResult(store, applied, {
    id: "live-applied",
    state: "succeeded",
  });
  assert.equal(appliedOutcome.sourceId, outcome.sourceId);
  assert.notEqual(appliedOutcome.revisionId, outcome.revisionId);
  assert.ok(store.revision(outcome.revisionId));
  assert.notEqual(
    readFileSync(join(source, "src/tickets.mjs"), "utf8"),
    original,
  );
  const test = await import("../apps/server/src/development/workspace.js");
  const checked = await test.runCommand(
    source,
    result.project,
    "acceptance",
    join(directory, "final-check"),
  );
  assert.equal(checked.exitCode, 0);
  saveJson(report, {
    at: new Date().toISOString(),
    seconds: (Date.now() - start) / 1000,
    passed: true,
    model: profile.model,
    article: article.document,
    updated: updated.document,
    research: updated.investigation,
    traces: { initial: { generation: article.generation, review: article.review }, update: { generation: updated.generation, review: updated.review } },
    outcome,
    appliedOutcome,
    task: store.tasks()[0],
    run: result,
  });
  passed = true;
  console.log(
    JSON.stringify({
      passed: true,
      seconds: (Date.now() - start) / 1000,
      report,
      attempts: result.attempt,
    }),
  );
  // Keep only role results and summaries; large exported snapshots are already removed by research.close().
} catch (error) {
  saveJson(report, {
    at: new Date().toISOString(),
    passed: false,
    error: String(error),
    directory,
    seconds: (Date.now() - start) / 1000,
  });
  throw error;
} finally {
  await pipeline.stop();
  store.close();
  if (passed) rmSync(directory, { recursive: true, force: true });
}
