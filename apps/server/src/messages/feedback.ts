import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";

export const messageFeedbackInput = z
  .object({
    requestId: z.uuid(),
    text: z.string().trim().min(1).max(2000),
    scope: z.enum(["message", "conversation"]).default("message"),
  })
  .strict();

/** Owner corrections are saved originals, not direct writes to inferred facts. */
export class MessageFeedback {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS message_feedback(
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      scope TEXT NOT NULL, text TEXT NOT NULL, revision_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_feedback_source ON message_feedback(source_id);
      CREATE INDEX IF NOT EXISTS message_feedback_chat ON message_feedback(chat_id);`);
  }
  forSource(sourceId: string) {
    const revision = this.store.db
      .prepare(
        "SELECT json_extract(r.body,'$.context.conversationId') AS chat_id FROM sources s JOIN revisions r ON r.id=s.head WHERE s.id=?",
      )
      .get(sourceId);
    const chatId = String(revision?.chat_id ?? "");
    return this.store.db
      .prepare(
        `SELECT id,text,scope,revision_id AS revisionId,created_at AS at,
        'manual:message-feedback:' || id AS materialKey FROM message_feedback
      WHERE active=1 AND (source_id=? OR (scope='conversation' AND chat_id=?)) ORDER BY created_at,id`,
      )
      .all(sourceId, chatId);
  }
  history(sourceId: string) {
    return this.store.db
      .prepare(
        "SELECT id,text,scope,active,created_at AS at FROM message_feedback WHERE source_id=? ORDER BY created_at,id",
      )
      .all(sourceId);
  }
  save(messageId: string, input: z.infer<typeof messageFeedbackInput>) {
    const value = messageFeedbackInput.parse(input);
    return this.store.tx(() => {
      const row = this.store.db
        .prepare(
          "SELECT revision_id,chat_id,chat_name FROM personal_lark_messages WHERE id=?",
        )
        .get(messageId);
      if (!row?.revision_id) throw Error("请先保存原消息，再补充理解");
      const original = this.store.revision(String(row.revision_id))!;
      const previous = this.store.db
        .prepare("SELECT * FROM message_feedback WHERE id=?")
        .get(value.requestId);
      if (previous) {
        if (
          previous.source_id !== original.sourceId ||
          previous.text !== value.text ||
          previous.scope !== value.scope
        )
          throw Error("同一请求已保存不同反馈");
        return { id: value.requestId, duplicate: true };
      }
      const capture = this.store.capture(
        {
          source: "manual",
          externalId: `message-feedback:${value.requestId}`,
          title: `${row.chat_name}：我的纠正`,
          parts: [
            {
              type: "text",
              text: `针对消息：\n${original.fragments.map((f) => f.text).join("\n")}\n\n我的纠正：\n${value.text}`,
            },
          ],
          context: {
            conversationId: String(row.chat_id),
            event: "message-feedback",
          },
          provenance: {
            collectorId: "web-owner",
            actorId: "owner",
            actorPrincipalId: "owner",
            actorType: "owner",
            actorVerifiedBy: "owner-session",
            producerKind: "original",
            sourceUri: null,
            eventId: value.requestId,
            eventAt: new Date().toISOString(),
            timezone: "Asia/Shanghai",
            quoted: false,
            forwarded: false,
          },
        },
        { learning: false, notify: false },
      );
      this.store.db
        .prepare("INSERT INTO message_feedback VALUES(?,?,?,?,?,?,1,?)")
        .run(
          value.requestId,
          original.sourceId,
          String(row.chat_id),
          value.scope,
          value.text,
          capture.revision.id,
          new Date().toISOString(),
        );
      const job = this.reconsider(original.sourceId, value.requestId);
      return {
        id: value.requestId,
        revisionId: capture.revision.id,
        jobId: job.job.id,
        duplicate: false,
      };
    });
  }
  revoke(id: string) {
    return this.store.tx(() => {
      const row = this.store.db
        .prepare("SELECT * FROM message_feedback WHERE id=? AND active=1")
        .get(id);
      if (!row) throw Error("这条纠正已撤销或不存在");
      this.store.db
        .prepare("UPDATE message_feedback SET active=0 WHERE id=?")
        .run(id);
      return this.reconsider(String(row.source_id), randomUUID());
    });
  }
  retry(messageId: string) {
    return this.store.tx(() => {
      const row = this.store.db
        .prepare("SELECT revision_id FROM personal_lark_messages WHERE id=?")
        .get(messageId);
      const revision =
        row?.revision_id && this.store.revision(String(row.revision_id));
      if (!revision) throw Error("原消息尚未保存，先重新读取资源");
      return this.reconsider(revision.sourceId, randomUUID());
    });
  }
  private reconsider(sourceId: string, feedbackId: string) {
    const source = this.store.db
      .prepare("SELECT head FROM sources WHERE id=?")
      .get(sourceId)!;
    const state = this.store.db
      .prepare("SELECT validity_epoch FROM source_state WHERE source_id=?")
      .get(sourceId)!;
    return this.store.jobs.enqueueInCurrentTransaction({
      kind: "extract_claims",
      inputRefs: [
        {
          sourceId,
          revisionId: source.head,
          validityEpoch: Number(state.validity_epoch),
          feedbackId,
        },
      ],
      roleVersion: "extractor@1",
      policyVersion: "memory-policy@1",
      cause: "owner_correction",
    });
  }
}
