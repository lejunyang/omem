/** Portable derived knowledge. JSON keeps generation provenance; Markdown is a
 * readable projection. Neither is re-ingested as independent source evidence. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Store } from "../store.js";
import { stableDigest, validateCodeUnderstanding, type CodeUnderstandingOutput } from "../../../../packages/agent-runtime/src/code-understanding.js";
import { currentSnapshotId, snapshotSourceText, symbolsOfSnapshot, listFiles } from "./store.js";
import { understandingSnapshot, understandingDetail } from "./understanding-store.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const GENERATED_DIR = ".repo-review/knowledge/generated";
const covers = (path: string, target: string) => path === target || path.startsWith(target.replace(/\/$/, "") + "/");
type Artifact = {
  version: 1;
  targetId: string;
  dependencies: { path: string; hash: string }[];
  nodes: { id: string; path: string; qualifiedName: string; kind: string }[];
  output: CodeUnderstandingOutput;
  budget?: unknown;
};

// Pass the real repository path so the same explicit rule set is used on export
// and import. No on-disk source body is read by understandingSnapshot.
function dependencyManifest(store: Store, repoRoot: string, snapshotId: string, target: string) {
  const { snapshot } = understandingSnapshot(store, repoRoot, snapshotId);
  const paths = new Set(snapshot.files.filter(f => covers(f.path, target)).map(f => f.path));
  const sources = [...paths].sort().map(path => {
    const text = snapshotSourceText(store, snapshotId, path);
    if (text === null) throw new Error(`Uncaptured dependency: ${path}`);
    return { path, hash: hash(text) };
  });
  // Rule selectors supplied only an excerpt. Hash exactly that provided text,
  // so unrelated edits elsewhere in a rule's source do not invalidate output.
  const evidence = snapshot.evidence.map(e => ({ path: e.ref.split("::")[0]!, evidenceId: e.id, hash: hash(e.text) })).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  return [...sources, ...evidence];
}
export function exportGeneratedUnderstanding(store: Store, repoRoot: string, id: string, destination: string): string {
  const detail = understandingDetail(store, id);
  const snapId = currentSnapshotId(store);
  if (!detail || !snapId || detail.status !== "generated" || detail.seed || detail.stale || detail.snapshot_id !== snapId)
    throw new Error("Only a current successful model result can be exported");
  const output = detail.output as CodeUnderstandingOutput;
  const files = new Map(listFiles(store).map(f => [f.fileId, f.path]));
  const symbols = symbolsOfSnapshot(store, snapId);
  const ids = new Set([...output.referenced_node_ids, ...output.claims.flatMap(c => c.node_ids), ...output.key_flows.flatMap(f => f.node_ids)]);
  const artifact: Artifact = {
    version: 1, targetId: String(detail.target_id), output,
    ...(detail.generation_budget ? { budget: JSON.parse(String(detail.generation_budget)) } : {}),
    dependencies: dependencyManifest(store, repoRoot, snapId, String(detail.target_id)),
    nodes: [...ids].sort().map(id => {
      const symbol = symbols.find(s => s.symbolId === id);
      if (!symbol) throw new Error(`Missing generated reference ${id}`);
      return { id, path: files.get(symbol.fileId)!, qualifiedName: symbol.qualifiedName, kind: symbol.kind };
    }),
  };
  const filename = hash(artifact.targetId).slice(0, 16) + ".json";
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, filename), JSON.stringify(artifact, null, 2) + "\n");
  return filename;
}

export function restoreGeneratedUnderstandings(store: Store, repoRoot: string) {
  const dir = join(repoRoot, GENERATED_DIR);
  const report: { file: string; status: "restored" | "stale" | "rejected"; reason?: string }[] = [];
  const snapId = currentSnapshotId(store);
  if (!snapId || !existsSync(dir)) return report;
  const { snapshot, bundle, inputDigest } = understandingSnapshot(store, repoRoot, snapId);
  const symbols = symbolsOfSnapshot(store, snapId);
  const files = new Map(listFiles(store).map(f => [f.fileId, f.path]));
  for (const file of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    try {
      const artifact = JSON.parse(readFileSync(join(dir, file), "utf8")) as Artifact;
      if (artifact.version !== 1 || !artifact.output || artifact.output.seed || !artifact.output.model || artifact.output.verified_by_agent)
        throw new Error("Invalid model provenance");
      if (stableDigest(artifact.dependencies) !== stableDigest(dependencyManifest(store, repoRoot, snapId, artifact.targetId))) {
        report.push({ file, status: "stale", reason: "来源内容或目标文件集合已变更，需要重新生成" });
        continue;
      }
      const remap = new Map(artifact.nodes.map(n => {
        if (!covers(n.path, artifact.targetId)) throw new Error("Out-of-scope locator");
        const symbol = symbols.find(s => files.get(s.fileId) === n.path && s.qualifiedName === n.qualifiedName && s.kind === n.kind);
        if (!symbol) throw new Error(`Unresolved locator: ${n.path}::${n.qualifiedName}`);
        return [n.id, symbol.symbolId];
      }));
      const mapped = (ids: string[]) => ids.map(id => { const current = remap.get(id); if (!current) throw new Error("Missing locator"); return current; });
      // Rebind only checked references/digest. Original model output and original
      // generation digest remain in the committed artifact, never overwritten.
      const output: CodeUnderstandingOutput = {
        ...artifact.output, input_digest: inputDigest,
        referenced_node_ids: mapped(artifact.output.referenced_node_ids),
        claims: artifact.output.claims.map(c => ({ ...c, node_ids: mapped(c.node_ids) })),
        key_flows: artifact.output.key_flows.map(f => ({ ...f, node_ids: mapped(f.node_ids) })),
      };
      const result = validateCodeUnderstanding({ snapshot, bundle, output, modelAvailable: true });
      if (!result.ok) throw new Error(result.errors.join(", "));
      const already = store.db.prepare("SELECT 1 FROM code_understandings WHERE snapshot_id=? AND target_id=? AND generated_at=? AND status='generated' AND stale=0 AND source='model-generated'").get(snapId, artifact.targetId, output.generated_at);
      if (already) { report.push({ file, status: "restored" }); continue; }
      const id = "cu_artifact_" + hash(stableDigest(artifact) + snapId).slice(0, 24);
      store.tx(() => {
        store.db.prepare(`INSERT OR IGNORE INTO code_understandings
          (understanding_id,target_type,target_id,snapshot_id,role_id,role_version,prompt_hash,schema_digest,input_hash,
           output_schema,output_json,confidence,unknowns,evidence_refs,status,model,generated_at,seed,verified_by_agent,stale,source,curated_note)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, "module", artifact.targetId, snapId, output.role, bundle.manifest.role_version, output.prompt_digest,
          output.schema_digest, inputDigest, "CodeUnderstanding.v1", JSON.stringify(output), output.confidence,
          JSON.stringify(output.unknowns), JSON.stringify(output.evidence_refs.map(e => e.evidence_id)), "generated", output.model,
          output.generated_at, 0, 0, 0, "model-generated", `已从版本化产物恢复，来源与引用校验通过；未进行独立语义复核。原生成输入 ${artifact.output.input_digest}`,
        );
        if (artifact.budget) store.db.prepare("UPDATE code_understandings SET generation_budget=? WHERE understanding_id=?").run(JSON.stringify(artifact.budget), id);
        const insert = store.db.prepare("INSERT OR IGNORE INTO code_understanding_refs(understanding_id,ref_kind,ref_id,selector,note) VALUES(?,?,?,?,?)");
        for (const node of output.referenced_node_ids) insert.run(id, "node", node, null, "");
        for (const e of output.evidence_refs) insert.run(id, "evidence", e.evidence_id, null, e.note);
      });
      report.push({ file, status: "restored" });
    } catch (error) { report.push({ file, status: "rejected", reason: error instanceof Error ? error.message : String(error) }); }
  }
  return report;
}
