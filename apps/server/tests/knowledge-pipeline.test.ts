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
    const key = String((input.context.task!.targetKeys as string[])[0]);
    const sourceKey = key.startsWith("module:") ? String((input.context.task!.allowedMaterials as {key:string}[])[0]!.key) : key;
    const sourceLine = key.startsWith("module:") ? 2 : 1;
    let result: unknown = input.roleId === "knowledge-verifier" ? { schema_version: 1, verdicts: [{ documentKey: key, verdict: reject ? "needs_revision" : "accepted", issues: reject ? ["The interpretation is unsupported"] : [], questions: [] }] } : {
      schema_version: 1, documents: [{ key, title: "Evidence behavior", summary: "A derived explanation", category: "background", sections: [{ key: "behavior", title: "Behavior", body: reject ? "An unsupported extrapolation.[[c1]]" : key.startsWith("module:") ? "Additional context is documented.[[c1]]" : "The release preserves evidence.[[c1]]" }], citations: [{ key: "c1", label: "Original statement", reason: "The original states this constraint.", relation: "supports", target: { kind: "material", key: sourceKey, startLine: sourceLine, endLine: sourceLine }, quote: "" }], questions: [] }],
    };
    const normalized = input.validateOutput?.(result); if (normalized !== undefined) result = normalized;
    const bundle = registry.load(input.roleId);
    return { result, bundle, trace: { runId: `fixture-${count}`, roleId: input.roleId, roleVersion: "1", bundleHash: bundle.bundleHash, promptHash: "p", contextHash: "c", skillHash: "s", toolHash: "t", fingerprint: "f", outputSchema: bundle.manifest.output_schema, effectiveModel: "fixture-model", effectiveEffort: "low", loadedSkills: [], allowedTools: [], sessionIds: [`${input.roleId}-${count}`], usage: {}, repairAttempts: 0 } } as Awaited<ReturnType<RoleRuntimeGateway["run"]>>;
  });
  const profile = profileSchema.parse({ id: "traex", name: "Fixture", command: "unused", transport: "acp" });
  const pipeline = new KnowledgePipeline(repository, gateway, profile, { concurrency: 1 });
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
  let researchRound = 0;
  run.mockImplementation(async input => {
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
  const [page] = await pipeline.writePage({ key: "guide:delivery", title: "Delivery", order: 0, kind: "explanation", reader: "New contributor", goal: "Explain retry behavior", scenario: "A pending message", questions: ["What happens after failure?"], entryPaths: ["manual:example"] });
  expect(researchRound).toBe(2);
  expect(page!.reading?.goal).toBe("Explain retry behavior");
  expect(page!.document.citations[0]!.quote).toContain("retries pending messages");
  expect(page!.generation.trace.research).toHaveProperty("rounds");
  expect(repository.list()).toHaveLength(1); // No per-file article prerequisite.
});

it("isolates sibling articles while retaining explicitly supplied background dependencies", async () => {
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
  expect(repository.get("manual:example")!.dependencies.map(d => d.key)).toContain("manual:other");
  other("The supplied background changed.");
  repository.refresh();
  expect(repository.get("manual:example")!.current).toBe(false);
});

it("provides full fixed source to synthesis when it fits, enabling a new supported line citation", async () => {
  const { repository, pipeline, capture } = setup();
  capture("The release uses fixed evidence.\nThe next line supplies additional context.");
  expect((await pipeline.analyze(repository.materials())).failures).toEqual([]);
  const result = await pipeline.synthesize({ key: "module:example", title: "Example module" }, ["manual:example"]);
  expect(result[0]!.document.citations[0]!.target.startLine).toBe(2);
  expect(result[0]!.document.citations[0]!.quote).toBe("The next line supplies additional context.");
});

it("resumes rejected synthesized chapters from their matching reviewed draft", async () => {
  const fixture = setup();
  fixture.capture("The release uses fixed evidence.\nThe next line supplies additional context.");
  await fixture.pipeline.analyze(fixture.repository.materials());
  fixture.reject();
  await expect(fixture.pipeline.synthesize({ key: "module:example", title: "Example" }, ["manual:example"])).rejects.toThrow("Semantic review");
  const before = fixture.run.mock.calls.length;
  fixture.accept();
  const result = await fixture.pipeline.synthesize({ key: "module:example", title: "Example" }, ["manual:example"]);
  expect(fixture.run.mock.calls[before]![0].roleId).toBe("knowledge-refresher");
  expect(result[0]!.current).toBe(true);
});

it("composes reviewed chapters without flattening descendant originals and preserves invalidation", async () => {
  const { repository, pipeline, capture, run } = setup();
  capture("The release uses fixed evidence.\nAdditional context is documented.\n" + "Background line.\n".repeat(80) + "DEEP_SOURCE_TAIL");
  await pipeline.analyze(repository.materials());
  await pipeline.synthesize({ key: "module:example", title: "Example" }, ["manual:example"]);
  const before = run.mock.calls.length;
  const [overview] = await pipeline.synthesize({ key: "module:overview", title: "Overview" }, ["module:example"]);
  const context = run.mock.calls[before]![0].context;
  expect(context.materials.map(m => m.text).join("\n")).not.toContain("DEEP_SOURCE_TAIL");
  expect(context.task!.articles).toEqual([expect.objectContaining({ key: "module:example", provenance: "derived knowledge, not independent evidence" })]);
  expect(overview!.dependencies).toContainEqual(expect.objectContaining({ kind: "article", key: "module:example" }));
  expect(run.mock.calls[before + 1]![0].roleId).toBe("knowledge-verifier");
  capture("The source changed."); repository.refresh();
  expect(repository.get("module:overview")!.current).toBe(false);
});
