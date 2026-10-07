/** One real ACP flow on synthetic materials and a stubbed personal Lark port. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import type { PersonalLarkPort } from "../apps/server/src/integrations/lark-personal/client.js";

delete process.env.OMEM_REPO_ROOT;
const model = loadReviewCodeModelConfig(
  resolve("config/review-code-model.json"),
);
const profile = profileSchema.parse({
  id: "traex",
  name: "Synthetic scheduled-assistant acceptance",
  transport: model.transport,
  command: model.command,
  args: model.args,
  model: model.model,
  effort: model.effort,
  idleTimeoutMs: model.idleTimeoutMs,
});
assert.equal(profile.transport, "acp");
assert.equal(profile.model, "gpt-5.6-sol");
const directory = mkdtempSync(join(tmpdir(), "omem-scheduled-assistant-"));
const output = resolve(
  ".repo-review/runtime/research/scheduled-assistant/current.json",
);
mkdirSync(resolve(".repo-review/runtime/research/scheduled-assistant"), {
  recursive: true,
});

type JsonObject = Record<string, unknown>;
const calls = {
  identity: 0,
  chats: 0,
  preferences: 0,
  messages: 0,
  resources: 0,
};
const stub: PersonalLarkPort = {
  identity: async () => {
    calls.identity++;
    return "ou_syntheticowner";
  },
  chats: async () => {
    calls.chats++;
    return {
      chats: [
        {
          chat_id: "oc_syntheticrefunds",
          name: "演示退款需求讨论",
          chat_mode: "group",
        },
      ],
      has_more: false,
    };
  },
  preferences: async (ids) => {
    calls.preferences++;
    return ids.map((chat_id) => ({
      chat_id,
      is_muted: false,
      is_mute_at_all: false,
    }));
  },
  messages: async (input) => {
    calls.messages++;
    return {
      messages: [
        {
          message_id: "om_synthetic_reply",
          chat_id: input.chatId,
          msg_type: "text",
          content:
            "【合成演示材料】接口说明尚待负责人回复，本消息没有新的交办。",
          create_time: new Date().toISOString(),
        },
      ],
      has_more: false,
    };
  },
  resource: async () => {
    calls.resources++;
    throw Error("Synthetic port does not download any resources");
  },
};

const turns: JsonObject[] = [];
let previousFailures: JsonObject[] = [];
if (existsSync(output)) {
  try {
    const previous = JSON.parse(readFileSync(output, "utf8"));
    previousFailures = Array.isArray(previous.previousFailures)
      ? previous.previousFailures
      : previous.previousFailure
        ? [previous.previousFailure]
        : [];
    if (previous.state === "failed")
      previousFailures.push({
        at: previous.at,
        stage: previous.stage,
        error: previous.error,
        turns: previous.turns,
        elapsedSeconds: previous.elapsedSeconds,
      });
    previousFailures = previousFailures.slice(-3);
  } catch {
    /* A report is diagnostic, never instructions. */
  }
}
const report: JsonObject = {
  at: new Date().toISOString(),
  model: profile.model,
  effort: profile.effort,
  transport: profile.transport,
  idleTimeoutMs: profile.idleTimeoutMs,
  passed: false,
  state: "starting",
  stages: [],
  turns,
  ...(previousFailures.length ? { previousFailures } : {}),
  boundaries: {
    isolatedLibrary: true,
    syntheticPersonalLarkPort: true,
    privateLarkRead: false,
    botBound: false,
    decisions: "off",
    learning: false,
    retrievalModels: false,
    totalTimeout: null,
  },
};
const started = Date.now();
let system: Awaited<ReturnType<typeof buildApp>> | undefined;
let stage = "starting";
const save = () =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        ...report,
        stage,
        elapsedSeconds: (Date.now() - started) / 1000,
        portCalls: calls,
      },
      null,
      2,
    ) + "\n",
  );
const setStage = (next: string) => {
  stage = next;
  console.log(`STAGE ${next}`);
  save();
};

