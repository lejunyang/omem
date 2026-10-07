import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkAction,
  WorkActor,
} from "../../../packages/contracts/src/work.js";
import type { ScheduledTask } from "../../../packages/contracts/src/schedules.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { Store } from "../src/store.js";
import { AssistantWork } from "../src/assistant/work.js";
import {
  AssistantRuntime,
  type AssistantModelPort,
} from "../src/assistant/runtime.js";
import {
  KnowledgeRepository,
  materialFromRevision,
} from "../src/knowledge/repository.js";
import { evidenceForRange } from "../src/assistant/research.js";
import { KnowledgePageWorker } from "../src/knowledge/page-worker.js";
import { KnowledgePageService } from "../src/knowledge/page-service.js";
import { DevelopmentQueue } from "../src/development/queue.js";
import { PersonalLarkService } from "../src/integrations/lark-personal/service.js";
import type { PersonalLarkPort } from "../src/integrations/lark-personal/client.js";
import { ScheduleService } from "../src/schedules/service.js";
import { ScheduledBriefService } from "../src/assistant/scheduled-brief.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

function setup(model?: AssistantModelPort) {
  const directory = mkdtempSync(join(tmpdir(), "omem-assistant-schedules-"));
  const store = new Store(directory),
    repository = new KnowledgeRepository(store);
  const maintenance = new KnowledgePageWorker(repository),
    pages = new KnowledgePageService(repository, maintenance, true);
  const queue = new DevelopmentQueue(
    store,
    pages,
    profileSchema.parse({
      id: "traex",
      name: "fixture",
      transport: "acp",
      command: "traex",
      args: [],
      instructions: "",
      model: "fixture",
      effort: "low",
    }),
  );
  let messageReads = 0;
  const port: PersonalLarkPort = {
    identity: async () => "ou_owner",
    chats: async () => ({
      chats: [{ chat_id: "oc_refunds", name: "退款讨论", chat_mode: "group" }],
      has_more: false,
    }),
    preferences: async (ids) =>
      ids.map((chat_id) => ({
        chat_id,
        is_muted: false,
        is_mute_at_all: false,
      })),
    messages: async () => {
      messageReads++;
      return { messages: [], has_more: false };
    },
    resource: async () => {
      throw Error("本用例不应下载资源");
    },
  };
  const personalLark = new PersonalLarkService(
    store,
    {
      decide: async () => null,
      status: () => ({
        status: "unavailable",
        model: "",
        lastError: "",
        mode: "auto",
      }),
    },
    port,
  );
  let brief: ScheduledBriefService | undefined,
    scheduleNow = new Date();
  const schedules = new ScheduleService(
    store,
    (task, signal, occurrence) =>
      brief
        ? brief.run(task, signal, occurrence)
        : Promise.resolve({ summary: "已检查" }),
    { now: () => scheduleNow, heartbeatMs: 0 },
  );
  const work = new AssistantWork(pages, queue, undefined, {
    personalLark,
    schedules,
  });
  if (model) brief = new ScheduledBriefService(store, work, model);
  const actor = (
    userText: string,
    patch: Partial<WorkActor> = {},
  ): WorkActor => ({
    requestId: randomUUID(),
    conversationId: "owner-private-chat",
    principalId: "owner",
    visibility: "private",
    userText,
    ...patch,
  });
  const tool = async (name: string, args = {}) => {
    const found = work.tools().find((candidate) => candidate.name === name);
    expect(found?.readOnly).toBe(true);
    return found!.run(args, { file: "", materials: [], articles: [] });
  };
  cleanup.push(async () => {
    await schedules.stop();
    await personalLark.stop();
    await queue.stop();
    await maintenance.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    work,
    schedules,
    personalLark,
    actor,
    tool,
    brief,
    advance: (minutes: number) => {
      scheduleNow = new Date(scheduleNow.getTime() + minutes * 60_000);
    },
    messageReads: () => messageReads,
  };
}

function seedFollowup(store: Store, projectId: string | null = null) {
  store.applications.applyTask({
    metadata: {
      workspaceId: "personal",
      applicationId: randomUUID(),
      proposalDigest: randomUUID(),
      generation: 1,
      title: "等待接口回复",
      details: "已应用的真实事项",
      delivery: {
        channelBindingVersion: 1,
        channel: "in_app",
        target: "notification-center",
      },
    },
    task: {
      ownerId: "owner",
      projectId,
      title: "检查退款接口回复",
      detail: "负责人待回复接口说明",
      nextStep: "确认负责人回复",
      status: "waiting",
    },
  });
}

function bindOwnerNotice(store: Store) {
  const at = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO lark_connections(id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,owner_open_id,created_at,updated_at)
    VALUES('brief-c','personal','cli_brief','feishu','t','active',1,'ou_owner',?,?)`,
    )
    .run(at, at);
  store.db
    .prepare(
      `INSERT INTO lark_bindings(id,workspace_id,connection_id,connection_version,binding_version,owner_open_id,target_chat_id,target_type,state,supersedes_binding_id,created_at)
    VALUES('brief-b','personal','brief-c',1,1,'ou_owner','oc_owner','p2p','active',NULL,?)`,
    )
    .run(at);
  store.db
    .prepare(
      `INSERT INTO lark_targets(id,workspace_id,connection_id,binding_version,chat_id,target_type,purpose,capture_enabled,state,created_at,updated_at)
    VALUES('brief-t','personal','brief-c',1,'oc_owner','p2p','owner_notification',0,'active',?,?)`,
    )
    .run(at, at);
}

function seedInboxMessage(
  store: Store,
  id: string,
  text: string,
  contextIds: string[] = [],
  sourceUri: string | null = null,
) {
  const at = new Date().toISOString();
  const input = {
    source: "chat" as const,
    externalId: `lark-personal:${id}`,
    title: "退款讨论",
    parts: [{ type: "text" as const, text }],
    context: { conversationId: "oc_refunds" },
    provenance: {
      collectorId: "lark-personal-fixture",
      actorId: "ou_colleague",
      actorType: "user" as const,
      actorVerifiedBy: "fixture",
      sourceUri,
      eventId: null,
      eventAt: at,
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original" as const,
    },
  };
  const { revision } = store.capture(input, {
    learning: false,
    notify: false,
    contextIds,
  });
  store.db
    .prepare(
      `INSERT INTO personal_lark_messages(id,chat_id,chat_name,digest,raw,revision_id,state,observed_at,updated_at)
       VALUES(?,'oc_refunds','退款讨论','fixture',?,?,'ready',?,?)`,
    )
    .run(
      id,
      JSON.stringify({
        message_id: id,
        chat_id: "oc_refunds",
        msg_type: "text",
        content: text,
        create_time: String(Date.parse(at)),
        message_app_link: sourceUri ?? undefined,
      }),
      revision.id,
      at,
      at,
    );
  return { input, revision };
}

const briefTask = (name = "退款每日简报") => ({
  kind: "daily_brief" as const,
  name,
  instruction: "退款最近变化与等待回复",
  contextIds: [],
  enabled: true,
  timing: {
    type: "cron" as const,
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  },
});

describe("derived scheduled briefs", () => {
  it("generates from selected-project captured messages alone and excludes messages belonging to another project", async () => {
    const calls: Parameters<AssistantModelPort["generate"]>[0][] = [];
    const s = setup({
      generate: async (input) => {
        calls.push(input);
        return { answer: "负责人已说明退款接口，等待确认。", citationIds: [] };
      },
    });
    const wanted = s.store.contexts.create({
      name: "退款",
      kind: "project",
      description: "退款接口",
    });
    const other = s.store.contexts.create({
      name: "支付",
      kind: "project",
      description: "另一项讨论",
    });
    const selected = seedInboxMessage(
      s.store,
      "om_selected",
      "负责人已说明接口，等待确认。",
      [wanted.id],
    );
    const unrelated = seedInboxMessage(
      s.store,
      "om_other",
      "退款群里另一项目的发布事项。",
      [other.id],
    );
    expect(s.store.tasks()).toEqual([]);
    const task = s.schedules.save({ ...briefTask(), contextIds: [wanted.id] });
    s.schedules.runOnce(task.id);
    await s.schedules.processOne();
    expect(calls).toHaveLength(1);
    const state = JSON.parse(
      calls[0]!.trustedContext!.match(
        /<brief_state>(.*?)<\/brief_state>/s,
      )![1]!,
    );
    expect(state.tasks).toEqual([]);
    expect(state.requirements).toEqual([]);
    expect(state.development).toEqual([]);
    expect(state.messages).toEqual([
      expect.objectContaining({
        revisionId: selected.revision.id,
        text: selected.input.parts[0]!.text,
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain(unrelated.revision.id);
    expect(JSON.stringify(state)).not.toContain(unrelated.input.parts[0]!.text);
    expect(s.schedules.get(task.id)?.lastRun).toMatchObject({
      state: "succeeded",
      skipped: false,
      detail: "负责人已说明退款接口，等待确认。",
    });
    expect(s.messageReads()).toBe(0);
  });

  it("preserves a captured revision link in the saved brief while the owner bot outbox uses its HTTPS origin", async () => {
    const sourceUri = "https://example.org/refunds/message-1";
    let researchedEvidence: ReturnType<typeof evidenceForRange> | undefined;
    const s = setup({
      generate: async () => ({
        answer: `退款接口仍等待回复。[[${researchedEvidence!.citationId}]]`,
        citationIds: [researchedEvidence!.citationId!],
        researchedEvidence: [researchedEvidence!],
      }),
    });
    const captured = seedInboxMessage(
      s.store,
      "om_fixed",
      "退款接口仍等待负责人回复。",
      [],
      sourceUri,
    );
    const material = materialFromRevision(s.store, captured.revision.id)!;
    researchedEvidence = evidenceForRange(material, 1, 1, () => true);
    const newer = s.store.capture(
      {
        ...captured.input,
        parts: [{ type: "text", text: "后续回复已收到。" }],
      },
      { learning: false, notify: false },
    ).revision;
    expect(newer.id).not.toBe(captured.revision.id);
    expect(s.store.revision(captured.revision.id)?.current).toBe(false);
    bindOwnerNotice(s.store);
    const task = s.schedules.save(briefTask());
    const run = s.schedules.runOnce(task.id).run;
    await s.schedules.processOne();
    const saved = s.schedules.repository.run(run.id)!;
    expect(saved).toMatchObject({
      state: "succeeded",
      detail: `退款接口仍等待回复。[退款讨论](/__omem/revision/${captured.revision.id})`,
      notificationState: "已进入机器人通知队列",
    });
    expect(saved.detail).not.toContain(newer.id);
    const intents = s.store.db
      .prepare("SELECT payload_json FROM delivery_intents WHERE channel='lark'")
      .all();
    expect(intents).toHaveLength(1);
    const payload = JSON.parse(String(intents[0]!.payload_json));
    const notification = payload.body.elements[0].content as string;
    expect(notification).toContain(`[退款讨论](${sourceUri})`);
    expect(notification).not.toMatch(/\/__omem\/|#\/read|\]\(\//);
    expect(s.schedules.repository.run(run.id)?.detail).toBe(saved.detail);
    expect(s.store.tasks()).toEqual([]);
    expect(s.messageReads()).toBe(0);
  });

  it("skips an unchanged automatic check and saves a manual result without duplicating the owner outbox", async () => {
    const calls: Parameters<AssistantModelPort["generate"]>[0][] = [];
    const s = setup({
      generate: async (input) => {
        calls.push(input);
        return {
          answer: `# 退款跟进\n\n检查退款接口回复。第 ${calls.length} 次整理。`,
          citationIds: [],
        };
      },
    });
    seedFollowup(s.store);
    bindOwnerNotice(s.store);
    const task = s.schedules.save({
      ...briefTask(),
      timing: { type: "interval", everyMinutes: 1 },
    });
    s.advance(1);
    const initial = s.schedules.tick()[0]!;
    await s.schedules.processOne();
    expect(s.schedules.get(task.id)?.lastRun).toMatchObject({
      id: initial.id,
      state: "succeeded",
      skipped: false,
      detail: expect.stringContaining("第 1 次整理"),
    });
    expect(calls[0]).toMatchObject({
      mode: "research",
      ownerScoped: true,
      tasks: [{ title: "检查退款接口回复", status: "waiting" }],
    });
    const noticeCount = () =>
      Number(
        s.store.db
          .prepare(
            "SELECT count(*) n FROM delivery_intents WHERE channel='lark'",
          )
          .get()?.n,
      );
    expect(noticeCount()).toBe(1);
    s.advance(1);
    s.schedules.tick();
    await s.schedules.processOne();
    expect(calls).toHaveLength(1);
    expect(s.schedules.get(task.id)?.lastRun).toMatchObject({
      state: "succeeded",
      skipped: true,
      summary: expect.stringContaining("没有新增"),
    });
    expect(noticeCount()).toBe(1);
    const manual = s.schedules.runOnce(task.id);
    await s.schedules.processOne();
    expect(calls).toHaveLength(2);
    expect(s.schedules.repository.run(manual.run.id)).toMatchObject({
      state: "succeeded",
      detail: expect.stringContaining("第 2 次整理"),
      notificationState: "未重复通知",
    });
    expect(noticeCount()).toBe(1);
    expect(
      s.store.db
        .prepare(
          "SELECT count(*) n FROM scheduled_brief_receipts WHERE task_id=?",
        )
        .get(task.id)?.n,
    ).toBe(2);
  });

  it("checks the real occurrence fence after model await and writes no obsolete brief or notification", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
    const s = setup({
      generate: async () => {
        entered();
        await released;
        return { answer: "旧范围的简报不应保存", citationIds: [] };
      },
    });
    seedFollowup(s.store);
    bindOwnerNotice(s.store);
    const task = s.schedules.save(briefTask()),
      run = s.schedules.runOnce(task.id).run;
    const processing = s.schedules.processOne();
    await started;
    s.schedules.pause(task.id, task.version);
    release();
    await processing;
    expect(s.schedules.repository.run(run.id)).toMatchObject({
      state: "cancelled",
      detail: null,
    });
    expect(
      s.store.db
        .prepare("SELECT count(*) n FROM scheduled_brief_receipts")
        .get()?.n,
    ).toBe(0);
    expect(
      s.store.db.prepare("SELECT count(*) n FROM scheduled_brief_state").get()
        ?.n,
    ).toBe(0);
    expect(
      s.store.db
        .prepare("SELECT count(*) n FROM changes WHERE kind='brief'")
        .get()?.n,
    ).toBe(0);
    expect(
      s.store.db
        .prepare("SELECT count(*) n FROM delivery_intents WHERE channel='lark'")
        .get()?.n,
    ).toBe(0);
  });

  it("passes only the selected project's applied tasks and rejects model mutation proposals", async () => {
    let modelInput: Parameters<AssistantModelPort["generate"]>[0] | undefined;
    const s = setup({
      generate: async (input) => {
        modelInput = input;
        return {
          answer: "不应应用此操作",
          citationIds: [],
          toolCalls: [
            {
              tool: "create_task",
              title: "未经交办的新事项",
              detail: "",
              dueAt: null,
            },
          ],
        };
      },
    });
    const wanted = s.store.contexts.create({
      name: "退款",
      kind: "project",
      description: "退款查询",
    });
    const other = s.store.contexts.create({
      name: "支付",
      kind: "project",
      description: "其他范围",
    });
    seedFollowup(s.store, wanted.id);
    seedFollowup(s.store, other.id);
    const task = s.schedules.save({ ...briefTask(), contextIds: [wanted.id] });
    s.schedules.runOnce(task.id);
    await s.schedules.processOne();
    expect(modelInput?.tasks).toHaveLength(1);
    expect(modelInput?.tasks?.[0]?.projectId).toBe(wanted.id);
    expect(s.schedules.get(task.id)?.lastRun).toMatchObject({
      state: "failed",
      error: expect.stringContaining("不能执行事项操作"),
    });
    expect(s.store.tasks()).toHaveLength(2);
    expect(
      s.store.db
        .prepare("SELECT count(*) n FROM scheduled_brief_receipts")
        .get()?.n,
    ).toBe(0);
  });
});

