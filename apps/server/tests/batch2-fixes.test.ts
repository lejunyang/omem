import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureSchema,
  type CaptureInput,
  type Proposal,
} from "../../../packages/contracts/src/index.js";
import {
  LarkEventInbox,
  type LarkInboundEvent,
} from "../src/integrations/lark/realtime.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import { MemoryService } from "../src/memory/service.js";
import { Store } from "../src/store.js";

type Row = Record<string, unknown>;
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

const chatEvent = (
  id: string,
  actorId: string,
  text: string,
  observedAt: Date,
  conversationId = "conversation-1",
): CaptureInput =>
  captureSchema.parse({
    source: "chat",
    externalId: `chat:${id}`,
    title: "Project room",
    observedAt: observedAt.toISOString(),
    parts: [{ type: "text", text }],
    context: { conversationId },
    provenance: {
      collectorId: "chat-connector",
      actorId,
      actorType: "user",
      actorVerifiedBy: "signed-event",
      sourceUri: null,
      eventId: id,
      eventAt: observedAt.toISOString(),
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  });

describe("Batch2 F4: per-part provenance survives aggregation", () => {
  it("G04 keeps each speaker's actor/time on its own part (top-level actorId null)", () => {
    const store = new Store(temporary("omem-f4-g04-"));
    const start = new Date("2026-09-27T00:00:00.000Z");
    try {
      store.inputs.ingest(
        chatEvent("alice-1", "ou_alice", "我负责开发", start),
        start,
      );
      store.inputs.ingest(
        chatEvent(
          "bob-1",
          "ou_bob",
          "我负责评审",
          new Date(start.getTime() + 60_000),
        ),
        new Date(start.getTime() + 60_000),
      );
      const flushed = store.inputs.flushReady((input) => store.capture(input), {
        now: new Date(start.getTime() + 120_000),
      });
      expect(flushed).toHaveLength(1);
      const revision = store.revision(flushed[0]!.revisionId)!;
      // Two speakers => top-level actorId is null, not flattened to one identity.
      expect(revision.provenance?.actorId).toBeNull();
      expect(revision.parts).toHaveLength(2);
      const [alicePart, bobPart] = revision.parts as Array<{
        text: string;
        provenance?: {
          actorExternalId: string | null;
          observedAt: string | null;
          eventId: string | null;
        };
      }>;
      expect(alicePart!.text).toContain("我负责开发");
      expect(alicePart!.provenance?.actorExternalId).toBe("ou_alice");
      expect(alicePart!.provenance?.observedAt).toBe(start.toISOString());
      expect(alicePart!.provenance?.eventId).toBe("alice-1");
      expect(bobPart!.text).toContain("我负责评审");
      expect(bobPart!.provenance?.actorExternalId).toBe("ou_bob");
      expect(bobPart!.provenance?.observedAt).toBe(
        new Date(start.getTime() + 60_000).toISOString(),
      );
      expect(bobPart!.provenance?.eventId).toBe("bob-1");
    } finally {
      store.close();
    }
  });

  it("G05 keeps both speakers when two actors say the same thing", () => {
    const store = new Store(temporary("omem-f4-g05-"));
    const start = new Date("2026-09-27T00:00:00.000Z");
    try {
      store.inputs.ingest(chatEvent("a-agree", "ou_alice", "同意", start), start);
      store.inputs.ingest(
        chatEvent(
          "b-agree",
          "ou_bob",
          "同意",
          new Date(start.getTime() + 60_000),
        ),
        new Date(start.getTime() + 60_000),
      );
      const flushed = store.inputs.flushReady((input) => store.capture(input), {
        now: new Date(start.getTime() + 120_000),
      });
      expect(flushed).toHaveLength(1);
      const revision = store.revision(flushed[0]!.revisionId)!;
      // Identical text, but different speakers => both pieces of evidence survive.
      expect(revision.parts).toHaveLength(2);
      const actors = (
        revision.parts as Array<{
          provenance?: { actorExternalId: string | null };
        }>
      ).map((p) => p.provenance?.actorExternalId);
      expect(actors.sort()).toEqual(["ou_alice", "ou_bob"]);
    } finally {
      store.close();
    }
  });
});

// --- Lark canonical owner resolution (F7) ---------------------------------

const seedLarkBinding = (store: Store) => {
  const at = "2026-09-27T00:00:00.000Z";
  const secrets = new EncryptedSecretStore(
    join(temporary("omem-f7-secrets-"), "secrets"),
    randomBytes(32),
  );
  const secretRef = secrets.put({
    appId: "cli_f7",
    clientSecret: "fixture-secret",
  });
  store.db
    .prepare(
      `INSERT INTO lark_connections(
         id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
         owner_open_id,created_at,updated_at
       ) VALUES('conn-f7','personal','cli_f7','feishu','tenant-f7',
         'active',1,'ou_owner',?,?)`,
    )
    .run(at, at);
  store.db
    .prepare(
      `INSERT INTO lark_connection_versions(
         id,connection_id,version,secret_ref,requested_config,capability_profile,
         missing_capabilities,state,created_at,updated_at
       ) VALUES('conn-v-f7','conn-f7',1,?,'{}',?,'[]','active',?,?)`,
    )
    .run(secretRef, JSON.stringify({ botOpenId: "ou_bot" }), at, at);
  store.db
    .prepare(
      `INSERT INTO lark_bindings(
         id,workspace_id,connection_id,connection_version,binding_version,
         owner_open_id,target_chat_id,target_type,state,supersedes_binding_id,
         created_at
       ) VALUES('binding-f7','personal','conn-f7',1,1,'ou_owner','oc_group',
         'group','active',NULL,?)`,
    )
    .run(at);
  store.db
    .prepare(
      `INSERT INTO lark_targets(
         id,workspace_id,connection_id,binding_version,chat_id,target_type,
         purpose,capture_enabled,state,created_at,updated_at
       ) VALUES('target-f7','personal','conn-f7',1,'oc_group','group',
         'group_monitoring',1,'active',?,?)`,
    )
    .run(at, at);
  return secrets;
};

const groupEvent = (patch: Partial<LarkInboundEvent> = {}): LarkInboundEvent => ({
  appId: "cli_f7",
  eventId: `evt-f7-${Math.random()}`,
  kind: "im.message.receive_v1",
  eventTime: "2026-09-27T00:00:00.000Z",
  senderOpenId: "ou_owner",
  senderType: "user",
  chatId: "oc_group",
  chatType: "group",
  messageId: `om-f7-${Math.random()}`,
  text: "把这周的评审任务指派给我",
  payload: { fixture: true },
  ...patch,
});

const taskProposalFor = (revision: {
  id: string;
  fragments: { id: string; text: string }[];
}): Proposal => {
  const fragment = revision.fragments[0]!;
  return {
    schema_version: 1,
    proposal_id: `proposal-f7-${Math.random()}`,
    kind: "task",
    operation: "create",
    scope: {
      workspace_id: "personal",
      project_id: "oc_group",
      subject_id: "owner",
    },
    body: {
      title: "本周评审",
      owner_id: "owner",
      due_at: null,
      due_expression: null,
      next_step: "开始评审",
    },
    evidence: [
      {
        fragment_revision_id: fragment.id,
        source_revision_id: revision.id,
        exact_quote: fragment.text,
        selector: {
          start: 0,
          end: Array.from(fragment.text).length,
          unit: "unicode_codepoint",
        },
      },
    ],
    uncertainties: [],
    reason: "owner明确交办",
    expected_versions: {},
    origin: {
      job_id: "job-f7",
      role_bundle: "planner@1",
      producer_kind: "derived",
    },
  };
};

describe("Batch2 F7: lark real identity resolves to canonical owner", () => {
  it("G06 bound owner's ou_* message maps to canonical owner and auto-applies", async () => {
    const store = new Store(temporary("omem-f7-g06-"));
    try {
      seedLarkBinding(store);
      const inbox = new LarkEventInbox(store, { ownerId: "owner" });
      const event = groupEvent({ eventId: "evt-owner-msg" });
      const result = await inbox.processMessage(event);
      expect(result).toMatchObject({ outcome: "captured" });
      const row = store.db
        .prepare("SELECT envelope FROM input_events WHERE event_id=?")
        .get("evt-owner-msg") as Row;
      const envelope = JSON.parse(String(row.envelope));
      expect(envelope.provenance).toMatchObject({
        actorType: "owner",
        actorId: "owner",
        actorExternalId: "ou_owner",
        actorPrincipalId: "owner",
        actorVerifiedBy: "lark-binding:1",
      });

      const flushed = store.inputs.flushReady((input) => store.capture(input), {
        now: new Date(Date.now() + 5_000),
        quietMs: 1_000,
      });
      expect(flushed).toHaveLength(1);
      const revision = store.revision(flushed[0]!.revisionId)!;
      const memory = new MemoryService(store, { ownerId: "owner" });
      const evaluated = memory.evaluate(
        taskProposalFor(revision),
        {
          semantic_verdict: "supported",
          reviewer_version: "fixture-reviewer",
          role_version: "verifier@1",
          reason_code: "supported",
          details: "owner明确交办",
        },
        { impactCount: 1 },
      );
      expect(evaluated.policy).toBe("auto_apply");
      expect(evaluated.reasons).not.toContain("owner_not_verified");
    } finally {
      store.close();
    }
  });

  it("G07 a non-owner group member's task clue is NOT treated as owner's own task", async () => {
    const store = new Store(temporary("omem-f7-g07-"));
    try {
      seedLarkBinding(store);
      const inbox = new LarkEventInbox(store, { ownerId: "owner" });
      const event = groupEvent({
        eventId: "evt-member-msg",
        senderOpenId: "ou_member",
      });
      const result = await inbox.processMessage(event);
      expect(result).toMatchObject({ outcome: "captured" });
      const row = store.db
        .prepare("SELECT envelope FROM input_events WHERE event_id=?")
        .get("evt-member-msg") as Row;
      const envelope = JSON.parse(String(row.envelope));
      expect(envelope.provenance).toMatchObject({
        actorType: "user",
        actorId: "ou_member",
        actorExternalId: "ou_member",
        actorPrincipalId: null,
        actorVerifiedBy: null,
      });

      const flushed = store.inputs.flushReady((input) => store.capture(input), {
        now: new Date(Date.now() + 5_000),
        quietMs: 1_000,
      });
      expect(flushed).toHaveLength(1);
      const revision = store.revision(flushed[0]!.revisionId)!;
      const memory = new MemoryService(store, { ownerId: "owner" });
      const evaluated = memory.evaluate(
        taskProposalFor(revision),
        {
          semantic_verdict: "supported",
          reviewer_version: "fixture-reviewer",
          role_version: "verifier@1",
          reason_code: "supported",
          details: "群成员提出",
        },
        { impactCount: 1 },
      );
      // Not auto-applied as the owner's own task; kept as a pending clue instead.
      expect(evaluated.policy).not.toBe("auto_apply");
      expect(evaluated.reasons).toContain("owner_not_verified");
    } finally {
      store.close();
    }
  });
});

describe("Batch2 F8: original vs derived agent sessions", () => {
  it("G14 original agent session enters extract_claims; derived does not", () => {
    const store = new Store(temporary("omem-f8-g14-"));
    try {
      const base = (
        producerKind: "original" | "derived",
        externalId: string,
      ): CaptureInput => ({
        source: "agent",
        externalId,
        title: "Agent session",
        parts: [{ type: "text", text: "user asked X, assistant did Y" }],
        context: { runId: "run-1" },
        provenance: {
          collectorId: "agent-run",
          actorId: "owner",
          actorType: "owner",
          actorVerifiedBy: "signed-event",
          sourceUri: null,
          eventId: externalId,
          eventAt: "2026-09-27T00:00:00.000Z",
          timezone: "UTC",
          quoted: false,
          forwarded: false,
          producerKind,
        },
      });
      const original = store.capture(base("original", "agent-original-1"));
      expect(original.job).not.toBeNull();
      const derived = store.capture(base("derived", "agent-derived-1"));
      expect(derived.job).toBeNull();
      const extractJobs = store.jobs
        .list()
        .filter((job: { kind?: string }) => job.kind === "extract_claims");
      expect(extractJobs).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
