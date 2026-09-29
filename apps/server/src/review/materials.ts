/** The repository adapter is an input producer. Analysis itself lives in the
 * common knowledge pipeline and accepts any captured source, not file paths. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
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
    if (path.startsWith(".repo-review/") || /(^|\/)(node_modules|dist|\.git)(\/|$)/.test(path) || /(^|\/)\.env(?!\.example$)/.test(path) || /(?:^|\/)omem\.local\.json$/.test(path)) {
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
  return result;
}

export function createReviewKnowledgeRepository(store: Store) {
  ensureReviewMetaTable(store);
  return new KnowledgeRepository(store, () => {
    const removed = new Set((store.db.prepare("SELECT source_id FROM review_source_meta WHERE removed=1 OR legacy_alias_of IS NOT NULL").all() as { source_id: string }[]).map(r => r.source_id));
    return currentMaterials(store).filter(m => !removed.has(m.sourceId));
  });
}
