import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "../apps/server/src/config.js";
import { Store } from "../apps/server/src/store.js";
import { MemoryService } from "../apps/server/src/memory/service.js";
import { KeywordRetrieval } from "../apps/server/src/retrieval/keyword.js";
import { AcpAssistantModel } from "../apps/server/src/assistant/acp-model.js";
import { AssistantRuntime } from "../apps/server/src/assistant/runtime.js";
import { selectLiveProfile } from "./live-model.js";

// Synthetic materials only. Real ACP calls, no external messages or user DB writes.
const config = loadConfig();
const dir = mkdtempSync(join(tmpdir(), "omem-live-assistant-"));
const store = new Store(dir);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: [] };
try {
  const base = config.profiles.find(p => p.id === "traex")!;
  const { profile } = await selectLiveProfile(base, join(dir, "agent"));
  assert.equal(profile.model, "gpt-5.6-sol", "Run with OMEM_LIVE_MODEL=gpt-5.6-sol");
  report.model = profile.model; report.effort = profile.effort;
  const revision = store.capture({ source: "manual", externalId: "synthetic:breaker", title: "CircuitBreaker design",
    parts: [{ type: "text", text: "The CircuitBreaker opens after exactly seven consecutive failures. Its cooldown is 41 seconds." }] }).revision;
  const runtime = new AssistantRuntime(store, new AcpAssistantModel({ profile, workspaceRoot: join(dir, "agent") }), {
    memory: new MemoryService(store), retrieval: new KeywordRetrieval(store.db), timezone: "Asia/Shanghai", turnTimeoutMs: 180_000,
  });
  const conversation = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "synthetic", visibility: "private" });
  const turn = async (text: string) => {
    console.log(`Live: ${text}`);
    const result = await runtime.turn({ conversationId: conversation.id, userText: text });
    assert.equal(result.turn.inputMessageRefs.status, "done", JSON.stringify(result.turn.inputMessageRefs));
    (report.steps as unknown[]).push({ input: text, answer: result.turn.result, actions: result.turn.toolActions, evidence: result.turn.selectedEvidence });
    return result;
  };
  const recalled = await turn("之前记录的熔断器连续失败几次会打开，冷却多久？");
  assert.ok(JSON.stringify(recalled.turn.selectedEvidence).includes(revision.fragments[0]!.id), "Must cite original English source");
  assert.match(recalled.turn.result, /7|七|seven/i); assert.match(recalled.turn.result, /41|四十一/);
  await turn("帮我记一下：2030年10月2日上午9点提醒我复习英语面试词汇。");
  assert.equal(store.tasks().length, 1);
  assert.equal(store.tasks()[0]!.dueAt, "2030-10-02T01:00:00.000Z");
  await turn("把刚才的英语复习任务改到2030年10月3日上午10点。");
  assert.equal(store.tasks()[0]!.dueAt, "2030-10-03T02:00:00.000Z");
  await turn("刚才的英语复习任务已经做完了，标记完成。");
  assert.equal(store.tasks()[0]!.status, "done");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const output = join(config.dataDir, "verification"); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "live-assistant.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, report: join(output, "live-assistant.json") }));
  store.close(); rmSync(dir, { recursive: true, force: true });
}
