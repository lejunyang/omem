import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { KnowledgePageWorker } from "../src/knowledge/page-worker.js";
import { KnowledgePageService } from "../src/knowledge/page-service.js";
import { KnowledgeOutlineService } from "../src/knowledge/outlines.js";
import type {
  KnowledgeOutlineInput,
  KnowledgeOutlineProposal,
} from "../../../packages/contracts/src/knowledge-outline.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const input: KnowledgeOutlineInput = {
  title: "参加工作坊",
  reader: "新参加者",
  goal: "准备费用和集合安排",
  topicPath: ["活动"],
  materialKeys: ["manual:workshop"],
  contextIds: [],
  pages: [
    {
      id: "fees",
      existingKey: null,
      title: "准备参加",
      kind: "how-to",
      reader: "新参加者",
      goal: "知道要带多少钱",
      scenario: "报名一个工作坊",
      questions: ["费用包括什么？"],
      entryPaths: [],
      topicPath: ["活动", "工作坊"],
      materialKeys: ["manual:workshop"],
      contextIds: [],
    },
  ],
};
const proposal: KnowledgeOutlineProposal = {
  schema_version: 1,
  rationale: "从准备费用开始。",
  gaps: [],
  pages: input.pages.map(({ id: _id, ...p }) => p),
};
function setup(
  run?: NonNullable<
    ConstructorParameters<typeof KnowledgeOutlineService>[2]
  >["run"],
  available = true,
) {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-outlines-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  cleanup.push(() => store.close());
  store.capture(
    {
      source: "manual",
      externalId: "workshop",
      title: "活动安排",
      parts: [
        { type: "text", text: "费用八十元，包含材料。周六在图书馆集合。" },
      ],
      context: {},
    },
    { learning: false, notify: false },
  );
  const repository = new KnowledgeRepository(store),
    worker = new KnowledgePageWorker(repository);
  cleanup.push(() => worker.stop());
  const pages = new KnowledgePageService(repository, worker, available),
    outlines = new KnowledgeOutlineService(repository, pages, { run });
  cleanup.push(() => outlines.stop());
  return { store, repository, worker, pages, outlines };
}

it("saves an unfinished outline without Agent or generation and rejects stale reader edits after reopening", () => {
  const { store, repository, pages, outlines } = setup(undefined, false);
  const created = outlines.create({
    ...input,
    title: "",
    reader: "",
    goal: "",
    materialKeys: [],
    pages: [],
  });
  const edited = outlines.save(created.id, created.version, {
    ...input,
    pages: [
      { ...input.pages[0], title: "", reader: "", goal: "", questions: [] },
    ],
  });
  const reopened = new KnowledgeOutlineService(
    new KnowledgeRepository(store),
    pages,
  );
  expect(reopened.get(created.id)).toMatchObject({
    version: 2,
    state: "editing",
    pages: [{ title: "", questions: [] }],
  });
  expect(() => reopened.save(created.id, 1, input)).toThrow("其他窗口");
  expect(repository.pages()).toEqual([]);
  expect(store.jobs.list()).toEqual([]);
  expect(() => reopened.propose(created.id, edited.version)).toThrow(
    "配置 Agent",
  );
});

it("resumes a queued directory proposal without writing pages and keeps a manual edit over a late model candidate", async () => {
  const first = setup(async () => proposal);
  const created = first.outlines.create(input),
    requested = first.outlines.propose(created.id, created.version);
  expect(requested.state).toBe("planning");
  await first.outlines.stop();
  const resumed = new KnowledgeOutlineService(first.repository, first.pages, {
    run: async () => proposal,
  });
  cleanup.push(() => resumed.stop());
  await resumed.processOne();
  expect(resumed.get(created.id)).toMatchObject({
    state: "ready",
    version: requested.version + 1,
    rationale: proposal.rationale,
  });
  expect(first.repository.pages()).toEqual([]);
  expect(
    first.store.jobs.list().filter((j) => j.kind === "knowledge:maintain-page"),
  ).toEqual([]);
  let finish!: (value: KnowledgeOutlineProposal) => void;
  const race = setup(
    async () =>
      new Promise<KnowledgeOutlineProposal>((resolve) => {
        finish = resolve;
      }),
  );
  const before = race.outlines.create(input),
    running = race.outlines.propose(before.id, before.version);
  const processing = race.outlines.processOne();
  await Promise.resolve();
  const manual = race.outlines.save(before.id, running.version, {
    ...input,
    goal: "保留本人改的阅读目的",
  });
  finish(proposal);
  await processing;
  expect(race.outlines.get(before.id)).toMatchObject({
    state: "editing",
    goal: manual.goal,
    jobId: null,
    version: manual.version,
  });
});

