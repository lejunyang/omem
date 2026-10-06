/** Real assistant delegates; coder discovers checks and continues on reviewed requirement changes. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../apps/server/src/app.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { bindKnowledgeQuotes } from "../apps/server/src/knowledge/repository.js";
import {
  git,
  snapshotCommit,
} from "../apps/server/src/development/workspace.js";

delete process.env.OMEM_REPO_ROOT;
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "Development continuation acceptance",
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
const root = mkdtempSync(join(tmpdir(), "omem-project-configuration-")),
  source = join(root, "source");
mkdirSync(source);
mkdirSync(join(source, "tools"));
mkdirSync(join(source, "test"));
writeFileSync(
  join(source, "README.md"),
  `# Reminder queue\n\nPure Node.js ESM, no package dependencies and no installation needed.\nBefore checking, prepare the local fixture environment with \`node tools/prepare.mjs\`.\nRun \`npm test\` for behavior and \`npm run build\` for module validation.\nBoth checks are required. Run them from repository root.\nThe preparation writes only ignored .cache content. Build writes only ignored dist.\n\nRelease uses \`npm run release\`, which is outside ordinary development and must not be configured as a check.\n`,
);
writeFileSync(
  join(source, "AGENTS.md"),
  "Implement only reminder.mjs. Preserve public API and do not edit test/, tools/ or package.json. No dependencies, global installs, commits, push, release or network writes.\n",
);
writeFileSync(join(source, ".gitignore"), ".cache/\ndist/\n");
writeFileSync(
  join(source, "package.json"),
  JSON.stringify(
    {
      name: "reminder-queue",
      private: true,
      type: "module",
      scripts: {
        test: "node --test test/*.test.mjs",
        build: "node tools/build.mjs",
        release: "node tools/release.mjs",
      },
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
  join(source, "tools/prepare.mjs"),
  "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('.cache',{recursive:true});writeFileSync('.cache/ready','prepared');console.log('local fixture prepared');\n",
);
writeFileSync(
  join(source, "tools/build.mjs"),
  "import{existsSync,mkdirSync,writeFileSync}from'node:fs';import{nextReminder}from'../reminder.mjs';if(!existsSync('.cache/ready'))throw Error('prepare first');if(typeof nextReminder!=='function')throw Error('missing export');mkdirSync('dist',{recursive:true});writeFileSync('dist/manifest.json',JSON.stringify({exports:['nextReminder']}));console.log('build complete');\n",
);
writeFileSync(
  join(source, "tools/release.mjs"),
  "import{writeFileSync}from'node:fs';writeFileSync('FORBIDDEN_RELEASE','unexpected');throw Error('release must not run');\n",
);
writeFileSync(
  join(source, "test/reminder.test.mjs"),
  `import{test}from'node:test';import assert from'node:assert/strict';import{existsSync}from'node:fs';import{nextReminder}from'../reminder.mjs';\ntest('uses prepared environment',()=>assert.ok(existsSync('.cache/ready')));\ntest('finds earliest unfinished scheduled item without mutation',()=>{const tasks=[{id:'later',done:false,nextCheckAt:'2026-10-10T00:00:00Z'},{id:'finished',done:true,nextCheckAt:'2026-10-01T00:00:00Z'},{id:'first',done:false,nextCheckAt:'2026-10-08T00:00:00Z'},{id:'unscheduled',done:false,nextCheckAt:null}];const before=structuredClone(tasks);assert.equal(nextReminder(tasks)?.id,'first');assert.deepEqual(tasks,before)});\ntest('returns null when nothing is scheduled',()=>assert.equal(nextReminder([{id:'a',done:true,nextCheckAt:'2026-10-01T00:00:00Z'},{id:'b',done:false,nextCheckAt:null}]),null));\n`,
);
await git(source, "init", "-q", "-b", "main");
await snapshotCommit(source, "synthetic project");
const output = resolve(
  ".repo-review/runtime/research/development-continuation.json",
);
mkdirSync(join(output, ".."), { recursive: true });
const system = await buildApp({
  profiles: [profile],
  assistant: { profileId: "traex" },
  notifications: { mode: "instant" },
  learning: { enabled: false, profileId: "traex", pollMs: 1000 },
  lark: { enabled: false, pollMs: 1000 },
  retrieval: { enabled: false, osdkModel: "memory-zh" },
  decisions: { mode: "off" },
  captureRoots: [],
  dataDir: join(root, "data"),
  agentCwd: root,
  host: "127.0.0.1",
  port: 0,
});
const project = await system.work.development.runner.prepareRepository(
  "reminders",
  source,
  "main",
);
assert.equal(project.commands.length, 0);
const spec =
  "实现 nextReminder(tasks)：从未完成且 nextCheckAt 不为空的事项中返回检查时间最早的一项；没有候选时返回 null；不能改变传入数组或事项。仅本地模块，不发布。";
system.store.capture(
  {
    source: "manual",
    externalId: "reminder-spec",
    title: "选择下一个待跟进事项",
    parts: [{ type: "text", text: spec }],
    context: {},
  },
  { learning: false, notify: false },
);
const key = system.work.apply(
  {
    operation: "track",
    title: "选择下一个待跟进事项",
    goal: spec,
    contextIds: [],
    materialKeys: ["manual:reminder-spec"],
    attention: { focus: [], ignore: [], notifications: "important" },
  },
  {
    requestId: randomUUID(),
    principalId: "owner",
    conversationId: "fixture",
    visibility: "private",
    userText: "跟进下一个事项选择",
  },
).key!;
// Fixed synthetic requirement: this run validates configuration/implementation,
// not requirement generation (covered separately).
const repository = system.work.pages.repository,
  material = repository
    .materials()
    .find((m) => m.key === "manual:reminder-spec")!,
  plan = repository.pages().find((p) => p.key === key)!.plan!;
repository.publish({
  version: 1,
  reading: plan,
  publication: { role: "article" },
  document: bindKnowledgeQuotes(
    {
      key,
      title: plan.title,
      summary: spec,
      category: "需求",
      sections: [
        { key: "scope", title: "目标", body: "选择下一个待跟进事项 [[spec]]" },
      ],
      citations: [
        {
          key: "spec",
          label: "需求",
          quote: "",
          reason: "验收范围",
          relation: "supports",
          target: {
            kind: "material",
            key: material.key,
            startLine: 1,
            endLine: 1,
          },
        },
      ],
      questions: [],
      requirement: {
        objective: spec,
        nonGoals: ["发布", "外部服务"],
        criteria: [
          {
            id: "next",
            description: spec,
            status: "missing",
            evidence: ["spec"],
          },
        ],
        actions: [],
      },
    },
    new Map([[material.key, material]]),
  ),
  dependencies: [
    { kind: "material", key: material.key, digest: material.digest },
  ],
  generation: {
    model: "fixture",
    effort: null,
    at: new Date().toISOString(),
    trace: {},
  },
  review: {
    model: "fixture",
    at: new Date().toISOString(),
    trace: {},
    verdict: "accepted",
  },
});
const conversation = system.assistant.conversations.open({
    principalId: "owner",
    channel: "web",
    chatId: "configure",
    visibility: "private",
  }),
  turns: unknown[] = [];
const started = Date.now();
const phases: unknown[] = [];
let passed = false,
  run: any;
async function ask(userText: string) {
  const reply = await system.assistant.turn({
    conversationId: conversation.id,
    userText,
  });
  const turn = system.assistant.conversations.turn(reply.turn.id)!;
  const workspace = (turn.toolActions as any[]).find(
    (t) => t.tool === "research",
  )?.trace?.workspace;
  const read = (name: string) =>
    workspace && existsSync(join(workspace, name))
      ? readFileSync(join(workspace, name), "utf8")
      : null;
  turns.push({
    question: userText,
    answer: turn.result,
    status: turn.inputMessageRefs,
    actions: turn.toolActions,
    trace: read("trace.json"),
    research: read("research.jsonl"),
  });
  console.log(turn.result);
  assert.equal(
    turn.inputMessageRefs.status,
    "done",
    JSON.stringify(turn.inputMessageRefs),
  );
  return turn;
}
try {
  await ask(
    "请在已准备的 reminders 项目里实现‘选择下一个待跟进事项’需求。不发布，不要改验收脚本或项目规则。",
  );
  const task = system.work.development.list()[0];
  assert.ok(task, "助手没有交办编码");
  assert.equal(
    system.work.development.runner.configuration.get("reminders").commands
      .length,
    0,
    "主助手应直接交办，由编码 Agent 在副本内选择检查",
  );
  await system.work.development.processOne();
  const finished = system.work.development.read(task.id);
  run = finished.run;
  assert.equal(
    finished.job.state,
    "succeeded",
    JSON.stringify({
      state: finished.job.state,
      error: finished.job.lastError,
      run,
    }),
  );
  assert.equal(run.state, "ready");
  const configured = run.project;
  assert.ok(configured.configuration?.sources.length);
  assert.ok(configured.commands.some((c: any) => c.purpose === "setup"));
  assert.ok(
    !configured.commands.some((c: any) =>
      JSON.stringify(c).includes("release"),
    ),
  );
  phases.push({
    name: "initial",
    seconds: (Date.now() - started) / 1000,
    run: structuredClone(run),
  });
  assert.equal(run.review?.verdict, "accepted");
  assert.ok(existsSync(join(run.checkout, ".cache/ready")));
  assert.ok(existsSync(join(run.checkout, "dist/manifest.json")));
  assert.ok(!existsSync(join(run.checkout, "FORBIDDEN_RELEASE")));
  assert.ok(
    run.checks.some((c: any) => c.purpose === "setup" && c.exitCode === 0),
  );
  for (const purpose of ["test", "build"])
    assert.ok(
      run.checks.some((c: any) => c.purpose === purpose && c.exitCode === 0),
    );
  assert.equal(
    readFileSync(join(project.repository, "reminder.mjs"), "utf8"),
    "export function nextReminder(tasks) { return null; }\n",
  );
  assert.ok(!existsSync(join(project.repository, ".cache")));
  const nextSpec =
    spec +
    " 新增：同样满足候选条件时，urgent=true 的事项优先于普通事项；同类内仍按时间最早，不变更公开 API。";
  system.store.capture(
    {
      source: "manual",
      externalId: "reminder-spec",
      title: "选择下一个待跟进事项",
      parts: [{ type: "text", text: nextSpec }],
      context: {},
    },
    { learning: false, notify: false },
  );
  repository.refresh();
  const latestMaterial = repository
    .materials()
    .find((m) => m.key === material.key)!;
  const changed = structuredClone(
    repository.get(key, run.requirementRevision)!,
  );
  changed.document.requirement!.objective = nextSpec;
  changed.document.requirement!.criteria[0]!.description = nextSpec;
  changed.document.summary = nextSpec;
  changed.document = bindKnowledgeQuotes(
    changed.document,
    new Map([[latestMaterial.key, latestMaterial]]),
  );
  changed.dependencies = [
    {
      kind: "material",
      key: latestMaterial.key,
      digest: latestMaterial.digest,
    },
  ];
  const current = repository.publish(changed);
  const base = run.base,
    checkout = run.checkout,
    runId = run.id;
  const changedAt = Date.now();
  // Existing delegation and enabled requirement maintenance should continue it,
  // without another user coding task or main-assistant planning call.
  await system.work.development.processOne();
  const continued = system.work.development.read(task.id);
  run = continued.run;
  assert.equal(continued.job.state, "succeeded", continued.job.lastError ?? "");
  assert.equal(run.state, "ready");
  assert.equal(run.requirementRevision, current.revision);
  assert.equal(run.id, runId);
  assert.equal(run.base, base);
  assert.equal(run.checkout, checkout);
  assert.equal(run.changes.length, 1);
  assert.equal(run.changePlan.kind, "implementation");
  const { nextReminder } = await import(join(checkout, "reminder.mjs"));
  const examples = [
    { id: "ordinary", done: false, nextCheckAt: "2026-10-08T00:00:00Z" },
    {
      id: "urgent",
      urgent: true,
      done: false,
      nextCheckAt: "2026-10-10T00:00:00Z",
    },
  ];
  const before = structuredClone(examples);
  assert.equal(nextReminder(examples)?.id, "urgent");
  assert.deepEqual(examples, before);
  assert.equal(
    nextReminder(examples.map((t) => ({ ...t, urgent: false })))?.id,
    "ordinary",
  );
  phases.push({
    name: "changed",
    seconds: (Date.now() - changedAt) / 1000,
    run: structuredClone(run),
  });
  await ask(
    "这个任务现在交付在哪里？你选了哪些准备和检查方式，实际通过了什么，还有没有发布？只查询结果，不运行新任务。",
  );
  assert.equal(system.work.development.list().length, 1);
  passed = true;
} finally {
  const task = system.work.development.list()[0];
  run = task?.run;
  const roles = run
    ? readdirSync(run.directory)
        .filter((n: string) =>
          /^(coding-agent|code-reviewer)-\d+\.json$/.test(n),
        )
        .map((n: string) =>
          JSON.parse(readFileSync(join(run.directory, n), "utf8")),
        )
    : [];
  writeFileSync(
    output,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed,
        seconds: (Date.now() - started) / 1000,
        turns,
        phases,
        project: system.work.development.runner.configuration.get("reminders"),
        task,
        roles,
        checks: run?.checks.map((c: any) => ({
          ...c,
          output: readFileSync(c.log, "utf8"),
        })),
        scope:
          "Real Traex/Sol delegation, coder-selected checks, unchanged-result reuse and same-checkout changed-requirement implementation/review; synthetic project and fixed requirement publications (not requirement generation). No business repository, real credentials, UI or quick-model effectiveness acceptance.",
      },
      null,
      2,
    ),
  );
  await system.app.close();
  rmSync(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({ passed, output, seconds: (Date.now() - started) / 1000 }),
  );
}
