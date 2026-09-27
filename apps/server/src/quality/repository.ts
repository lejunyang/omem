import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { stableDigest } from "../storage/digest.js";

type Row = Record<string, unknown>;

export const qualitySampleInputSchema = z
  .object({
    source: z
      .object({
        uri: z.string().min(1).max(2000),
        documentId: z.string().min(1).max(500),
        revisionId: z.string().min(1).max(500),
        fragmentId: z.string().min(1).max(500),
        section: z.string().min(1).max(500),
      })
      .strict(),
    category: z.enum([
      "explicit",
      "ambiguous",
      "forwarded",
      "conflict",
      "time",
      "image",
      "unsafe",
    ]),
    text: z.string().min(1).max(20_000),
    provenance: z
      .object({
        actorId: z.string().min(1).max(300).nullable(),
        actorVerified: z.boolean(),
        forwarded: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const qualityLabelSchema = z
  .object({
    disposition: z.enum(["extract", "abstain", "needs_context"]),
    objects: z
      .array(
        z
          .object({
            kind: z.enum(["task", "claim", "episode", "procedure"]),
            statement: z.string().min(1).max(4000),
            evidenceQuote: z.string().min(1).max(20_000),
            ownerId: z.string().min(1).max(300).nullable().optional(),
            dueAt: z.string().datetime({ offset: true }).nullable().optional(),
            dueExpression: z.string().max(500).nullable().optional(),
          })
          .strict(),
      )
      .max(20),
    autoApply: z.boolean(),
    forbiddenEffects: z.array(z.string().min(1).max(1000)).max(20),
    notes: z.string().max(2000),
  })
  .strict()
  .superRefine((label, context) => {
    if (label.disposition === "extract" && !label.objects.length)
      context.addIssue({
        code: "custom",
        path: ["objects"],
        message: "extract labels require at least one object",
      });
    if (label.disposition !== "extract" && label.autoApply)
      context.addIssue({
        code: "custom",
        path: ["autoApply"],
        message: "non-extract labels cannot auto apply",
      });
  });

export type QualitySampleInput = z.infer<typeof qualitySampleInputSchema>;
export type QualityLabel = z.infer<typeof qualityLabelSchema>;

export type QualitySample = {
  id: string;
  datasetId: string;
  ordinal: number;
  inputDigest: string;
  input: QualitySampleInput;
  draftLabel: QualityLabel;
  confirmedLabel: QualityLabel | null;
  labelDigest: string;
  state: "pending" | "confirmed" | "needs_edit" | "skipped";
  reviewerOpenId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const sampleFromRow = (row: Row): QualitySample => ({
  id: String(row.id),
  datasetId: String(row.dataset_id),
  ordinal: Number(row.ordinal),
  inputDigest: String(row.input_digest),
  input: qualitySampleInputSchema.parse(JSON.parse(String(row.input_json))),
  draftLabel: qualityLabelSchema.parse(
    JSON.parse(String(row.draft_label_json)),
  ),
  confirmedLabel: row.confirmed_label_json
    ? qualityLabelSchema.parse(JSON.parse(String(row.confirmed_label_json)))
    : null,
  labelDigest: String(row.label_digest),
  state: String(row.state) as QualitySample["state"],
  reviewerOpenId: row.reviewer_open_id ? String(row.reviewer_open_id) : null,
  reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class QualityRepository {
  constructor(readonly db: DatabaseSync) {}

  createDataset(input: {
    name: string;
    split: "dev" | "holdout";
    sourceUri: string;
    sourceRevisionId?: string | null;
    sourceDigest: string;
    targetCount: number;
  }) {
    const existing = this.db
      .prepare(
        `SELECT id FROM quality_datasets
         WHERE name=? AND split=? AND source_digest=?`,
      )
      .get(input.name, input.split, input.sourceDigest) as Row | undefined;
    if (existing) return { id: String(existing.id), duplicate: true };
    const id = randomUUID();
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO quality_datasets(
           id,name,split,state,source_uri,source_revision_id,source_digest,
           target_count,created_at,frozen_at,manifest_digest
         ) VALUES(?,?,?,'draft',?,?,?,?,?,NULL,NULL)`,
      )
      .run(
        id,
        input.name,
        input.split,
        input.sourceUri,
        input.sourceRevisionId ?? null,
        input.sourceDigest,
        input.targetCount,
        at,
      );
    return { id, duplicate: false };
  }

  addSamples(
    datasetId: string,
    samples: { input: QualitySampleInput; draftLabel: QualityLabel }[],
  ) {
    const dataset = this.db
      .prepare("SELECT state FROM quality_datasets WHERE id=?")
      .get(datasetId) as Row | undefined;
    if (!dataset) throw Error("QUALITY_DATASET_NOT_FOUND");
    if (!["draft", "labeling"].includes(String(dataset.state)))
      throw Error("QUALITY_DATASET_FROZEN");
    const start = Number(
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM quality_samples WHERE dataset_id=?",
          )
          .get(datasetId) as { ordinal: number }
      ).ordinal,
    );
    let inserted = 0;
    const at = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      samples.forEach((candidate, index) => {
        const input = qualitySampleInputSchema.parse(candidate.input);
        const draftLabel = qualityLabelSchema.parse(candidate.draftLabel);
        const inputDigest = stableDigest(input);
        const labelDigest = stableDigest(draftLabel);
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO quality_samples(
               id,dataset_id,ordinal,input_digest,input_json,draft_label_json,
               confirmed_label_json,label_digest,state,reviewer_open_id,
               reviewed_at,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,NULL,?,'pending',NULL,NULL,?,?)`,
          )
          .run(
            randomUUID(),
            datasetId,
            start + index + 1,
            inputDigest,
            JSON.stringify(input),
            JSON.stringify(draftLabel),
            labelDigest,
            at,
            at,
          );
        inserted += Number(result.changes);
      });
      this.db
        .prepare(
          "UPDATE quality_datasets SET state='labeling' WHERE id=? AND state='draft'",
        )
        .run(datasetId);
      this.db.exec("COMMIT");
      return { inserted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  datasets() {
    return this.db
      .prepare(
        `SELECT d.id,d.name,d.split,d.state,d.source_uri AS sourceUri,
           d.source_revision_id AS sourceRevisionId,d.source_digest AS sourceDigest,
           d.target_count AS targetCount,d.manifest_digest AS manifestDigest,
           d.created_at AS createdAt,d.frozen_at AS frozenAt,
           count(s.id) AS sampleCount,
           sum(CASE WHEN s.state='confirmed' THEN 1 ELSE 0 END) AS confirmedCount,
           sum(CASE WHEN s.state='needs_edit' THEN 1 ELSE 0 END) AS needsEditCount
         FROM quality_datasets d LEFT JOIN quality_samples s ON s.dataset_id=d.id
         GROUP BY d.id ORDER BY d.created_at`,
      )
      .all();
  }

  dataset(datasetId: string) {
    return (
      (this.datasets() as Row[]).find((row) => row.id === datasetId) ?? null
    );
  }

  samples(datasetId: string) {
    return (
      this.db
        .prepare(
          "SELECT * FROM quality_samples WHERE dataset_id=? ORDER BY ordinal",
        )
        .all(datasetId) as Row[]
    ).map(sampleFromRow);
  }

  sample(sampleId: string) {
    const row = this.db
      .prepare("SELECT * FROM quality_samples WHERE id=?")
      .get(sampleId) as Row | undefined;
    return row ? sampleFromRow(row) : null;
  }

  nextPending(datasetId: string) {
    const row = this.db
      .prepare(
        `SELECT * FROM quality_samples WHERE dataset_id=? AND state='pending'
         ORDER BY ordinal LIMIT 1`,
      )
      .get(datasetId) as Row | undefined;
    return row ? sampleFromRow(row) : null;
  }

  progress(datasetId: string) {
    const rows = this.db
      .prepare(
        `SELECT state,count(*) AS count FROM quality_samples
         WHERE dataset_id=? GROUP BY state`,
      )
      .all(datasetId) as { state: string; count: number }[];
    return Object.fromEntries(
      rows.map((row) => [row.state, Number(row.count)]),
    );
  }

  label(input: {
    sampleId: string;
    action: "confirm" | "abstain" | "needs_edit" | "skip";
    reviewerOpenId: string;
    expectedLabelDigest: string;
  }) {
    const sample = this.sample(input.sampleId);
    if (!sample) throw Error("QUALITY_SAMPLE_NOT_FOUND");
    if (sample.state !== "pending")
      throw Error("QUALITY_SAMPLE_ALREADY_REVIEWED");
    if (sample.labelDigest !== input.expectedLabelDigest)
      throw Error("QUALITY_LABEL_STALE");
    const at = new Date().toISOString();
    const confirmed =
      input.action === "confirm"
        ? sample.draftLabel
        : input.action === "abstain"
          ? qualityLabelSchema.parse({
              disposition: "abstain",
              objects: [],
              autoApply: false,
              forbiddenEffects: sample.draftLabel.forbiddenEffects,
              notes: "Human reviewer marked this sample as abstain.",
            })
          : null;
    const state =
      input.action === "confirm" || input.action === "abstain"
        ? "confirmed"
        : input.action === "skip"
          ? "skipped"
          : "needs_edit";
    const changed = this.db
      .prepare(
        `UPDATE quality_samples SET state=?,confirmed_label_json=?,
           reviewer_open_id=?,reviewed_at=?,updated_at=?
         WHERE id=? AND state='pending' AND label_digest=?`,
      )
      .run(
        state,
        confirmed ? JSON.stringify(confirmed) : null,
        input.reviewerOpenId,
        at,
        at,
        input.sampleId,
        input.expectedLabelDigest,
      );
    if (Number(changed.changes) !== 1) throw Error("QUALITY_SAMPLE_STALE");
    return { state, confirmedLabel: confirmed };
  }

  revise(input: {
    sampleId: string;
    expectedLabelDigest: string;
    label: QualityLabel;
  }) {
    const sample = this.sample(input.sampleId);
    if (!sample) throw Error("QUALITY_SAMPLE_NOT_FOUND");
    if (!["pending", "needs_edit", "skipped"].includes(sample.state))
      throw Error("QUALITY_SAMPLE_ALREADY_CONFIRMED");
    if (sample.labelDigest !== input.expectedLabelDigest)
      throw Error("QUALITY_LABEL_STALE");
    const label = qualityLabelSchema.parse(input.label);
    const labelDigest = stableDigest(label);
    const changed = this.db
      .prepare(
        `UPDATE quality_samples SET draft_label_json=?,label_digest=?,
           confirmed_label_json=NULL,state='pending',reviewer_open_id=NULL,
           reviewed_at=NULL,updated_at=? WHERE id=? AND label_digest=?`,
      )
      .run(
        JSON.stringify(label),
        labelDigest,
        new Date().toISOString(),
        sample.id,
        input.expectedLabelDigest,
      );
    if (Number(changed.changes) !== 1) throw Error("QUALITY_SAMPLE_STALE");
    return { id: sample.id, state: "pending", labelDigest };
  }

  freeze(datasetId: string) {
    const dataset = this.db
      .prepare("SELECT * FROM quality_datasets WHERE id=?")
      .get(datasetId) as Row | undefined;
    if (!dataset) throw Error("QUALITY_DATASET_NOT_FOUND");
    const samples = this.samples(datasetId);
    if (
      samples.length !== Number(dataset.target_count) ||
      samples.some((sample) => sample.state !== "confirmed")
    )
      throw Error("QUALITY_DATASET_NOT_FULLY_CONFIRMED");
    const manifestDigest = stableDigest(
      samples.map((sample) => ({
        ordinal: sample.ordinal,
        inputDigest: sample.inputDigest,
        labelDigest: stableDigest(sample.confirmedLabel),
      })),
    );
    const at = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE quality_datasets SET state='frozen',manifest_digest=?,frozen_at=?
         WHERE id=? AND state='labeling'`,
      )
      .run(manifestDigest, at, datasetId);
    return { datasetId, manifestDigest, frozenAt: at };
  }

  verifyFrozen(datasetId: string) {
    const dataset = this.dataset(datasetId);
    if (!dataset) throw Error("QUALITY_DATASET_NOT_FOUND");
    if (dataset.state !== "frozen" || !dataset.manifestDigest)
      throw Error("QUALITY_DATASET_NOT_FROZEN");
    const samples = this.samples(datasetId);
    const actual = stableDigest(
      samples.map((sample) => ({
        ordinal: sample.ordinal,
        inputDigest: sample.inputDigest,
        labelDigest: stableDigest(sample.confirmedLabel),
      })),
    );
    if (actual !== dataset.manifestDigest)
      throw Error("QUALITY_DATASET_INTEGRITY_FAILED");
    return { dataset, samples, manifestDigest: actual };
  }
}
