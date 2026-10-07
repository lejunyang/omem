import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { KnowledgeRepository, bindKnowledgeQuotes } from "../src/knowledge/repository.js";
import { KnowledgePipeline, analystFor } from "../src/knowledge/pipeline.js";
import { RoleBundleRegistry } from "../src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../src/agent-runtime/gateway.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import type { KnowledgeResearch } from "../../../packages/contracts/src/knowledge.js";
import type { KnowledgeOutlineDraft } from "../../../packages/contracts/src/knowledge-outline.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function setup(reject = false, changeDuringRun = false) {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-pipeline-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "db")); cleanups.push(() => store.close());
  const capture = (text: string) => store.capture({ source: "manual", externalId: "example", title: "User note", parts: [{ type: "text", text }], context: {} });
  const captured = capture("The release uses fixed evidence.");
  const repository = new KnowledgeRepository(store), registry = new RoleBundleRegistry(), gateway = new RoleRuntimeGateway(registry, join(dir, "agents"));
  let count = 0;
  let composition: KnowledgeResearch["composition"];
  const run = vi.spyOn(gateway, "run").mockImplementation(async input => {
    count++;
    if (changeDuringRun && count === 1) capture("The release has changed.");
    const key = String((input.context.task!.targetKeys as string[] | undefined)?.[0] ?? (input.context.task!.page as {key:string}).key);
    const sourceKey = !key.startsWith("manual:") ? String((input.context.task!.allowedMaterials as {key:string}[])[0]!.key) : key;
    const sourceLine = 1;
    let result: unknown = input.roleId === "knowledge-researcher" ? {schema_version:1,ready:true,findings:"Read the original",gaps:[],requests:[],composition} : input.roleId === "knowledge-verifier" ? { schema_version: 1, verdicts: [{ documentKey: key, verdict: reject ? "needs_revision" : "accepted", issues: reject ? ["The interpretation is unsupported"] : [], questions: [] }] } : {
      schema_version: 1, documents: [{ key, title: "Evidence behavior", summary: "A derived explanation", category: "background", sections: [{ key: "behavior", title: "Behavior", body: reject ? "An unsupported extrapolation.[[c1]]" : key.startsWith("module:") ? "Additional context is documented.[[c1]]" : "The release preserves evidence.[[c1]]" }], citations: [{ key: "c1", label: "Original statement", reason: "The original states this constraint.", relation: "supports", target: { kind: "material", key: sourceKey, startLine: sourceLine, endLine: sourceLine }, quote: "" }], questions: [] }],
    };
    const normalized = input.validateOutput?.(result); if (normalized !== undefined) result = normalized;
    const bundle = registry.load(input.roleId);
    return { result, bundle, trace: { runId: `fixture-${count}`, roleId: input.roleId, roleVersion: "1", bundleHash: bundle.bundleHash, promptHash: "p", contextHash: "c", skillHash: "s", toolHash: "t", fingerprint: "f", outputSchema: bundle.manifest.output_schema, effectiveModel: "fixture-model", effectiveEffort: "low", loadedSkills: [], allowedTools: [], sessionIds: [`${input.roleId}-${count}`], usage: {}, repairAttempts: 0 } } as Awaited<ReturnType<RoleRuntimeGateway["run"]>>;
  });
  const profile = profileSchema.parse({ id: "traex", name: "Fixture", command: "unused", transport: "acp" });
  const pipeline = new KnowledgePipeline(repository, gateway, profile, { concurrency: 1, nativeResearch: false });
  return { store, repository, pipeline, run, captured, capture, accept: () => { reject = false; }, reject: () => { reject = true; }, compose: (plan: KnowledgeResearch["composition"]) => { composition = plan; } };
}

