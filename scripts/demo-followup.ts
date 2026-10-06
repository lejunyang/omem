/** Synthetic public-safe inputs, real Traex investigation/writing/review/coding.
 * Kept in one ignored library for interactive inspection; never calls Lark. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../apps/server/src/app.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import {
  profileSchema,
  captureSchema,
} from "../packages/contracts/src/index.js";
import {
  git,
  snapshotCommit,
} from "../apps/server/src/development/workspace.js";
import { LearningPipeline } from "../apps/server/src/learning/pipeline.js";
import { MessageUnderstanding } from "../apps/server/src/messages/understanding.js";
import type { LarkMessage } from "../apps/server/src/integrations/lark-personal/client.js";
import { stableDigest } from "../apps/server/src/storage/digest.js";
delete process.env.OMEM_REPO_ROOT;
const dataIndex = process.argv.indexOf("--data");
const root = resolve(
  dataIndex >= 0
    ? process.argv[dataIndex + 1]!
    : ".repo-review/runtime/followup-demo",
);
const dataDir = join(root, "data"),
  source = join(root, "source");
mkdirSync(root, { recursive: true });
if (existsSync(join(dataDir, "omem.sqlite")))
  throw Error(
    "演示库已经存在；直接启动查看，避免重复生成。需要重建时选择新的 --data 路径。",
  );
mkdirSync(source, { recursive: true });
writeFileSync(
  join(source, "README.md"),
  "# 演示：提醒选择器\n\nNode ESM，无依赖。公开函数 nextReminder(tasks) 返回下一个提醒。npm test 检查行为。不发布。\n",
);
writeFileSync(
  join(source, "AGENTS.md"),
  "只改 reminder.mjs。不要修改测试或 package.json，不安装依赖，不提交、推送或发布。\n",
);
writeFileSync(
  join(source, "package.json"),
  JSON.stringify(
    {
      name: "omem-followup-demo",
      private: true,
      type: "module",
      scripts: { test: "node --test reminder.test.mjs" },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(source, "reminder.mjs"),
  "export function nextReminder(tasks) { return null; }\n",
);
writeFileSync(
  join(source, "reminder.test.mjs"),
  `import{test}from'node:test';import assert from'node:assert/strict';import{nextReminder}from'./reminder.mjs';
test('按检查时间选择未完成事项，不修改输入',()=>{const a=[{id:'b',nextCheckAt:'2026-10-09T00:00:00Z',done:false},{id:'a',nextCheckAt:'2026-10-08T00:00:00Z',done:false},{id:'c',nextCheckAt:'2026-10-01T00:00:00Z',done:true}];const copy=structuredClone(a);assert.equal(nextReminder(a).id,'a');assert.deepEqual(a,copy)});
test('没有候选时返回null',()=>assert.equal(nextReminder([]),null));
`,
);
await git(source, "init", "-q", "-b", "main");
await snapshotCommit(source, "synthetic demo input");
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "Traex / Sol（演示）",
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
const config = {
  profiles: [profile],
  assistant: { profileId: "traex" },
  notifications: { mode: "digest" as const },
  learning: { enabled: false, profileId: "traex", pollMs: 1000 },
  lark: { enabled: false, pollMs: 1000 },
  decisions: { mode: "off" as const },
  retrieval: { enabled: false, osdkModel: "memory-zh" },
  captureRoots: [],
  dataDir,
  agentCwd: join(root, "agents"),
  host: "127.0.0.1",
  port: 0,
};
writeFileSync(
  join(root, "config.json"),
  JSON.stringify(
    {
      profiles: config.profiles,
      assistant: config.assistant,
      notifications: config.notifications,
      learning: { ...config.learning, enabled: true },
      lark: config.lark,
      decisions: config.decisions,
      retrieval: config.retrieval,
      captureRoots: [],
    },
    null,
    2,
  ),
);
const system = await buildApp(config);
const { store, work } = system;
const pipe = new LearningPipeline({
  store,
  memory: system.memory,
  feedback: system.feedback,
  profile,
  workspaceRoot: config.agentCwd,
});
const started = Date.now();
const context = store.contexts.create({
  name: "[演示] 提醒选择器",
  kind: "project",
  description:
    "合成需求、讨论与本地小仓库，用于查看消息理解、纠正和编码调整；不是个人飞书数据。",
});
const actor = (text: string) => ({
  requestId: randomUUID(),
  conversationId: "demo-owner",
  principalId: "owner",
  visibility: "private" as const,
  userText: text,
});
function message(id: string, text: string, who: string, learn = false) {
  const at = new Date().toISOString();
  const raw: LarkMessage & { demonstration: boolean } = {
    message_id: id,
    chat_id: "oc_demo",
    chat_name: "[演示] 产品与研发讨论",
    msg_type: "text",
    content: text,
    create_time: at,
    sender: { id: who === "我" ? "owner" : "demo-colleague", name: who },
    demonstration: true,
  };
  const r = store.capture(
    captureSchema.parse({
      source: "chat",
      externalId: `lark-personal:${id}`,
      title: `[演示] 产品与研发讨论 · ${who}`,
      parts: [{ type: "text", text }],
      context: { conversationId: raw.chat_id },
      provenance: {
        collectorId: "synthetic-demo",
        actorId: raw.sender!.id,
        actorType: who === "我" ? "owner" : "user",
        actorVerifiedBy: "synthetic-demo",
        actorPrincipalId: who === "我" ? "owner" : null,
        sourceUri: null,
        eventId: id,
        eventAt: at,
        timezone: "Asia/Shanghai",
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    }),
    { contextIds: [context.id], learning: learn, notify: false },
  );
  store.db
    .prepare(
      "INSERT INTO personal_lark_messages(id,chat_id,chat_name,digest,raw,revision_id,resources,state,observed_at,updated_at) VALUES(?,?,?,?,?,?,'[]','ready',?,?)",
    )
    .run(
      id,
      raw.chat_id,
      raw.chat_name!,
      stableDigest(raw),
      JSON.stringify(raw),
      r.revision.id,
      at,
      at,
    );
  return r;
}
async function waitFor(label: string, predicate: () => boolean) {
  console.log(label);
  const deadline = Date.now() + 15 * 60_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw Error(`${label}未完成，数据与实际状态已保留`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
try {
  await work.development.runner.prepareRepository(
    "demo-reminders",
    source,
    "main",
  );
  const spec =
    "[演示需求] 实现 nextReminder(tasks)：从未完成且 nextCheckAt 非空的事项中返回时间最早的一项，没有候选时返回 null，不修改输入。仅本地 Node ESM 模块，不发布。";
  store.capture(
    {
      source: "manual",
      externalId: "demo-spec",
      title: "[演示] 提醒选择器需求",
      parts: [{ type: "text", text: spec }],
      context: { demonstration: true },
    },
    { contextIds: [context.id], learning: false, notify: false },
  );
  message(
    "demo-confirm",
    "演示项目的基础规则已确认：先按检查时间选下一个未完成提醒。小林提供接口说明。我明天上午9点检查小林的回复，请帮我记下这个跟进。",
    "我",
    true,
  );
  message(
    "demo-waiting",
    "接口说明还差紧急提醒的定义，我明天上午把说明补齐。",
    "小林",
  );
  const key = work.apply(
    {
      operation: "track",
      title: "[演示] 提醒选择器",
      goal: "跟进提醒选择器的确定范围、未确认建议、接口说明和个人跟进，区分代码完成与发布状态。",
      contextIds: [context.id],
      materialKeys: [],
      attention: {
        focus: ["规则变化", "接口说明", "等待回复"],
        ignore: ["重复报警"],
        notifications: "important",
      },
    },
    actor("跟进演示提醒选择器的需求与等待回复"),
  ).key!;
  await system.app.ready();
  const generation = async () => {
    await waitFor("Traex 正在调查、写作并独立补查…", () => {
      const status = work.pages.maintenance.status(key);
      if (status?.state === "failed")
        throw Error(status.error ?? "需求生成失败");
      return (
        status?.state === "published" &&
        !!work.pages.repository.get(key)?.current
      );
    });
  };
  await generation();
  console.log("需求首稿已生成，正在理解原消息…");
  await pipe.drain(12);
  const first = work.status(key);
  const follow = first.actions.find(
    (a) => a.certainty === "confirmed" && /检查|回复|跟进/.test(a.title),
  );
  if (follow) {
    const existing = store.tasks().find(t => String(t.title).includes("检查小林"));
    work.actions.follow(key, follow.id, first.revision!, existing ? String(existing.id) : undefined);
  }
  const task = work.apply(
    {
      operation: "start_development",
      key,
      project: "demo-reminders",
      delegation: "请实现演示提醒选择器，不发布。",
    },
    actor("请实现演示提醒选择器，不发布。"),
  );
  await waitFor("编码 Agent 正在实现并独立评审首版…", () => {
    const t = work.development.read(task.taskId!);
    if (["failed", "blocked"].includes(t.run?.state ?? ""))
      throw Error(t.message);
    return t.run?.state === "ready";
  });
  const previous = work.development.read(task.taskId!).run!;
  message(
    "demo-priority",
    "建议下一步加紧急优先：urgent=true 先于普通事项，同一优先级仍按 nextCheckAt 排序。这个提议等你确认。代码仍由助手实现，小林只负责提供接口说明。",
    "小林",
  );
  store.messageFeedback.save("demo-priority", {
    requestId: randomUUID(),
    scope: "message",
    text: "纠正：紧急优先已经由我确认纳入本期，现在要实现；小林只提供接口说明，代码仍交给助手在现有任务里完成。不发布。",
  });
  work.pages.refresh(key);
  await generation();
  console.log("正在按本人纠正重新理解消息…");
  await pipe.drain(16);
  await waitFor("现有任务正在保留首版代码、调整紧急优先并重新评审…", () => {
    const t = work.development.read(task.taskId!);
    if (["failed", "blocked"].includes(t.run?.state ?? ""))
      throw Error(t.message);
    return (
      t.run?.state === "ready" &&
      t.run.requirementRevision !== previous.requirementRevision &&
      !!t.run.changePlan
    );
  });
  const after = work.development.read(task.taskId!).run!;
  assert.equal(after.id, previous.id);
  assert.equal(after.checkout, previous.checkout);
  const items = store.db
    .prepare("SELECT id,revision_id,state FROM personal_lark_messages")
    .all()
    .map((r) => ({
      id: r.id,
      revision_id: r.revision_id,
      state: r.state,
      resources: [],
    }));
  const report = {
    at: new Date().toISOString(),
    model: profile.model,
    durationMs: Date.now() - started,
    key,
    taskId: task.taskId,
    catalog: work.catalog(),
    messages: new MessageUnderstanding(store, work).read(items),
  };
  writeFileSync(join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log(
    `演示可查看。数据：${dataDir}\n配置：${join(root, "config.json")}\n真实编码与评审：${after.state}`,
  );
} finally {
  await pipe.stop();
  await system.app.close();
}
