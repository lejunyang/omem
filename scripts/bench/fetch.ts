/**
 * Public evaluation data, fetched by hand when tuning (never on a schedule).
 *
 *   node scripts/bench/fetch.ts                     # list the datasets in datasets.json
 *   node scripts/bench/fetch.ts <name> [--dir .scratch/bench] [--pin] [--queries 400] [--distractors 15000] [--seed 7]
 *
 * Downloads each file of the dataset into `<dir>/<name>/raw/` (git-ignored), checks the SHA-256
 * from datasets.json (a mismatch deletes the file and stops; a dataset without a pinned hash prints
 * it, and `--pin` writes it back), then converts it into what the eval scripts read:
 *
 * - longmemeval: the JSON as is → scripts/eval-longmemeval.ts (`--recall` needs no model)
 * - cmteb-retrieval: corpus / queries / qrels parquet → corpus.jsonl + queries.jsonl for
 *   scripts/eval-retrieval.ts (subset: `--queries` questions with a positive, all their relevant
 *   documents, `--distractors` random others; Python with pandas + pyarrow, as before)
 * - locomo: locomo10.json → locomo_lme.json in LongMemEval's shape for eval-longmemeval.ts
 *
 * Licences are in datasets.json; LoCoMo is non-commercial: local runs only, nothing redistributed.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { locomoToLongMemEval } from "./locomo.ts";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type File = { url: string; name: string; size: number | null; sha256: string | null; role?: string };
type Dataset = { description: string; license: string; commercial: boolean; convert: "longmemeval" | "cmteb-retrieval" | "locomo"; files: File[] };

const here = import.meta.dirname;
const manifestPath = join(here, "datasets.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, Dataset>;
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const name = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

if (!name) {
  for (const [k, d] of Object.entries(manifest)) {
    const size = d.files.reduce((s, f) => s + (f.size ?? 0), 0);
    console.log(`${k.padEnd(20)} ${size ? `${(size / 1e6).toFixed(1)} MB` : "大小未知"}  ${d.license}\n${" ".repeat(21)}${d.description}`);
  }
  process.exit(0);
}
const ds = manifest[name];
if (!ds) throw new Error(`datasets.json 里没有 ${name}（有：${Object.keys(manifest).join("、")}）`);
const dir = resolve(opt("--dir", join(process.cwd(), ".scratch", "bench")), name);
const raw = join(dir, "raw");
mkdirSync(raw, { recursive: true });
if (!ds.commercial) console.error(`注意：${name} 的许可是 ${ds.license}`);

async function sha256Of(path: string) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

async function download(f: File) {
  const target = join(raw, f.name);
  if (existsSync(target) && (!f.sha256 || (await sha256Of(target)) === f.sha256)) {
    console.error(`已有 ${f.name}`);
    return target;
  }
  console.error(`下载 ${f.url}${f.size ? `（${(f.size / 1e6).toFixed(1)} MB）` : ""}`);
  const res = await fetch(f.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}：${f.url}`);
  const part = `${target}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  const got = await sha256Of(part);
  if (f.sha256 && got !== f.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${f.name} 的 SHA-256 不对：期望 ${f.sha256}，得到 ${got}。文件已删除；源变了就核对后改 datasets.json`);
  }
  renameSync(part, target);
  if (!f.sha256) {
    console.error(`${f.name} 没有固定哈希：sha256 ${got}，${statSync(target).size} 字节${args.includes("--pin") ? "，已写进 datasets.json" : "（加 --pin 写进 datasets.json）"}`);
    if (args.includes("--pin")) {
      f.sha256 = got;
      f.size = statSync(target).size;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
  }
  return target;
}

const paths: Record<string, string> = {};
for (const f of ds.files) paths[f.role ?? f.name] = await download(f);

if (ds.convert === "longmemeval") {
  const p = paths[ds.files[0].name];
  console.log(JSON.stringify({ dataset: name, file: p, next: `node scripts/eval-longmemeval.ts ${p} --recall` }));
} else if (ds.convert === "cmteb-retrieval") {
  const py = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const r = spawnSync(
    py,
    ["-I", join(here, "cmteb_to_jsonl.py"), paths.corpus, paths.queries, paths.qrels, dir, opt("--seed", "7"), opt("--queries", "400"), opt("--distractors", "15000")],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`转换失败（要 Python 和 pandas、pyarrow：pip install pandas pyarrow）`);
  console.log(JSON.stringify({ dataset: name, corpus: join(dir, "corpus.jsonl"), queries: join(dir, "queries.jsonl"), next: `node scripts/eval-retrieval.ts ${join(dir, "corpus.jsonl")} ${join(dir, "queries.jsonl")} --home .scratch/eval-${name}` }));
} else if (ds.convert === "locomo") {
  const out = join(dir, "locomo_lme.json");
  const items = locomoToLongMemEval(JSON.parse(readFileSync(paths[ds.files[0].name], "utf8")));
  writeFileSync(out, JSON.stringify(items));
  console.log(JSON.stringify({ dataset: name, questions: items.length, file: out, next: `node scripts/eval-longmemeval.ts ${out} --recall` }));
}