it("publishes only after independent review and reuses durable outputs after projection loss", async () => {
  const { store, repository, pipeline, run, captured } = setup();
  expect((await pipeline.analyze(repository.materials())).failures).toEqual([]);
  expect(run).toHaveBeenCalledTimes(2);
  const article = repository.list()[0]!;
  expect(article.document.citations[0]!.quote).toBe("The release uses fixed evidence.");
  expect(article.generation.trace.sessionIds).not.toEqual(article.review.trace.sessionIds);
  expect(store.jobs.get(captured.job!.id)!.state).toBe("queued");
  store.db.exec("DELETE FROM knowledge_heads");
  expect((await pipeline.analyze(repository.materials())).failures).toEqual([]);
  expect(run).toHaveBeenCalledTimes(2);
  expect(repository.list()[0]!.revision).toBe(article.revision);
});

it("does not promote rejected knowledge or a result whose source changed during analysis", async () => {
  const rejected = setup(true);
  expect((await rejected.pipeline.analyze(rejected.repository.materials())).failures).toHaveLength(1);
  expect(rejected.repository.list()).toEqual([]);
  const stale = setup(false, true);
  expect((await stale.pipeline.analyze(stale.repository.materials())).failures[0]!.error).toContain("KNOWLEDGE_INPUT_CHANGED");
  expect(stale.repository.list()).toEqual([]);
});

it("resumes a semantic rejection with its exact prior draft and reviewer feedback", async () => {
  const { repository, pipeline, run, accept } = setup(true);
  expect((await pipeline.analyze(repository.materials())).failures).toHaveLength(1);
  const before = run.mock.calls.length;
  accept();
  expect((await pipeline.analyze(repository.materials())).failures).toEqual([]);
  expect(run.mock.calls[before]![0].roleId).toBe("knowledge-refresher");
  expect(run.mock.calls[before]![0].context.task).toHaveProperty("revisionRequest.previousDrafts");
  expect(repository.list()).toHaveLength(1);
});

it("distinguishes Lark documents from conversations and recognizes ordinary imported code", () => {
  const { repository } = setup(); const base = repository.materials()[0]!;
  expect(analystFor({ ...base, namespace: "lark", path: null })).toBe("material-analyst");
  expect(analystFor({ ...base, namespace: "lark", path: null, conversationId: "chat-1" })).toBe("conversation-analyst");
  expect(analystFor({ ...base, namespace: "git", path: null, title: "src/main.ts" })).toBe("code-analyst");
  expect(analystFor({ ...base, namespace: "file", path: null, title: "main.py" })).toBe("code-analyst");
});

it("gives the directory planner an explicit inventory of dynamic project materials without exposing unselected originals", async () => {
  const f = setup();
  f.pipeline.options.nativeResearch = true;
  const project = f.store.contexts.create({ name: "排班工具", kind: "project", description: "安排参与者" });
  for (const [externalId, title, filePath, text] of [
    ["planning-note", "排班规则", "notes/rules.md", "阅读安排实现和配置后选择参加方式。"],
    ["participant-picker", "参与者选择实现", "lib/pick.ts", "export function pickParticipant(names: string[]) {\n  return names[0];\n}"],
  ]) f.store.capture({ source: "file", externalId, title: title!, parts: [{ type: "text", text: text! }], context: { filePath } }, { contextIds: [project.id], learning: false, notify: false });
  const selected = f.repository.materials().filter(m => f.store.contexts.forSource(m.sourceId).includes(project.id));
  const draft: KnowledgeOutlineDraft = { id: "saved-outline", version: 2, title: "如何排班", reader: "新参与者", goal: "理解参加方式和选择规则", topicPath: ["活动"], materialKeys: [], contextIds: [project.id], pages: [],
    state: "planning", rationale: "", gaps: [], error: null, jobId: "outline-job", appliedPages: [], createdAt: "2026-10-07", updatedAt: "2026-10-07" };
  f.run.mockImplementation(async input => {
    expect(input.roleId).toBe("knowledge-outliner");
    expect(input.context.task!.selectedMaterials).toEqual(selected.map(m => ({ key: m.key, title: m.title, path: m.path, lineCount: m.lineCount, source: m.namespace })));
    expect(JSON.stringify(input.context)).not.toContain("The release uses fixed evidence.");
    expect(typeof input.research).toBe("function");
    const bundle = f.pipeline.registry.load(input.roleId);
    const result = { schema_version: 1, rationale: "先认识安排规则，再看选择过程。", gaps: [], pages: [{ title: "参加方式", kind: "explanation", reader: draft.reader, goal: draft.goal, scenario: "参加一次活动", questions: ["怎么选择参与者？"], entryPaths: [], topicPath: draft.topicPath, materialKeys: selected.map(m => m.key), contextIds: [], existingKey: null }] };
    input.validateOutput?.(result);
    return { result, bundle, trace: { runId: "fixture-outline", roleId: input.roleId, roleVersion: "1", bundleHash: bundle.bundleHash, promptHash: "p", contextHash: "c", skillHash: "s", toolHash: "t", fingerprint: "f", outputSchema: bundle.manifest.output_schema, effectiveModel: "fixture", effectiveEffort: null, loadedSkills: [], allowedTools: [], sessionIds: ["fixture-outline"], usage: {}, repairAttempts: 0 } } as Awaited<ReturnType<RoleRuntimeGateway["run"]>>;
  });
  const result = await f.pipeline.proposeOutline(draft);
  expect(result.pages[0]!.materialKeys).toEqual(selected.map(m => m.key));
  expect(f.repository.pages()).toEqual([]);
});

