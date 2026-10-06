/** Production assistant -> persistent follow/feedback -> background coding.
 * All materials and the repository are synthetic; no private integrations run. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { git, saveJson } from "../apps/server/src/development/workspace.js";

delete process.env.OMEM_REPO_ROOT;
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "Assistant work acceptance",
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
const directory = mkdtempSync(join(tmpdir(), "omem-assistant-work-")),
  source = join(directory, "project");
const output = resolve(".repo-review/runtime/research/assistant-work");
mkdirSync(output, { recursive: true });
mkdirSync(join(source, "src"), { recursive: true });
const original =
  "export function routeTicket(topic) { return {queue: topic === 'billing' ? 'finance' : 'general', state:'waiting'}; }\n";
writeFileSync(join(source, "src/tickets.mjs"), original);
writeFileSync(
  join(source, "AGENTS.md"),
  "Use ESM JavaScript without new dependencies. Do not edit acceptance.cjs. Keep routeTicket compatible. Return new objects, preserve extra ticket fields, never mutate input. Use supplied completedAt exactly.\n",
);
writeFileSync(
  join(source, "acceptance.cjs"),
  `const assert=require('node:assert/strict');
(async()=>{const {routeTicket,completeTicket}=await import('./src/tickets.mjs');
assert.equal(routeTicket('billing').queue,'finance');assert.equal(routeTicket('other').queue,'general');
const input=Object.freeze({id:'T1',state:'waiting',note:'keep'});const out=completeTicket(input,'2026-10-06T12:00:00Z');
assert.notEqual(out,input);assert.equal(out.state,'done');assert.equal(out.note,'keep');assert.equal(out.completedAt,'2026-10-06T12:00:00Z');assert.equal(input.state,'waiting');
console.log('Ticket completion accepted');})().catch(e=>{console.error(e);process.exit(1)});\n`,
);
await git(source, "init", "-q");
await git(source, "add", ".");
await git(
  source,
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
  "commit",
  "-qm",
  "acceptance base",
);
const system = await buildApp({
  profiles: [profile],
  assistant: { profileId: "traex" },
  notifications: { mode: "instant" },
  learning: { enabled: false, profileId: "traex", pollMs: 1000 },
  lark: { enabled: false, pollMs: 1000 },
  retrieval: { enabled: false, osdkModel: "memory-zh" },
  decisions: { mode: "auto" },
  captureRoots: [],
  dataDir: join(directory, "data"),
  agentCwd: directory,
  host: "127.0.0.1",
  port: 0,
});
const context = system.store.contexts.create({
  name: "工单完成入口",
  kind: "project",
  description: "工单分派与完成状态，当前只实现后端函数",
});
for (const [id, title, text] of [
  [
    "spec",
    "工单完成入口需求",
    "新增 completeTicket(ticket, completedAt)：返回新对象，将 state 变为 done，保留其他字段，原样保存传入 completedAt，不能修改原 ticket。保留 routeTicket 原有行为。验收运行 acceptance.cjs。非目标：页面、通知、部署。",
  ],
  [
    "meeting",
    "工单会议纪要",
    "小周负责实现完成入口，待本地验收通过再演示。本次无页面、群通知和发布；演示日期未定。",
  ],
  ["code", "src/tickets.mjs", original],
] as const)
  system.store.capture(
    {
      source: "manual",
      externalId: id,
      title,
      parts: [{ type: "text", text }],
      context: {},
    },
    { contextIds: [context.id], learning: false, notify: false },
  );
await system.work.development.runner.register("tickets", {
  name: "工单服务",
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
await system.app.ready();
const conversation = system.assistant.conversations.open({
  principalId: "owner",
  channel: "web",
  chatId: "live-work",
  visibility: "private",
});
const turns: unknown[] = [];
const start = Date.now();
let passed = false;
async function ask(text: string) {
  console.log(`用户：${text}`);
  const result = await system.assistant.turn({
    conversationId: conversation.id,
    userText: text,
  });
  const turn = system.assistant.conversations.turn(result.turn.id)!;
  console.log(`助手：${turn.result || JSON.stringify(turn.inputMessageRefs)}`);
  assert.equal(
    turn.inputMessageRefs.status,
    "done",
    JSON.stringify(turn.inputMessageRefs),
  );
  const saved = { text, result: turn.result, tools: turn.toolActions };
  turns.push(saved);
  const trace = (
    turn.toolActions as { tool: string; trace?: { workspace?: string } }[]
  ).find((t) => t.tool === "research")?.trace;
  if (trace?.workspace)
    for (const file of [
      "trace.json",
      "question-context.json",
      "answer-review.json",
    ]) {
      const path = join(trace.workspace, file);
      if (existsSync(path))
        copyFileSync(path, join(output, `turn-${turns.length}-${file}`));
    }
  saveJson(join(output, "result.json"), {
    at: new Date().toISOString(),
    directory,
    passed: false,
    state: "running",
    turns,
  });
  return turn;
}
async function waitFor(label: string, ready: () => boolean) {
  let previous = "";
  while (!ready()) {
    const catalog = system.work.catalog();
    const state = JSON.stringify({
      requirements: catalog.requirements.map((p) => ({
        title: p.title,
        state: p.maintenance?.state,
        error: p.maintenance?.error,
      })),
      development: catalog.development.map((t) => ({
        state: t.state,
        phase: t.phase,
        message: t.message,
      })),
    });
    if (state !== previous) {
      console.log(`${label}：${state}`);
      previous = state;
    }
    await new Promise((r) => setTimeout(r, 15000));
    // Agent/activity timeouts live in production services. This only catches a
    // terminal worker error; elapsed observation time never restarts a model.
    for (const p of system.work.catalog().requirements)
      if (p.maintenance?.state === "failed")
        throw Error(String(p.maintenance.error));
    for (const t of system.work.catalog().development)
      if (["failed", "cancelled"].includes(t.state))
        throw Error(String(t.error));
  }
}
try {
  await ask(
    "帮我持续跟进工单完成入口，结合这个项目的需求、纪要与代码。我只关注后端函数验收，暂不关注页面；有重要进展或阻塞再通知我。现在先不要编码。",
  );
  assert.equal(system.work.catalog().requirements.length, 1);
  const key = system.work.catalog().requirements[0]!.key;
  await waitFor("需求调查", () => system.work.status(key).current);
  await ask(
    "纠正一下刚才的需求负责人：完成入口现在由小林负责，不是小周。请保存这条补充并重新跟进，其他范围保持不变。",
  );
  assert.equal(system.work.status(key).feedback.length, 1);
  await waitFor("按反馈更新", () => system.work.status(key).current);
  const state = system.work.status(key);
  assert.ok(
    state.requirement?.actions.some((a) => a.owner?.includes("小林")),
    JSON.stringify(state.requirement),
  );
  await ask(
    "请用 tickets 项目开始实现这个需求，按项目已有检查完成编码和独立评审。",
  );
  assert.equal(system.work.catalog().development.length, 1);
  const taskId = system.work.catalog().development[0]!.id;
  await waitFor(
    "后台编码",
    () => system.work.development.read(taskId).job.state === "succeeded",
  );
  const task = system.work.development.read(taskId);
  assert.equal(
    task.run?.state,
    "ready",
    task.run?.error ?? task.run?.review?.summary,
  );
  assert.equal(readFileSync(join(source, "src/tickets.mjs"), "utf8"), original);
  assert.ok(task.run.checks.some((c) => c.exitCode === 0));
  assert.equal(task.run.review?.verdict, "accepted");
  const status = await system.app.inject({
    url: `/api/work/development/${taskId}`,
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().run.state, "ready");
  await ask("现在做到哪了？具体检查了什么，还有什么没有做？");
  for (const name of [
    `coding-agent-${task.run.attempt}.json`,
    `code-reviewer-${task.run.attempt}.json`,
    "run.json",
  ]) {
    const path = join(task.run.directory, name);
    if (existsSync(path)) copyFileSync(path, join(output, name));
  }
  saveJson(join(output, "result.json"), {
    at: new Date().toISOString(),
    flowChecksPassed: true,
    answerQuality: "requires_reading_final_answer",
    seconds: (Date.now() - start) / 1000,
    model: profile.model,
    turns,
    attention: state.attention,
    feedback: state.feedback.map((f) => ({
      kind: f.kind,
      text: f.text,
      active: f.active,
    })),
    requirement: state.requirement,
    development: {
      state: task.run.state,
      checks: task.run.checks,
      review: task.run.review,
    },
    sourceUnchanged: true,
  });
  passed = true;
  console.log(`FLOW CHECKS PASSED; read final answer separately: ${output}`);
} catch (error) {
  saveJson(join(output, "result.json"), {
    at: new Date().toISOString(),
    passed: false,
    seconds: (Date.now() - start) / 1000,
    directory,
    turns,
    error: String(error),
  });
  throw error;
} finally {
  await system.app.close();
  if (passed) rmSync(directory, { recursive: true, force: true });
}
