/** Real Traex assembly check with synthetic external inputs; no private systems. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { randomUUID } from "node:crypto";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
} from "../apps/server/src/knowledge/repository.js";
import { git, saveJson } from "../apps/server/src/development/workspace.js";
delete process.env.OMEM_REPO_ROOT;
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "External context acceptance",
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
const directory = mkdtempSync(join(tmpdir(), "omem-capabilities-live-"));
const output = resolve(".repo-review/runtime/research/capabilities");
mkdirSync(output, { recursive: true });
const skill = join(directory, "design-reading");
mkdirSync(join(skill, "references"), { recursive: true });
writeFileSync(
  join(skill, "SKILL.md"),
  "---\nname: design-reading\ndescription: Read synthetic design requirements.\n---\nRead references/workflow.md before querying design details.",
);
writeFileSync(
  join(skill, "references/workflow.md"),
  "Use lookup-node with screen=工单完成 or 工单归档 to get each node ID. Then call read_design with that node to read layout, spacing and button label. The coding requirement is a plain configuration module, no UI; use the structured fields, not the synthetic image. Image is a synthetic one-pixel transport fixture, not a real visual design; do not claim a visual acceptance.",
);
const system = await buildApp({
  profiles: [profile],
  assistant: { profileId: "traex" },
  notifications: { mode: "instant" },
  learning: { enabled: false, profileId: "traex", pollMs: 1000 },
  lark: { enabled: false, pollMs: 1000 },
  retrieval: { enabled: false, osdkModel: "memory-zh" },
  decisions: { mode: "off" },
  captureRoots: [],
  dataDir: join(directory, "data"),
  agentCwd: directory,
  host: "127.0.0.1",
  port: 0,
});
system.work.development.runner.capabilities.register({
  version: 1,
  id: "design",
  name: "工单设计资料",
  description: "读取工单页面节点及布局要求",
  skills: [{ name: "design-reading", directory: skill }],
  cli: [
    {
      name: "lookup-node",
      description: "按页面名读取设计节点 ID",
      readOnly: true,
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({screen:process.argv[1],node:process.argv[1]==='工单归档'?'PANEL-9':'PANEL-7',version:'design-r3'}))",
        { input: "screen", description: "页面中文名称" },
      ],
    },
  ],
  mcp: {
    transport: "stdio",
    command: process.execPath,
    args: [resolve("apps/server/tests/fixtures/capability-mcp.mjs")],
    readOnlyTools: ["read_design"],
  },
});
// A fixed synthetic requirement bypasses generation here; this acceptance is
// specifically about real assistant -> coding -> review context transfer.
const source = join(directory, "project");
mkdirSync(source);
writeFileSync(
  join(source, "preset.mjs"),
  "export function completionPreset() { return null; }\n",
);
writeFileSync(
  join(source, "AGENTS.md"),
  "Implement a headless ESM configuration module only. No UI, dependencies, network writes or deployment. Do not alter acceptance.mjs. Return a fresh plain object each call.\n",
);
writeFileSync(
  join(source, "acceptance.mjs"),
  `import assert from 'node:assert/strict';
import {completionPreset} from './preset.mjs';
const first=completionPreset(),second=completionPreset();
assert.ok(first && typeof first==='object');
assert.ok(['vertical','horizontal'].includes(first.layout));
assert.ok(Number.isInteger(first.gap)&&first.gap>0);
assert.equal(typeof first.label,'string');
assert.notEqual(first,second); assert.deepEqual(first,second);
first.gap=999; assert.notEqual(completionPreset().gap,999);
console.log('configuration checks passed');
`,
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
  "synthetic base",
);
await system.work.development.runner.register("preset", {
  name: "工单展示配置",
  repository: source,
  commands: [
    {
      name: "acceptance",
      command: process.execPath,
      args: ["acceptance.mjs"],
      purpose: "test",
    },
  ],
});
system.store.capture(
  {
    source: "manual",
    externalId: "preset-spec",
    title: "工单展示配置需求",
    parts: [
      {
        type: "text",
        text: "实现 completionPreset()：返回用户在交办时选定的设计节点的 layout、gap、label 三个结构化字段。每次返回新对象，修改结果不能影响后续调用。只交付配置模块，不开发页面、不发布；所选节点从已登记设计能力读取。",
      },
    ],
    context: {},
  },
  { learning: false, notify: false },
);
const key = system.work.apply(
  {
    operation: "track",
    title: "工单展示配置",
    goal: "实现用户选择的配置方案",
    materialKeys: ["manual:preset-spec"],
    contextIds: [],
    attention: { focus: [], ignore: [], notifications: "important" },
  },
  {
    requestId: randomUUID(),
    conversationId: "fixture-setup",
    principalId: "owner",
    visibility: "private",
    userText: "跟进工单展示配置",
  },
).key!;
const repository = new KnowledgeRepository(system.store),
  material = repository
    .materials()
    .find((m) => m.key === "manual:preset-spec")!,
  plan = repository.pages().find((p) => p.key === key)!.plan!;
repository.publish({
  version: 1,
  reading: plan,
  publication: { role: "article" },
  document: bindKnowledgeQuotes(
    {
      key,
      title: plan.title,
      summary: "实现选定配置",
      category: "需求",
      sections: [
        {
          key: "scope",
          title: "范围",
          body: "只实现选定节点的配置模块 [[spec]]",
        },
      ],
      citations: [
        {
          key: "spec",
          label: "配置需求",
          quote: "",
          reason: "范围与验收",
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
        objective: "实现交办时选定的配置",
        nonGoals: ["页面", "发布"],
        criteria: [
          {
            id: "selected-preset",
            description:
              "completionPreset() 返回用户本次选定节点的 layout、gap、label；每次返回新对象，不共享可变结果。",
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
await system.work.pages.maintenance.stop();
await system.app.ready();
let passed = false;
let workspace: string | undefined;
const start = Date.now();
try {
  const conversation = system.assistant.conversations.open({
    principalId: "owner",
    channel: "web",
    chatId: "live-capabilities",
    visibility: "private",
  });
  const response = await system.assistant.turn({
    conversationId: conversation.id,
    userText:
      "请通过已登记的工单设计资料分别查一下工单完成和工单归档两个方案的布局、间距、按钮文字。按技能说明读取实际资料，简要列出两者。只读取，不启动编码。",
  });
  const turn = system.assistant.conversations.turn(response.turn.id)!;
  console.log(turn.result);
  assert.equal(
    turn.inputMessageRefs.status,
    "done",
    JSON.stringify(turn.inputMessageRefs),
  );
  const trace = (
    turn.toolActions as { tool: string; trace?: { workspace?: string } }[]
  ).find((t) => t.tool === "research")?.trace;
  workspace = trace?.workspace;
  assert.ok(workspace);
  const receipts = readdirSync(join(workspace, "external-inputs"))
    .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))
    .map((n) =>
      JSON.parse(readFileSync(join(workspace!, "external-inputs", n), "utf8")),
    );
  assert.ok(
    receipts.some(
      (r) =>
        r.tool === "lookup-node" &&
        r.args.screen === "工单完成" &&
        r.result.exitCode === 0,
    ),
  );
  assert.ok(
    receipts.some(
      (r) =>
        r.tool === "read_design" &&
        r.args.node === "PANEL-7" &&
        !r.result.isError,
    ),
  );
  assert.match(turn.result ?? "", /24/);
  assert.match(turn.result ?? "", /完成工单/);
  assert.match(turn.result ?? "", /纵|垂直/);
  assert.ok(
    receipts.some(
      (r) =>
        r.tool === "read_design" &&
        r.args.node === "PANEL-9" &&
        !r.result.isError,
    ),
  );
  // A subsequent production turn must find the saved prior receipts itself.
  rmSync(join(workspace, "external-inputs"), { recursive: true });
  const delegation =
    "请帮我实现工单展示配置，交给已登记的 preset 项目。只采用刚才的工单归档方案，不采用完成方案；把刚才实际读到的归档资料带给编码和评审，完成本地检查即可，不用开发页面或发布。";
  const delegated = await system.assistant.turn({
    conversationId: conversation.id,
    userText: delegation,
  });
  console.log(delegated.turn.result);
  const task = system.work.development
    .list()
    .find((t) => t.requestId === delegated.turn.id);
  assert.ok(task, JSON.stringify(delegated.turn));
  const saved = (task.job.inputRefs[0] as any).handoff;
  assert.equal(saved.assignment.text, delegation);
  assert.equal(saved.selection, "explicit");
  assert.ok(saved.inputs.length > 0);
  const handed = saved.inputs.map((r: any) =>
    JSON.parse(
      readFileSync(
        join(
          system.work.development.runner.root,
          "runs",
          task.id,
          "external-inputs",
          r.recordId + ".json",
        ),
        "utf8",
      ),
    ),
  );
  assert.ok(
    handed.some(
      (r: any) => r.tool === "read_design" && r.args.node === "PANEL-9",
    ),
  );
  assert.ok(
    !handed.some(
      (r: any) => r.args.node === "PANEL-7" || r.args.screen === "工单完成",
    ),
  );
  let current = system.work.development.read(task.id),
    previous = "";
  const deadline = Date.now() + 20 * 60 * 1000;
  while (
    ["queued", "leased", "running", "retry_wait"].includes(current.job.state) &&
    Date.now() < deadline
  ) {
    if (current.message !== previous) {
      console.log(current.message);
      previous = current.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
    current = system.work.development.read(task.id);
  }
  assert.equal(current.run?.state, "ready", JSON.stringify(current));
  const run = current.run!;
  const { completionPreset } = await import(join(run.checkout, "preset.mjs"));
  assert.deepEqual(completionPreset(), {
    layout: "horizontal",
    gap: 12,
    label: "确认归档",
  });
  assert.equal(await git(source, "status", "--porcelain"), "");
  assert.equal(run.review?.verdict, "accepted");
  saveJson(join(output, "handoff.json"), {
    at: new Date().toISOString(),
    passed: true,
    model: profile.model,
    elapsedSeconds: (Date.now() - start) / 1000,
    assignment: saved.assignment.text,
    selected: handed,
    discussion: saved.discussion,
    implementation: readFileSync(join(run.checkout, "preset.mjs"), "utf8"),
    checks: run.checks,
    review: run.review,
    scope:
      "Seeded synthetic requirement; actual assistant, coding and independent review via Traex. No real Figma/private repository/visual acceptance.",
  });
  for (const file of ["trace.json", "question-context.json"])
    if (existsSync(join(workspace, file)))
      copyFileSync(join(workspace, file), join(output, file));
  saveJson(join(output, "result.json"), {
    at: new Date().toISOString(),
    passed: true,
    elapsedSeconds: (Date.now() - start) / 1000,
    model: profile.model,
    answer: turn.result,
    tools: turn.toolActions,
    receipts,
    scope:
      "Synthetic inputs through actual production assistant and real Traex ACP; no private Figma or Git validated.",
  });
  passed = true;
  console.log(
    JSON.stringify({
      passed,
      elapsedSeconds: (Date.now() - start) / 1000,
      output,
    }),
  );
} catch (error) {
  saveJson(join(output, "result.json"), {
    at: new Date().toISOString(),
    passed: false,
    directory,
    workspace,
    error: String(error),
    elapsedSeconds: (Date.now() - start) / 1000,
  });
  throw error;
} finally {
  await system.app.close();
  if (passed) rmSync(directory, { recursive: true, force: true });
}
