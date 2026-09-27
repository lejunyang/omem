/** G18: cancelling a quality annotation session revokes unsent cards, and the
 *  Lark delivery sender never sends a card for a session that is no longer active.
 *
 * Regression for Batch-2 review F9. Uses a temporary SQLite database and a fake
 * message adapter; no real Lark/network calls.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LarkDeliveryRepository,
  LarkDeliveryWorker,
  type LarkMessageAdapter,
} from "../src/integrations/lark/delivery.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import { QualityLarkAnnotationService } from "../src/quality/lark-annotations.js";
import { QualityRepository } from "../src/quality/repository.js";
import { stableDigest } from "../src/storage/digest.js";
import { Store } from "../src/store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class FakeMessages implements LarkMessageAdapter {
  sends: Parameters<LarkMessageAdapter["send"]>[0][] = [];
  async send(input: Parameters<LarkMessageAdapter["send"]>[0]) {
    this.sends.push(input);
    return { messageId: "om_g18_fake" };
  }
  async update() {}
}

const sample = (ordinal: number) => {
  const text = `规则 ${ordinal}：一个主体只能有一个主账号。`;
  return {
    input: {
      source: {
        uri: "https://example.test/wiki/g18",
        documentId: "doc-g18",
        revisionId: "1",
        fragmentId: `fragment-${ordinal}`,
        section: "账号规则",
      },
      category: "explicit" as const,
      text,
      provenance: { actorId: null, actorVerified: false, forwarded: false },
    },
    draftLabel: {
      disposition: "extract" as const,
      objects: [{ kind: "claim" as const, statement: text, evidenceQuote: text }],
      autoApply: true,
      forbiddenEffects: ["不得执行外部操作"],
      notes: "fixture",
    },
  };
};

type Fixture = {
  store: Store;
  secrets: EncryptedSecretStore;
  quality: QualityLarkAnnotationService;
  datasetId: string;
};

function setup(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "omem-g18-"));
  directories.push(directory);
  const store = new Store(directory);
  const secrets = new EncryptedSecretStore(join(directory, "secrets"), randomBytes(32));
  const secretRef = secrets.put({
    appId: "cli_g18",
    clientSecret: "g18-fixture-secret",
  });
  const at = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO lark_connections(
         id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
         owner_open_id,created_at,updated_at
       ) VALUES('g18-connection','personal','cli_g18','feishu',NULL,
         'active',1,'ou_g18owner',?,?)`,
    )
    .run(at, at);
  store.db
    .prepare(
      `INSERT INTO lark_connection_versions(
         id,connection_id,version,secret_ref,requested_config,
         capability_profile,missing_capabilities,state,created_at,updated_at
       ) VALUES('g18-version','g18-connection',1,?,'{}','{}','[]','active',?,?)`,
    )
    .run(secretRef, at, at);
  store.db
    .prepare(
      `INSERT INTO lark_bindings(
         id,workspace_id,connection_id,connection_version,binding_version,
         owner_open_id,target_chat_id,target_type,state,
         supersedes_binding_id,created_at
       ) VALUES('g18-binding','personal','g18-connection',1,1,
         'ou_g18owner','oc_g18owner','p2p','active',NULL,?)`,
    )
    .run(at);
  store.db
    .prepare(
      `INSERT INTO lark_targets(
         id,workspace_id,connection_id,binding_version,chat_id,target_type,
         purpose,capture_enabled,state,created_at,updated_at
       ) VALUES('g18-target','personal','g18-connection',1,
         'oc_g18owner','p2p','owner_notification',0,'active',?,?)`,
    )
    .run(at, at);
  const repository = new QualityRepository(store.db);
  const dataset = repository.createDataset({
    name: "g18",
    split: "dev",
    sourceUri: "https://example.test/wiki/g18",
    sourceRevisionId: "1",
    sourceDigest: stableDigest("g18"),
    targetCount: 1,
  });
  repository.addSamples(dataset.id, [sample(1)]);
  const quality = new QualityLarkAnnotationService(store, secrets);
  return { store, secrets, quality, datasetId: dataset.id };
}

const sessionState = (store: Store, sessionId: string) =>
  String(
    (
      store.db
        .prepare("SELECT state FROM quality_annotation_sessions WHERE id=?")
        .get(sessionId) as { state: string }
    ).state,
  );

const intentRow = (store: Store, sessionId: string, ordinal = 0) =>
  store.db
    .prepare(
      `SELECT id,state,last_error AS lastError,message_id AS messageId
       FROM delivery_intents WHERE annotation_session_id=?
       ORDER BY created_at,id`,
    )
    .all(sessionId)[ordinal] as
    | { id: string; state: string; lastError: string | null; messageId: string | null }
    | undefined;

/** Insert a second manual delivery intent tied to an existing session, to
 *  simulate a queued / in-flight card the service itself did not create. */
