import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureInput } from "../../../packages/contracts/src/index.js";
import { evaluateQuality } from "../src/quality/evaluator.js";
import { importDocumentDataset } from "../src/quality/import.js";
import { QualityRepository } from "../src/quality/repository.js";
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
      const imported = importDocumentDataset({
        repository,
        document,
        sourceUri: "https://example.test/wiki/doc-quality",
        name: "quality-dev",
        split: "dev",
        targetCount: 3,
      });
      expect(imported).toMatchObject({ inserted: 3, sampleCount: 3 });
      expect(
        importDocumentDataset({
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
      expect(
        evaluateQuality(repository.samples(imported.id), predictions),
      ).toMatchObject({
        denominator: 3,
        missingPredictions: 0,
        exactMatches: 3,
        autoApply: { predicted: 3, correct: 3, precision: 1 },
        evidenceSupport: { supported: 3, precision: 1 },
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
