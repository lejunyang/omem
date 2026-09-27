import { z } from "zod";
import { qualityLabelSchema, type QualitySample } from "./repository.js";

export const qualityPredictionSchema = z
  .object({
    sampleId: z.string().uuid(),
    prediction: qualityLabelSchema,
    durationMs: z.number().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().nullable().optional(),
    outputTokens: z.number().int().nonnegative().nullable().optional(),
    error: z.string().max(2000).nullable().optional(),
  })
  .strict();

export type QualityPrediction = z.infer<typeof qualityPredictionSchema>;

const normalizedObjects = (label: z.infer<typeof qualityLabelSchema>) =>
  label.objects
    .map((object) => ({
      kind: object.kind,
      statement: object.statement.trim().replace(/\s+/g, " "),
      evidenceQuote: object.evidenceQuote.trim().replace(/\s+/g, " "),
      ownerId: object.ownerId ?? null,
      dueAt: object.dueAt ?? null,
      dueExpression: object.dueExpression ?? null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

export function evaluateQuality(
  samples: QualitySample[],
  predictionsInput: unknown[],
) {
  const predictions = predictionsInput.map((prediction) =>
    qualityPredictionSchema.parse(prediction),
  );
  const bySample = new Map(
    predictions.map((prediction) => [prediction.sampleId, prediction]),
  );
  if (bySample.size !== predictions.length)
    throw Error("QUALITY_PREDICTION_DUPLICATE");
  const labeled = samples.filter(
    (
      sample,
    ): sample is QualitySample & {
      confirmedLabel: NonNullable<QualitySample["confirmedLabel"]>;
    } => sample.state === "confirmed" && Boolean(sample.confirmedLabel),
  );
  const rows = labeled.map((sample) => {
    const prediction = bySample.get(sample.id);
    if (!prediction)
      return {
        sampleId: sample.id,
        category: sample.input.category,
        missing: true,
        exact: false,
        autoApplied: false,
        autoApplyCorrect: false,
        evidenceSupported: false,
      };
    const expected = sample.confirmedLabel;
    const actual = prediction.prediction;
    const exact =
      actual.disposition === expected.disposition &&
      actual.autoApply === expected.autoApply &&
      JSON.stringify(normalizedObjects(actual)) ===
        JSON.stringify(normalizedObjects(expected));
    const autoApplied = actual.autoApply;
    const autoApplyCorrect = autoApplied && expected.autoApply && exact;
    const evidenceSupported = actual.objects.every((object) =>
      sample.input.text.includes(object.evidenceQuote),
    );
    return {
      sampleId: sample.id,
      category: sample.input.category,
      missing: false,
      exact,
      autoApplied,
      autoApplyCorrect,
      evidenceSupported,
    };
  });
  const count = (predicate: (row: (typeof rows)[number]) => boolean) =>
    rows.filter(predicate).length;
  const autoApplied = count((row) => row.autoApplied);
  const explicit = rows.filter(
    (row) =>
      samples.find((sample) => sample.id === row.sampleId)?.confirmedLabel
        ?.disposition === "extract",
  );
  const ambiguous = rows.filter((row) =>
    ["ambiguous", "forwarded"].includes(row.category),
  );
  const durations = predictions
    .flatMap((prediction) =>
      prediction.durationMs === undefined ? [] : [prediction.durationMs],
    )
    .sort((left, right) => left - right);
  const percentile = (ratio: number) =>
    durations.length
      ? durations[
          Math.min(
            durations.length - 1,
            Math.ceil(durations.length * ratio) - 1,
          )
        ]!
      : null;
  return {
    denominator: rows.length,
    predictionCount: predictions.length,
    missingPredictions: count((row) => row.missing),
    exactMatches: count((row) => row.exact),
    autoApply: {
      predicted: autoApplied,
      correct: count((row) => row.autoApplyCorrect),
      precision: autoApplied
        ? count((row) => row.autoApplyCorrect) / autoApplied
        : null,
    },
    evidenceSupport: {
      supported: count((row) => row.evidenceSupported),
      precision: rows.length
        ? count((row) => row.evidenceSupported) / rows.length
        : null,
    },
    explicitCoverage: {
      expected: explicit.length,
      covered: explicit.filter((row) => row.exact).length,
      rate: explicit.length
        ? explicit.filter((row) => row.exact).length / explicit.length
        : null,
    },
    ambiguousOwnerFalsePositives: ambiguous.filter((row) => row.autoApplied)
      .length,
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
    failures: rows.filter((row) => !row.exact),
  };
}
