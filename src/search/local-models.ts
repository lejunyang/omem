import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where a local model (embeddings, reranker) comes from. When osdk is on the machine it goes first:
 * a model omem knows by its hub id is downloaded and pinned through osdk (osdk.toml declares it) and
 * loaded from that directory, offline. Only without osdk, or when osdk could not get it, does
 * transformers.js download it itself into its own cache (not pinned; gone when dependencies are
 * reinstalled).
 *
 * The configured name stays what it was: an embedding model's name is its identity (changing it
 * clears every vector), so the osdk directory is only looked up when the model is loaded.
 */
type Known = { alias: string; source: string; files: string[]; kind: string; family: string; derivedFrom?: string; size: string };
const COMMON = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
/** Hub ids omem can hand to osdk: the same aliases, sources and files as osdk.toml and `omem setup`. */
export const OSDK_MODELS: Record<string, Known> = {
  "onnx-community/bge-reranker-v2-m3-ONNX": {
    alias: "rerank-m3", source: "hf:onnx-community/bge-reranker-v2-m3-ONNX@6f5ff65298512715a1e669753bc754d2bc8f367b", files: COMMON,
    kind: "other", family: "bge-reranker", derivedFrom: "BAAI/bge-reranker-v2-m3", size: "约 570MB",
  },
  "Xenova/bge-m3": { alias: "memory-m3", source: "hf:Xenova/bge-m3@main", files: COMMON, kind: "embedding", family: "bge", size: "约 570MB" },
  "Xenova/bge-small-zh-v1.5": {
    alias: "memory-zh", source: "hf:Xenova/bge-small-zh-v1.5@75c43b069aac4d136ba6bc1122f995fedcfd2781", files: [...COMMON.slice(0, 4), "vocab.txt", COMMON[4]],
    kind: "embedding", family: "bge", derivedFrom: "BAAI/bge-small-zh-v1.5", size: "约 25MB",
  },
  "Xenova/bge-base-zh-v1.5": { alias: "memory-zh-base", source: "hf:Xenova/bge-base-zh-v1.5@main", files: COMMON, kind: "embedding", family: "bge", size: "约 100MB" },
};

const here = dirname(fileURLToPath(import.meta.url));
/** The package root (osdk.toml declares the models there), from src/search or dist/src/search. */
function packageRoot() {
  for (const c of [resolve(here, "../.."), resolve(here, "../../..")]) if (existsSync(join(c, "osdk.toml"))) return c;
  for (const c of [resolve(here, "../.."), resolve(here, "../../..")]) if (existsSync(join(c, "package.json"))) return c;
  return resolve(here, "../..");
}

let osdkThere: boolean | undefined;
let runner: { available(): boolean; path(alias: string): string | null; sync(known: Known): Promise<void> } | null = null;
/** Tests: a stand-in for osdk (null turns the real one back on). */
export function setOsdkForTests(fake: typeof runner) {
  runner = fake;
  osdkThere = undefined;
  states.clear();
  missing.clear();
}
/** Asked once a process. Under the test runner the real osdk is never touched (a test sets its own stand-in). */
function osdkAvailable() {
  if (runner) return runner.available();
  if (process.env.VITEST) return false;
  return (osdkThere ??= spawnSync("osdk", ["--version"], { stdio: "ignore", windowsHide: true, shell: process.platform === "win32", timeout: 15_000 }).status === 0);
}

/** Looked up once a process for a model osdk has; asked again a minute later for one it has not. */
const missing = new Map<string, number>();
function osdkPath(alias: string): string | null {
  if (runner) return runner.path(alias);
  if (Date.now() - (missing.get(alias) ?? 0) < 60_000) return null;
  const r = spawnSync("osdk", ["model", "path", alias, "--stable"], { cwd: packageRoot(), encoding: "utf8", stdio: "pipe", windowsHide: true, shell: process.platform === "win32", timeout: 15_000 });
  const p = r.status === 0 ? (r.stdout ?? "").trim().split("\n").pop()!.trim() : "";
  if (p && existsSync(p)) return p;
  missing.set(alias, Date.now());
  return null;
}