it("investigates a requested range beyond the entry preview before writing and independently reviewing a reader page", async () => {
  const { pipeline, repository, run, capture } = setup();
  capture("Intro\n" + "Background\n".repeat(148) + "The delivery worker retries pending messages.");
  repository.store.capture({ source: "manual", externalId: "unrelated", title: "摄影", parts: [{ type: "text", text: "UNRELATED_CAMERA_MATERIAL" }], context: {} });
  let researchRound = 0;
  run.mockImplementation(async input => {
    expect(JSON.stringify(input.context)).not.toContain("UNRELATED_CAMERA_MATERIAL");
    const bundle = pipeline.registry.load(input.roleId);
    let result: unknown;
    if (input.roleId === "knowledge-researcher") {
      researchRound++;
      if (researchRound > 1) {
        expect(JSON.stringify(input.context.task!.observations)).not.toContain("The delivery worker");
        expect(input.context.materials.map(m => m.text).join("\n")).toContain("L150 The delivery worker retries pending messages.");
      }
      result = { schema_version: 1, ready: researchRound > 1, findings: "Follow the delivery behavior", gaps: [], requests: researchRound === 1 ? [{ kind: "read", materialKey: "manual:example", startLine: 140, endLine: 150 }] : [] };
    } else if (input.roleId === "knowledge-verifier") {
      expect(input.context.task!.reading).toMatchObject({ goal: "Explain retry behavior" });
      result = { schema_version: 1, verdicts: [{ documentKey: "guide:delivery", verdict: "accepted", issues: [], questions: [] }] };
    } else {
      expect(input.context.materials.map(m => m.text).join("\n")).toContain("L150 The delivery worker retries pending messages.");
      result = { schema_version: 1, documents: [{ key: "guide:delivery", title: "Delivery", summary: "Follow a message", category: "workflow", sections: [{ key: "retry", title: "When delivery fails", body: "Pending messages can be retried. Reference [[c1]]" }], citations: [{ key: "c1", label: "Worker behavior", reason: "Explains retry", relation: "supports", target: { kind: "material", key: "manual:example", startLine: 150, endLine: 150 }, quote: "" }], questions: [] }] };
    }
    input.validateOutput?.(result);
    return { result, bundle, trace: { runId: "fixture-research", promptHash: "p", contextHash: "c", skillHash: "s", toolHash: "t", fingerprint: "f", effectiveEffort: null, repairAttempts: 0, roleId: input.roleId, roleVersion: "1", bundleHash: bundle.bundleHash, effectiveModel: "fixture", outputSchema: bundle.manifest.output_schema, sessionIds: [input.roleId + researchRound], loadedSkills: [], allowedTools: [], usage: {} } } as Awaited<ReturnType<RoleRuntimeGateway["run"]>>;
  });
  const [page] = await pipeline.writePage({ key: "guide:delivery", title: "Delivery", order: 0, kind: "explanation", reader: "New contributor", goal: "Explain retry behavior", scenario: "A pending message", questions: ["What happens after failure?"], entryPaths: ["manual:example"], materialKeys: ["manual:example"], topicPath: ["消息系统", "重试"] });
  expect(researchRound).toBe(2);
  expect(page!.reading?.goal).toBe("Explain retry behavior");
  expect(page!.document.topicPath).toEqual(["消息系统", "重试"]);
  expect(page!.dependencies.every(d => d.key === "manual:example")).toBe(true);
  expect(page!.document.citations[0]!.quote).toContain("retries pending messages");
  expect(page!.generation.trace.research).toHaveProperty("rounds");
  expect(repository.list()).toHaveLength(1); // No per-file article prerequisite.
});

