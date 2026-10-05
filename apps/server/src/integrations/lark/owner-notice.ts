import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { stableDigest } from "../../storage/digest.js";
const digest = stableDigest;
type Row = Record<string, unknown>;
/** Shared owner-only outbox. Delivery remains owned by the existing bot worker. */
export function queueOwnerNotice(
  db: DatabaseSync,
  changeId: string,
  title: string,
  body: string,
  createdAt: string,
  timing: { mode: "instant" | "window" | "scheduled"; after: string } = {
    mode: "instant",
    after: createdAt,
  },
  workspaceId = "personal",
) {
  const larkTargets = db
    .prepare(
      `SELECT t.chat_id,t.binding_version,b.id AS binding_id
           FROM lark_targets t JOIN lark_bindings b
             ON b.connection_id=t.connection_id
            AND b.binding_version=t.binding_version
           JOIN lark_connections c ON c.id=t.connection_id
           WHERE t.workspace_id=? AND t.purpose='owner_notification'
             AND t.state='active' AND b.state='active' AND c.state='active'`,
    )
    .all(workspaceId) as Row[];
  for (const target of larkTargets) {
    const payload = {
      schema: "2.0",
      config: { width_mode: "default" },
      header: {
        title: { tag: "plain_text", content: title.slice(0, 100) },
        template: "green",
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: body.slice(0, 8000),
          },
        ],
      },
    };
    const payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson) > 30_000)
      throw Error("LARK_CARD_PAYLOAD_TOO_LARGE");
    const intentId = randomUUID();
    db.prepare(
      `INSERT INTO delivery_intents(
               id,workspace_id,change_id,channel_binding_version,channel,target,
               payload_digest,provider_uuid,state,created_at,updated_at,
               binding_id,payload_json,next_attempt_at,aggregation_mode,
               aggregate_after
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      intentId,
      workspaceId,
      changeId,
      Number(target.binding_version),
      "lark",
      String(target.chat_id),
      stableDigest(payload),
      digest({ changeId, target: target.chat_id }).slice(0, 50),
      "pending",
      createdAt,
      createdAt,
      String(target.binding_id),
      payloadJson,
      timing.after,
      timing.mode,
      timing.after,
    );
    db.prepare(
      `INSERT INTO delivery_intent_changes(intent_id,change_id,ordinal)
             VALUES(?,?,0)`,
    ).run(intentId, changeId);
  }
}
