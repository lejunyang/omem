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
import { saveJson } from "../apps/server/src/development/workspace.js";
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
  "First use the lookup-node CLI with screen=工单完成; its output gives the node ID. Then call read_design with that node to read layout, spacing and button label. Image is a synthetic one-pixel transport fixture, not a real visual design; do not claim a visual acceptance.",
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
        "console.log(JSON.stringify({screen:process.argv[1],node:'PANEL-7',version:'design-r3'}))",
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
      "请通过已登记的工单设计资料查一下：工单完成页面要什么布局、间距、按钮文字？按这个能力的技能说明读取实际资料，简要给结论。只读取，不启动编码。",
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
