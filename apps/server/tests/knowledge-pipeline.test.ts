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
  return { store, repository, pipeline, run, captured, capture, accept: () => { reject = false; } };
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

it("provides full fixed source to synthesis when it fits, enabling a new supported line citation", async () => {
  const { repository, pipeline, capture } = setup();
  capture("The release uses fixed evidence.\nThe next line supplies additional context.");
  expect((await pipeline.analyze(repository.materials())).failures).toEqual([]);
  const result = await pipeline.synthesize({ key: "module:example", title: "Example module" }, ["manual:example"]);
  expect(result[0]!.document.citations[0]!.target.startLine).toBe(2);
  expect(result[0]!.document.citations[0]!.quote).toBe("The next line supplies additional context.");
});
