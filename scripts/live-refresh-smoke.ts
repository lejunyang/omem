import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../apps/server/src/store.js";
import { loadConfig } from "../apps/server/src/config.js";
import { MemoryService, FeedbackService } from "../apps/server/src/memory/service.js";
import { LearningPipeline } from "../apps/server/src/learning/pipeline.js";
import { selectLiveProfile } from "./live-model.js";
const config = loadConfig();
const directory = mkdtempSync(join(tmpdir(), "omem-live-refresh-"));
const store = new Store(directory);
let pipeline: LearningPipeline | undefined;
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
try {
  const { profile } = await selectLiveProfile(config.profiles.find(p => p.id === "traex")!, join(directory, "agent"));
  assert.equal(profile.model, "gpt-5.6-sol");
  report.model = profile.model; report.effort = profile.effort;
  pipeline = new LearningPipeline({ store, memory: new MemoryService(store), feedback: new FeedbackService(store), profile, workspaceRoot: join(directory, "agent") });
  const capture = (limit: number) => store.capture({ source: "manual", externalId: "synthetic:retry-limit", title: "个人实验项目固定配置",
    parts: [{ type: "text", text: `我的个人实验项目 Aurora 当前固定重试上限是 ${limit} 次。这是已生效的配置。` }],
    provenance: { collectorId: "live-refresh", actorId: "owner", actorType: "owner", actorVerifiedBy: "synthetic-live",
      sourceUri: null, eventId: `retry-${limit}`, eventAt: new Date().toISOString(), timezone: "Asia/Shanghai", quoted: false, forwarded: false, producerKind: "original" } });
  console.log("Live refresh: extract and independently verify initial source");
  const old = capture(3); await pipeline.drain(8);
  const before = store.db.prepare("SELECT id,version FROM memories WHERE status='active'").all() as { id: string; version: number }[];
  assert.equal(before.length, 1, "Expected one applied source claim");
  console.log("Live refresh: source changes from 3 to 5; re-analyze and independently verify");
  const next = capture(5);
  assert.equal((store.db.prepare("SELECT status FROM memories WHERE id=?").get(before[0]!.id) as { status: string }).status, "invalidated");
  await pipeline.drain(8);
  const after = store.db.prepare("SELECT m.id,m.version,m.status,r.body FROM memories m JOIN memory_revisions r ON r.id=m.head_revision_id").all();
  assert.equal(after.length, 1); assert.equal(after[0]!.id, before[0]!.id); assert.equal(after[0]!.version, 2); assert.equal(after[0]!.status, "active");
  assert.match(String(after[0]!.body), /5/);
  assert.match(store.revision(old.revision.id)!.fragments[0]!.text, /3/);
  assert.equal((store.db.prepare("SELECT status FROM refresh_records WHERE new_revision_id=?").get(next.revision.id) as { status: string }).status, "applied");
  report.status = "passed"; report.memories = after;
} catch (error) { report.status = "failed"; report.error = String(error); process.exitCode = 1; }
finally {
  await pipeline?.stop();
  report.jobs = store.jobs.list(); report.refresh = store.db.prepare("SELECT * FROM refresh_records").all();
  report.proposals = new MemoryService(store).proposals(); report.finishedAt = new Date().toISOString();
  const out = join(config.dataDir, "verification"); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "live-refresh.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, report: join(out, "live-refresh.json") }));
  store.close(); rmSync(directory, { recursive: true, force: true });
}
