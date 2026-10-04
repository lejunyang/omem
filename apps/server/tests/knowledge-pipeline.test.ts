import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { KnowledgePipeline, analystFor } from "../src/knowledge/pipeline.js";
import { RoleBundleRegistry } from "../src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../src/agent-runtime/gateway.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function setup(reject = false, changeDuringRun = false) {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-pipeline-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "db")); cleanups.push(() => store.close());
  const capture = (text: string) => store.capture({ source: "manual", externalId: "example", title: "User note", parts: [{ type: "text", text }], context: {} });
  const captured = capture("The release uses fixed evidence.");
  const repository = new KnowledgeRepository(store), registry = new RoleBundleRegistry(), gateway = new RoleRuntimeGateway(registry, join(dir, "agents"));
  let count = 0;
  const run = vi.spyOn(gateway, "run").mockImplementation(async input => {
    count++;
    if (changeDuringRun && count === 1) capture("The release has changed.");
    const key = String((input.context.task!.targetKeys as string[] | undefined)?.[0] ?? (input.context.task!.page as {key:string}).key);
    const sourceKey = !key.startsWith("manual:") ? String((input.context.task!.allowedMaterials as {key:string}[])[0]!.key) : key;
    const sourceLine = 1;
    let result: unknown = input.roleId === "knowledge-researcher" ? {schema_version:1,ready:true,findings:"Read the original",gaps:[],requests:[]} : input.roleId === "knowledge-verifier" ? { schema_version: 1, verdicts: [{ documentKey: key, verdict: reject ? "needs_revision" : "accepted", issues: reject ? ["The interpretation is unsupported"] : [], questions: [] }] } : {
      schema_version: 1, documents: [{ key, title: "Evidence behavior", summary: "A derived explanation", category: "background", sections: [{ key: "behavior", title: "Behavior", body: reject ? "An unsupported extrapolation.[[c1]]" : key.startsWith("module:") ? "Additional context is documented.[[c1]]" : "The release preserves evidence.[[c1]]" }], citations: [{ key: "c1", label: "Original statement", reason: "The original states this constraint.", relation: "supports", target: { kind: "material", key: sourceKey, startLine: sourceLine, endLine: sourceLine }, quote: "" }], questions: [] }],
    };
    const normalized = input.validateOutput?.(result); if (normalized !== undefined) result = normalized;
    const bundle = registry.load(input.roleId);
    return { result, bundle, trace: { runId: `fixture-${count}`, roleId: input.roleId, roleVersion: "1", bundleHash: bundle.bundleHash, promptHash: "p", contextHash: "c", skillHash: "s", toolHash: "t", fingerprint: "f", outputSchema: bundle.manifest.output_schema, effectiveModel: "fixture-model", effectiveEffort: "low", loadedSkills: [], allowedTools: [], sessionIds: [`${input.roleId}-${count}`], usage: {}, repairAttempts: 0 } } as Awaited<ReturnType<RoleRuntimeGateway["run"]>>;
  });
  const profile = profileSchema.parse({ id: "traex", name: "Fixture", command: "unused", transport: "acp" });
  const pipeline = new KnowledgePipeline(repository, gateway, profile, { concurrency: 1, nativeResearch: false });
  return { store, repository, pipeline, run, captured, capture, accept: () => { reject = false; }, reject: () => { reject = true; } };
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