it("tracks investigation separately from cited dependencies", async () => {
  const { store, repository, pipeline, capture } = setup();
  const other = (text: string) => store.capture({ source: "manual", externalId: "other", title: "Other note", parts: [{ type: "text", text }], context: {} });
  other("Another release also uses fixed evidence.");
  expect((await pipeline.analyze(repository.materials())).failures).toEqual([]);
  const sibling = repository.get("manual:other")!;
  expect(sibling.dependencies.map(d => d.key)).toEqual(["manual:other"]);
  capture("The first release has changed.");
  repository.refresh();
  expect(repository.get("manual:example")!.current).toBe(false);
  expect(repository.get("manual:other")!.current).toBe(true);
  expect(repository.get("manual:other")!.revision).toBe(sibling.revision);
  const materials = repository.materials(), background = materials.find(m => m.key === "manual:other")!;
  await pipeline.analyze(materials, () => [{ material: background, ranges: [{ start: 1, end: 1 }] }]);
  expect(repository.get("manual:example")!.dependencies.map(d => d.key)).not.toContain("manual:other");
  expect(repository.get("manual:example")!.investigation?.map(d => d.key)).toContain("manual:other");
  other("The supplied background changed.");
  repository.refresh();
  expect(repository.get("manual:example")!.current).toBe(true);
});

it("keeps the reading plan after failure and resumes the matching draft for publication", async()=>{
  const f=setup(true);
  const brief={key:"guide:release",title:"发布流程",order:0,kind:"explanation" as const,reader:"新人",goal:"了解发布",scenario:"一次发布",questions:["如何发布？"],entryPaths:["manual:example"]};
  await expect(f.pipeline.writePage(brief)).rejects.toThrow("Semantic review");
  expect(f.repository.pages()).toContainEqual(expect.objectContaining({key:brief.key,state:"failed",plan:brief}));
  expect(f.repository.published()).toEqual([]);
  const before=f.run.mock.calls.length;
  f.accept();
  const [article]=await f.pipeline.writePage(brief);
  expect(f.run.mock.calls.slice(before).some(([input])=>input.roleId==="knowledge-refresher" && !!input.context.task?.revisionRequest)).toBe(true);
  expect(article!.publication?.role).toBe("article");
  expect(f.repository.pages()).toContainEqual(expect.objectContaining({key:brief.key,state:"published"}));
  expect(f.repository.published()).toHaveLength(1);
});

it("carries a reader's supplemental answer into the next investigation, writing and independent review", async () => {
  const f = setup();
  const brief = { key: "guide:evidence", title: "Evidence review", order: 0, kind: "explanation" as const, reader: "New reader", goal: "Understand evidence review", scenario: "Review a release", questions: ["Who reviews evidence?"], entryPaths: [], materialKeys: ["manual:example"] };
  const [first] = await f.pipeline.writePage(brief);
  f.repository.publish({ ...first!, document: { ...first!.document, questions: [{ question: "Who reviews evidence?", why: "The owner is missing.", nextStep: "Ask the owner.", blocking: false, citationKeys: ["c1"] }] } });
  const question = f.repository.questions()[0]!;
  const revision = f.repository.answer(question.id, "Mira reviews release evidence every Thursday.");
  const reopened = new KnowledgeRepository(f.store);
  const plan = reopened.pages().find(p => p.key === brief.key)!.plan!;
  expect(plan.materialKeys).toContain("manual:knowledge-answer:" + question.id);
  expect(f.store.revision(revision)?.parts).toContainEqual(expect.objectContaining({ text: "Mira reviews release evidence every Thursday." }));
  const before = f.run.mock.calls.length;
  await f.pipeline.writePage(plan);
  for (const role of ["knowledge-researcher", "knowledge-refresher", "knowledge-verifier"]) {
    const input = f.run.mock.calls.slice(before).find(([input]) => input.roleId === role)?.[0];
    expect(input, role).toBeDefined();
    expect(JSON.stringify(input!.context.materials), role).toContain("Mira reviews release evidence every Thursday.");
  }
  expect(reopened.published()).toHaveLength(1);
  expect(reopened.get(brief.key)?.reading).toEqual(plan);
  expect(reopened.get(brief.key, first!.revision)).not.toBeNull();
});

