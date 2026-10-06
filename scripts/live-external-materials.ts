/** Real assistant read -> capture -> new-conversation recall with synthetic MCP input. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
delete process.env.OMEM_REPO_ROOT;
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "External material acceptance",
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
const directory = mkdtempSync(join(tmpdir(), "omem-external-live-"));
const output = resolve(".repo-review/runtime/research/external-materials.json");
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
  dataDir: join(directory, "data"),
  agentCwd: directory,
  host: "127.0.0.1",
  port: 0,
});
const capabilities = system.work.development.runner.capabilities;
capabilities.register({
  version: 1,
  id: "design",
  name: "工单设计资料",
  description:
    "读取明确指定的设计节点；结构化字段是真实验收输入，图片只是一个像素的传输样本，不作视觉验收",
  mcp: {
    transport: "stdio",
    command: process.execPath,
    args: [resolve("apps/server/tests/fixtures/capability-mcp.mjs")],
    readOnlyTools: ["read_design"],
  },
});
const repository = new KnowledgeRepository(system.store);
const turns: unknown[] = [];
const started = Date.now();
let passed = false;
async function ask(chatId: string, userText: string) {
  const conversation = system.assistant.conversations.open({
    principalId: "owner",
    channel: "web",
    chatId,
    visibility: "private",
  });
  const response = await system.assistant.turn({
    conversationId: conversation.id,
    userText,
  });
  const turn = system.assistant.conversations.turn(response.turn.id)!;
  const workspace = (turn.toolActions as any[]).find(
    (t) => t.tool === "research",
  )?.trace?.workspace;
  const read = (name: string) =>
    workspace && existsSync(join(workspace, name))
      ? readFileSync(join(workspace, name), "utf8")
      : null;
  const research =
    read("research.jsonl")
      ?.trim()
      .split("\n")
      .map((line) => JSON.parse(line)) ?? [];
  turns.push({
    userText,
    answer: turn.result,
    status: turn.inputMessageRefs,
    actions: turn.toolActions,
    evidence: turn.selectedEvidence,
    research,
    trace: read("trace.json"),
    review: read("answer-review.json"),
  });
  console.log(turn.result);
  assert.equal(
    turn.inputMessageRefs.status,
    "done",
    JSON.stringify(turn.inputMessageRefs),
  );
  return { turn, research };
}
try {
  const first = await ask(
    "read-and-save",
    "通过已登记的 design 能力读取 PANEL-7（工单完成）和 PANEL-9（工单归档），把两份具体设计资料保存到材料库，方便以后查询。简要比较布局、间距、按钮文字，引用保存的原文。图片只是传输样本，不做视觉判断；不要写代码、创建事项或发送消息。",
  );
  assert.ok(
    first.research.some(
      (e: any) => e.tool === "capture_external_input" && e.success,
    ),
  );
  const originals = repository.materials();
  assert.equal(originals.length, 2);
  assert.ok(originals.every((m) => m.images.length === 1));
  assert.match(first.turn.result ?? "", /24/);
  assert.match(first.turn.result ?? "", /12/);
  assert.ok((first.turn.selectedEvidence as unknown[]).length >= 2);
  capabilities.disable("design");
  // A different conversation has no earlier answers or receipt permissions.
  const recalled = await ask(
    "independent-recall",
    "从已经保存的材料回答：工单完成和工单归档的按钮文字、间距、排列方式分别是什么？我记不清区别了。请引用原文，不访问外部服务。",
  );
  assert.match(recalled.turn.result ?? "", /24/);
  assert.match(recalled.turn.result ?? "", /12/);
  assert.match(recalled.turn.result ?? "", /完成工单/);
  assert.match(recalled.turn.result ?? "", /确认归档/);
  assert.ok(
    recalled.research.some(
      (e: any) =>
        ["search_materials", "read_material"].includes(e.tool) && e.success,
    ),
  );
  assert.ok(
    !recalled.research.some(
      (e: any) => e.tool === "capability_call" && e.success,
    ),
  );
  assert.equal(repository.materials().length, 2);
  passed = true;
} finally {
  writeFileSync(
    output,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed,
        model: profile.model,
        seconds: (Date.now() - started) / 1000,
        turns,
        materials: repository
          .materials()
          .map((m) => ({
            key: m.key,
            title: m.title,
            revision: m.revisionId,
            images: m.images.length,
          })),
        scope:
          "真实 Traex/Sol、合成 MCP 输入、两个独立私聊。图片仅验证保留，快速决策关闭；不代表真实 Figma 或视觉理解。",
        ...(passed ? {} : { directory }),
      },
      null,
      2,
    ),
  );
  await system.app.close();
  if (passed) rmSync(directory, { recursive: true, force: true });
  console.log(
    JSON.stringify({ passed, output, seconds: (Date.now() - started) / 1000 }),
  );
}