it("applies all confirmed page plans atomically, allocates page identities once and retains failed proposal drafts", async () => {
  const f = setup(async () => {
    throw Error("Agent 暂时不可用");
  });
  const draft = f.outlines.create(input),
    requested = f.outlines.propose(draft.id, draft.version);
  await f.outlines.processOne();
  const failed = f.outlines.get(draft.id)!;
  expect(failed).toMatchObject({
    state: "failed",
    pages: input.pages,
    error: "Agent 暂时不可用",
  });
  expect(failed.version).toBe(requested.version + 1);
  const invalid = f.outlines.save(draft.id, failed.version, {
    ...input,
    pages: [
      ...input.pages,
      { ...input.pages[0]!, id: "empty", title: "没有目的", goal: "" },
    ],
  });
  expect(() => f.outlines.apply(draft.id, invalid.version)).toThrow("补全");
  expect(f.repository.pages()).toEqual([]);
  expect(
    f.store.jobs.list().filter((j) => j.kind === "knowledge:maintain-page"),
  ).toEqual([]);
  const saved = f.outlines.save(draft.id, invalid.version, input);
  const applied = f.outlines.apply(draft.id, saved.version);
  expect(applied.state).toBe("applied");
  expect(applied.appliedPages).toHaveLength(1);
  expect(applied.appliedPages[0]!.key).toMatch(/^page:/);
  expect(f.repository.pages()[0]!.plan).toMatchObject({
    title: "准备参加",
    order: 0,
    topicPath: ["活动", "工作坊"],
    materialKeys: ["manual:workshop"],
  });
  expect(applied.pageStatuses[0]).toMatchObject({ state: "queued" });
  expect(f.outlines.apply(draft.id, saved.version).appliedPages).toEqual(
    applied.appliedPages,
  );
  expect(
    f.store.jobs.list().filter((j) => j.kind === "knowledge:maintain-page"),
  ).toHaveLength(1);
  f.outlines.delete(draft.id, applied.version);
  expect(f.repository.pages()).toHaveLength(1);
});

it("keeps proposed scopes inside the reader selection and rejects a busy existing page without touching its plan", () => {
  const f = setup();
  f.store.capture(
    {
      source: "manual",
      externalId: "other",
      title: "无关材料",
      parts: [{ type: "text", text: "另一项活动" }],
      context: {},
    },
    { learning: false, notify: false },
  );
  expect(() =>
    f.outlines.create({
      ...input,
      pages: [{ ...input.pages[0]!, materialKeys: ["manual:other"] }],
    }),
  ).toThrow("范围");
  const { id: _id, existingKey: _existing, ...page } = input.pages[0]!;
  const oldPlan = { ...page, key: "existing", order: 5, contextIds: undefined };
  f.repository.savePlan(oldPlan, true);
  f.worker.request(oldPlan.key);
  const draft = f.outlines.create({
    ...input,
    pages: [{ ...input.pages[0]!, existingKey: "existing", title: "新标题" }],
  });
  expect(() => f.outlines.apply(draft.id, draft.version)).toThrow("正在整理");
  expect(f.repository.pages()[0]!.plan).toEqual(oldPlan);
  expect(
    f.store.jobs.list().filter((j) => j.kind === "knowledge:maintain-page"),
  ).toHaveLength(1);
});
