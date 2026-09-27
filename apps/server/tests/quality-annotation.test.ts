import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LarkDeliveryRepository,
  LarkDeliveryWorker,
  type LarkMessageAdapter,
} from "../src/integrations/lark/delivery.js";
import type { LarkInboundEvent } from "../src/integrations/lark/realtime.js";
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
    return { messageId: "om_quality_card" };
  }
  async update() {}
}

const sample = (ordinal: number) => {
  const text = `规则 ${ordinal}：一个主体只能有一个主账号。`;
  return {
    input: {
      source: {
        uri: "https://example.test/wiki/source",
        documentId: "doc-source",
        revisionId: "1",
        fragmentId: `fragment-${ordinal}`,
        section: "账号类型与额度限制",
      },
      category: "explicit" as const,
      text,
      provenance: {
        actorId: null,
        actorVerified: false,
        forwarded: false,
      },
    },
    draftLabel: {
      disposition: "extract" as const,
      objects: [
        {
          kind: "claim" as const,
          statement: text,
          evidenceQuote: text,
        },
      ],
      autoApply: true,
      forbiddenEffects: ["不得执行外部操作"],
      notes: "待人工确认",
    },
  };
};

describe("B2-08 owner quality annotation", () => {
  it("maps the skip action to the persisted skipped state", () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-quality-skip-"));
    directories.push(directory);
    const store = new Store(directory);
    try {
      const repository = new QualityRepository(store.db);
      const dataset = repository.createDataset({
        name: "quality-skip",
        split: "dev",
        sourceUri: "https://example.test/wiki/source",
        sourceRevisionId: "1",
        sourceDigest: stableDigest("skip-source"),
        targetCount: 1,
      });
      repository.addSamples(dataset.id, [sample(1)]);
      const pending = repository.samples(dataset.id)[0]!;
      expect(
        repository.label({
          sampleId: pending.id,
          action: "skip",
          reviewerOpenId: "ou_qualityowner",
          expectedLabelDigest: pending.labelDigest,
        }),
      ).toEqual({ state: "skipped", confirmedLabel: null });
      expect(repository.progress(dataset.id)).toEqual({ skipped: 1 });
      const revised = repository.revise({
        sampleId: pending.id,
        expectedLabelDigest: pending.labelDigest,
        label: {
          ...pending.draftLabel,
          autoApply: false,
          notes: "人工修正后重新入队",
        },
      });
      expect(revised).toMatchObject({ state: "pending" });
      expect(revised.labelDigest).not.toBe(pending.labelDigest);
      expect(repository.progress(dataset.id)).toEqual({ pending: 1 });
    } finally {
      store.close();
    }
  });

  it("sends one project card and advances only authenticated, non-replayed labels", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-quality-"));
    directories.push(directory);
    const store = new Store(directory);
    const secrets = new EncryptedSecretStore(
      join(directory, "secrets"),
      randomBytes(32),
    );
    const secretRef = secrets.put({
      appId: "cli_quality1",
      clientSecret: "quality-fixture-secret",
    });
    const at = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO lark_connections(
           id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
           owner_open_id,created_at,updated_at
         ) VALUES('quality-connection','personal','cli_quality1','feishu',NULL,
           'active',1,'ou_qualityowner',?,?)`,
      )
      .run(at, at);
    store.db
      .prepare(
        `INSERT INTO lark_connection_versions(
           id,connection_id,version,secret_ref,requested_config,
           capability_profile,missing_capabilities,state,created_at,updated_at
         ) VALUES('quality-version','quality-connection',1,?,'{}','{}','[]',
           'active',?,?)`,
      )
      .run(secretRef, at, at);
    store.db
      .prepare(
        `INSERT INTO lark_bindings(
           id,workspace_id,connection_id,connection_version,binding_version,
           owner_open_id,target_chat_id,target_type,state,
           supersedes_binding_id,created_at
         ) VALUES('quality-binding','personal','quality-connection',1,1,
           'ou_qualityowner','oc_qualityowner','p2p','active',NULL,?)`,
      )
      .run(at);
    store.db
      .prepare(
        `INSERT INTO lark_targets(
           id,workspace_id,connection_id,binding_version,chat_id,target_type,
           purpose,capture_enabled,state,created_at,updated_at
         ) VALUES('quality-target','personal','quality-connection',1,
           'oc_qualityowner','p2p','owner_notification',0,'active',?,?)`,
      )
      .run(at, at);

    const repository = new QualityRepository(store.db);
    const dataset = repository.createDataset({
      name: "quality-dev",
      split: "dev",
      sourceUri: "https://example.test/wiki/source",
      sourceRevisionId: "1",
      sourceDigest: stableDigest("source"),
      targetCount: 2,
    });
    expect(repository.addSamples(dataset.id, [sample(1), sample(2)])).toEqual({
      inserted: 2,
    });
    const quality = new QualityLarkAnnotationService(store, secrets);
    const session = quality.start(dataset.id, "cli_quality1");
    const messages = new FakeMessages();
    const delivery = new LarkDeliveryWorker(
      new LarkDeliveryRepository(store.db),
      secrets,
      messages,
      "quality-sender",
    );
    expect(await delivery.processOne()).toMatchObject({
      processed: true,
      state: "delivered",
      messageId: "om_quality_card",
    });
    const firstCard = messages.sends[0]!.card as any;
    const firstValue =
      firstCard.body.elements[1].columns[0].elements[0].behaviors[0].value;
    expect(firstValue).toMatchObject({
      protocol: "omem.quality.v1",
      action: "confirm",
    });
    expect(JSON.stringify(firstCard)).not.toContain("quality-fixture-secret");

    const event = (
      eventId: string,
      value: unknown,
      senderOpenId = "ou_qualityowner",
    ): LarkInboundEvent => ({
      appId: "cli_quality1",
      eventId,
      kind: "card.action.trigger",
      eventTime: new Date().toISOString(),
      senderOpenId,
      senderType: "user",
      chatId: "oc_qualityowner",
      chatType: "p2p",
      messageId: "om_quality_card",
      payload: { action: { value } },
    });
    expect(
      quality.handle(event("quality-forged", firstValue, "ou_attacker")),
    ).toMatchObject({ accepted: false, reason: "QUALITY_ACTION_REJECTED" });
    expect(repository.progress(dataset.id)).toEqual({ pending: 2 });

    const first = quality.handle(event("quality-event-1", firstValue));
    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(repository.progress(dataset.id)).toEqual({
      confirmed: 1,
      pending: 1,
    });
    expect(quality.handle(event("quality-event-1", firstValue))).toMatchObject({
      accepted: true,
      duplicate: true,
    });

    const nextCard = first.card as any;
    const abstainValue =
      nextCard.body.elements[1].columns[1].elements[0].behaviors[0].value;
    const second = quality.handle(event("quality-event-2", abstainValue));
    expect(second).toMatchObject({ accepted: true, duplicate: false });
    expect(repository.progress(dataset.id)).toEqual({ confirmed: 2 });
    expect(
      store.db
        .prepare(
          "SELECT state,current_sample_id FROM quality_annotation_sessions WHERE id=?",
        )
        .get(session.id),
    ).toEqual({ state: "completed", current_sample_id: null });
    expect(repository.freeze(dataset.id)).toMatchObject({
      datasetId: dataset.id,
    });
    expect(repository.datasets()).toMatchObject([
      { state: "frozen", sampleCount: 2, confirmedCount: 2 },
    ]);
    store.close();
  });
});
