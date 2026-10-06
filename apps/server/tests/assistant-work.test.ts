import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
} from "../src/knowledge/repository.js";
import { KnowledgePageWorker } from "../src/knowledge/page-worker.js";
import { KnowledgePageService } from "../src/knowledge/page-service.js";
import { AssistantWork } from "../src/assistant/work.js";
import { AssistantRuntime } from "../src/assistant/runtime.js";
import { DevelopmentQueue } from "../src/development/queue.js";
import { DevelopmentRunner } from "../src/development/runner.js";
import { inspectRequirementChange } from "../src/development/replanning.js";
import { requirementBasis } from "../src/development/requirement-basis.js";
import { MessageUnderstanding } from "../src/messages/understanding.js";
import {
  git,
  fingerprint,
  snapshotCommit,
} from "../src/development/workspace.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import type {
  WorkAction,
  WorkActor,
} from "../../../packages/contracts/src/work.js";
const profile = profileSchema.parse({
  id: "traex",
  name: "fixture",
  transport: "acp",
  command: "traex",
  args: [],
  instructions: "",
  model: "fixture",
  effort: "low",
});
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function setup(runner?: (path: string) => DevelopmentRunner) {
  const dir = mkdtempSync(join(tmpdir(), "omem-work-")),
    store = new Store(join(dir, "data"));
  const repository = new KnowledgeRepository(store),
    maintenance = new KnowledgePageWorker(repository);
  const pages = new KnowledgePageService(repository, maintenance, true);
  const queue = new DevelopmentQueue(store, pages, profile, {
    runner: runner?.(store.dataDir),
  });
  const work = new AssistantWork(pages, queue);
  const actor = (userText: string): WorkActor => ({
    requestId: randomUUID(),
    conversationId: "test-chat",
    principalId: "owner",
    userText,
    visibility: "private",
  });
  cleanup.push(async () => {
    await queue.stop();
    await maintenance.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.capture(
    {
      source: "manual",
      externalId: "spec",
      title: "退款需求",
      parts: [
        {
          type: "text",
          text: "本期支持退款查询，接口由小李负责，页面由我负责。",
        },
      ],
      context: {},
    },
    { learning: false, notify: false },
  );
  const action: WorkAction = {
    operation: "track",
    title: "退款查询",
    goal: "跟进本期上线阻塞",
    materialKeys: ["manual:spec"],
    contextIds: [],
    attention: {
      focus: ["上线阻塞"],
      ignore: ["批量操作"],
      notifications: "important",
    },
  };
  return {
    dir,
    store,
    repository,
    maintenance,
    pages,
    queue,
    work,
    actor,
    action,
  };
}
function publish(
  repository: KnowledgeRepository,
  key: string,
  actionTitle = "实现退款页面",
  questions: import("../../../packages/contracts/src/knowledge.js").KnowledgeQuestion[] = [],
) {
  const plan = repository.pages().find((p) => p.key === key)!.plan!,
    m = repository.materials().find((m) => m.key === "manual:spec")!;
  return repository.publish({
    version: 1,
    reading: plan,
    publication: { role: "article" },
    document: bindKnowledgeQuotes(
      {
        key,
        title: plan.title,
        summary: "退款查询待实现",
        category: "需求",
        sections: [
          { key: "scope", title: "本期范围", body: "实现退款查询 [[spec]]" },
        ],
        citations: [
          {
            key: "spec",
            label: "需求",
            quote: "",
            reason: "范围",
            relation: "supports",
            target: { kind: "material", key: m.key, startLine: 1, endLine: 1 },
          },
        ],
        questions,
        requirement: {
          objective: "退款查询",
          nonGoals: [],
          criteria: [
            {
              id: "query",
              description: "返回退款状态",
              status: "missing",
              evidence: ["spec"],
            },
          ],
          actions: [
            {
              id: "page",
              title: actionTitle,
              detail: "本期查询页面",
              owner: "我",
              waitingOn: null,
              dueAt: null,
              dueExpression: null,
              status: "open",
              certainty: "confirmed",
              evidence: ["spec"],
            },
          ],
        },
      },
      new Map([[m.key, m]]),
    ),
    dependencies: [{ kind: "material", key: m.key, digest: m.digest }],
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
}

it("separates saved messages from actual understanding and keeps owner corrections in current requirement inputs", () => {
  const s = setup();
  const context = s.store.contexts.create({ name: "退款", kind: "project", description: "退款查询" });
  const capture = (id: string) => s.store.capture({ source: "chat", externalId: `lark-personal:${id}`, title: "讨论", context: { conversationId: "oc_feedback" }, parts: [{ type: "text", text: "建议小李负责页面，尚未确定。" }] }, { learning: false, notify: false, contextIds: [context.id] });
  const first = capture("test-first");
  s.store.db.prepare("INSERT INTO personal_lark_messages(id,chat_id,chat_name,digest,raw,revision_id,observed_at,updated_at) VALUES(?,?,?,'test','{}',?,?,?)").run("test-first", "oc_feedback", "退款讨论", first.revision.id, new Date().toISOString(), new Date().toISOString());
  const key = s.work.apply({ ...s.action, contextIds: [context.id] }, s.actor("跟进退款")).key!;
  publish(s.repository, key);
  const reader = new MessageUnderstanding(s.store, s.work);
  const read = () => reader.read([{ id: "test-first", revision_id: first.revision.id, state: "ready", resources: [] }])[0]!.understanding;
  expect(read()).toMatchObject({ stage: "saved", results: [], requirements: [{ key, cited: false }] });
  const id = randomUUID();
  const saved = s.store.messageFeedback.save("test-first", { requestId: id, text: "这只是提议，还没有决定；负责人不能当成已确定。", scope: "conversation" });
  expect(read().stage).toBe("understanding");
  expect(s.repository.materialsForPlan(s.repository.pages().find(p => p.key === key)!.plan!).some(m => m.revisionId === saved.revisionId)).toBe(true);
  const later = capture("test-later");
  expect(s.store.messageFeedback.forSource(later.revision.sourceId)).toMatchObject([{ text: expect.stringContaining("只是提议") }]);
  expect(s.store.messageFeedback.save("test-first", { requestId: id, text: "这只是提议，还没有决定；负责人不能当成已确定。", scope: "conversation" }).duplicate).toBe(true);
  expect(s.store.tasks()).toHaveLength(0);
  expect(s.store.db.prepare("SELECT count(*) n FROM memories").get()!.n).toBe(0);
  s.store.messageFeedback.revoke(id);
  expect(s.store.messageFeedback.forSource(later.revision.sourceId)).toEqual([]);
  expect(s.repository.materialsForPlan(s.repository.pages().find(p => p.key === key)!.plan!).some(m => m.revisionId === saved.revisionId)).toBe(false);
});

it("applies one natural-language work action with a receipt, persists corrections and attention, and supports revocation while writing", async () => {
  const s = setup();
  const runtime = new AssistantRuntime(
    s.store,
    {
      generate: async () => ({
        answer: "模型自行宣称完成",
        citationIds: [],
        workAction: s.action,
      }),
    },
    { work: s.work },
  );
  const conversation = runtime.conversations.open({
    principalId: "owner",
    channel: "web",
    chatId: "chat",
    visibility: "private",
  });
  const result = await runtime.turn({
    conversationId: conversation.id,
    userText: "帮我跟进退款查询，只关心上线阻塞",
  });
  expect(result.turn.result).toContain("当前已排队");
  expect(result.turn.result).not.toContain("模型自行宣称完成");
  const key = s.work.catalog().requirements[0]!.key;
  expect(s.work.status(key).attention.instruction).toBe(
    "帮我跟进退款查询，只关心上线阻塞",
  );
  const a = s.actor("页面由小王负责，不是我");
  const correction: WorkAction = {
    operation: "feedback",
    key,
    expectedVersion: 1,
    kind: "correction",
    text: a.userText,
  };
  const receipt = s.work.apply(correction, a);
  expect(s.work.apply(correction, a)).toEqual(receipt);
  expect(s.work.status(key).version).toBe(2);
  expect(s.work.status(key).feedback).toHaveLength(1);
  expect(
    s.repository
      .materialsForPlan(s.repository.pages()[0]!.plan!)
      .some((m) => m.text.includes("页面由小王")),
  ).toBe(true);
  const b = s.actor("只关注接口，不关注页面");
  s.work.apply(
    {
      operation: "feedback",
      key,
      expectedVersion: 2,
      kind: "attention",
      text: b.userText,
      attention: {
        focus: ["接口"],
        ignore: ["页面"],
        notifications: "important",
      },
    },
    b,
  );
  expect(s.work.status(key).attention.focus).toEqual(["接口"]);
  s.work.apply(
    {
      operation: "revoke_feedback",
      key,
      expectedVersion: 3,
      feedbackId: a.requestId,
    },
    s.actor("撤回刚才的负责人修正"),
  );
  expect(
    s.repository
      .materialsForPlan(s.repository.pages()[0]!.plan!)
      .some((m) => m.text.includes("页面由小王")),
  ).toBe(false);
  expect(
    s.store.jobs.list().filter((j) => j.kind === "knowledge:maintain-page"),
  ).toHaveLength(1);
  s.work.apply(
    { operation: "pause", key, expectedVersion: 4 },
    s.actor("暂停跟进"),
  );
  expect(s.work.status(key).maintenance?.enabled).toBe(false);
  s.work.apply(
    { operation: "resume", key, expectedVersion: 5 },
    s.actor("继续跟进"),
  );
  expect(s.work.status(key).maintenance?.enabled).toBe(true);
  const project = s.store.contexts.create({
    name: "退款",
    kind: "project",
    description: "退款查询进展",
  });
  s.work.apply(
    {
      operation: "scope",
      key,
      expectedVersion: 6,
      contextIds: [project.id],
      materialKeys: ["manual:spec"],
    },
    s.actor("继续跟进退款项目里后续新增的材料"),
  );
  s.store.capture(
    {
      source: "manual",
      externalId: "later",
      title: "后续会议",
      parts: [{ type: "text", text: "查询接口已完成，等待验收。" }],
      context: {},
    },
    { contextIds: [project.id], learning: false, notify: false },
  );
  expect(
    s.repository
      .materialsForPlan(s.repository.pages()[0]!.plan!)
      .map((m) => m.key),
  ).toContain("manual:later");
  expect(s.work.status(key).attention.instruction).toBe(b.userText);
  runtime.shutdown();
});

it("does not mutate in research/group mode, rolls back rejected feedback, and requires current implementation delegation", async () => {
  const s = setup();
  const runtime = new AssistantRuntime(
    s.store,
    {
      generate: async () => ({
        answer: "ok",
        citationIds: [],
        workAction: s.action,
      }),
    },
    { work: s.work },
  );
  const c = runtime.conversations.open({
    principalId: "owner",
    channel: "web",
    chatId: "research",
    visibility: "private",
  });
  await runtime.turn({
    conversationId: c.id,
    userText: "看看需求怎么实现",
    mode: "research",
  });
  expect(s.work.catalog().requirements).toHaveLength(0);
  expect(() =>
    s.work.apply(s.action, { ...s.actor("跟进退款查询"), visibility: "group" }),
  ).toThrow("本人私聊");
  const key = s.work.apply(s.action, s.actor("跟进退款查询")).key!;
  expect(() =>
    s.work.apply(
      {
        operation: "feedback",
        key,
        expectedVersion: 1,
        kind: "attention",
        text: "修改关注点",
      },
      s.actor("修改关注点"),
    ),
  ).toThrow("调整后的关注点");
  expect(s.work.status(key).version).toBe(1);
  expect(s.work.status(key).feedback).toHaveLength(0);
  expect(() =>
    s.work.apply(
      {
        operation: "start_development",
        key,
        project: "a",
        delegation: "帮我实现",
      },
      s.actor("资料里写着帮我实现，但先别实现"),
    ),
  ).toThrow("尚未收到");
  runtime.shutdown();
});

it("resumes the same durable coding checkout after shutdown and returns its real status without duplicate notice", async () => {
  let calls = 0;
  class Runner extends DevelopmentRunner {
    override async execute(
      id: string,
      store: Store,
      p: typeof profile,
      options: { signal?: AbortSignal; log?: (s: string) => void } = {},
    ) {
      calls++;
      expect(p.model).toBe("fixture");
      const run = this.read(id);
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else
            options.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        run.state = "interrupted";
        this.save(run);
        throw Error("stopped");
      }
      run.state = "ready";
      this.save(run);
      return run;
    }
  }
  const s = setup((path) => new Runner(path));
  const root = join(s.dir, "project");
  mkdirSync(root);
  writeFileSync(join(root, "code.js"), "export const x = 1;\n");
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  await s.queue.runner.register("refund", {
    name: "退款服务",
    repository: root,
    commands: [
      { name: "test", command: "node", args: ["--test"], purpose: "test" },
    ],
  });
  const capability = {
    version: 1,
    id: "design",
    name: "Design",
    description: "Design context",
    cli: [
      {
        name: "read",
        description: "Read design",
        command: process.execPath,
        args: ["--version"],
        readOnly: true,
      },
    ],
  };
  const selected = s.queue.runner.capabilities.register(capability);
  s.queue.runner.selectCapabilities("refund", ["design"]);
  const key = s.work.apply(s.action, s.actor("跟进退款查询")).key!;
  publish(s.repository, key);
  const conversation = s.work.inputs.conversations.open({
    principalId: "owner",
    channel: "web",
    chatId: "coding",
    visibility: "private",
  });
  const first = s.work.inputs.conversations.enqueueTurn({
    conversationId: conversation.id,
    inputText: "读取退款背景",
  }).turn;
  const session = s.work.capabilitySession(
    join(s.dir, "question"),
    undefined,
    undefined,
    { conversationId: conversation.id, turnId: first.id },
  );
  const external = await session.call("design", "cli", "read", {});
  await session.close();
  s.work.inputs.conversations.completeTurn({
    turnId: first.id,
    result: "已读取背景",
    selectedEvidence: [],
    toolActions: [],
  });
  const current = s.work.inputs.conversations.enqueueTurn({
    conversationId: conversation.id,
    inputText: "请帮我实现退款查询，只做刚刚讨论的入口",
  }).turn;
  const a = {
    ...s.actor(current.inputText),
    conversationId: conversation.id,
    requestId: current.id,
  };
  const action: WorkAction = {
    operation: "start_development",
    key,
    project: "refund",
    delegation: a.userText,
  };
  const taskId = s.work.apply(action, a).taskId!;
  rmSync(join(s.dir, "question"), { recursive: true });
  expect(s.queue.read(taskId).job.inputRefs[0]).toMatchObject({
    profiles: { coding: { model: "fixture" }, review: { model: "fixture" } },
    handoff: {
      assignment: { text: a.userText },
      inputs: [{ recordId: external.recordId }],
    },
  });
  s.queue.runner.capabilities.register({
    ...capability,
    description: "Updated catalog",
  });
  expect(s.work.apply(action, s.actor(a.userText)).taskId).toBe(taskId);
  const processing = s.queue.processOne();
  while (!calls) await new Promise((r) => setTimeout(r, 10));
  await s.queue.stop();
  await processing;
  const stopped = s.queue.read(taskId);
  expect(stopped.job.state).toBe("retry_wait");
  expect(stopped.runId).toBe(taskId);
  expect(stopped.run?.capabilities).toEqual([
    { id: "design", revision: selected.revision },
  ]);
  s.store.db
    .prepare("UPDATE jobs SET not_before=? WHERE id=?")
    .run("2000-01-01T00:00:00Z", stopped.job.id);
  const restored = new DevelopmentQueue(
    s.store,
    s.pages,
    { ...profile, model: "changed-after-enqueue" },
    {
      runner: new Runner(s.store.dataDir),
    },
  );
  await restored.processOne();
  const ready = restored.read(taskId);
  expect(ready.runId).toBe(stopped.runId);
  expect(ready.run?.state).toBe("ready");
  expect(ready.job.state).toBe("succeeded");
  const run = ready.run!;
  expect(run.handoff?.assignment.text).toBe(a.userText);
  expect(run.handoff?.discussion[0]?.userText).toBe("读取退款背景");
  expect(
    JSON.parse(
      readFileSync(
        join(run.directory, "external-inputs", external.recordId + ".json"),
        "utf8",
      ),
    ).result.exitCode,
  ).toBe(0);
  writeFileSync(join(run.checkout, "code.js"), "export const x = 2;\n");
  writeFileSync(
    join(run.directory, "changes.patch"),
    await git(run.checkout, "diff", run.base),
  );
  run.reviewedFingerprint = await fingerprint(run.checkout);
  restored.runner.save(run);
  const result = await s.work.result(taskId);
  expect(result.delivery).toMatchObject({
    location: "isolated_checkout",
    sourceRepository: realpathSync(root),
    applied: false,
  });
  expect(result.matchesReviewed).toBe(true);
  expect(result.diff?.text).toContain("+export const x = 2;");
  writeFileSync(join(run.checkout, "code.js"), "export const x = 3;\n");
  expect((await s.work.result(taskId)).matchesReviewed).toBe(false);
  expect(await git(root, "status", "--porcelain")).toBe("");
  const notices = () =>
    s.store.db
      .prepare("SELECT count(*) n FROM changes WHERE kind='development'")
      .get()!.n;
  expect(notices()).toBe(1);
  expect(result.outcome?.learningJob?.kind).toBe("extract_claims");
  expect(result.outcome?.citedByRequirement).toBe(false);
  expect(
    s.repository
      .materialsForPlan(s.repository.pages().find((p) => p.key === key)!.plan!)
      .some((m) => m.key === result.outcome?.materialKey),
  ).toBe(true);
  await restored.processOne();
  expect(notices()).toBe(1);
  await restored.stop();
});

it("follows a requirement action into one personal todo, syncs a new revision and stops syncing without deleting it", () => {
  const s = setup();
  const key = s.work.apply(s.action, s.actor("跟进退款查询")).key!;
  const article = publish(s.repository, key);
  const actor = s.actor("将实现退款页面加入我的待办"),
    action: WorkAction = {
      operation: "follow_action",
      key,
      actionId: "page",
      expectedRevision: article.revision,
      delegation: actor.userText,
    };
  const receipt = s.work.apply(action, actor);
  expect(s.work.apply(action, actor)).toEqual(receipt);
  const id = receipt.personalTaskId!;
  expect(s.store.tasks().find((t) => t.id === id)?.title).toBe(
    "跟进：实现退款页面",
  );
  const next = publish(s.repository, key, "实现退款状态页面");
  s.work.actions.sync(next);
  expect(s.store.tasks().find((t) => t.id === id)?.title).toBe(
    "跟进：实现退款状态页面",
  );
  expect(s.work.status(key).actionLinks).toHaveLength(1);
  s.work.apply(
    {
      operation: "unfollow_action",
      key,
      actionId: "page",
      expectedRevision: next.revision,
      delegation: "停止同步这个行动",
    },
    s.actor("停止同步这个行动"),
  );
  s.work.actions.sync(publish(s.repository, key, "下一次变更"));
  expect(s.store.tasks().find((t) => t.id === id)?.title).toBe(
    "跟进：实现退款状态页面",
  );
  expect(s.work.status(key).actionLinks[0]?.enabled).toBe(0);
});

it("continues the same blocked task and queues an exact reviewed patch for guarded application", async () => {
  let calls = 0;
  class Runner extends DevelopmentRunner {
    override async execute(id: string) {
      const run = this.read(id);
      if (++calls === 1) {
        run.state = "blocked";
        run.error = "检查环境未就绪";
      } else {
        writeFileSync(
          join(run.checkout, "value.js"),
          "export const value = 2;\n",
        );
        run.head = await snapshotCommit(run.checkout, "implementation");
        run.reviewedFingerprint = await fingerprint(run.checkout);
        run.state = "ready";
        delete run.error;
      }
      this.save(run);
      return run;
    }
  }
  const s = setup((path) => new Runner(path));
  const root = join(s.dir, "project");
  mkdirSync(root);
  writeFileSync(join(root, "value.js"), "export const value = 1;\n");
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  await s.queue.runner.register("refund", {
    name: "退款",
    repository: root,
    commands: [],
  });
  const key = s.work.apply(s.action, s.actor("跟进退款查询")).key!;
  publish(s.repository, key);
  const id = s.work.apply(
    {
      operation: "start_development",
      key,
      project: "refund",
      delegation: "请帮我实现退款查询",
    },
    s.actor("请帮我实现退款查询"),
  ).taskId!;
  await s.queue.processOne();
  const blocked = s.queue.read(id);
  expect(blocked.run?.state).toBe("blocked");
  const resume: WorkAction = {
    operation: "resume_development",
    taskId: id,
    delegation: "环境已修好，继续该任务",
  };
  const actor = s.actor(resume.delegation);
  const queued = s.work.apply(resume, actor);
  expect(s.work.apply(resume, actor)).toEqual(queued);
  expect(s.queue.read(id).job.id).not.toBe(blocked.job.id);
  await s.queue.processOne();
  const ready = s.queue.read(id);
  expect(ready.runId).toBe(blocked.runId);
  expect(ready.run?.checkout).toBe(blocked.run?.checkout);
  expect((ready.job.inputRefs[0] as any).continuation.userText).toBe(
    actor.userText,
  );
  const result = await s.work.result(id);
  expect(result.matchesReviewed).toBe(true);
  const apply: WorkAction = {
    operation: "apply_development",
    taskId: id,
    reviewedFingerprint: ready.run!.reviewedFingerprint!,
    delegation: "请应用这份补丁",
  };
  expect(() => s.work.apply(apply, s.actor("不要应用这份补丁"))).toThrow();
  expect(() =>
    s.work.apply(
      { ...apply, reviewedFingerprint: "old" },
      s.actor(apply.delegation),
    ),
  ).toThrow("当前评审结果");
  writeFileSync(join(root, "value.js"), "用户尚未提交的修改\n");
  s.work.apply(apply, s.actor(apply.delegation));
  await s.queue.processOne();
  expect(s.queue.read(id).job.state).toBe("failed");
  expect(readFileSync(join(root, "value.js"), "utf8")).toContain(
    "用户尚未提交",
  );
  writeFileSync(join(root, "value.js"), "export const value = 1;\n");
  const request = s.actor(apply.delegation);
  const receipt = s.work.apply(apply, request);
  expect(receipt.message).toContain("尚未应用");
  expect(s.work.apply(apply, request)).toEqual(receipt);
  await s.queue.processOne();
  expect(s.queue.read(id).run?.state).toBe("applied");
  expect(readFileSync(join(root, "value.js"), "utf8")).toContain("value = 2");
  expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(ready.run!.base);
  expect(s.queue.list()).toHaveLength(1);
});

it("reads project guidance, configures checks during delegation, and freezes queued configuration", async () => {
  class Runner extends DevelopmentRunner {
    override async execute(id: string) {
      const run = this.read(id);
      run.state = "ready";
      this.save(run);
      return run;
    }
  }
  const s = setup((path) => new Runner(path)),
    root = join(s.dir, "project");
  mkdirSync(root);
  writeFileSync(
    join(root, "AGENTS.md"),
    "Use the registered checks. Do not publish.\n",
  );
  writeFileSync(
    join(root, "README.md"),
    "Verify locally with node --check code.mjs.\n",
  );
  writeFileSync(join(root, "code.mjs"), "export const answer = 1;\n");
  await git(root, "init", "-q");
  await snapshotCommit(root, "initial");
  await s.queue.runner.register("project", {
    name: "Project",
    repository: root,
    instructions: "Keep owner constraint",
  });
  const service = s.queue.runner.configuration;
  const inspection = await service.inspect("project");
  expect(inspection.hasVerificationCommands).toBe(false);
  const doc = await service.read("project", "README.md");
  const configuration = {
    expectedVersion: inspection.configurationVersion,
    instructions: "Keep owner constraint",
    ruleFiles: [],
    commands: [
      {
        name: "syntax",
        command: process.execPath,
        args: ["--check", "code.mjs"],
        cwd: ".",
        purpose: "test" as const,
        required: true,
        timeoutMs: 10000,
      },
    ],
    sources: [{ path: doc.path, hash: doc.hash }],
    summary: "检查模块语法",
    gaps: ["尚无业务行为测试"],
  };
  const key = s.work.apply(s.action, s.actor("跟进退款查询")).key!;
  publish(s.repository, key);
  const assignment = s.actor("请直接实现退款查询，按项目说明配置检查");
  const receipt = s.work.apply(
    {
      operation: "start_development",
      key,
      project: "project",
      configuration,
      delegation: assignment.userText,
    },
    assignment,
  );
  expect(receipt.taskId).toBeTruthy();
  expect(service.get("project").configuration?.gaps).toEqual([
    "尚无业务行为测试",
  ]);
  expect(() => service.configure("project", configuration)).toThrow(
    "配置已变化",
  );
  const current = await service.inspect("project");
  const update = {
    ...configuration,
    expectedVersion: current.configurationVersion,
    commands: [{ ...configuration.commands[0]!, name: "new-check" }],
  };
  const actor = s.actor("调整项目检查配置");
  s.work.apply(
    {
      operation: "configure_project",
      project: "project",
      configuration: update,
      delegation: actor.userText,
    },
    actor,
  );
  await s.queue.processOne();
  const run = s.queue.read(receipt.taskId!).run!;
  expect(run.project.commands[0]?.name).toBe("syntax");
  expect(service.get("project").commands[0]?.name).toBe("new-check");
  writeFileSync(join(root, "README.md"), "Changed instructions\n");
  const next = await service.inspect("project");
  expect(next.configurationStale).toBe(true);
  expect(() =>
    service.configure("project", {
      ...update,
      expectedVersion: next.configurationVersion,
    }),
  ).toThrow("文件已变化");
});

it("automatically continues only an existing watched task and ignores progress-only refreshes and cancellation", async () => {
  let executions = 0;
  class Runner extends DevelopmentRunner {
    override async execute(id: string) {
      executions++;
      const run = this.read(id);
      const update = inspectRequirementChange(s.repository, run);
      if (update) {
        run.requirementRevision = update.article.revision;
        run.requirementBasis = update.basis;
      }
      writeFileSync(
        join(run.checkout, "value.js"),
        `export const value=${executions + 1};\n`,
      );
      run.head = await snapshotCommit(run.checkout, "implementation");
      run.state = "ready";
      run.reviewedFingerprint = await fingerprint(run.checkout);
      this.save(run);
      return run;
    }
  }
  const s = setup((path) => new Runner(path)),
    root = join(s.dir, "project");
  mkdirSync(root);
  writeFileSync(join(root, "value.js"), "export const value=1;\n");
  await git(root, "init", "-q");
  await snapshotCommit(root, "base");
  await s.queue.runner.register("refund", {
    name: "Refund",
    repository: root,
    commands: [],
  });
  const key = s.work.apply(s.action, s.actor("跟进退款查询")).key!;
  publish(s.repository, key);
  const id = s.work.apply(
    {
      operation: "start_development",
      key,
      project: "refund",
      delegation: "请帮我实现退款查询",
    },
    s.actor("请帮我实现退款查询"),
  ).taskId!;
  await s.queue.processOne();
  const first = s.queue.read(id);
  const progress = structuredClone(
    s.repository.get(key, first.run!.requirementRevision)!,
  );
  progress.document.requirement!.criteria[0]!.status = "verified";
  s.repository.publish(progress);
  await s.queue.processOne();
  expect(executions).toBe(1);
  const changed = structuredClone(progress);
  changed.document.requirement!.criteria[0]!.description = "返回退款状态和原因";
  s.repository.publish(changed);
  await s.queue.processOne();
  const continued = s.queue.read(id);
  expect(executions).toBe(2);
  expect(continued.runId).toBe(first.runId);
  expect(continued.run?.checkout).toBe(first.run?.checkout);
  expect(s.queue.list()).toHaveLength(1);
  const again = structuredClone(changed);
  again.document.requirement!.criteria[0]!.description =
    "返回退款状态、原因和时间";
  s.repository.publish(again);
  // Pause the requirement before the worker notices its new definition.
  s.pages.maintenance.setEnabled(key, false);
  await s.queue.processOne();
  expect(executions).toBe(2);
  s.pages.maintenance.setEnabled(key, true);
  s.queue.continueTask(id, s.actor("继续"));
  s.queue.cancel(id, randomUUID());
  await s.queue.processOne();
  expect(executions).toBe(2);
});


it("freezes actual tasks for all page phases without self-triggering another revision", () => {
  const s = setup();
  const key = s.work.apply(s.action, s.actor("跟进退款")).key!;
  const article = publish(s.repository, key);
  s.work.actions.follow(key, "page", article.revision);
  const plan = s.repository.pages().find(p => p.key === key)!.plan!;
  const beforeState = requirementBasis(s.repository, article);
  s.work.preparePage(plan);
  const state = s.repository.materialsForPlan(plan).find(m => m.key.startsWith("hook:followup-state:"))!;
  expect(state.text).toContain("跟进：实现退款页面");
  expect(state.text).toContain(String(s.store.tasks()[0]!.id));
  s.work.preparePage(plan);
  expect(s.repository.materialsForPlan(plan).find(m => m.key === state.key)!.revisionId).toBe(state.revisionId);
  s.store.db.prepare("UPDATE tasks SET status='done',version=version+1 WHERE id=?").run(String(s.store.tasks()[0]!.id));
  s.work.preparePage(plan);
  const changed = s.repository.materialsForPlan(plan).find(m => m.key === state.key)!;
  expect(changed.revisionId).not.toBe(state.revisionId);
  expect(changed.text).toContain('"status": "done"');
  expect(s.store.revision(state.revisionId)!.fragments.map(f => f.text).join("\n")).toContain('"status": "open"');
  expect(s.store.jobs.list().filter(j => j.kind === "extract_claims" && j.inputRefs.some((r: any) => r.sourceId === state.sourceId))).toHaveLength(0);
  // The coding acceptance basis must survive both attaching and revising this
  // host snapshot, otherwise a successful review invalidates its own result.
  expect(requirementBasis(s.repository, article)).toEqual(beforeState);
});

it("answers an actual decision from owner chat without widening the selected project", () => {
  const s = setup();
  const group = s.store.contexts.create({name:"退款", kind:"project", description:"退款查询"});
  const key = s.work.apply({...s.action, contextIds:[group.id]}, s.actor("跟进退款")).key!;
  publish(s.repository, key, "实现退款页面", [
    {kind:"investigate", question:"个人事项是否已创建？", why:"核对实际状态", nextStep:"助手查询", blocking:true, citationKeys:["spec"]},
    {kind:"supplement", question:"非法输入如何处理？", why:"可并行完善", nextStep:"补接口说明", blocking:false, citationKeys:["spec"]},
    {kind:"decision", question:"本期是否包含批量退款？", why:"影响本期范围", nextStep:"选择本期或后续", blocking:true, citationKeys:["spec"]},
  ]);
  const questions = s.work.status(key).questions;
  expect(questions.filter(q => q.blocking).map(q => q.question)).toEqual(["本期是否包含批量退款？"]);
  const q = questions.find(q => q.kind === "decision")!;
  s.work.apply({operation:"answer_question", questionId:q.id, answer:"批量退款放到下期"}, s.actor("批量退款放到下期"));
  expect(s.work.status(key).questions.some(x => x.id === q.id)).toBe(false);
  const plan = s.repository.pages().find(p => p.key === key)!.plan!;
  expect(plan.contextIds).toEqual([group.id]);
  expect(plan.materialKeys).toHaveLength(2);
  const answer = s.repository.materialsForPlan(plan).find(m => m.key.startsWith("manual:knowledge-answer:"))!;
  expect(answer.text).toContain("批量退款放到下期");
  expect(answer.actorId).toBe("owner");
});
