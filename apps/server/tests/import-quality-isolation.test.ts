/** G01: ordinary material import must not become a human annotation task.
 *
 * Regression for Batch-2 review F1. The rule-based quality splitter may exist
 * for the opt-in research harness, but capturing a business document through the
 * normal store.capture path must only persist the immutable source revision and
 * retrievable fragments — it must NOT auto-create quality datasets, draft samples,
 * or outbound confirmation cards.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureSchema } from "../../../packages/contracts/src/index.js";
import {
  importQualityDatasetEval,
  QUALITY_EVAL_ONLY,
} from "../src/quality/import.js";
import { QualityRepository } from "../src/quality/repository.js";
import { Store } from "../src/store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// 40 business paragraphs, each long enough that the eval splitter would pick it.
const paragraphs = Array.from(
  { length: 40 },
  (_, i) =>
    `第${i + 1}段：本业务规则要求运营人员在提交前必须完成三方核对，` +
    `且该限制仅适用于生产环境的人工审核流程，测试环境不受约束。`,
).join("\n\n");

describe("G01 ordinary import does not create quality annotation work", () => {
  it("persists source revision + fragments but zero quality datasets/samples/cards", () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-g01-"));
    directories.push(directory);
    const store = new Store(directory);
    try {
      const receipt = store.capture(
        captureSchema.parse({
          source: "manual",
          externalId: "g01-doc",
          title: "业务说明文档（40段）",
          parts: [{ type: "text", text: paragraphs }],
          context: {},
          provenance: {
            collectorId: "g01-test",
            actorId: "owner",
            actorType: "user",
            actorVerifiedBy: "fixture",
            sourceUri: null,
            eventId: null,
            eventAt: "2026-09-27T02:00:00Z",
            timezone: "Asia/Shanghai",
            quoted: false,
            forwarded: false,
            producerKind: "original",
          },
        }),
      );
      // The material itself is saved and retrievable.
      expect(receipt.revision.fragments.length).toBeGreaterThan(0);
      expect(receipt.revision.fragments[0]!.text).toContain("三方核对");

      // No quality dataset / draft sample / outbound annotation card may exist.
      const datasetCount = Number(
        (
          store.db
            .prepare("SELECT count(*) AS n FROM quality_datasets")
            .get() as { n: number }
        ).n,
      );
      const sampleCount = Number(
        (
          store.db
            .prepare("SELECT count(*) AS n FROM quality_samples")
            .get() as { n: number }
        ).n,
      );
      const intentCount = Number(
        (
          store.db
            .prepare("SELECT count(*) AS n FROM delivery_intents")
            .get() as { n: number }
        ).n,
      );
      expect(datasetCount).toBe(0);
      expect(sampleCount).toBe(0);
      expect(intentCount).toBe(0);
    } finally {
      store.close();
    }
  });

  it("guards the eval-only importer against accidental ordinary-path use", () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-g01-guard-"));
    directories.push(directory);
    const store = new Store(directory);
    try {
      const repository = new QualityRepository(store.db);
      const document = captureSchema.parse({
        source: "lark",
        externalId: "g01-eval",
        title: "eval",
        parts: [{ type: "text", text: paragraphs }],
        context: {},
      });
      // Missing opt-in discriminator -> loud failure, never silent dataset creation.
      const withoutOptIn = {
        repository,
        document,
        sourceUri: "https://example.test/g01",
        name: "g01",
        split: "dev" as const,
        targetCount: 40,
      };
      expect(() =>
        importQualityDatasetEval(
          withoutOptIn as Parameters<typeof importQualityDatasetEval>[0],
        ),
      ).toThrow(/QUALITY_IMPORT_IS_EVAL_ONLY/);
      // The opt-in path still works for the research harness.
      const imported = importQualityDatasetEval({
        optIn: QUALITY_EVAL_ONLY,
        repository,
        document,
        sourceUri: "https://example.test/g01",
        name: "g01",
        split: "dev",
        targetCount: 40,
      });
      expect(imported.sampleCount).toBe(40);
    } finally {
      store.close();
    }
  });
});