it("maintains a published page from its old explanation and source changes before independent review", async () => {
  const f = setup();
  f.pipeline.options.nativeResearch = true;
  const brief = { key: "guide:release", title: "Release", order: 0, kind: "explanation" as const, reader: "Reader", goal: "Understand release", scenario: "A release", questions: ["What changes?"], entryPaths: [], materialKeys: ["manual:example"] };
  const [previous] = await f.pipeline.writePage(brief);
  const oldSource = f.repository.materials()[0]!;
  f.capture("The release now waits for the reviewer.\nThe original statement stays in history.");
  const before = f.run.mock.calls.length;
  const [updated] = await f.pipeline.writePage(brief);
  const calls = f.run.mock.calls.slice(before).map(([input]) => input);
  expect(calls.map(input => input.roleId)).toEqual(["knowledge-researcher", "knowledge-refresher", "knowledge-verifier"]);
  for (const input of calls) {
    expect(input.context.task!.maintenance).toMatchObject({
      previousRevision: previous!.revision, previousDraft: previous!.document,
      changedFields: [],
      materialChanges: [{ key: oldSource.key, previousRevision: oldSource.revisionId,
        hunks: [{ before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 2 } }] }],
      sections: [{ key: "behavior", state: "needs-review" }],
    });
  }
  expect(calls[1]!.context.task!.revisionRequest).toMatchObject({ previousDrafts: [previous!.document] });
  expect(updated!.document.citations[0]!.quote).toContain("now waits for the reviewer");
  expect(updated!.generation.trace.maintenance).toMatchObject({ previousRevision: previous!.revision, reusedDraft: true });
  expect(updated!.generation.trace.maintenance).not.toHaveProperty("previousDraft");
  expect(f.repository.get(brief.key, previous!.revision)?.document.citations[0]!.quote).toBe("The release uses fixed evidence.");
});

it.each([true, false])("can reorganize a published explanation without patching its old structure (native=%s)", async nativeResearch => {
  const f = setup();
  f.pipeline.options.nativeResearch = nativeResearch;
  const brief = { key: "release-explained", title: "Release", order: 0, kind: "explanation" as const, reader: "Reader", goal: "Understand release", scenario: "A release", questions: ["What changes?"], entryPaths: [], materialKeys: ["manual:example"] };
  const [previous] = await f.pipeline.writePage(brief);
  const composition = { mode: "rewrite" as const, reason: "The explanation is a list of assertions, not a release walkthrough.", outline: "Follow one release; retain the required review step and explain its observable result." };
  f.compose(composition);
  f.capture("The release now waits for the reviewer.");
  const before = f.run.mock.calls.length;
  const [updated] = await f.pipeline.writePage(brief);
  const calls = f.run.mock.calls.slice(before).map(([input]) => input);
  expect(calls.map(input => input.roleId)).toEqual(["knowledge-researcher", "knowledge-writer", "knowledge-verifier"]);
  expect(calls[0]!.context.task!.maintenance).toHaveProperty("previousDraft", previous!.document);
  for (const input of calls.slice(1)) {
    expect(input.context.task!.maintenance).toMatchObject({ previousRevision: previous!.revision, previousDraft: undefined, sections: [] });
    expect(input.context.task).not.toHaveProperty("revisionRequest");
  }
  expect(calls[1]!.context.task!.research).toHaveProperty("composition", composition);
  expect(calls[2]!.context.task!.composition).toEqual(composition);
  expect(updated!.generation.trace.research).toHaveProperty("composition", composition);
  expect(updated!.generation.trace.maintenance).toMatchObject({ previousRevision: previous!.revision, reusedDraft: false });
  expect(updated!.document.citations[0]!.quote).toBe("The release now waits for the reviewer.");
  expect(f.repository.published()).toHaveLength(1);
  expect(f.repository.get(brief.key, previous!.revision)!.document).toEqual(previous!.document);
});