/** Retain names, outcomes and timing; temporary snapshots and databases are released. */
function traceSummary(trace: unknown) {
  if (!trace || typeof trace !== "object") return null;
  const value = trace as JsonObject;
  const workspace =
    typeof value.workspace === "string" ? value.workspace : null;
  let disk: JsonObject = {};
  if (workspace && existsSync(join(workspace, "trace.json"))) {
    try {
      disk = JSON.parse(readFileSync(join(workspace, "trace.json"), "utf8"));
    } catch {
      /* optional trace */
    }
  }
  const activity = ((value.usage as JsonObject | undefined)?.activity ??
    (disk.usage as JsonObject | undefined)?.activity ??
    disk.activity ??
    []) as JsonObject[];
  const config = (disk.configOptions ??
    value.configOptions ??
    []) as JsonObject[];
  const timings = value.timings as JsonObject | undefined;
  return {
    model: value.model ?? disk.model ?? profile.model,
    effort: value.effort ?? disk.effort ?? profile.effort,
    elapsedMs: timings?.totalMs ?? value.elapsedMs ?? disk.elapsedMs ?? null,
    timings: timings ?? null,
    acpTimings: value.acpTimings ?? null,
    effectiveOptions: config
      .filter((option) =>
        ["model", "reasoning_effort"].includes(String(option.id)),
      )
      .map((option) => ({ id: option.id, value: option.currentValue })),
    activity: activity.slice(0, 100).map((entry) => ({
      kind: entry.kind,
      tool: entry.tool,
      type: entry.type,
      status: entry.status,
      reads: entry.reads,
      at: entry.at,
    })),
    nativeTools: [
      ...new Set(activity.map((entry) => entry.tool).filter(Boolean)),
    ],
  };
}

