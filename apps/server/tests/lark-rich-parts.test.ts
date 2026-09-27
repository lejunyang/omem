import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LarkEventInbox,
  type LarkInboundEvent,
  type LarkMediaPort,
} from "../src/integrations/lark/realtime.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import { Store } from "../src/store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // windows may hold the sqlite file briefly
    }
  }
});

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), "omem-lark-parts-"));
  directories.push(directory);
  const store = new Store(directory);
  const secrets = new EncryptedSecretStore(
    join(directory, "secrets"),
    randomBytes(32),
  );
  const at = "2026-09-27T00:00:00.000Z";
  const secretRef = secrets.put({
    appId: "cli_parts1",
    clientSecret: "fixture-secret",
  });
  store.db
    .prepare(
      `INSERT INTO lark_connections(
         id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
         owner_open_id,created_at,updated_at
       ) VALUES('conn-parts','personal','cli_parts1','feishu',NULL,
         'active',1,'ou_owner',?,?)`,
    )
    .run(at, at);
  store.db
    .prepare(
      `INSERT INTO lark_connection_versions(
         id,connection_id,version,secret_ref,requested_config,capability_profile,
         missing_capabilities,state,created_at,updated_at
       ) VALUES('ver-parts','conn-parts',1,?,'{}',?,'[]','active',?,?)`,
    )
    .run(secretRef, JSON.stringify({ botOpenId: "ou_bot" }), at, at);
  store.db
    .prepare(
      `INSERT INTO lark_bindings(
         id,workspace_id,connection_id,connection_version,binding_version,
         owner_open_id,target_chat_id,target_type,state,supersedes_binding_id,
         created_at
       ) VALUES('bind-parts','personal','conn-parts',1,1,'ou_owner','oc_group','group',
         'active',NULL,?)`,
    )
    .run(at);
  return { directory, store, secrets };
};

const groupEvent = (patch: Partial<LarkInboundEvent>): LarkInboundEvent => ({
  appId: "cli_parts1",
  eventId: `evt-${Math.random()}`,
  kind: "im.message.receive_v1",
  eventTime: "2026-09-27T00:00:00.000Z",
  senderOpenId: "ou_member",
  senderType: "user",
  chatId: "oc_group",
  chatType: "group",
  messageId: `om-${Math.random()}`,
  messageType: "text",
  parentMessageId: null,
  text: "群消息",
  payload: { message: { content: JSON.stringify({ text: "群消息" }) } },
  ...patch,
});

const envelopeFor = (store: Store, eventId: string) =>
  JSON.parse(
    String(
      (
        store.db
          .prepare("SELECT envelope FROM input_events WHERE event_id=?")
          .get(eventId) as { envelope: string }
      ).envelope,
    ),
  );

class FakeMedia implements LarkMediaPort {
  calls: { appId: string; messageId: string; imageKey: string }[] = [];
  async downloadImage(input: {
    appId: string;
    messageId: string;
    imageKey: string;
  }) {
    this.calls.push(input);
    // A tiny valid-ish PNG fixture (magic bytes matter only at flush/capture).
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
    ]);
    return { dataBase64: bytes.toString("base64"), mimeType: "image/png" };
  }
}

describe("H-G15 Lark rich messages adapt to unified parts", () => {
  it("parses a post (rich text) into title + paragraph text parts", async () => {
    const { store } = setup();
    const inbox = new LarkEventInbox(store);
    const ev = groupEvent({
      eventId: "evt-post",
      messageId: "om_post",
      messageType: "post",
      text: undefined,
      payload: {
        message: {
          message_type: "post",
          content: JSON.stringify({
            title: "会议纪要",
            content: [
              [
                { tag: "text", text: "第一段正文" },
                { tag: "a", text: "链接", href: "https://example.com" },
              ],
              [
                { tag: "at", user_name: "张三" },
                { tag: "text", text: "收到" },
              ],
            ],
          }),
        },
      },
    });
    await inbox.processMessage(ev);
    const envelope = envelopeFor(store, "evt-post");
    const texts = envelope.parts.map((p: { type: string; text: string }) =>
      p.type === "text" ? p.text : `[${p.type}]`,
    );
    expect(texts).toEqual([
      "【标题】会议纪要",
      "第一段正文链接(https://example.com)",
      "@张三收到",
    ]);
    // Every part carries actor/time/event provenance.
    for (const part of envelope.parts) {
      expect(part.provenance).toMatchObject({
        actorExternalId: "ou_member",
        eventId: "evt-post",
        observedAt: "2026-09-27T00:00:00.000Z",
      });
    }
    store.close();
  });

  it("downloads an image message and stores an asset-backed image part", async () => {
    const { store } = setup();
    const media = new FakeMedia();
    const inbox = new LarkEventInbox(store, { media });
    const ev = groupEvent({
      eventId: "evt-image",
      messageId: "om_image",
      messageType: "image",
      text: undefined,
      payload: {
        message: {
          message_type: "image",
          content: JSON.stringify({ image_key: "img_v_fixture" }),
        },
      },
    });
    await inbox.processMessage(ev);
    expect(media.calls).toEqual([
      { appId: "cli_parts1", messageId: "om_image", imageKey: "img_v_fixture" },
    ]);
    const envelope = envelopeFor(store, "evt-image");
    expect(envelope.parts).toHaveLength(1);
    expect(envelope.parts[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(typeof envelope.parts[0].data).toBe("string");
    // Flush the batch through store.capture: bytes are hashed into an asset.
    // received_at is wall-clock, so advance `now` past the quiet window.
    store.inputs.flushReady((input) => store.capture(input), {
      now: new Date(Date.now() + 30_000),
    });
    const expectedHash = createHash("sha256")
      .update(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]),
      )
      .digest("hex");
    expect(store.asset(expectedHash)).not.toBeNull();
    store.close();
  });

  it("carries reply_to / quoted provenance on parts for a quoted message", async () => {
    const { store } = setup();
    const inbox = new LarkEventInbox(store);
    const ev = groupEvent({
      eventId: "evt-reply",
      messageId: "om_reply",
      parentMessageId: "om_parent_123",
      text: "回复内容",
      payload: {
        message: {
          parent_id: "om_parent_123",
          content: JSON.stringify({ text: "回复内容" }),
        },
      },
    });
    await inbox.processMessage(ev);
    const envelope = envelopeFor(store, "evt-reply");
    expect(envelope.parts).toHaveLength(1);
    expect(envelope.parts[0].provenance).toMatchObject({
      replyTo: "om_parent_123",
      quoted: true,
    });
    // Envelope-level quoted flag is also set for downstream aggregation.
    expect(envelope.provenance.quoted).toBe(true);
    store.close();
  });
});
