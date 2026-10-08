/** Real Traex/Sol on explicitly synthetic events. No private Feishu or delivery.
 * Keep one owned preview for browser reading; overwrite the same report. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildApp } from "../apps/server/src/app.js";
import { Store } from "../apps/server/src/store.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
const directory = resolve(".repo-review/runtime/context-view-preview");
mkdirSync(directory, { recursive: true });
if (existsSync(join(directory, "data", "omem.sqlite")))
  throw Error(
    "Preview already exists; inspect its purpose before removing or replaying",
  );
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "项目理解验收",
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
assert.equal(profile.transport, "acp");
const config = {
  host: "127.0.0.1",
  port: 0,
  dataDir: join(directory, "data"),
  agentCwd: join(directory, "agents"),
  captureRoots: [],
  profiles: [profile],
  notifications: { mode: "instant" as const },
  decisions: { mode: "off" as const },
  learning: { enabled: false, profileId: "traex", pollMs: 1000 },
};
writeFileSync(
  join(directory, "config.json"),
  JSON.stringify(
    { ...config, agentsConfiguredAt: new Date().toISOString() },
    null,
    2,
  ) + "\n",
);
let built = await buildApp(config);
const report: any = {
  startedAt: new Date().toISOString(),
  implementationCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  model: profile.model,
  scenario:
    "合成发布协调：两次改期、交接及预算纠正，保留验收人和费用条件；不含私人材料",
  stages: [],
  passed: false,
};
const persist = () =>
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const path = (id: string) =>
  `/api/knowledge/context-views/${encodeURIComponent(id)}`;
async function read(id: string) {
  const r = await built.app.inject(path(id));
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function wait(id: string, previous?: string) {
  const deadline = Date.now() + 20 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const v = await read(id);
    if (v.maintenance?.state !== last) {
      last = v.maintenance?.state;
      console.log("VIEW", last);
    }
    if (v.maintenance?.state === "failed") throw Error(v.maintenance.error);
    if (v.current && v.revision !== previous) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw Error("Project understanding did not finish");
}
const text = (v: any) => v.document.sections.map((s: any) => s.body).join("\n");
function capture(
  store: Store,
  id: string,
  body: string,
  eventAt: string,
  contextId: string,
) {
  return store.capture(
    {
      source: "chat",
      externalId: id,
      title: "[合成演示] 发布协调讨论",
      parts: [{ type: "text", text: body }],
      context: { conversationId: "synthetic-project-view" },
      provenance: {
        collectorId: "acceptance",
        actorId: "owner",
        actorType: "owner",
        actorVerifiedBy: "synthetic-owner",
        sourceUri: null,
        eventId: id,
        eventAt,
        timezone: "Asia/Shanghai",
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    },
    { contextIds: [contextId], learning: false, notify: false },
  );
}
try {
  const context = built.store.contexts.create({
    name: "[合成演示] 发布协调",
    kind: "project",
    description: "上线安排、负责人及预算，全部为合成验收材料",
  });
  report.contextId = context.id;
  capture(
    built.store,
    "initial",
    "【合成演示】10 月 1 日已确认：10 月 15 日上线；小林负责实现，小周验收。总预算 8000 元，包含云费用 3000 元。付款日尚未约定。",
    "2026-10-01T10:00:00+08:00",
    context.id,
  );
  const conversation = built.assistant.conversations.open({
    principalId: "owner",
    channel: "web",
    chatId: "context-view-acceptance",
    visibility: "private",
  });
  const result = await built.assistant.turn({
    conversationId: conversation.id,
    userText:
      "持续整理「[合成演示] 发布协调」这个项目的当前安排和变化，后续新增材料维护同一份理解。不创建待办。",
  });
  const turn = built.assistant.conversations.turn(result.turn.id)!;
  report.turn = { result: turn.result, tools: turn.toolActions };
  persist();
  assert.equal(turn.inputMessageRefs.status, "done");
  const first = await wait(context.id);
  report.stages.push({ stage: "initial", view: first });
  persist();
  assert.match(text(first), /8000|8,000/);
  const key = first.key,
    revision = first.revision;
  await built.app.close();
  const offline = new Store(config.dataDir);
  capture(
    offline,
    "change",
    "【合成演示】10 月 3 日决定：外部接口延期，上线改为 10 月 18 日。小陈接替小林负责实现，小周继续验收，费用包含条件不变。",
    "2026-10-03T10:00:00+08:00",
    context.id,
  );
  capture(
    offline,
    "correction",
    "【合成演示】10 月 5 日本人纠正：总预算是 9000 元，其中云费用 3500 元已包含在总额内，不能再加一次。为完成验收，上线再改到 10 月 20 日。付款日仍未约定。",
    "2026-10-05T10:00:00+08:00",
    context.id,
  );
  const other = offline.contexts.create({
    name: context.name,
    kind: "project",
    description: "同名的其他项目",
  });
  capture(
    offline,
    "other",
    "【合成演示】另一项目 10 月 30 日上线，总预算 99999 元。",
    "2026-10-06T10:00:00+08:00",
    other.id,
  );
  offline.close();
  built = await buildApp(config);
  const pending = await read(context.id);
  assert.equal(pending.key, key);
  assert.equal(pending.current, false);
  const updated = await wait(context.id, revision);
  assert.equal(updated.key, key);
  const body = text(updated);
  assert.match(body, /9000|9,000/);
  assert.match(body, /3500|3,500/);
  assert.match(body, /小陈/);
  assert.match(body, /小周/);
  assert.match(body, /20/);
  assert.match(body, /外部接口/);
  assert.match(body, /验收/);
  assert.match(body, /未约定|未确定|尚未/);
  assert.doesNotMatch(body, /99999/);
  report.stages.push({ stage: "restart-and-coalesced-events", view: updated });
  persist();
  const jobsBefore = built.store.jobs.list().length;
  const reads = await Promise.all([read(context.id), read(context.id)]);
  assert.ok(reads.every((v) => v.revision === updated.revision));
  assert.equal(built.store.jobs.list().length, jobsBefore);
  assert.equal(built.store.tasks().length, 0);
  report.passed = true;
  console.log(
    "PASS same view, corrected budget, preserved constraints, current/history distinction and isolated same-name project",
  );
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  persist();
  await built.app.close();
}
