import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export interface EmbeddingModel {
  /** Includes weights, tokenizer, pooling, query instruction and window version. */
  id: string;
  embed(texts: string[], purpose: "query" | "passage"): Promise<number[][]>;
  close(): Promise<void>;
}

export const BGE_REVISION = "75c43b069aac4d136ba6bc1122f995fedcfd2781";
const files = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt", "onnx/model_quantized.onnx"];

/** osdk owns downloads. The application verifies and reads one immutable snapshot. */
export async function loadChineseEmbedding(alias = "memory-zh", cwd = process.cwd()): Promise<EmbeddingModel> {
  const { stdout } = await promisify(execFile)("osdk", ["model", "show", alias, "--json"], { cwd, timeout: 30_000, maxBuffer: 1_000_000 });
  const { model } = JSON.parse(stdout) as { model: { repository: string; revision: string; snapshot_path: string; files: { path: string; sha256: string }[] } };
  if (model.repository !== "Xenova/bge-small-zh-v1.5" || model.revision !== BGE_REVISION) throw Error("Unsupported embedding snapshot; run osdk model sync memory-zh with the project lock");
  const hashes: string[] = [];
  for (const name of files) {
    const expected = model.files.find(f => f.path === name)?.sha256;
    const actual = createHash("sha256").update(await readFile(join(model.snapshot_path, name))).digest("hex");
    if (!expected || actual !== expected) throw Error(`Embedding snapshot checksum mismatch: ${name}`);
    hashes.push(actual);
  }
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.useFSCache = false;
  const extractor = await pipeline("feature-extraction", model.snapshot_path, {
    local_files_only: true, dtype: "q8", device: "cpu", session_options: { intraOpNumThreads: 2 },
  });
  return {
    id: "bge-zh-cls-q8-window400-v1:" + createHash("sha256").update(hashes.join(":" )).digest("hex"),
    async embed(texts, purpose) {
      const result = await extractor(texts.map(text => purpose === "query" ? "为这个句子生成表示以用于检索相关文章：" + text : text), {
        pooling: "cls", normalize: true,
      });
      return result.tolist() as number[][];
    },
    async close() { await extractor.dispose(); },
  };
}
