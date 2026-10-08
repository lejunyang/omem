/** Real model interpretation of synthetic owner requests; no mutations. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { configuredRequestInterpreter } from "../apps/server/src/assistant/request-interpretation.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "交办语义验收",
  transport: model.transport,
  command: model.command,
  args: model.args,
  model: model.model,
  effort: model.effort,
  idleTimeoutMs: model.idleTimeoutMs,
  timeoutMs: model.timeoutMs,
  maxDurationMs: model.maxDurationMs,
});
const directory = resolve(".repo-review/runtime/request-interpretation");
mkdirSync(directory, { recursive: true });
if (existsSync(join(directory,"report.json")) && !existsSync(join(directory,"baseline.json"))) copyFileSync(join(directory,"report.json"),join(directory,"baseline.json"));
const judge = configuredRequestInterpreter({
  profile: () => profile,
  directory,
});
const context = {
  id: "synthetic-release-project",
  name: "发布协调",
  kind: "project",
  description: "合成上线安排",
};
const report: {
  at: string;
  commit: string;
  model: string | null | undefined;
  cases: unknown[];
  passed: boolean;
} = {
  at: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  model: profile.model,
  cases: [],
  passed: false,
};
const persist = () =>
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const cases: {text:string;expected:"execute"|"decline"|"uncertain";activeProjectId?:string;priorTurns?:{userText:string;result:string}[]}[] = [
  { text: "能帮我持续整理发布协调的当前安排吗？", expected: "execute" },
  {
    text: "不要创建待办，只帮我把发布协调的当前安排持续整理起来。",
    expected: "execute",
  },
  { text: "先别持续整理发布协调，告诉我怎么做就好。", expected: "decline" },
  { text: "持续整理发布协调会不会新建待办？", expected: "decline" },
  { text: "请持续整理报销安排，不要整理发布协调。", expected: "decline" },
  {
    text: "Please keep the 发布协调 project's current arrangements up to date.",
    expected: "execute",
  },
  { text: "帮我持续整理这个项目。", expected: "uncertain" },
  { text: "帮我持续整理这个项目。", expected: "execute", activeProjectId:context.id },
  { text: "帮我持续整理刚才说的项目。", expected: "execute", priorTurns:[{userText:"这里说的项目是发布协调。",result:"我们继续讨论发布协调。"}] },
];
try {
  for (const item of cases) {
    const started = performance.now();
    const result = await judge({
      actor: {
        requestId: randomUUID(),
        conversationId: "synthetic-intent",
        principalId: "owner",
        visibility: "private",
        userText: item.text,
      },
      candidate: {
        operation: "maintain_context",
        contextId: context.id,
        mode: "start",
        delegation: item.text,
      },
      target: { context, maintenance: null },
      activeProjectId:item.activeProjectId,
      priorTurns:item.priorTurns,
    });
    report.cases.push({
      ...item,
      result,
      elapsedMs: Math.round(performance.now() - started),
    });
    persist();
    assert.equal(result.verdict, item.expected, item.text);
    console.log("PASS", item.expected, item.text);
  }
  report.passed = true;
} finally {
  persist();
}
