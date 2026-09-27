import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureInput } from "../../../packages/contracts/src/index.js";
import {
  evaluateQuality,
  judgeFactSlots,
  judgeSemanticSupport,
} from "../src/quality/evaluator.js";
import {
  importQualityDatasetEval,
  QUALITY_EVAL_ONLY,
} from "../src/quality/import.js";
import {
  QualityRepository,
  type QualityLabel,
  type QualitySample,
  type QualitySampleInput,
} from "../src/quality/repository.js";
import { Store } from "../src/store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const document: CaptureInput = {
  source: "lark",
  externalId: "doc-quality",
  upstreamVersion: "3709",
  title: "Quality source",
  context: {},
  parts: [
    {
      type: "text",
      text: [
        "# 规则",
        "一个主体只能拥有一个主账号，并且该主账号代表对应组织。",
        "一个运营人最多关联五个手机号，每个手机号只能关联一个运营人。",
        "# 权限",
        "超级管理员可以管理主体下所有企业机构账号，普通管理员仅管理自己创建的账号。",
      ].join("\n\n"),
    },
  ],
};

describe("B2-08 quality dataset and evaluation", () => {
  it("imports deduplicated source samples, requires human labels and freezes a digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-quality-eval-"));
    directories.push(directory);
    const store = new Store(directory);
    try {
      const repository = new QualityRepository(store.db);
      // Eval-only harness: this test intentionally exercises the research
      // annotation dataset builder; ordinary capture must NOT reach this path.
      const imported = importQualityDatasetEval({
        optIn: QUALITY_EVAL_ONLY,
        repository,
        document,
        sourceUri: "https://example.test/wiki/doc-quality",
        name: "quality-dev",
        split: "dev",
        targetCount: 3,
      });
      expect(imported).toMatchObject({ inserted: 3, sampleCount: 3 });
      expect(
        importQualityDatasetEval({
          optIn: QUALITY_EVAL_ONLY,
          repository,
          document,
          sourceUri: "https://example.test/wiki/doc-quality",
          name: "quality-dev",
          split: "dev",
          targetCount: 3,
        }),
      ).toMatchObject({ id: imported.id, duplicate: true, inserted: 0 });
      expect(() => repository.freeze(imported.id)).toThrow(
        "QUALITY_DATASET_NOT_FULLY_CONFIRMED",
      );
      const samples = repository.samples(imported.id);
      for (const sample of samples)
        repository.label({
          sampleId: sample.id,
          action: "confirm",
          reviewerOpenId: "ou_reviewer",
          expectedLabelDigest: sample.labelDigest,
        });
      const frozen = repository.freeze(imported.id);
      expect(frozen.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(repository.verifyFrozen(imported.id).manifestDigest).toBe(
        frozen.manifestDigest,
      );
      const predictions = repository.samples(imported.id).map((sample) => ({
        sampleId: sample.id,
        prediction: sample.confirmedLabel,
        durationMs: 100 + sample.ordinal,
        inputTokens: 10,
        outputTokens: 5,
        error: null,
      }));
      // F6: the old assertion `evidenceSupport: { supported: 3, precision: 1 }`
      // credited any prediction whose evidenceQuote was a substring, even when the
      // statement contradicted the quote. The metric is now split into six
      // independent dimensions; a verbatim copy of the label scores 1 on every
      // dimension for the right reason (located quote, no negation flip, no
      // dropped qualifiers, no time mismatch).
      expect(
        evaluateQuality(repository.samples(imported.id), predictions),
      ).toMatchObject({
        denominator: 3,
        missingPredictions: 0,
        exactMatches: 3,
        dispositionAgreements: 3,
        autoApply: { predicted: 3, correct: 3, precision: 1 },
        citationLocation: { predictedObjects: 3, located: 3, accuracy: 1 },
        semanticSupport: {
          predictedObjects: 3,
          supported: 3,
          partial: 0,
          contradicted: 0,
          unsupported: 0,
          rate: 1,
        },
        coreFactSlots: { predictedObjects: 3, consistent: 3, mismatched: 0 },
        necessaryEvidenceCoverage: { expectedObjects: 3, covered: 3, rate: 1 },
        taskCompletion: { eligible: 3, completed: 3, rate: 1 },
        unnecessaryInterruption: { eligible: 3, count: 0, rate: 0 },
        explicitCoverage: { expected: 3, covered: 3, rate: 1 },
        ambiguousOwnerFalsePositives: 0,
      });
      store.db
        .prepare(
          "UPDATE quality_samples SET confirmed_label_json='{}' WHERE id=?",
        )
        .run(samples[0]!.id);
      expect(() => repository.verifyFrozen(imported.id)).toThrow();
    } finally {
      store.close();
    }
  });
});

