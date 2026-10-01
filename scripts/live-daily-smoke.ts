/** Real ACP, synthetic personal messages, isolated DB; never sends externally. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema } from "../packages/contracts/src/index.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { Store } from "../apps/server/src/store.js";
import { MemoryService } from "../apps/server/src/memory/service.js";
import { AssistantRuntime } from "../apps/server/src/assistant/runtime.js";
import { AcpAssistantModel } from "../apps/server/src/assistant/acp-model.js";
import { selectLiveProfile } from "./live-model.js";
const dir = mkdtempSync(join(tmpdir(), "omem-live-daily-"));
let store = new Store(dir), runtime: AssistantRuntime | undefined;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: [] };
try {
  const config = loadReviewCodeModelConfig();
  const base = profileSchema.parse({ id: "traex", name: "Daily workflow acceptance", transport: config.transport, command: config.command, args: config.args, model: config.model, effort: config.effort, timeoutMs: config.timeoutMs });
  const selected = await selectLiveProfile(base, join(dir, "agent"));
  const profile = { ...selected.profile, effort: selected.profile.effort ?? config.effort };
  assert.equal(profile.model, "gpt-5.6-sol"); report.model = profile.model; report.effort = profile.effort;
  const start = () => new AssistantRuntime(store, new AcpAssistantModel({ profile, workspaceRoot: join(dir, "agent") }), {
    memory: new MemoryService(store), timezone: "Asia/Shanghai", turnTimeoutMs: 180000 });
  runtime = start();
  const conversation = runtime.conversations.open({ principalId: "owner", channel: "web", visibility: "private", chatId: "live-daily" });
  const turn = async (text: string) => {
    console.log("LIVE", text);
    const result = await runtime!.turn({ conversationId: conversation.id, userText: text });
    (report.steps as unknown[]).push({ input: text, status: result.turn.inputMessageRefs, answer: result.turn.result, actions: result.turn.toolActions });
    assert.equal(result.turn.inputMessageRefs.status, "done"); return result;
  };
  await turn("帮我跟进张三的评审回复，2030年10月2日上午9点提醒我检查；这是跟进时间，不是截止时间。");
  assert.equal(store.tasks().length, 1);
  assert.equal(store.tasks()[0]!.status, "waiting");
  assert.equal(store.tasks()[0]!.dueAt, null);
  assert.equal(store.tasks()[0]!.followUp?.next_check_at, "2030-10-02T01:00:00.000Z");
  await turn("稍后，2030年10月3日上午10点再提醒我检查这件事。");
  assert.equal(store.tasks()[0]!.followUp?.snoozed_until, "2030-10-03T02:00:00.000Z");
  assert.equal(store.tasks()[0]!.dueAt, null);
  assert.equal(store.remind("2030-10-02T02:00:00.000Z"), 0);
  runtime.shutdown(); store.close(); store = new Store(dir); runtime = start();
  assert.equal(store.remind("2030-10-03T03:00:00.000Z"), 1);
  assert.equal(store.remind("2030-10-03T04:00:00.000Z"), 0);
  report.restartCatchup = { first: 1, repeat: 0 };
  const before = store.tasks()[0]!.version;
  await turn("回顾刚才的评审回复事项，告诉我状态，不修改。");
  assert.equal(store.tasks()[0]!.version, before);
  await turn("取消刚才的评审回复事项，不用继续跟进了。");
  assert.equal(store.tasks()[0]!.status, "cancelled");
  assert.equal(store.remind("2040-01-01T00:00:00.000Z"), 0);
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error); process.exitCode = 1; }
finally {
  runtime?.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  const out = ".omem/verification"; mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "live-daily.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
