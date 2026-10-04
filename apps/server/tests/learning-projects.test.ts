import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, expect } from "vitest";
import { Store } from "../src/store.js";
import { LearningPipeline } from "../src/learning/pipeline.js";
import { MemoryService, FeedbackService } from "../src/memory/service.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";

it("updates a project's active memory from a later source, and rejects membership changed between extraction and review", async () => {
  const root = mkdtempSync(join(tmpdir(), "omem-learning-project-"));
  const store = new Store(root);
  const pipe = new LearningPipeline({ store, memory: new MemoryService(store), feedback: new FeedbackService(store),
    profile: profileSchema.parse({ id: "traex", name: "Protocol fixture", transport: "acp", command: process.execPath,
      args: [resolve("apps/server/tests/fixtures/role-acp-agent.mjs")], timeoutMs: 5000 }), workspaceRoot: join(root, "agents") });
  const web = store.contexts.create({ name: "发布", kind: "project", description: "Web" });
  const mobile = store.contexts.create({ name: "发布", kind: "project", description: "Mobile" });
  const capture = (key: string, project: string, text: string) => store.capture({ source: "manual", externalId: key,
    title: "重试规则", parts: [{ type: "text", text }], provenance: { collectorId: "test", actorId: "owner",
      actorType: "owner", actorVerifiedBy: "local-user", sourceUri: null, eventId: key,
      eventAt: new Date().toISOString(), timezone: "Asia/Shanghai", quoted: false, forwarded: false, producerKind: "original" } },
    { contextIds: [project] });
  const memories = () => store.db.prepare("SELECT m.id,m.version,m.scope,r.body FROM memories m JOIN memory_revisions r ON r.id=m.head_revision_id ORDER BY m.id").all();
  try {
    capture("web", web.id, "REFRESH_FACT retry limit is 3");
    await pipe.drain();
    const first = memories()[0]!;
    capture("mobile", mobile.id, "REFRESH_FACT retry limit is 8");
    await pipe.drain();
    capture("web-later-message", web.id, "REFRESH_FACT retry limit is 5");
    await pipe.drain();
    expect(memories()).toHaveLength(2);
    expect(memories().find(m => m.id === first.id)).toMatchObject({ version: 2, body: expect.stringContaining("limit is 5") });
    expect(memories().find(m => JSON.parse(String(m.scope)).project_id === mobile.id)?.body).toContain("limit is 8");
    const outputs = store.jobs.list().filter(j => j.resultRef).map(j => store.jobs.roleOutput(j.resultRef!)!);
    expect(outputs.filter(o => o.outputSchema === "ProposalBatch.v1").every(o => (o.trace.allowedTools as string[]).includes("read_fragments"))).toBe(true);
    const changed = capture("scope-edit", web.id, "REFRESH_FACT retry limit is 9");
    await pipe.processOne();
    store.contexts.setForSource(changed.revision.sourceId, [mobile.id]);
    await pipe.drain();
    expect(memories().find(m => m.id === first.id)?.version).toBe(2);
    expect(memories().every(m => !String(m.body).includes("limit is 9"))).toBe(true);
    expect(store.jobs.list().some(j => j.lastError?.includes("project membership changed"))).toBe(true);
  } finally { await pipe.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("investigates unassigned input, independently reviews filing, and resumes ambiguous input after a manual choice", async () => {
  const root = mkdtempSync(join(tmpdir(), "omem-context-resolution-"));
  const store = new Store(root), memory = new MemoryService(store);
  let pipe = new LearningPipeline({ store, memory, feedback: new FeedbackService(store),
    profile: profileSchema.parse({ id: "traex", name: "Protocol fixture", transport: "acp", command: process.execPath,
      args: [resolve("apps/server/tests/fixtures/role-acp-agent.mjs")], timeoutMs: 5000 }), workspaceRoot: join(root, "agents") });
  const web = store.contexts.create({ name: "发布", kind: "project", description: "Web" });
  const mobile = store.contexts.create({ name: "发布", kind: "project", description: "Mobile" });
  const capture = (key: string, text: string, contextIds?: string[]) => store.capture({ source: "manual", externalId: key, title: "消息",
    parts: [{ type: "text", text }], provenance: { collectorId: "test", actorId: "owner", actorType: "owner",
      actorVerifiedBy: "local-user", sourceUri: null, eventId: key, eventAt: new Date().toISOString(),
      timezone: "Asia/Shanghai", quoted: false, forwarded: false, producerKind: "original" } }, { contextIds });
  const active = () => store.db.prepare("SELECT id,scope FROM memories WHERE status='active'").all();
  try {
    const first = capture("first", "REFRESH_FACT retry limit is 3");
    await pipe.drain();
    expect(store.jobs.list().map(j => ({ state: j.state, error: j.lastError }))).toEqual([
      { state: "succeeded", error: null }, { state: "succeeded", error: null },
    ]);
    expect(store.contexts.forSource(first.revision.sourceId)).toEqual([web.id]);
    expect(store.contexts.assignment(first.revision.sourceId)?.status).toBe("automatic");
    expect(active()).toHaveLength(1);
    expect(JSON.parse(String(active()[0]!.scope)).project_id).toBe(web.id);
    const filing = store.jobs.roleOutputs(first.job!.id).filter(o => o.outputSchema === "ContextResolution.v1");
    expect(filing).toHaveLength(2);
    expect(new Set(filing.map(o => JSON.parse(String(o.traceJson)).sessionIds[0])).size).toBe(2);
    const unresolved = capture("unclear", "REFRESH_FACT AMBIGUOUS_CONTEXT retry limit is 8");
    await pipe.drain();
    expect(store.contexts.assignment(unresolved.revision.sourceId)).toMatchObject({ status: "ambiguous", question: "这条消息说的是 Web 还是移动端？" });
    expect(active()).toHaveLength(1);
    store.setSourceContexts(unresolved.revision.sourceId, [mobile.id]);
    await pipe.drain();
    expect(active()).toHaveLength(2);
    const prior = active().find(m => JSON.parse(String(m.scope)).project_id === mobile.id)!;
    // Re-importing the same original with a different manual choice is also a correction.
    const original = store.revision(unresolved.revision.id)!;
    store.capture({ source: "manual", externalId: "unclear", title: original.title,
      parts: [{ type: "text", text: "REFRESH_FACT AMBIGUOUS_CONTEXT retry limit is 8" }],
      provenance: original.provenance }, { contextIds: [] });
    expect(active().some(m => m.id === prior.id)).toBe(false);
    await pipe.drain();
    expect(store.contexts.assignment(unresolved.revision.sourceId)?.status).toBe("manual");
    expect(store.contexts.forSource(unresolved.revision.sourceId)).toEqual([]);
    expect(store.jobs.list().filter(j => j.cause === "context_correction").every(j => j.state === "succeeded")).toBe(true);
    expect(active().some(m => JSON.parse(String(m.scope)).project_id === null)).toBe(true);
  } finally { await pipe.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