function osdkRun(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const p = spawn("osdk", args, { cwd: packageRoot(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: process.platform === "win32" });
    let err = "";
    p.stderr?.on("data", (d) => (err = (err + String(d)).slice(-600)));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? done() : fail(new Error(err.trim() || `osdk ${args.slice(0, 2).join(" ")} 退出码 ${code}`))));
  });
}
async function osdkSync(k: Known) {
  if (runner) return runner.sync(k);
  // Declared in osdk.toml when omem runs from its checkout; from the npm package it is declared here first.
  await osdkRun(["model", "show", k.alias, "--json", "--offline"]).catch(() =>
    osdkRun(["model", "use", k.alias, k.source, ...k.files.flatMap((f) => ["--include", f]), "--kind", k.kind, "--family", k.family, ...(k.derivedFrom ? ["--derived-from", k.derivedFrom] : []), "-y"]));
  await osdkRun(["model", "sync", k.alias]);
}

export type ModelSource = {
  /** local: a directory the owner set; osdk: osdk's pinned copy; hub: transformers.js's own download. */
  via: "local" | "osdk" | "hub";
  path?: string;
  /** osdk is downloading it now. */
  syncing?: boolean;
  /** Why osdk could not get it (the model then comes from the hub). */
  error?: string;
  osdk: boolean;
  /** A model omem can hand to osdk. */
  known: boolean;
  /** The hub download is already in the cache (usable while osdk is still fetching). */
  cached?: boolean;
  size?: string;
};
const states = new Map<string, { path?: string; syncing?: Promise<string | null>; error?: string }>();

/** transformers.js keeps what it downloaded under its own package directory. */
const hubCached = (model: string) => existsSync(join(packageRoot(), "node_modules", "@huggingface", "transformers", ".cache", model, "onnx"));

/** What loading `model` uses right now. No download starts here. */
export function modelSource(model: string): ModelSource {
  if (existsSync(model)) return { via: "local", path: resolve(model), osdk: osdkAvailable(), known: false };
  const known = OSDK_MODELS[model];
  const osdk = osdkAvailable();
  if (!known || !osdk) return { via: "hub", osdk, known: !!known, cached: hubCached(model), ...(known ? { size: known.size } : {}) };
  const s = states.get(model) ?? {};
  const path = s.path ?? osdkPath(known.alias) ?? undefined;
  if (path) {
    states.set(model, { path });
    return { via: "osdk", path, osdk, known: true, size: known.size };
  }
  return { via: "hub", osdk, known: true, cached: hubCached(model), size: known.size, ...(s.syncing ? { syncing: true } : {}), ...(s.error ? { error: s.error } : {}) };
}

/** The directory to load `model` from when osdk already has it (any process; nothing is downloaded). */
export function osdkModelDir(model: string): string | null {
  const known = OSDK_MODELS[model];
  return known && osdkAvailable() ? osdkPath(known.alias) : null;
}

/**
 * Make sure osdk has the model (the main process, before a model is first used): starts the download
 * once and resolves with the directory, or with null when osdk is not there, does not know the model
 * or failed (the caller then lets transformers.js download it). A failure is tried again after ten minutes.
 */
const retryAt = new Map<string, number>();
export function prepareLocalModel(model: string): Promise<string | null> {
  const src = modelSource(model);
  if (src.via !== "hub") return Promise.resolve(src.path ?? null);
  if (!src.osdk || !src.known) return Promise.resolve(null);
  const s = states.get(model) ?? {};
  if (s.syncing) return s.syncing;
  if (s.error && Date.now() < (retryAt.get(model) ?? 0)) return Promise.resolve(null);
  const known = OSDK_MODELS[model];
  console.log(`[omem] 用 osdk 下载模型 ${model}（${known.size}），下完后从本地目录加载`);
  const syncing = osdkSync(known).then(() => {
    missing.delete(known.alias);
    const path = osdkPath(known.alias);
    if (!path) throw new Error(`osdk 没有给出 ${known.alias} 的本地路径`);
    states.set(model, { path });
    console.log(`[omem] 模型 ${model} 已由 osdk 准备好：${path}`);
    return path as string | null;
  }).catch((e) => {
    const error = (e as Error).message;
    states.set(model, { error });
    retryAt.set(model, Date.now() + 600_000);
    console.warn(`[omem] osdk 没能下载模型 ${model}，改由 transformers.js 自己下载：${error}`);
    return null;
  });
  states.set(model, { syncing });
  return syncing;
}
