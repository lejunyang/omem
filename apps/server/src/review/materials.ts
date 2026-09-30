/** The repository adapter is an input producer. Analysis itself lives in the
 * common knowledge pipeline and accepts any captured source, not file paths. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { join, relative, posix } from "node:path";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import { ensureReviewMetaTable } from "./store.js";
import type { Store } from "../store.js";
import { currentMaterials, KnowledgeRepository } from "../knowledge/repository.js";
import { createHash } from "node:crypto";

export type RepositoryCoverage = { path: string; state: "captured" | "excluded" | "failed"; reason: string; materialKey?: string; digest?: string };

export function captureRepositoryMaterials(store: Store, repoRoot: string): RepositoryCoverage[] {
  let paths: string[];
  try { paths = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 10_000_000, stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(Boolean))].sort(); }
  catch {
    paths = [];
    const walk = (directory: string, prefix = "") => { for (const e of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", ".repo-review", "node_modules", "dist"].includes(e.name)) continue;
      const path = prefix + e.name;
      if (e.isDirectory()) walk(join(directory, e.name), path + "/"); else paths.push(path);
    } }; walk(repoRoot);
  }
  const result: RepositoryCoverage[] = [];
  const realRoot = realpathSync(repoRoot);
  for (const path of paths) {
    if (path.startsWith(".repo-review/") || /(^|\/)(node_modules|dist|\.git)(\/|$)/.test(path) || /(^|\/)\.env(?!\.example$)/.test(path) || /\.local\.json$/.test(path)) {
      result.push({ path, state: "excluded", reason: path.startsWith(".repo-review/") ? "派生知识或历史运行数据，不作为新的独立证据" : "依赖、构建、运行配置或私有环境" }); continue;
    }
    try {
      const absolute = join(repoRoot, path), stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || relative(realRoot, realpathSync(absolute)).startsWith("..")) { result.push({ path, state: "excluded", reason: "非普通文件或符号链接" }); continue; }
      if (stat.size > 5_000_000) throw Error("文件超过 5 MB 输入预算，需单独处理");
      const bytes = readFileSync(absolute);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const externalId = `omem:${path}`;
      const previous = store.db.prepare("SELECT r.body FROM sources s JOIN revisions r ON s.head=r.id WHERE s.namespace='file' AND s.external_id=?").get(externalId) as { body: string } | undefined;
      const context = previous ? JSON.parse(previous.body).context : {};
      if (context.contentHash !== hash || context.captureFormat !== "verbatim-v1") {
        let parts: CaptureInput["parts"];
        const mime = /\.png$/i.test(path) ? "image/png" : /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.webp$/i.test(path) ? "image/webp" : null;
        if (mime) parts = [{ type: "image", mimeType: mime, data: bytes.toString("base64"), label: path.slice(-200) }];
        else {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.includes("\0")) throw Error("不是可直接分析的文本或支持的图像");
          if (!text.trim()) { result.push({ path, state: "excluded", reason: "空文件，无可提炼内容" }); continue; }
          parts = Array.from({ length: Math.ceil(text.length / 180000) }, (_, i) => ({ type: "text" as const, text: text.slice(i * 180000, (i + 1) * 180000) }));
        }
        store.capture({ source: "file", externalId, title: path, parts,
          context: { filePath: path, contentHash: hash, captureFormat: "verbatim-v1", category: path.startsWith("docs/research/") ? "research" : path.startsWith("docs/") ? "decisions" : "architecture" } as CaptureInput["context"] });
      }
      result.push({ path, state: "captured", materialKey: externalId, digest: hash, reason: "固定材料已保存" });
    } catch (error) { result.push({ path, state: "failed", reason: error instanceof Error ? error.message : String(error) }); }
  }
  // The general material adapter also owns non-code files (for example JSON).
  // Reconcile removals here; the code/docs synchronizer cannot see all of them.
  ensureReviewMetaTable(store);
  const present = new Set(result.filter(row => row.state === "captured").map(row => row.materialKey));
  const sources = store.db.prepare("SELECT id,external_id FROM sources WHERE namespace='file' AND external_id LIKE 'omem:%'").all() as {id:string;external_id:string}[];
  const mark = store.db.prepare(`INSERT INTO review_source_meta(source_id,removed,updated_at) VALUES(?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET removed=excluded.removed,updated_at=excluded.updated_at
    WHERE removed != excluded.removed`);
  for (const source of sources) mark.run(source.id,present.has(source.external_id)?0:1,new Date().toISOString());
  return result;
}

export function createReviewKnowledgeRepository(store: Store) {
  ensureReviewMetaTable(store);
  return new KnowledgeRepository(store, () => {
    const removed = new Set((store.db.prepare("SELECT source_id FROM review_source_meta WHERE removed=1 OR legacy_alias_of IS NOT NULL").all() as { source_id: string }[]).map(r => r.source_id));
    return currentMaterials(store).filter(m => !removed.has(m.sourceId));
  });
}

/** Select explicit local document links as context, not as confirmed relations.
 * Models still decide what the material means and the verifier checks support. */
export function linkedMaterialOffers(all: KnowledgeMaterial[], targets: KnowledgeMaterial[]) {
  const byPath = new Map(all.filter(m => m.path).map(m => [m.path!, m]));
  const selected = new Map<string, { material: KnowledgeMaterial; ranges: { start: number; end: number }[] }>();
  for (const target of targets) {
    if (!target.path) continue;
    const references = [...target.text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]!);
    if (target.path.endsWith(".html")) references.push("./build.mjs", "./app.jsx", "./styles.css");
    for (const ref of references) {
      if (/^(?:[a-z]+:|\/\/)/i.test(ref)) continue;
      const [file, anchor] = ref.split("#");
      const path = posix.normalize(posix.join(posix.dirname(target.path), file || posix.basename(target.path)));
      const material = byPath.get(path);
      if (!material || targets.some(t => t.key === material.key) || selected.has(material.key)) continue;
      const lines = material.text.split("\n");
      const slug = (text: string) => text.replace(/^#+\s*/, "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
      let start = 1;
      if (anchor) { let decoded = anchor; try { decoded = decodeURIComponent(anchor); } catch {} const index = lines.findIndex(line => /^#+\s/.test(line) && slug(line) === decoded); if (index >= 0) start = index + 1; }
      selected.set(material.key, { material, ranges: [{ start, end: Math.min(material.lineCount, start + 79) }] });
    }
  }
  return [...selected.values()].slice(0, 4);
}
