import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  captureSchema,
  type CaptureInput,
} from "../../../../packages/contracts/src/index.js";
import { stableDigest } from "../storage/digest.js";

type Row = Record<string, unknown>;
type CaptureResult = {
  revision: { id: string };
  job: { id: string } | null;
};

export type AggregationOptions = {
  quietMs?: number;
  maxWindowMs?: number;
  maxEvents?: number;
  now?: Date;
};

const iso = (date: Date) => date.toISOString();

export class InputAggregator {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private streamKey(input: CaptureInput) {
    if (input.source === "chat") {
      if (!input.context.conversationId)
        throw Error("CHAT_CONVERSATION_ID_REQUIRED");
      return input.context.conversationId;
    }
    if (input.source === "screen")
      return [
        input.context.application || "unknown-application",
        input.context.windowTitle || "unknown-window",
      ].join(":");
    throw Error("AGGREGATION_SOURCE_MUST_BE_CHAT_OR_SCREEN");
  }

  ingest(input: CaptureInput, now = new Date()) {
    const eventId = input.provenance?.eventId;
    const producer = input.provenance?.collectorId;
    if (!eventId || !producer) throw Error("INPUT_EVENT_ID_REQUIRED");
    const streamKey = this.streamKey(input);
    const payloadDigest = stableDigest(input);
    const contentDigest = stableDigest({
      source: input.source,
      title: input.title,
      parts: input.parts,
      context: input.context,
    });
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT * FROM input_events
           WHERE workspace_id='personal' AND producer=? AND event_id=?`,
        )
        .get(producer, eventId) as Row | undefined;
      if (existing) {
        if (existing.payload_digest !== payloadDigest)
          throw Error("INPUT_EVENT_CONFLICT");
        return {
          id: String(existing.id),
          eventId,
          state: String(existing.state),
          duplicate: true,
        };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO input_events(
             id,workspace_id,source,producer,stream_key,event_id,payload_digest,
             content_digest,envelope,observed_at,received_at,state,batch_id
           ) VALUES(?,'personal',?,?,?,?,?,?,?,?,?,'pending',NULL)`,
        )
        .run(
          id,
          input.source,
          producer,
          streamKey,
          eventId,
          payloadDigest,
          contentDigest,
          JSON.stringify(input),
          input.observedAt ?? input.provenance?.eventAt ?? null,
          iso(now),
        );
      return { id, eventId, state: "pending", duplicate: false };
    });
  }

  pendingCount() {
    return Number(
      (
        this.db
          .prepare(
            "SELECT count(*) AS count FROM input_events WHERE state='pending'",
          )
          .get() as { count: number }
      ).count,
    );
  }

  batches() {
    return this.db
      .prepare("SELECT * FROM input_batches ORDER BY created_at")
      .all() as Row[];
  }

  private readyStreams(options: AggregationOptions) {
    const now = options.now ?? new Date();
    const quietCutoff = iso(
      new Date(now.getTime() - (options.quietMs ?? 15_000)),
    );
    const windowCutoff = iso(
      new Date(now.getTime() - (options.maxWindowMs ?? 300_000)),
    );
    const maxEvents = Math.max(1, Math.min(options.maxEvents ?? 50, 500));
    return this.db
      .prepare(
        `SELECT workspace_id,source,stream_key,MIN(received_at) AS first_received,
           MAX(received_at) AS last_received,COUNT(*) AS event_count
         FROM input_events WHERE state='pending'
         GROUP BY workspace_id,source,stream_key
         HAVING last_received<=? OR first_received<=? OR event_count>=?
         ORDER BY first_received`,
      )
      .all(quietCutoff, windowCutoff, maxEvents) as Row[];
  }

  private selectBatchEvents(stream: Row, maxEvents: number) {
    const candidates = this.db
      .prepare(
        `SELECT * FROM input_events
         WHERE workspace_id=? AND source=? AND stream_key=? AND state='pending'
         ORDER BY received_at,id LIMIT ?`,
      )
      .all(
        String(stream.workspace_id),
        String(stream.source),
        String(stream.stream_key),
        Math.max(1, Math.min(maxEvents, 500)),
      ) as Row[];
    const selected: Row[] = [];
    const contentDigests = new Set<string>();
    let partCount = 0;
    for (const event of candidates) {
      const envelope = captureSchema.parse(JSON.parse(String(event.envelope)));
      const duplicateContent = contentDigests.has(String(event.content_digest));
      const extraParts = duplicateContent ? 0 : envelope.parts.length;
      if (selected.length && partCount + extraParts > 50) break;
      if (!selected.length && extraParts > 50)
        throw Error("AGGREGATION_PART_BUDGET_EXCEEDED");
      selected.push(event);
      if (!duplicateContent) {
        contentDigests.add(String(event.content_digest));
        partCount += extraParts;
      }
    }
    return selected;
  }

  private envelopeFor(stream: Row, events: Row[]) {
    const parsed = events.map((event) =>
      captureSchema.parse(JSON.parse(String(event.envelope))),
    );
    const unique = new Set<string>();
    const parts: CaptureInput["parts"] = [];
    for (let index = 0; index < parsed.length; index++) {
      const digest = String(events[index]!.content_digest);
      if (unique.has(digest)) continue;
      unique.add(digest);
      parts.push(...parsed[index]!.parts);
    }
    const eventIds = events.map(
      (event) => `${String(event.producer)}:${String(event.event_id)}`,
    );
    const rowIds = events.map((event) => String(event.id));
    const observed = events.map((event) =>
      String(event.observed_at || event.received_at),
    );
    const previous = this.db
      .prepare(
        `SELECT * FROM input_batches
         WHERE workspace_id=? AND source=? AND stream_key=?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(
        String(stream.workspace_id),
        String(stream.source),
        String(stream.stream_key),
      ) as Row | undefined;
    const lateForBatchId =
      previous &&
      observed.some(
        (eventTime) =>
          previous.last_observed_at &&
          eventTime <= String(previous.last_observed_at),
      )
        ? String(previous.id)
        : null;
    const batchId = `batch-${stableDigest({
      workspaceId: stream.workspace_id,
      source: stream.source,
      streamKey: stream.stream_key,
      eventIds,
    })}`;
    const latest = parsed.at(-1)!;
    const actorIds = new Set(parsed.map((event) => event.provenance?.actorId));
    const actorTypes = new Set(
      parsed.map((event) => event.provenance?.actorType),
    );
    const verifiedBy = new Set(
      parsed.map((event) => event.provenance?.actorVerifiedBy),
    );
    const actorStable =
      actorIds.size === 1 && actorTypes.size === 1 && verifiedBy.size === 1;
    const firstObservedAt = observed.reduce((left, right) =>
      left < right ? left : right,
    );
    const lastObservedAt = observed.reduce((left, right) =>
      left > right ? left : right,
    );
    const envelope = captureSchema.parse({
      source: stream.source,
      externalId: batchId,
      title: `${latest.title}（${events.length} 条事件）`,
      observedAt: lastObservedAt,
      parts,
      context: {
        ...latest.context,
        aggregation: {
          eventIds,
          windowStartedAt: firstObservedAt,
          windowEndedAt: lastObservedAt,
          lateForBatchId,
        },
      },
      provenance: {
        collectorId: "omem-input-aggregator",
        actorId: actorStable ? (latest.provenance?.actorId ?? null) : null,
        actorType: actorStable
          ? (latest.provenance?.actorType ?? "unknown")
          : "unknown",
        actorVerifiedBy: actorStable
          ? (latest.provenance?.actorVerifiedBy ?? null)
          : null,
        sourceUri: latest.provenance?.sourceUri ?? null,
        eventId: batchId,
        eventAt: lastObservedAt,
        timezone: latest.provenance?.timezone ?? null,
        quoted: parsed.some((event) => event.provenance?.quoted),
        forwarded: parsed.some((event) => event.provenance?.forwarded),
        producerKind: "original",
      },
    });
    return {
      batchId,
      eventIds,
      rowIds,
      firstObservedAt,
      lastObservedAt,
      lateForBatchId,
      envelope,
    };
  }

  flushReady(
    capture: (input: CaptureInput) => CaptureResult,
    options: AggregationOptions = {},
  ) {
    const maxEvents = Math.max(1, Math.min(options.maxEvents ?? 50, 500));
    const results: {
      batchId: string;
      revisionId: string;
      jobId: string | null;
      eventIds: string[];
      lateForBatchId: string | null;
    }[] = [];
    for (const stream of this.readyStreams(options)) {
      const events = this.selectBatchEvents(stream, maxEvents);
      if (!events.length) continue;
      const batch = this.envelopeFor(stream, events);
      const captured = capture(batch.envelope);
      const createdAt = iso(options.now ?? new Date());
      this.transaction(() => {
        const placeholders = batch.rowIds.map(() => "?").join(",");
        const stillPending = Number(
          (
            this.db
              .prepare(
                `SELECT count(*) AS count FROM input_events
                 WHERE workspace_id=? AND source=? AND stream_key=?
                   AND state='pending' AND id IN (${placeholders})`,
              )
              .get(
                String(stream.workspace_id),
                String(stream.source),
                String(stream.stream_key),
                ...batch.rowIds,
              ) as { count: number }
          ).count,
        );
        if (stillPending !== batch.eventIds.length)
          throw Error("INPUT_BATCH_CHANGED");
        this.db
          .prepare(
            `INSERT OR IGNORE INTO input_batches(
               id,workspace_id,source,stream_key,event_ids,first_observed_at,
               last_observed_at,first_received_at,last_received_at,
               late_for_batch_id,revision_id,job_id,created_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            batch.batchId,
            String(stream.workspace_id),
            String(stream.source),
            String(stream.stream_key),
            JSON.stringify(batch.eventIds),
            batch.firstObservedAt,
            batch.lastObservedAt,
            String(events[0]!.received_at),
            String(events.at(-1)!.received_at),
            batch.lateForBatchId,
            captured.revision.id,
            captured.job?.id ?? null,
            createdAt,
          );
        this.db
          .prepare(
            `UPDATE input_events SET state='batched',batch_id=?
             WHERE workspace_id=? AND source=? AND stream_key=?
               AND state='pending' AND id IN (${placeholders})`,
          )
          .run(
            batch.batchId,
            String(stream.workspace_id),
            String(stream.source),
            String(stream.stream_key),
            ...batch.rowIds,
          );
      });
      results.push({
        batchId: batch.batchId,
        revisionId: captured.revision.id,
        jobId: captured.job?.id ?? null,
        eventIds: batch.eventIds,
        lateForBatchId: batch.lateForBatchId,
      });
    }
    return results;
  }
}
