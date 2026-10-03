/** BGE's Chinese/English cross-encoder judges a query and passage together.
 * osdk owns immutable downloads; inference is offline and never fetches weights. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export interface RerankerModel {
  id: string;
  score(query: string, passages: string[]): Promise<number[]>;
  close(): Promise<void>;
}
export const RERANKER_REVISION = "280bcc27a84e0b898c251e06fddb25171bd9b101";
const snapshots: Record<string, { revision: string; label: string }> = {
  "Xenova/bge-reranker-base": {
    revision: RERANKER_REVISION,
    label: "bge-reranker",
  },
  "onnx-community/bge-reranker-v2-m3-ONNX": {
    revision: "6f5ff65298512715a1e669753bc754d2bc8f367b",
    label: "bge-reranker-v2-m3",
  },
};
const files = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];
export async function loadChineseReranker(
  alias = "relevance-zh",
  cwd = process.cwd(),
): Promise<RerankerModel> {
  const { stdout } = await promisify(execFile)(
    "osdk",
    ["model", "show", alias, "--json"],
    { cwd, timeout: 30_000, maxBuffer: 1_000_000 },
  );
  const { model: snapshot } = JSON.parse(stdout) as {
    model: {
      repository: string;
      revision: string;
      snapshot_path: string;
      files: { path: string; sha256: string }[];
    };
  };
  const supported = snapshots[snapshot.repository];
  if (!supported || snapshot.revision !== supported.revision)
    throw Error(
      "Unsupported reranker snapshot; sync a locked relevance-zh or relevance-zh-v2 model",
    );
  const hashes: string[] = [];
  for (const name of files) {
    const bytes = await readFile(join(snapshot.snapshot_path, name)),
      hash = createHash("sha256").update(bytes).digest("hex");
    if (snapshot.files.find((f) => f.path === name)?.sha256 !== hash)
      throw Error(`Reranker checksum mismatch: ${name}`);
    hashes.push(hash);
  }
  const { AutoTokenizer, AutoModelForSequenceClassification, env } =
    await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.useFSCache = false;
  const tokenizer = await AutoTokenizer.from_pretrained(
    snapshot.snapshot_path,
    { local_files_only: true },
  );
  const model = await AutoModelForSequenceClassification.from_pretrained(
    snapshot.snapshot_path,
    {
      local_files_only: true,
      dtype: "q8",
      device: "cpu",
      session_options: { intraOpNumThreads: 2 },
    },
  );
  // Serial batches avoid competing CPU work and quadratic padding of long inputs.
  let serial: Promise<unknown> = Promise.resolve();
  return {
    id:
      supported.label +
      "-q8-pair512-temp3-v1:" +
      createHash("sha256").update(hashes.join(":")).digest("hex"),
    score(query, passages) {
      const work = serial.then(async () => {
        const result: number[] = [];
        for (let i = 0; i < passages.length; i += 4) {
          const batch = passages.slice(i, i + 4);
          const encoded = tokenizer(
            batch.map(() => query),
            {
              text_pair: batch,
              padding: true,
              truncation: true,
              max_length: 512,
            },
          );
          const output = await model(encoded);
          const logits = output.logits.tolist() as number[][];
          for (const row of logits) {
            const logit = row[0];
            if (logit === undefined || !Number.isFinite(logit))
              throw Error("Invalid reranker score");
            result.push(1 / (1 + Math.exp(-logit / 3)));
          }
        }
        if (result.length !== passages.length)
          throw Error("Reranker batch length mismatch");
        return result;
      });
      serial = work.catch(() => {});
      return work;
    },
    async close() {
      await serial;
      await model.dispose();
    },
  };
}
