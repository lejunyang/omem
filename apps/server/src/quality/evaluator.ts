import { z } from "zod";
import { qualityLabelSchema, type QualityLabel, type QualitySample } from "./repository.js";

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

const normalized = (value: string) => value.trim().replace(/\s+/g, " ");

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

// ---------------------------------------------------------------------------
// Deterministic, rule-based semantic support judge (NOT an LLM).
//
// The old `evidenceSupport` metric only checked whether evidenceQuote was a
// substring of the source text, which credited even statements that directly
// contradicted the quote. This judge separates citation location (substring)
// from semantic entailment using small, explicit rule baselines:
//   - negation flip on a shared verb ("X 支持 Y" vs "X 不支持 Y")
//   - antonym concept opposition (single vs many, allow vs forbid)
//   - dropped restrictive qualifiers (scope broadening -> partial)
//   - dated quote treated as currently valid (time mismatch -> partial)
//   - near-zero lexical overlap (unrelated)
// Correct synonymous paraphrases are NOT penalized: they share the same verb
// polarities and qualifiers, so they resolve to "supported".
// ---------------------------------------------------------------------------

export type SupportVerdict =
  | "supported"
  | "partial"
  | "contradicted"
  | "unsupported";

const VERB_ROOTS = [
  "支持",
  "允许",
  "管理",
  "关联",
  "绑定",
  "包含",
  "属于",
  "是",
  "能",
  "可以",
  "会",
];

/** Map each shared verb root to whether its occurrence is negated. */
function verbPolarities(text: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const root of VERB_ROOTS) {
    let idx = text.indexOf(root);
    let found = false;
    let negated = false;
    while (idx !== -1) {
      found = true;
      const prefix = text.slice(Math.max(0, idx - 1), idx);
      if (/[没无未非不]/.test(prefix)) negated = true;
      idx = text.indexOf(root, idx + root.length);
    }
    if (found) result.set(root, negated);
  }
  return result;
}

/**
 * Antonym concept groups. Members on the left oppose members on the right.
 * A statement that lands on the opposite side of the quote (without hedging as
 * a future possibility) directly contradicts it.
 */
const ANTONYM_GROUPS: [string[], string[]][] = [
  [
    ["单一", "唯一", "一对一"],
    ["多个", "多对多", "任意", "所有", "全部", "任意数量"],
  ],
  [["禁止", "不得", "不能", "不允许"], ["允许", "可以", "有权", "自由"]],
  [["最多", "不超过", "上限", "仅限"], ["任意", "无限制", "无限"]],
];

/**
 * Restrictor equivalence classes. If the quote uses a member of a class to
 * scope the claim and the statement uses no member of that class, the claim
 * has been broadened (a dropped condition) -> partial support.
 */
const RESTRICTOR_EQUIVS: string[][] = [
  ["只能", "仅能", "仅可", "只能拥有", "仅拥有", "只能关联", "仅关联"],
  ["普通管理员", "普通"],
  ["自己创建", "自己"],
  ["未来可能", "可能", "或许", "将来可能"],
];

/** Present-tense validity markers that conflict with a dated historical quote. */
const PRESENT_MARKERS = [
  "当前有效",
  "目前有效",
  "仍然有效",
  "当前",
  "目前",
  "现在",
];

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}

function bigramOverlap(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const gram of ba) if (bb.has(gram)) inter++;
  return inter / Math.min(ba.size, bb.size);
}

export function judgeSemanticSupport(
  statement: string,
  quote: string,
): SupportVerdict {
  const s = normalized(statement).replace(/\s+/g, "");
  const q = normalized(quote).replace(/\s+/g, "");

  // 1. Negation flip on a shared verb root.
  const sPol = verbPolarities(s);
  const qPol = verbPolarities(q);
  for (const [root, qNeg] of qPol) {
    const sNeg = sPol.get(root);
    if (sNeg !== undefined && sNeg !== qNeg) return "contradicted";
  }

  // 2. Direct antonym opposition. A statement that asserts the opposite side
  //    (and does not hedge it as a future possibility) contradicts the quote.
  for (const [left, right] of ANTONYM_GROUPS) {
    const qLeft = left.some((word) => q.includes(word));
    const qRight = right.some((word) => q.includes(word));
    const sLeft = left.some((word) => s.includes(word));
    const sRight = right.some((word) => s.includes(word));
    const sTentative = s.includes("可能") || s.includes("未来");
    if (qLeft && sRight && !sTentative) return "contradicted";
    if (qRight && sLeft) return "contradicted";
  }

  // 3. Time mismatch: the quote describes a dated state, the statement treats
  //    it as currently valid.
  const qYears = q.match(/(?:19|20)\d{2}/g) ?? [];
  if (qYears.length > 0 && PRESENT_MARKERS.some((m) => s.includes(m)))
    return "partial";

  // 4. Dropped restrictive qualifier: quote scopes the claim, statement drops
  //    the scope and broadens it.
  for (const group of RESTRICTOR_EQUIVS) {
    const qHas = group.some((word) => q.includes(word));
    const sHas = group.some((word) => s.includes(word));
    if (qHas && !sHas) return "partial";
  }

  // 5. Near-zero lexical overlap: the statement is unrelated to the quote.
  if (bigramOverlap(s, q) < 0.2) return "unsupported";

  return "supported";
}