it("does not reintroduce the old draft when the reader removes its source from the new selection", async () => {
  const f = setup();
  f.pipeline.options.nativeResearch = true;
  f.store.capture({ source: "manual", externalId: "other", title: "Other", parts: [{ type: "text", text: "Only discuss the next release." }], context: {} });
  const brief = { key: "guide:release", title: "Release", order: 0, kind: "explanation" as const, reader: "Reader", goal: "Understand release", scenario: "A release", questions: ["What changes?"], entryPaths: [], materialKeys: ["manual:example", "manual:other"] };
  await f.pipeline.writePage(brief);
  const before = f.run.mock.calls.length;
  await f.pipeline.writePage({ ...brief, materialKeys: ["manual:other"], goal: "Understand the next release" });
  const calls = f.run.mock.calls.slice(before).map(([input]) => input);
  expect(calls.map(input => input.roleId)).toEqual(["knowledge-researcher", "knowledge-writer", "knowledge-verifier"]);
  for (const input of calls) {
    expect(input.context.task!.maintenance).toMatchObject({ previousDraft: undefined, changedFields: ["goal", "materialKeys"] });
    expect(JSON.stringify(input.context)).not.toContain("The release uses fixed evidence.");
  }
  expect(f.repository.get(brief.key)!.dependencies.map(d => d.key)).toEqual(["manual:other"]);
});

it("keeps a partially outdated explanation available to every native writing role", async () => {
  const f = setup();
  f.pipeline.options.nativeResearch = true;
  f.capture("# 工作坊\n## 预算\n预算八十元。\n\n## 集合\n在图书馆集合。");
  const brief = { key: "workshop-introduction", title: "参加工作坊", order: 0, kind: "explanation" as const, reader: "参加者", goal: "知道怎样准备", scenario: "参加一次工作坊", questions: ["费用和地点？"], entryPaths: [], materialKeys: ["manual:example"] };
  const [initial] = await f.pipeline.writePage(brief);
  const original = f.repository.materials()[0]!;
  const previous = f.repository.publish({
    ...initial!,
    document: bindKnowledgeQuotes({ ...initial!.document,
      sections: [
        {key:"budget",title:"费用",body:"准备八十元。[[budget]]"},
        {key:"venue",title:"集合地点",body:"在图书馆集合。[[venue]]"},
      ],
      citations: ([['budget', 3], ['venue', 6]] as const).map(([key, line])=>({
        key,label:key,reason:"活动约定",relation:"supports",
        target:{kind:"material",key:original.key,startLine:line,endLine:line},quote:"",
      })),
    }, new Map([[original.key, original]])),
  });
  f.capture("# 工作坊\n## 预算\n预算一百二十元。\n\n## 集合\n在图书馆集合。");
  f.repository.refresh();
  expect(f.repository.get(brief.key)!.current).toBe(false);
  expect(f.repository.statusReader()(previous)).toMatchObject({budget:{state:"needs-review"},venue:{state:"current"}});
  const next = {...brief,key:"workshop-route",goal:"从已知集合地点安排出行"};
  await f.pipeline.writePage(next);
  const jobs = f.store.db.prepare("SELECT kind,input_refs FROM jobs WHERE kind LIKE 'knowledge:%'").all().filter(row=>{
    const task=JSON.parse(String(row.input_refs))[0].task;
    return task.page?.key===next.key || task.targetKeys?.includes(next.key);
  });
  expect(jobs).toHaveLength(3);
  for(const row of jobs) expect(JSON.parse(String(row.input_refs))[0].articles).toContainEqual({key:brief.key,revision:previous.revision});
});