// --- G19: deterministic rule-baseline tests for the split evidence metrics ---

const makeInput = (
  text: string,
  category: QualitySampleInput["category"] = "explicit",
): QualitySampleInput => ({
  source: {
    uri: "https://example.test/wiki/g19",
    documentId: "doc-g19",
    revisionId: "1",
    fragmentId: "frag-g19",
    section: "正文",
  },
  category,
  text,
  provenance: { actorId: null, actorVerified: false, forwarded: false },
});

const makeLabel = (
  objects: QualityLabel["objects"],
  overrides: Partial<QualityLabel> = {},
): QualityLabel => ({
  disposition: objects.length ? "extract" : "abstain",
  objects,
  autoApply: false,
  forbiddenEffects: [],
  notes: "",
  ...overrides,
});

const makeSample = (
  input: QualitySampleInput,
  confirmedLabel: QualityLabel,
): QualitySample => ({
  id: randomUUID(),
  datasetId: "ds-g19",
  ordinal: 1,
  inputDigest: "digest-" + randomUUID(),
  input,
  draftLabel: confirmedLabel,
  confirmedLabel,
  labelDigest: "label-" + randomUUID(),
  state: "confirmed",
  reviewerOpenId: "ou_g19",
  reviewedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const claim = (statement: string, evidenceQuote: string) => ({
  kind: "claim" as const,
  statement,
  evidenceQuote,
});

describe("G19 split evidence metrics", () => {
  it("judges a reverse statement as contradicted even when the quote is a substring", () => {
    const text =
      "当前甲系统与乙主体是单一关联关系，未来可能允许多对多绑定。";
    const sample = makeSample(
      makeInput(text),
      makeLabel([claim(text, text)], { autoApply: true }),
    );
    // The prediction cites the true quote but draws the opposite conclusion.
    const metrics = evaluateQuality([sample], [
      {
        sampleId: sample.id,
        prediction: makeLabel(
          [claim("甲系统已经永远支持任意多对多关系。", text)],
          { autoApply: false },
        ),
      },
    ]);
    // The quote IS locatable, so citation location passes...
    expect(metrics.citationLocation).toMatchObject({
      predictedObjects: 1,
      located: 1,
      accuracy: 1,
    });
    // ...but semantic support must NOT pass: substring location is not support.
    expect(metrics.semanticSupport).toMatchObject({
      supported: 0,
      contradicted: 1,
      rate: 0,
    });
    expect(metrics.taskCompletion.completed).toBe(0);
  });

  it("does not credit an empty answer as evidence support (null denominator)", () => {
    const text =
      "一个运营人最多关联五个手机号，每个手机号只能关联一个运营人。";
    const sample = makeSample(
      makeInput(text),
      makeLabel([claim(text, text)], { autoApply: true }),
    );
    // Prediction abstains with zero objects.
    const metrics = evaluateQuality([sample], [
      {
        sampleId: sample.id,
        prediction: makeLabel([], { disposition: "abstain" }),
      },
    ]);
    // Empty objects contribute nothing to the support denominators -> null, not 1.
    expect(metrics.citationLocation.predictedObjects).toBe(0);
    expect(metrics.citationLocation.accuracy).toBeNull();
    expect(metrics.semanticSupport.predictedObjects).toBe(0);
    expect(metrics.semanticSupport.rate).toBeNull();
    expect(metrics.coreFactSlots.rate).toBeNull();
    // But it IS a coverage miss: the expected evidence was not cited.
    expect(metrics.necessaryEvidenceCoverage).toMatchObject({
      expectedObjects: 1,
      covered: 0,
      rate: 0,
    });
  });

  it("does not penalize a faithful synonymous paraphrase", () => {
    const text = "一个主体只能拥有一个主账号，并且该主账号代表对应组织。";
    const sample = makeSample(makeInput(text), makeLabel([claim(text, text)]));
    const metrics = evaluateQuality([sample], [
      {
        sampleId: sample.id,
        prediction: makeLabel([
          claim(
            "一个运营主体仅能存在一个主账号，该账号代表对应组织。",
            text,
          ),
        ]),
      },
    ]);
    expect(metrics.semanticSupport.supported).toBe(1);
    expect(metrics.semanticSupport.contradicted).toBe(0);
    expect(metrics.semanticSupport.rate).toBe(1);
    expect(
      judgeSemanticSupport("一个运营主体仅能存在一个主账号", text),
    ).toBe("supported");
  });

  it("flags a dropped restrictive condition as partial support", () => {
    const text =
      "超级管理员可以管理主体下所有企业机构账号，普通管理员仅管理自己创建的账号。";
    const sample = makeSample(makeInput(text), makeLabel([claim(text, text)]));
    // Statement drops "普通" and "自己创建的", broadening the claim.
    const metrics = evaluateQuality([sample], [
      {
        sampleId: sample.id,
        prediction: makeLabel([claim("管理员可以管理企业机构账号。", text)]),
      },
    ]);
    expect(metrics.semanticSupport.supported).toBe(0);
    expect(metrics.semanticSupport.partial).toBe(1);
  });

  it("flags a dated quote treated as currently valid as a time mismatch", () => {
    const text = "2024年规则：一个运营人最多关联五个手机号。";
    const sample = makeSample(makeInput(text), makeLabel([claim(text, text)]));
    const metrics = evaluateQuality([sample], [
      {
        sampleId: sample.id,
        prediction: makeLabel([
          claim("一个运营人最多关联五个手机号，当前仍然有效。", text),
        ]),
      },
    ]);
    expect(metrics.semanticSupport.supported).toBe(0);
    expect(metrics.semanticSupport.partial).toBe(1);
  });

  it("detects a negation flip (X 支持 Y vs X 不支持 Y)", () => {
    expect(judgeSemanticSupport("系统支持该方案。", "系统不支持该方案。")).toBe(
      "contradicted",
    );
    expect(
      judgeSemanticSupport("系统不支持该方案。", "系统支持该方案。"),
    ).toBe("contradicted");
  });

  it("flags a changed numeric bound as a fact-slot mismatch", () => {
    const quote = "一个运营人最多关联五个手机号。";
    expect(judgeFactSlots("一个运营人最多关联五个手机号。", quote)).toBe(true);
    expect(judgeFactSlots("一个运营人最多关联三个手机号。", quote)).toBe(
      false,
    );
  });

  it("returns null for every rate when there is no eligible denominator", () => {
    // Zero labeled samples.
    const metrics = evaluateQuality([], []);
    expect(metrics.denominator).toBe(0);
    expect(metrics.citationLocation.accuracy).toBeNull();
    expect(metrics.semanticSupport.rate).toBeNull();
    expect(metrics.coreFactSlots.rate).toBeNull();
    expect(metrics.necessaryEvidenceCoverage.rate).toBeNull();
    expect(metrics.taskCompletion.rate).toBeNull();
    expect(metrics.unnecessaryInterruption.rate).toBeNull();
    expect(metrics.latencyMs.p50).toBeNull();
  });

  it("counts unnecessary interruption when it asks the user for an autonomous extract", () => {
    const text = "一个主体只能拥有一个主账号。";
    const sample = makeSample(
      makeInput(text),
      makeLabel([claim(text, text)], { autoApply: true }),
    );
    // Expected autonomous extract; prediction defers to the user.
    const metrics = evaluateQuality([sample], [
      {
        sampleId: sample.id,
        prediction: makeLabel([], { disposition: "needs_context" }),
      },
    ]);
    expect(metrics.unnecessaryInterruption.count).toBe(1);
    expect(metrics.taskCompletion.completed).toBe(0);
  });
});
