/** Real personal workflow through HTTP and Traex ACP. Keeps originals, failures,
 * role outputs, application receipts and conversation answers in an isolated run. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildApp } from "../apps/server/src/app.js";
import type { Config } from "../apps/server/src/config.js";
import type { AssistantTurnResult } from "../apps/server/src/assistant/runtime.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { materialFromRevision } from "../apps/server/src/knowledge/repository.js";
import { selectLiveProfile } from "./live-model.js";

type Built = Awaited<ReturnType<typeof buildApp>>;
type Memory = { id: string; version: number; status: string; body: string };
const runId =
  new Date().toISOString().replace(/[:.]/g, "-") +
  "-" +
  randomUUID().slice(0, 8);
const directory = resolve(
  process.env.OMEM_MEMORY_FLOW_DIR ??
    join(".repo-review/runtime/assistant-memory-flow", runId),
);
const reportPath = join(directory, "report.json");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  implementationCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  scenario: "个人读书会费用约定换版，并跟进报名确认",
  runtimeDirectory: directory,
  steps: [],
};
let built: Built | undefined;
let config: Config | undefined;
let baseUrl = "";
let conversationId = "";
const persist = () =>
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const step = (name: string, result: unknown) => {
  (report.steps as unknown[]).push({
    name,
    recordedAt: new Date().toISOString(),
    result,
  });
  persist();
  console.log(JSON.stringify({ step: name, reportPath }));
};
const request = async <T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(600_000),
  });
  const result = await response.json();
  assert.equal(
    response.status,
    200,
    `${method} ${path}: ${JSON.stringify(result)}`,
  );
  return result as T;
};
const start = async () => {
  built = await buildApp(config!);
  baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
};
const memories = (): Memory[] =>
  built!.store.db
    .prepare(
      `SELECT m.id,m.version,m.status,r.body
  FROM memories m JOIN memory_revisions r ON r.id=m.head_revision_id ORDER BY m.id`,
    )
    .all() as Memory[];
const learningState = () => ({
  jobs: built!.store.jobs.list().map((job) => ({
    ...job,
    attempts: built!.store.jobs.attempts(job.id),
    output: job.resultRef ? built!.store.jobs.roleOutput(job.resultRef) : null,
  })),
  memories: memories(),
  refreshes: built!.store.db.prepare("SELECT * FROM refresh_records").all(),
  proposals: built!.memory.proposals(),
});
const waitForLearning = async (revisionId: string) => {
  const deadline = Date.now() + 720_000;
  while (Date.now() < deadline) {
    const jobs = built!.store.jobs
      .list()
      .filter((job) =>
        job.inputRefs.some(
          (ref) =>
            ref &&
            typeof ref === "object" &&
            (ref as { revisionId?: unknown }).revisionId === revisionId,
        ),
      );
    const terminalFailure = jobs.find((job) =>
      ["failed", "cancelled", "expired"].includes(job.state),
    );
    if (terminalFailure)
      throw Error(
        `Learning ${terminalFailure.id} ${terminalFailure.state}: ${terminalFailure.lastError}`,
      );
    if (jobs.length >= 2 && jobs.every((job) => job.state === "succeeded"))
      return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error(
    `Learning did not finish for ${revisionId}; see persisted jobs and traces`,
  );
};
const waitForLearningIdle = async () => {
  const deadline = Date.now() + 720_000;
  while (Date.now() < deadline) {
    const jobs = built!.store.jobs.list();
    const failed = jobs.find((job) =>
      ["failed", "cancelled", "expired"].includes(job.state),
    );
    if (failed)
      throw Error(
        `Background learning ${failed.id} ${failed.state}: ${failed.lastError}`,
      );
    if (jobs.every((job) => job.state === "succeeded")) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error(
    "Background learning remained active; see persisted jobs and traces",
  );
};
const captureBudget = async (amount: number) => {
  const text = `# 周末读书会\n\n## 费用约定\n我参加周末读书会时，每次费用上限为${amount}元。这是我已经确认并生效的个人预算约定。`;
  writeFileSync(join(directory, `original-budget-${amount}.md`), text + "\n", {
    mode: 0o600,
  });
  const result = await request<{
    revision: { id: string; sourceId: string; version: number };
    job: unknown;
  }>("POST", "/api/captures", {
    source: "manual",
    externalId: "personal:reading-club-budget",
    title: "周末读书会费用约定",
    parts: [{ type: "text", text }],
    provenance: {
      collectorId: "assistant-memory-flow",
      actorId: "owner",
      actorType: "owner",
      actorVerifiedBy: "authenticated-personal-acceptance",
      sourceUri: null,
      eventId: `budget-${amount}`,
      eventAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  });
  step(`保存原件预算${amount}`, result);
  return result;
};
const turn = async (name: string, text: string) => {
  const result = await request<AssistantTurnResult>(
    "POST",
    `/api/assistant/conversations/${conversationId}/turns`,
    {
      text,
      requestId: `${runId}:${name}`,
    },
  );
  step(name, { input: text, ...result });
  assert.equal(
    result.turn.inputMessageRefs.status,
    "done",
    `${name}: turn did not finish`,
  );
  assert.equal(
    result.degraded,
    false,
    `${name}: degraded answer is not acceptance`,
  );
  const inlineReferences = [...(result.turn.result ?? "").matchAll(/\[\[(e:[^\]]+)\]\]/g)].map(match => match[1]!);
  const returnedReferences = new Set(result.evidence.map(item => item.citationId ?? item.fragmentId));
  assert.ok(inlineReferences.every(id => returnedReferences.has(id)),
    `${name}: the answer's references must also be returned as readable source anchors`);
  for (const evidence of result.evidence) {
    assert.ok(evidence.sourceTarget, `${name}: citations must retain a fixed original range`);
    assert.equal(evidence.sourceTarget.revisionId, evidence.sourceRevisionId);
    const original = materialFromRevision(built!.store, evidence.sourceRevisionId)!;
    assert.ok(original, `${name}: citation original must still exist`);
    assert.equal(evidence.sourceTarget.digest, original.digest);
    assert.equal(evidence.text, original.text.split("\n").slice(evidence.sourceTarget.startLine - 1, evidence.sourceTarget.endLine).join("\n"));
  }
  return result;
};

try {
  assert.equal(
    process.env.OMEM_REPO_ROOT,
    undefined,
    "Run without OMEM_REPO_ROOT; this acceptance uses personal material only",
  );
  const model = loadReviewCodeModelConfig();
  assert.equal(model.transport, "acp");
  assert.equal(model.command, "traex");
  const selected = await selectLiveProfile(
    profileSchema.parse({
      id: "traex",
      name: "Personal memory flow acceptance",
      transport: model.transport,
      command: model.command,
      args: model.args,
      model: model.model,
      effort: model.effort,
      timeoutMs: model.timeoutMs,
    }),
    join(directory, "probe"),
  );
  const profile = {
    ...selected.profile,
    effort: selected.profile.effort ?? model.effort,
  };
  assert.equal(
    profile.model,
    "gpt-5.6-sol",
    "Acceptance requires the requested real model",
  );
  report.profile = {
    command: profile.command,
    args: profile.args,
    model: profile.model,
    effort: profile.effort,
    timeoutMs: profile.timeoutMs,
  };
  report.probe = selected.probe;
  persist();
  config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: join(directory, "data"),
    agentCwd: join(directory, "agents"),
    captureRoots: [],
    profiles: [profile],
    notifications: {
      mode: "instant",
      external: {
        mode: "instant",
        windowMs: 300_000,
        scheduleLocalTime: "09:00",
        timezone: "Asia/Shanghai",
      },
    },
    learning: { enabled: true, profileId: "traex", pollMs: 100 },
    lark: { enabled: false, pollMs: 1000 },
    retrieval: { enabled: false, osdkModel: "memory-zh" },
  };
  await start();
  const first = await captureBudget(80);
  await waitForLearning(first.revision.id);
  step("首次提取与独立核验", learningState());
  const originalMemories = memories().filter(
    (memory) => memory.status === "active" && /80/.test(memory.body),
  );
  assert.ok(
    originalMemories.length,
    "The original budget must become an applied memory, not merely a model proposal",
  );
  assert.equal(
    built!.store.tasks().length,
    0,
    "A budget note does not itself authorize a registration task",
  );
  const conversation = await request<{ id: string }>(
    "POST",
    "/api/assistant/conversations",
    { chatId: `personal-memory-flow:${runId}` },
  );
  conversationId = conversation.id;
  const firstAnswer = await turn(
    "查询原约定",
    "这份周末读书会约定里，我每次参加最多花多少？这是预算上限还是报名任务？先不要创建事项。",
  );
  assert.match(firstAnswer.turn.result ?? "", /80/);
  assert.ok(firstAnswer.evidence.some(evidence => evidence.sourceRevisionId === first.revision.id),
    "The original-budget answer must include an openable citation to the 80-yuan revision");
  assert.equal(built!.store.tasks().length, 0);
  const next = await captureBudget(120);
  const frozen = memories().filter((memory) =>
    originalMemories.some((original) => original.id === memory.id),
  );
  assert.ok(
    frozen.every((memory) => memory.status === "invalidated"),
    "Source changes must freeze dependent old memories before model review",
  );
  step("原件换版立即暂停旧记忆", frozen);
  await waitForLearning(next.revision.id);
  step("复查与自主应用新约定", learningState());
  const repaired = memories().filter((memory) =>
    originalMemories.some((original) => original.id === memory.id),
  );
  assert.equal(repaired.length, originalMemories.length);
  for (const memory of repaired) {
    const original = originalMemories.find((value) => value.id === memory.id)!;
    assert.equal(memory.status, "active");
    assert.equal(memory.version, original.version + 1);
    assert.match(memory.body, /120/);
  }
  assert.equal(
    memories().filter(
      (memory) => memory.status === "active" && /120/.test(memory.body),
    ).length,
    repaired.length,
    "Updating a budget must not create a duplicate active budget",
  );
  assert.match(
    built!.store
      .revision(first.revision.id)!
      .parts.map((part) => (part.type === "text" ? part.text : ""))
      .join("\n"),
    /80/,
  );
  const refresh = built!.store.db
    .prepare("SELECT status FROM refresh_records WHERE new_revision_id=?")
    .get(next.revision.id) as { status: string };
  assert.equal(refresh.status, "applied");
  const notices = await request<{ title: string; body: string }[]>("GET", "/api/notifications");
  const changedBudgetNotice = notices.find(notice => /记忆已更新/.test(notice.title) && /120/.test(notice.title));
  assert.ok(changedBudgetNotice, "An applied budget change needs a notification naming the new agreement");
  assert.match(changedBudgetNotice.body, /之前：[\s\S]*80[\s\S]*现在：[\s\S]*120/);
  assert.doesNotMatch(changedBudgetNotice.title, /claim|proposal|fragment|应用/);
  step("约定更新通知", changedBudgetNotice);
  const newAnswer = await turn(
    "查询变更后的约定",
    "现在周末读书会每次参加最多能花多少？和刚才的约定比有什么变化？只查询，不创建事项。",
  );
  assert.match(newAnswer.turn.result ?? "", /120/);
  assert.ok(newAnswer.evidence.some(evidence => evidence.sourceRevisionId === next.revision.id),
    "The updated-budget answer must include an openable citation to the 120-yuan revision");
  assert.equal(built!.store.tasks().length, 0);
  await turn(
    "明确委托跟进",
    "帮我跟进周末读书会报名确认，等待组织者回复；2030年10月2日上午9点提醒我检查。这是跟进时间，不是截止时间。",
  );
  await waitForLearningIdle();
  step("跟进指令后台处理后", learningState());
  assert.equal(built!.store.tasks().length, 1);
  const waiting = built!.store.tasks()[0]!;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.dueAt, null);
  assert.equal(waiting.followUp?.next_check_at, "2030-10-02T01:00:00.000Z");
  assert.equal(built!.store.remind("2030-10-02T00:59:59.000Z"), 0);
  const versionBeforeRead = waiting.version;
  await turn(
    "只查询当前事项",
    "回顾周末读书会报名确认事项，告诉我现在在等什么、什么时候检查，不修改事项。",
  );
  assert.equal(built!.store.tasks()[0]!.version, versionBeforeRead);
  await built!.app.close();
  built = undefined;
  await start();
  assert.equal(built!.store.remind("2030-10-02T01:00:00.000Z"), 1);
  assert.equal(built!.store.remind("2030-10-02T01:01:00.000Z"), 0);
  step("重启后按约定时间提醒一次", await request("GET", "/api/notifications"));
  await turn(
    "改期提醒",
    "稍后，2030年10月3日上午10点再提醒我检查周末读书会报名确认。",
  );
  await waitForLearningIdle();
  step("改期指令后台处理后", learningState());
  assert.equal(
    built!.store.tasks().length,
    1,
    "Background extraction must not create a second task from an applied command",
  );
  assert.equal(
    built!.store.tasks()[0]!.followUp?.snoozed_until,
    "2030-10-03T02:00:00.000Z",
  );
  assert.equal(built!.store.tasks()[0]!.dueAt, null);
  assert.equal(built!.store.remind("2030-10-03T01:59:59.000Z"), 0);
  assert.equal(built!.store.remind("2030-10-03T02:00:00.000Z"), 1);
  assert.equal(built!.store.remind("2030-10-03T02:01:00.000Z"), 0);
  await turn(
    "确认完成",
    "组织者已经回复我，周末读书会报名成功。把刚才的报名确认事项标记完成，不用再提醒。",
  );
  await waitForLearningIdle();
  step("完成指令后台处理后", learningState());
  assert.equal(
    built!.store.tasks().length,
    1,
    "Background extraction must not recreate a completed task",
  );
  assert.equal(built!.store.tasks()[0]!.status, "done");
  assert.equal(built!.store.remind("2040-01-01T00:00:00.000Z"), 0);
  step("最终记忆事项与通知", {
    memories: memories(),
    tasks: await request("GET", "/api/tasks"),
    notifications: await request("GET", "/api/notifications"),
    receipts: built!.store.db
      .prepare("SELECT * FROM application_receipts")
      .all(),
    reminderReceipts: built!.store.db
      .prepare("SELECT * FROM task_reminder_receipts")
      .all(),
  });
  report.status = "passed";
  report.limits = [
    "只有一份普通个人约定；不代表所有材料和问法已验收",
    "提醒为站内通知，未连接外部发送",
    "组织者回复由用户明确报告，未自动监听聊天",
    "时钟入口用明确 ISO 时刻推进，没有等待四年墙钟时间",
  ];
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (built) {
    report.finalLearningState = learningState();
    report.finalTasks = built.store.tasks();
    report.finalNotifications = built.store.notifications();
    await built.app.close();
  }
  report.finishedAt = new Date().toISOString();
  persist();
  console.log(
    JSON.stringify(
      { status: report.status, error: report.error, reportPath },
      null,
      2,
    ),
  );
}
