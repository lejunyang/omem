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
