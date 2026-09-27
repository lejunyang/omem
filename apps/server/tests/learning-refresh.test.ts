import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  profileSchema,
  captureSchema,
  type CaptureInput,
} from "../../../packages/contracts/src/index.js";
import { MemoryService, FeedbackService } from "../src/memory/service.js";
import { LearningPipeline } from "../src/learning/pipeline.js";
import { Store } from "../src/store.js";
import { createHash } from "node:crypto";

const directories: string[] = [];
const temporary = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const fixtureAgent = resolve("apps/server/tests/fixtures/role-acp-agent.mjs");
const profile = () =>
  profileSchema.parse({
    id: "traex",
    name: "Provenance fixture",
    transport: "acp",
    command: process.execPath,
    args: [fixtureAgent],
    timeoutMs: 3000,
  });

const iso = "2026-09-27T09:00:00+08:00";
const provenance = (eventId: string) => ({
  collectorId: "prov-test",
  actorId: "owner",
  actorType: "owner" as const,
  actorVerifiedBy: "authenticated-test",
  sourceUri: null,
  eventId,
  eventAt: iso,
  timezone: "Asia/Shanghai",
  quoted: false,
  forwarded: false,
  producerKind: "original" as const,
});

// 1x1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("P0: context manifest per-fragment provenance reaches the model", () => {
  it("materials carry per-fragment actor (alice/bob), image asset_ref, and project_trusted=false", async () => {
    const directory = temporary("omem-provenance-");
    const store = new Store(directory);
    try {
      const captured = store.capture(
        captureSchema.parse({
          source: "manual",
          externalId: "prov-multi",
          title: "Multi speaker chat",
          parts: [
            {
              type: "text",
              text: "alice unique turn body",
              provenance: {
                actorExternalId: "ou_alice",
                actorPrincipalId: null,
                observedAt: "2026-09-27T09:00:00+08:00",
                eventId: "evt-alice",
                replyTo: null,
                quoted: false,
                forwarded: false,
                producerKind: "original",
              },
            },
            {
              type: "text",
              text: "bob unique turn body",
              provenance: {
                actorExternalId: "ou_bob",
                actorPrincipalId: null,
                observedAt: "2026-09-27T09:01:00+08:00",
                eventId: "evt-bob",
                replyTo: "evt-alice",
                quoted: false,
                forwarded: false,
                producerKind: "original",
              },
            },
            {
              type: "image",
              mimeType: "image/png",
              data: PNG,
              label: "screenshot",
              provenance: {
                actorExternalId: "ou_bob",
                actorPrincipalId: null,
                observedAt: null,
                eventId: null,
                replyTo: null,
                quoted: false,
                forwarded: false,
                producerKind: "original",
              },
            },
          ],
          // conversationId is a context carrier, NOT a trusted project.
          context: { application: "chat-app", conversationId: "conv-xyz" },
          provenance: provenance("prov-multi-event"),
        } satisfies CaptureInput),
      );
      expect(captured.job).not.toBeNull();

      const pipe = new LearningPipeline({
        store,
        memory: new MemoryService(store, { ownerId: "owner" }),
        feedback: new FeedbackService(store),
        profile: profile(),
        workspaceRoot: join(directory, "agent"),
        pollMs: 20,
      });
      const result = await pipe.processOne();
      expect(result.processed).toBe(true);
      await pipe.stop();

      const job = store.jobs.get(captured.job!.id)!;
      expect(job.state).toBe("succeeded");
      expect(job.kind).toBe("extract_claims");
      const output = store.jobs.roleOutput(job.resultRef!)!;
      const batch = output.output as {
        abstentions: { detail: string }[];
      };
      const detail = batch.abstentions[0]!.detail;
      // Both speakers survived per-fragment into the model prompt.
      expect(detail).toContain("ou_alice");
      expect(detail).toContain("ou_bob");
      // The image fragment surfaced an asset_ref.
      expect(detail).toContain("assetRefs=1");
      // conversationId was NOT promoted to a trusted project.
      expect(detail).toContain("projectTrusted=false");
    } finally {
      store.close();
    }
  });
});

describe("P0: refresh_dependents does not claim a successful re-verification", () => {
  it("fails the job NOT_IMPLEMENTED and records needs_review for affected memories", async () => {
    const directory = temporary("omem-refresh-job-");
    const store = new Store(directory);
    try {
      const v1 = store.capture(
        captureSchema.parse({
          source: "manual",
          externalId: "refresh-job-src",
          title: "v1",
          parts: [{ type: "text", text: "refresh source fact term" }],
          provenance: provenance("refresh-v1"),
        }),
      );
      // A memory depends on v1.
      const mem = store.applications.applyMemory({
        metadata: {
          workspaceId: "personal",
          applicationId: "refresh-app-1",
          proposalDigest: createHash("sha256")
            .update("refresh-app-1")
            .digest("hex"),
          generation: 1,
          title: "Apply refresh seed",
          details: "seed",
          delivery: {
            channelBindingVersion: 1,
            channel: "in_app",
            target: "notification-center",
          },
        },
        memory: {
          kind: "claim",
          scope: { workspace_id: "personal" },
          body: { statement: "refresh source fact term" },
          evidenceSet: [
            {
              sourceId: v1.revision.sourceId,
              sourceRevisionId: v1.revision.id,
              validityEpoch: 1,
            },
          ],
        },
      });
      // Advance the source: deterministically invalidates dependents and enqueues
      // a refresh_dependents job.
      store.capture(
        captureSchema.parse({
          source: "manual",
          externalId: "refresh-job-src",
          title: "v2",
          parts: [{ type: "text", text: "refresh changed completely" }],
          provenance: provenance("refresh-v2"),
        }),
      );

      const refreshJobRow = store.jobs
        .list()
        .find((j) => j.kind === "refresh_dependents")!;
      expect(refreshJobRow).toBeTruthy();

      const pipe = new LearningPipeline({
        store,
        memory: new MemoryService(store, { ownerId: "owner" }),
        feedback: new FeedbackService(store),
        profile: profile(),
        workspaceRoot: join(directory, "agent"),
        pollMs: 20,
      });
      // Drain queued work; the refresh job must reach a non-succeeded terminal state.
      for (let i = 0; i < 10; i++) {
        const r = await pipe.processOne();
        if (!r.processed) break;
      }
      await pipe.stop();

      const refreshJob = store.jobs.get(refreshJobRow.id)!;
      expect(refreshJob.state).not.toBe("succeeded");
      expect(refreshJob.state).toBe("failed");
      expect(refreshJob.lastError).toContain("NOT_IMPLEMENTED");

      const row = store.db
        .prepare(
          "SELECT status, affected_count, affected_memory_ids FROM refresh_records WHERE source_id=?",
        )
        .get(v1.revision.sourceId) as {
        status: string;
        affected_count: number;
        affected_memory_ids: string;
      };
      expect(row.status).toBe("needs_review");
      expect(row.affected_count).toBe(1);
      expect(JSON.parse(row.affected_memory_ids)).toContain(mem.entityId);
    } finally {
      store.close();
    }
  });
});