function insertManualIntent(
  fixture: Fixture,
  sessionId: string,
  state: string,
  at: string,
  options: { leaseExpiresAt?: string; messageId?: string } = {},
) {
  const changeId = randomUUID();
  fixture.store.db
    .prepare("INSERT INTO changes VALUES(?,?,?,?,?,?,?)")
    .run(changeId, "quality_annotation", "fixture intent", null, sessionId, "g18 fixture", at);
  const id = randomUUID();
  fixture.store.db
    .prepare(
      `INSERT INTO delivery_intents(
         id,workspace_id,change_id,channel_binding_version,channel,target,
         payload_digest,provider_uuid,state,created_at,updated_at,binding_id,
         payload_json,next_attempt_at,card_action_id,aggregation_mode,
         aggregate_after,superseded_by,annotation_session_id,
         lease_expires_at,message_id
       ) VALUES(?,?,?,1,'lark','oc_g18owner',?,? ,?, ?,?,'g18-binding','{}',?,NULL,'instant',NULL,NULL,?,?,?)`,
    )
    .run(
      id,
      "personal",
      changeId,
      stableDigest("g18-card"),
      stableDigest({ sessionId, fixture: id }).slice(0, 50),
      state,
      at,
      at,
      state === "pending" ? at : null,
      sessionId,
      options.leaseExpiresAt ?? null,
      options.messageId ?? null,
    );
  return id;
}

describe("G18 cancelling an annotation session revokes unsent cards", () => {
  it("cancel sweeps the queued intent in the same transaction; sender sends nothing", async () => {
    const fixture = setup();
    try {
      const session = fixture.quality.start(fixture.datasetId, "cli_g18");
      expect(intentRow(fixture.store, session.id)!.state).toBe("pending");
      fixture.quality.cancel(session.id);
      expect(sessionState(fixture.store, session.id)).toBe("cancelled");
      const row = intentRow(fixture.store, session.id)!;
      expect(row.state).toBe("cancelled");
      expect(row.lastError).toMatch(/cancelled before send/);

      const messages = new FakeMessages();
      const worker = new LarkDeliveryWorker(
        new LarkDeliveryRepository(fixture.store.db),
        fixture.secrets,
        messages,
        "g18-sender",
      );
      expect(await worker.processOne()).toEqual({ processed: false });
      expect(messages.sends).toHaveLength(0);
    } finally {
      fixture.store.close();
    }
  });

  it("keeps delivered history and does not recall an in-flight send", () => {
    const fixture = setup();
    try {
      const session = fixture.quality.start(fixture.datasetId, "cli_g18");
      const at = new Date().toISOString();
      // The first card already reached the user.
      fixture.store.db
        .prepare(
          "UPDATE delivery_intents SET state='delivered',message_id='om_seen' WHERE annotation_session_id=?",
        )
        .run(session.id);
      // A second card is currently in-flight with a lease in the future.
      const inFlightId = insertManualIntent(
        fixture,
        session.id,
        "sending",
        at,
        { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
      );
      fixture.quality.cancel(session.id);

      expect(sessionState(fixture.store, session.id)).toBe("cancelled");
      // User-visible history is preserved, not rewritten as if it were recalled.
      const delivered = intentRow(fixture.store, session.id, 0)!;
      expect(delivered.state).toBe("delivered");
      expect(delivered.messageId).toBe("om_seen");
      // The in-flight intent cannot be recalled mid-network; cancel leaves it to
      // its honest outcome (delivered / unknown-after-dedupe-window).
      const inFlight = fixture.store.db
        .prepare("SELECT state FROM delivery_intents WHERE id=?")
        .get(inFlightId) as { state: string };
      expect(inFlight.state).toBe("sending");
    } finally {
      fixture.store.close();
    }
  });

  it("sender suppresses a card even if a retry intent appears after cancellation", async () => {
    const fixture = setup();
    try {
      const session = fixture.quality.start(fixture.datasetId, "cli_g18");
      fixture.quality.cancel(session.id);
      // Simulate an intent that lands in the queue after the session was
      // cancelled (e.g. a retry_wait row resurfacing). The cancel sweep already
      // removed start()'s own intent; this one bypasses that sweep.
      const at = new Date().toISOString();
      insertManualIntent(fixture, session.id, "pending", at);

      const messages = new FakeMessages();
      const worker = new LarkDeliveryWorker(
        new LarkDeliveryRepository(fixture.store.db),
        fixture.secrets,
        messages,
        "g18-sender",
      );
      expect(await worker.processOne()).toEqual({ processed: false });
      expect(messages.sends).toHaveLength(0);
      // The sender-side guard flips the orphaned intent to cancelled.
      const rows = fixture.store.db
        .prepare(
          `SELECT state FROM delivery_intents
           WHERE annotation_session_id=? AND state='cancelled'`,
        )
        .all(sessionIdOf(fixture));
      expect(rows.length).toBeGreaterThanOrEqual(2);
    } finally {
      fixture.store.close();
    }
  });
});

// Small helper to avoid shadowing `session` in the last test.
function sessionIdOf(fixture: Fixture): string {
  return String(
    (
      fixture.store.db
        .prepare("SELECT id FROM quality_annotation_sessions ORDER BY created_at")
        .all()[0] as { id: string }
    ).id,
  );
}