const heartbeat = setInterval(
  () =>
    console.log(
      `RUNNING ${stage} (${Math.round((Date.now() - started) / 1000)}s)`,
    ),
  30_000,
);
heartbeat.unref();
save();
try {
  system = await buildApp(
    {
      profiles: [profile],
      assistant: { profileId: profile.id },
      notifications: { mode: "instant" },
      learning: { enabled: false, profileId: profile.id, pollMs: 1000 },
      lark: { enabled: false, pollMs: 1000 },
      decisions: { mode: "off" },
      retrieval: { enabled: false, osdkModel: "memory-zh" },
      captureRoots: [],
      dataDir: join(directory, "data"),
      agentCwd: directory,
      host: "127.0.0.1",
      port: 0,
    },
    { personalLarkPort: stub },
  );
  await system.app.ready();
  // Execute only the explicit acceptance steps; no collector can escape the stub.
  await system.schedules.stop();
  await system.personalLark.stop();
  await system.personalLark.discover();
  const taskReceipt = system.store.applications.applyTask({
    metadata: {
      workspaceId: "personal",
      applicationId: randomUUID(),
      proposalDigest: randomUUID(),
      generation: 1,
      title: "合成演示事项",
      details: "已创建且等待负责人回复",
      delivery: {
        channelBindingVersion: 1,
        channel: "in_app",
        target: "notification-center",
      },
    },
    task: {
      ownerId: "owner",
      title: "检查演示退款接口回复",
      detail: "合成演示：负责人尚未回复接口说明。",
      nextStep: "确认负责人是否回复",
      status: "waiting",
    },
  });
  const beforeTasks = system.store.tasks();
  report.initialTaskReceipt = { id: taskReceipt.id };
  report.initialTasks = beforeTasks;
  const conversation = system.assistant.conversations.open({
    principalId: "owner",
    channel: "lark_p2p",
    chatId: "oc_syntheticowner",
    visibility: "private",
  });

  async function ask(text: string, label: string) {
    setStage(label);
    const result = await system!.assistant.turn({
      conversationId: conversation.id,
      userText: text,
    });
    const turn = system!.assistant.conversations.turn(result.turn.id)!;
    const actions = turn.toolActions as JsonObject[];
    const entry = {
      userText: text,
      turnId: turn.id,
      status: turn.inputMessageRefs.status,
      degraded: result.degraded,
      answer: turn.result,
      receipts: actions.filter((action) => action.tool === "work_action"),
      research: actions
        .filter((action) => action.tool === "research")
        .map((action) => traceSummary(action.trace)),
    };
    turns.push(entry);
    save();
    console.log(`RESULT ${label}: ${turn.result}`);
    assert.equal(
      turn.inputMessageRefs.status,
      "done",
      JSON.stringify(turn.inputMessageRefs),
    );
    assert.equal(
      result.degraded,
      false,
      "Real ACP must complete without deterministic fallback",
    );
    return entry;
  }

  await ask(
    "请关注飞书群「演示退款需求讨论」。先查询最近会话的实际身份，再执行一次关注；消息采集开关保持现在的设置。这是合成演示群，不要关注其他会话。",
    "owner-watch-chat",
  );
  const watched = system.personalLark
    .streams()
    .find((stream) => stream.id === "oc_syntheticrefunds");
  assert.equal(
    watched?.mode,
    "watch",
    "Owner assistant must actually save the subscription",
  );
  assert.equal(
    system.personalLark.settings().enabled,
    false,
    "Watching a chat must not silently enable collection",
  );
  report.subscription = {
    id: watched.id,
    name: watched.name,
    mode: watched.mode,
    annotation: watched.subscription,
  };

  await ask(
    "请设置一项每天北京时间上午9点运行、名字为「演示退款每日简报」的定时任务，整理我等待退款接口回复的事项和最近变化。先读取已有定时任务，再保存这项简报；现在只设置，不立即生成。请告诉我实际保存的任务和版本。",
    "owner-save-daily-brief",
  );
  const scheduled = system.schedules
    .list()
    .find((task) => task.name === "演示退款每日简报");
  assert.ok(scheduled, "Owner assistant must save the requested brief");
  assert.equal(scheduled.kind, "daily_brief");
  assert.equal(scheduled.enabled, true);
  assert.deepEqual(scheduled.timing, {
    type: "cron",
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  });
  assert.equal(
    system.schedules.list().filter((task) => task.name === scheduled.name)
      .length,
    1,
  );
  report.savedSchedule = {
    id: scheduled.id,
    version: scheduled.version,
    name: scheduled.name,
    timing: scheduled.timing,
    nextRunAt: scheduled.nextRunAt,
  };
  save();

  setStage("real-brief-generation");
  const manual = system.schedules.runOnce(scheduled.id);
  const processed = await system.schedules.processOne();
  const run = system.schedules.repository.run(manual.run.id)!;
  report.brief = {
    ...run,
    trace: traceSummary(
      system.schedules.repository.storedResult(run.id)?.usage?.researchTrace,
    ),
  };
  save();
  assert.equal(processed.processed, true);
  assert.equal(run.state, "succeeded", run.error ?? "Brief failed");
  assert.ok(
    run.detail && run.detail.length > 30,
    "Real brief must have readable content",
  );
  assert.equal(
    run.skipped,
    false,
    "The existing waiting task must reach the model",
  );
  assert.deepEqual(
    system.store.tasks(),
    beforeTasks,
    "Derived brief must not change task facts",
  );
  assert.equal(
    system.store.db
      .prepare("SELECT count(*) n FROM delivery_intents WHERE channel='lark'")
      .get()?.n,
    0,
  );
  assert.equal(
    system.store.db.prepare("SELECT count(*) n FROM lark_bindings").get()?.n,
    0,
  );

  await ask(
    "请查询「演示退款每日简报」刚才实际运行的结果，然后暂停这一项定时任务，保留已生成简报。沿用刚才实际保存的任务身份和当前版本，不要创建其他任务。",
    "owner-read-and-pause-same-brief",
  );
  const paused = system.schedules.get(scheduled.id)!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.version, scheduled.version + 1);
  assert.equal(paused.lastRun?.id, run.id);
  assert.equal(paused.lastRun?.detail, run.detail);
  assert.equal(
    system.schedules.list().filter((task) => task.name === scheduled.name)
      .length,
    1,
  );
  report.finalSchedule = {
    id: paused.id,
    version: paused.version,
    enabled: paused.enabled,
    nextRunAt: paused.nextRunAt,
    lastRunId: paused.lastRun?.id,
  };
  report.finalTasks = system.store.tasks();
  report.passed = true;
  report.state = "passed";
} catch (error) {
  report.state = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(`FAILED ${stage}: ${report.error}`);
} finally {
  clearInterval(heartbeat);
  if (system) {
    report.finalTasks ??= system.store.tasks();
    report.scheduleStates = system.schedules.list().map((task) => ({
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      version: task.version,
      lastState: task.lastRun?.state ?? null,
      error: task.lastRun?.error ?? null,
    }));
    await system.app.close();
  }
  rmSync(directory, { recursive: true, force: true });
  report.cleaned = true;
  report.at = new Date().toISOString();
  save();
  console.log(`REPORT ${output}`);
}
