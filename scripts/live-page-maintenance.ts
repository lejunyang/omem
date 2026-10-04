/** Real Sol acceptance of opt-in maintenance through the application API.
 * Synthetic originals and the temporary database are released after the run. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { Store } from "../apps/server/src/store.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema, type CaptureInput } from "../packages/contracts/src/index.js";

const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({ id: "traex", name: "Live page maintenance", transport: model.transport,
  command: model.command, args: model.args, model: model.model, effort: model.effort, timeoutMs: model.timeoutMs });
assert.equal(profile.model, "gpt-5.6-sol");
const dir = mkdtempSync(join(tmpdir(), "omem-live-page-maintenance-"));
const config = { dataDir: join(dir, "data"), agentCwd: join(dir, "agents"), host: "127.0.0.1", port: 0,
  captureRoots: [], notifications: { mode: "instant" as const }, profiles: [profile] };
const input = (amount: number, hour: string): CaptureInput => ({
  source: "manual", externalId: "reading-group-agreement", title: "阅读小组约定（合成验收材料）",
  context: {}, parts: [{ type: "text", text: `# 阅读小组约定（合成验收材料）\n\n2026 年 10 月 9 日 14:00 在三楼会议室举办阅读活动，小林负责组织。\n\n每人费用 ${amount} 元，包含材料费，不包含交通费。报名截止时间为 2026 年 10 月 8 日 ${hour}。` }],
});
const key = "acceptance:reading-group";
let built = await buildApp(config);
const report: Record<string, any> = { startedAt: new Date().toISOString(), model: profile.model, passed: false, inputs: "Synthetic dated reading-group agreement; no personal data.", stages: [] };
async function state() {
  const response = await built.app.inject("/api/knowledge/articles");
  assert.equal(response.statusCode, 200);
  return response.json().pages.find((p: any) => p.key === key);
}
async function waitPublished(previous?: string) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const page = await state();
    if (page?.maintenance?.state === "failed") throw Error(page.maintenance.error);
    const article = new KnowledgeRepository(built.store).get(key);
    if (article && article.revision !== previous && page?.maintenance?.state === "published") return article;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error("Page maintenance did not finish");
}
try {
  const createdContext = await built.app.inject({ method: "POST", url: "/api/contexts", payload: { name: "阅读小组（合成验收）", kind: "project", description: "本次阅读活动的报名、费用与现场安排" } });
  assert.equal(createdContext.statusCode, 200);
  const contextId = createdContext.json().id;
  const captured = await built.app.inject({ method: "POST", url: "/api/captures", payload: { ...input(80, "18:00"), contextIds: [contextId] } });
  assert.equal(captured.statusCode, 200);
  const material = new KnowledgeRepository(built.store).materials()[0]!;
  const requested = await built.app.inject({ method: "POST", url: "/api/knowledge/pages", payload: {
    revisionIds: [], brief: { key, title: "参加阅读小组前需要知道什么", order: 0, kind: "how-to", contextIds: [contextId],
      reader: "准备报名的参加者", goal: "用一段连贯说明让参加者知道活动时间、地点、组织者、费用包含范围和报名截止时间。不展开未约定事项。",
      scenario: "准备报名并安排交通", questions: ["何时、在哪里参加，找谁联系？", "费用包含什么，何时截止报名？"], entryPaths: [], topicPath: ["流程验收"] },
  } });
  assert.equal(requested.statusCode, 202);
  const start = Date.now(), first = await waitPublished();
  report.stages.push({ stage: "initial", seconds: (Date.now() - start) / 1000, article: first });
  console.log("PUBLISHED initial", first.document.title);
  const enabled = await built.app.inject({ method: "PUT", url: `/api/knowledge/pages/${encodeURIComponent(key)}/maintenance`, payload: { enabled: true } });
  assert.equal(enabled.statusCode, 200);
  await built.app.close();
  const offline = new Store(config.dataDir);
  offline.capture(input(120, "20:00"));
  offline.close();
  const updateStart = Date.now();
  built = await buildApp(config);
  const updated = await waitPublished(first.revision);
  const body = updated.document.sections.map(s => s.body).join("\n");
  assert.match(body, /120/);
  assert.match(body, /20[:：]00/);
  assert.match(body, /交通/);
  assert.match(body, /小林/);
  const repository = new KnowledgeRepository(built.store);
  assert.equal(repository.get(key, first.revision)?.document.sections[0]?.body, first.document.sections[0]?.body);
  assert.equal((await state()).maintenance.enabled, true);
  const detail = (await built.app.inject(`/api/knowledge/articles/${encodeURIComponent(key)}`)).json();
  assert.ok(detail.citations.every((c: any) => c.actionable));
  report.stages.push({ stage: "automatic-after-restart", seconds: (Date.now() - updateStart) / 1000, article: updated });
  // A separate original is admitted by persisted membership, not by a title or
  // keyword match. Unlinked content with the same subject must stay outside.
  const unrelated = await built.app.inject({ method: "POST", url: "/api/captures", payload: {
    ...input(999, "12:00"), externalId: "unrelated-reading-group", title: "另一场阅读小组（合成干扰材料）",
  } });
  assert.equal(unrelated.statusCode, 200);
  const added = await built.app.inject({ method: "POST", url: "/api/captures", payload: {
    source: "chat", externalId: "venue-update", title: "10 月 6 日场地与签到补充（合成验收材料）", context: {}, contextIds: [contextId],
    parts: [{ type: "text", text: "2026 年 10 月 6 日，小林补充：10 月 9 日阅读活动改在东侧阅读室举行，不再使用三楼会议室。小周负责现场签到。活动时间、120 元费用（含材料费、不含交通费）及 10 月 8 日 20:00 报名截止不变。" }],
  } });
  assert.equal(added.statusCode, 200);
  const addedStart = Date.now(), expanded = await waitPublished(updated.revision);
  const expandedBody = expanded.document.sections.map(s => s.body).join("\n");
  assert.match(expandedBody, /东侧阅读室/);
  assert.match(expandedBody, /小周/);
  assert.match(expandedBody, /120/);
  assert.doesNotMatch(expandedBody, /999/);
  assert.ok(expanded.dependencies.some(d => d.key === "chat:venue-update"));
  assert.ok(!expanded.selection?.materialKeys.includes("manual:unrelated-reading-group"));
  assert.ok(repository.get(key, updated.revision));
  report.stages.push({ stage: "new-linked-original", seconds: (Date.now() - addedStart) / 1000, article: expanded });
  report.status = await state();
  report.historyRetained = true;
  report.passed = true;
  console.log("PASS automatic update after restart and new project source, preserved conditions and old article");
} catch (error) { report.error = String(error); process.exitCode = 1; console.error(error); }
finally {
  await built.app.close();
  report.finishedAt = new Date().toISOString();
  mkdirSync(".repo-review/runtime/research", { recursive: true });
  writeFileSync(".repo-review/runtime/research/page-maintenance.json", JSON.stringify(report, null, 2) + "\n");
  rmSync(dir, { recursive: true, force: true });
}
