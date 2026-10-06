import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { git, fingerprint } from "../src/development/workspace.js";
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
function publish(repository: KnowledgeRepository, key: string) {
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
        questions: [],
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
          actions: [],
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
  const key = s.work.apply(s.action, s.actor("跟进退款查询")).key!;
  publish(s.repository, key);
  const a = s.actor("请帮我实现退款查询");
  const action: WorkAction = {
    operation: "start_development",
    key,
    project: "refund",
    delegation: a.userText,
  };
  const taskId = s.work.apply(action, a).taskId!;
  expect(s.work.apply(action, s.actor(a.userText)).taskId).toBe(taskId);
  const processing = s.queue.processOne();
  while (!calls) await new Promise((r) => setTimeout(r, 10));
  await s.queue.stop();
  await processing;
  const stopped = s.queue.read(taskId);
  expect(stopped.job.state).toBe("retry_wait");
  expect(stopped.runId).toBe(taskId);
  s.store.db
    .prepare("UPDATE jobs SET not_before=? WHERE id=?")
    .run("2000-01-01T00:00:00Z", stopped.job.id);
  const restored = new DevelopmentQueue(s.store, s.pages, profile, {
    runner: new Runner(s.store.dataDir),
  });
  await restored.processOne();
  const ready = restored.read(taskId);
  expect(ready.runId).toBe(stopped.runId);
  expect(ready.run?.state).toBe("ready");
  expect(ready.job.state).toBe("succeeded");
  const run = ready.run!;
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
  await restored.processOne();
  expect(notices()).toBe(1);
  await restored.stop();
});
