import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { evaluateQuality } from "../apps/server/src/quality/evaluator.js";
import { QualityRepository } from "../apps/server/src/quality/repository.js";
import { stableDigest } from "../apps/server/src/storage/digest.js";
import { Store } from "../apps/server/src/store.js";

const datasetId = process.argv[2] || process.env.OMEM_QUALITY_DATASET_ID;
const predictionPath = process.argv[3] || process.env.OMEM_QUALITY_PREDICTIONS;
if (!datasetId || !predictionPath)
  throw Error("Usage: quality-evaluate <dataset-id> <predictions.json>");
const store = new Store(resolve(process.env.OMEM_DATA_DIR || ".omem"));
try {
  const repository = new QualityRepository(store.db);
  const frozen = repository.verifyFrozen(datasetId);
  const predictions = JSON.parse(
    readFileSync(resolve(predictionPath), "utf8"),
  ) as unknown[];
  if (!Array.isArray(predictions)) throw Error("QUALITY_PREDICTIONS_NOT_ARRAY");
  const metrics = evaluateQuality(frozen.samples, predictions);
  const report = {
    createdAt: new Date().toISOString(),
    datasetId,
    split: frozen.dataset.split,
    manifestDigest: frozen.manifestDigest,
    predictionDigest: stableDigest(predictions),
    metrics,
    gates: {
      autoApplyPrecision:
        metrics.autoApply.precision !== null &&
        metrics.autoApply.precision >= 0.95,
      // F6: evidence support is no longer a substring check. The gate now
      // requires semantic entailment (reverse statements score 0), not just
      // that evidenceQuote appears in the source text.
      semanticSupport:
        metrics.semanticSupport.rate !== null &&
        metrics.semanticSupport.rate >= 0.95,
      citationLocation:
        metrics.citationLocation.accuracy !== null &&
        metrics.citationLocation.accuracy >= 0.95,
      necessaryEvidenceCoverage:
        metrics.necessaryEvidenceCoverage.rate !== null &&
        metrics.necessaryEvidenceCoverage.rate >= 0.8,
      explicitCoverage:
        metrics.explicitCoverage.rate !== null &&
        metrics.explicitCoverage.rate >= 0.8,
      ambiguousOwnerFalsePositives: metrics.ambiguousOwnerFalsePositives === 0,
      complete: metrics.missingPredictions === 0,
    },
  };
  const output = resolve(
    process.env.OMEM_QUALITY_REPORT ||
      `.omem/quality/${datasetId}-evaluation.json`,
  );
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(output, 0o600);
  console.log(JSON.stringify({ output, ...report }, null, 2));
  if (Object.values(report.gates).some((passed) => !passed))
    process.exitCode = 1;
} finally {
  store.close();
}