/**
 * Core fact-slot consistency: every number / quantified bound asserted in the
 * statement must also appear in the quote. A statement that introduces a new
 * number or changes a bound (最多五个 -> 最多三个) mismatches.
 */
export function judgeFactSlots(statement: string, quote: string): boolean {
  const quantified = /\d+|[一二三四五六七八九十两]+(?=个|名|位|条|次|年|月|日|%|台|款|项)/g;
  const qNums: string[] = quote.match(quantified) ?? [];
  const sNums: string[] = statement.match(quantified) ?? [];
  for (const num of sNums) if (!qNums.includes(num)) return false;
  return true;
}

type PredictedObjectEval = {
  located: boolean;
  verdict: SupportVerdict;
  slotsConsistent: boolean;
};

type Row = {
  sampleId: string;
  category: string;
  missing: boolean;
  exact: boolean;
  dispositionMatch: boolean;
  expectedDisposition: QualityLabel["disposition"];
  actualDisposition: QualityLabel["disposition"] | null;
  autoApplied: boolean;
  autoApplyCorrect: boolean;
  objectEvals: PredictedObjectEval[];
  expectedObjectCount: number;
  expectedCovered: number;
  interruption: boolean;
  completed: boolean;
};

const coversEvidence = (
  actual: { statement: string; evidenceQuote: string },
  expected: { statement: string; evidenceQuote: string },
): boolean => {
  const a = normalized(actual.evidenceQuote);
  const e = normalized(expected.evidenceQuote);
  if (a === e || a.includes(e) || e.includes(a)) return true;
  return (
    bigramOverlap(normalized(actual.statement), normalized(expected.statement)) >=
    0.5
  );
};

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

  const rows: Row[] = labeled.map((sample) => {
    const expected = sample.confirmedLabel!;
    const prediction = bySample.get(sample.id);
    if (!prediction)
      return {
        sampleId: sample.id,
        category: sample.input.category,
        missing: true,
        exact: false,
        dispositionMatch: false,
        expectedDisposition: expected.disposition,
        actualDisposition: null,
        autoApplied: false,
        autoApplyCorrect: false,
        objectEvals: [],
        expectedObjectCount: expected.objects.length,
        expectedCovered: 0,
        interruption: false,
        completed: false,
      };

    const actual = prediction.prediction;
    const exact =
      actual.disposition === expected.disposition &&
      actual.autoApply === expected.autoApply &&
      JSON.stringify(normalizedObjects(actual)) ===
        JSON.stringify(normalizedObjects(expected));
    const dispositionMatch = actual.disposition === expected.disposition;
    const autoApplied = actual.autoApply;
    const autoApplyCorrect = autoApplied && expected.autoApply && exact;

    // Per-object evidence evaluation. Objects are only produced when the
    // prediction actually extracts; an empty array contributes NOTHING to the
    // support denominators (previously `every()` credited empty answers).
    const objectEvals: PredictedObjectEval[] = actual.objects.map((object) => ({
      located: normalized(sample.input.text).includes(
        normalized(object.evidenceQuote),
      ),
      verdict: judgeSemanticSupport(object.statement, object.evidenceQuote),
      slotsConsistent: judgeFactSlots(object.statement, object.evidenceQuote),
    }));

    const expectedCovered = expected.objects.filter((expectedObject) =>
      actual.objects.some((actualObject) =>
        coversEvidence(actualObject, expectedObject),
      ),
    ).length;

    // Unnecessary interruption: auto-applied when the label forbade it, OR
    // asked the user (needs_context) when the label expected autonomous extract.
    const interruption =
      (actual.autoApply && !expected.autoApply) ||
      (actual.disposition === "needs_context" &&
        expected.disposition === "extract");

    // Task completion: disposition agreement plus evidence coverage.
    const completed =
      expected.disposition === "extract"
        ? actual.disposition === "extract" &&
          expectedCovered === expected.objects.length &&
          objectEvals.every((o) => o.verdict !== "contradicted")
        : expected.disposition === "abstain"
          ? actual.disposition === "abstain" && objectEvals.length === 0
          : actual.disposition !== "extract" || !autoApplied;

    return {
      sampleId: sample.id,
      category: sample.input.category,
      missing: false,
      exact,
      dispositionMatch,
      expectedDisposition: expected.disposition,
      actualDisposition: actual.disposition,
      autoApplied,
      autoApplyCorrect,
      objectEvals,
      expectedObjectCount: expected.objects.length,
      expectedCovered,
      interruption,
      completed,
    };
  });

  const count = (predicate: (row: Row) => boolean) =>
    rows.filter(predicate).length;

  // --- Per-object evidence aggregates (denominator = predicted objects) ---
  const objectEvals = rows.flatMap((row) => row.objectEvals);
  const predictedObjects = objectEvals.length;
  const located = objectEvals.filter((o) => o.located).length;
  const supported = objectEvals.filter((o) => o.verdict === "supported").length;
  const partial = objectEvals.filter((o) => o.verdict === "partial").length;
  const contradicted = objectEvals.filter(
    (o) => o.verdict === "contradicted",
  ).length;
  const unsupported = objectEvals.filter(
    (o) => o.verdict === "unsupported",
  ).length;
  const slotsConsistent = objectEvals.filter((o) => o.slotsConsistent).length;

  // --- Necessary evidence coverage (denominator = expected objects) ---
  const expectedObjectsTotal = rows.reduce(
    (sum, row) => sum + row.expectedObjectCount,
    0,
  );
  const expectedCoveredTotal = rows.reduce(
    (sum, row) => sum + row.expectedCovered,
    0,
  );

  const autoApplied = count((row) => row.autoApplied);
  const explicit = rows.filter(
    (row) => row.expectedDisposition === "extract",
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
    dispositionAgreements: count((row) => row.dispositionMatch),
    autoApply: {
      predicted: autoApplied,
      correct: count((row) => row.autoApplyCorrect),
      precision: autoApplied
        ? count((row) => row.autoApplyCorrect) / autoApplied
        : null,
    },
    // 1. Citation location: can the evidenceQuote be found in the source text?
    //    This is the old substring check, now its own metric — NOT evidence
    //    support. Empty predictions contribute 0 objects, so accuracy is null
    //    rather than a free 1.
    citationLocation: {
      predictedObjects,
      located,
      accuracy: predictedObjects ? located / predictedObjects : null,
    },
    // 2. Semantic support: does the statement actually follow from the quote?
    //    Reverse statements and negation flips score 0; faithful paraphrases
    //    score 1 regardless of verbatim mismatch.
    semanticSupport: {
      predictedObjects,
      supported,
      partial,
      contradicted,
      unsupported,
      rate: predictedObjects ? supported / predictedObjects : null,
    },
    // 3. Core fact slots: numbers / bounds preserved between statement and quote.
    coreFactSlots: {
      predictedObjects,
      consistent: slotsConsistent,
      mismatched: predictedObjects - slotsConsistent,
      rate: predictedObjects ? slotsConsistent / predictedObjects : null,
    },
    // 4. Necessary evidence coverage: recall over the expected (confirmed) objects.
    necessaryEvidenceCoverage: {
      expectedObjects: expectedObjectsTotal,
      covered: expectedCoveredTotal,
      rate: expectedObjectsTotal
        ? expectedCoveredTotal / expectedObjectsTotal
        : null,
    },
    // 5. Task completion: disposition agreement plus evidence coverage.
    taskCompletion: {
      eligible: rows.length,
      completed: count((row) => row.completed),
      rate: rows.length ? count((row) => row.completed) / rows.length : null,
    },
    // 6. Unnecessary interruption: asked the user or auto-applied without need.
    unnecessaryInterruption: {
      eligible: rows.length,
      count: count((row) => row.interruption),
      rate: rows.length ? count((row) => row.interruption) / rows.length : null,
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