describe("owner-directed assistant schedules", () => {
  it("uses returned chat IDs for owner-private subscription and exclusion without silently reading messages", async () => {
    const s = setup();
    const chats = (await s.tool("message_chats", {
      query: "退款",
      limit: 30,
      refresh: true,
    })) as { id: string; name: string }[];
    const chat = chats[0]!;
    const watch: WorkAction = {
      operation: "subscribe_chat",
      chatId: chat.id,
      mode: "watch",
      delegation: "关注退款讨论群",
    };
    const owner = s.actor(watch.delegation);
    const receipt = s.work.apply(watch, owner);
    expect(receipt.message).toContain("已关注");
    expect(s.work.apply(watch, owner)).toEqual(receipt);
    expect(
      s.personalLark.streams().find((stream) => stream.id === chat.id),
    ).toMatchObject({ mode: "watch", subscription: { source: "manual" } });
    const exclude: WorkAction = {
      operation: "subscribe_chat",
      chatId: chat.id,
      mode: "excluded",
      delegation: "排除退款讨论群",
    };
    s.work.apply(exclude, s.actor(exclude.delegation));
    expect(
      s.personalLark.streams().find((stream) => stream.id === chat.id)?.mode,
    ).toBe("excluded");
    expect(s.personalLark.settings().enabled).toBe(false);
    expect(s.messageReads()).toBe(0);
    expect(
      s.store.db.prepare("SELECT count(*) n FROM assistant_work_receipts").get()
        ?.n,
    ).toBe(2);
  });

  it("creates through the main assistant then uses actual IDs and versions to edit, pause and resume the same schedule", async () => {
    const s = setup(),
      text = "帮我设置退款每日简报，每天上午9点整理";
    const action: WorkAction = {
      operation: "save_schedule",
      task: briefTask(),
      delegation: text,
    };
    const model: AssistantModelPort = {
      generate: async () => ({
        answer: "模型自报已送达",
        citationIds: [],
        workAction: action,
      }),
    };
    const runtime = new AssistantRuntime(s.store, model, { work: s.work });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "lark_p2p",
      chatId: "oc_owner",
      visibility: "private",
    });
    const result = await runtime.turn({
      conversationId: conversation.id,
      userText: text,
    });
    expect(result.turn.result).toContain("已保存");
    expect(result.turn.result).not.toContain("模型自报");
    const list = (await s.tool("schedule_list")) as ScheduledTask[];
    const created = list.find((task) => task.name === "退款每日简报")!;
    expect(created).toMatchObject({ version: 1, enabled: true });
    const changeText = "把退款每日简报改到上午10点";
    const changed = s.work.apply(
      {
        operation: "save_schedule",
        id: created.id,
        task: {
          ...briefTask(),
          timing: {
            type: "cron",
            expression: "0 10 * * *",
            timezone: "Asia/Shanghai",
          },
          expectedVersion: created.version,
        },
        delegation: changeText,
      },
      s.actor(changeText),
    );
    expect(changed.taskId).toBe(created.id);
    const current = (await s.tool("schedule_get", {
      id: changed.taskId,
    })) as ScheduledTask;
    expect(current).toMatchObject({
      id: created.id,
      version: 2,
      timing: { expression: "0 10 * * *" },
    });
    const pauseText = "暂停退款每日简报",
      pauseActor = s.actor(pauseText);
    const pause: WorkAction = {
      operation: "pause_schedule",
      id: current.id,
      expectedVersion: current.version,
      delegation: pauseText,
    };
    const paused = s.work.apply(pause, pauseActor);
    expect(s.work.apply(pause, pauseActor)).toEqual(paused);
    expect(s.schedules.get(current.id)).toMatchObject({
      id: created.id,
      version: 3,
      enabled: false,
      nextRunAt: null,
    });
    const resumeText = "恢复退款每日简报";
    s.work.apply(
      {
        operation: "resume_schedule",
        id: current.id,
        expectedVersion: 3,
        delegation: resumeText,
      },
      s.actor(resumeText),
    );
    expect(s.schedules.get(current.id)).toMatchObject({
      id: created.id,
      version: 4,
      enabled: true,
    });
    expect(
      s.schedules.list().filter((task) => task.name === "退款每日简报"),
    ).toHaveLength(1);
    expect(() => s.work.apply(pause, s.actor(pauseText))).toThrow("变化");
  });

  it("rejects group or non-owner actions and a conflicting request retry without changing saved state", async () => {
    const s = setup();
    await s.personalLark.discover();
    const initialMode = s.personalLark.streams()[0]?.mode;
    const action: WorkAction = {
      operation: "subscribe_chat",
      chatId: s.personalLark.searchChats("退款")[0]!.id,
      mode: "watch",
      delegation: "关注退款讨论群",
    };
    expect(() =>
      s.work.apply(action, s.actor(action.delegation, { visibility: "group" })),
    ).toThrow("本人私聊");
    expect(() =>
      s.work.apply(
        action,
        s.actor(action.delegation, { principalId: "other" }),
      ),
    ).toThrow("本人私聊");
    expect(s.personalLark.streams()[0]?.mode).toBe(initialMode);
    const text = "设置退款每日简报",
      actor = s.actor(text);
    const create: WorkAction = {
      operation: "save_schedule",
      task: briefTask(),
      delegation: text,
    };
    const receipt = s.work.apply(create, actor);
    expect(s.work.apply(create, actor)).toEqual(receipt);
    expect(() =>
      s.work.apply({ ...create, task: briefTask("另一份简报") }, actor),
    ).toThrow("同一请求");
    expect(
      s.schedules
        .list()
        .filter(
          (task) => task.kind === "daily_brief" && task.id !== "daily-brief",
        ),
    ).toHaveLength(1);
  });
});
