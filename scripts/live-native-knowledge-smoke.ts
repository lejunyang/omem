/** Real traex ACP acceptance, including native tool use and independent reading. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../apps/server/src/store.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
import { KnowledgePipeline } from "../apps/server/src/knowledge/pipeline.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import {
  profileSchema,
  type CaptureInput,
} from "../packages/contracts/src/index.js";
import { wikiPageBriefSchema } from "../packages/contracts/src/knowledge.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
const dir = mkdtempSync(join(tmpdir(), "omem-native-research-")),
  store = new Store(join(dir, "data"));
const config = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "Native research acceptance",
  transport: "acp",
  command: config.command,
  args: config.args,
  model: config.model,
  effort: config.effort,
  timeoutMs: config.timeoutMs,
});
const repository = new KnowledgeRepository(store);
for (const [path, text] of [
  [
    "src/route.ts",
    `import { regions } from './regions';\nexport function routeTicket(topic: string) {\n  const region = regions[topic] ?? 'general';\n  return { queue: region, state: 'waiting' };\n}\n`,
  ],
  [
    "src/regions.ts",
    `export const regions: Record<string, string> = { billing: 'finance', outage: 'operations' };\n`,
  ],
  [
    "docs/routing.md",
    `# 工单分派\n\n收到主题后分派到负责队列，暂不把分派当已处理。\n\n## 为什么保留通用队列\n\n未知主题进入 general 队列，由值班人员重新分类，避免丢单。财务类主题 billing 交 finance，服务中断 outage 交 operations。\n\n## 当前限制\n\n只按主题查表，不识别自由文字，也没有自动提醒和去重。\n`,
  ],
] as const)
  store.capture({
    source: "file",
    externalId: path,
    title: path,
    parts: [{ type: "text", text }],
    context: {
      filePath: path,
      captureFormat: "verbatim-v1",
    } as CaptureInput["context"],
  });
const pipeline = new KnowledgePipeline(
  repository,
  new RoleRuntimeGateway(new RoleBundleRegistry(), join(dir, "agents")),
  profile,
  { log: console.log },
);
try {
  const brief = wikiPageBriefSchema.parse({
    key: "guide:routing",
    order: 1,
    title: "一张工单如何找到负责队列",
    kind: "explanation",
    reader: "首次维护系统的开发者",
    goal: "理解输入、查表、未知主题和处理状态，能找到修改分派的位置。",
    scenario: "提交 billing 和未知主题的工单，解释各自得到什么结果。",
    questions: [
      "分派与处理完有什么区别？",
      "未知主题会怎样？",
      "要新增主题去哪里修改？",
    ],
    entryPaths: ["src/route.ts"],
    topicPath: ["支持工具", "工单分派"],
  });
  const [article] = await pipeline.writePage(brief);
  assert.ok(article?.current);
  const activity = (trace: Record<string, unknown>) =>
    (
      trace.usage as {
        activity?: {
          kind: string;
          tool?: string;
          type?: string;
          reads?: string[];
        }[];
      }
    ).activity ?? [];
  const writer = activity(article.generation.trace),
    reviewer = activity(article.review.trace);
  assert.ok(
    writer.some((e) => e.kind === "native" || e.kind === "mcp"),
    "writer must use actual tools",
  );
  assert.ok(
    reviewer.some(
      (e) =>
        (e.kind === "mcp" && e.tool === "read_material") ||
        (e.kind === "native" && e.type === "tool_call"),
    ),
    "reviewer must independently investigate",
  );
  assert.equal(
    (article.generation.trace.usage as Record<string, unknown>).hostTokenBudget,
    null,
  );
  const report = {
    passed: true,
    model: profile.model,
    document: article.document,
    research: article.generation.trace.research,
    writer: article.generation.trace,
    reviewer: article.review.trace,
  };
  mkdirSync(".repo-review/runtime/research", { recursive: true });
  writeFileSync(
    ".repo-review/runtime/research/live-native-knowledge.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: true,
      title: article.document.title,
      sections: article.document.sections.map((s) => s.title),
      writerTools: writer.filter((e) => e.kind === "mcp").map((e) => e.tool),
      reviewerTools: reviewer
        .filter((e) => e.kind === "mcp")
        .map((e) => e.tool),
    }),
  );
} finally {
  await pipeline.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
