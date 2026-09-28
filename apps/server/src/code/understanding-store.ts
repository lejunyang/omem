/** Curated Code Understanding projection.
 *
 * Committed seed assets live under `.repo-review/knowledge/understandings/`.
 * They are hand-curated, human-readable module notes that cite the graph by
 * stable locators (repo-relative path + qualified symbol name). At sync time
 * this module:
 *
 *   1. builds the fixed CodeSnapshot from the CURRENT head graph + on-disk file
 *      text (the same reference set a model run would see),
 *   2. resolves every curated locator to a concrete node/evidence id,
 *   3. seals the narrative with the module-architect bundle digests and the
 *      snapshot input digest,
 *   4. runs the strict validateCodeUnderstanding cross-reference check, and
 *   5. persists accepted seeds as current, or records a rejected/failed row that
 *      never shadows a good result.
 *
 * No production model is ever called: modelAvailable is always false, so the
 * validator forces seed=true / model=null / verified_by_agent=false. The
 * curator identity lives in the curated_* columns and the seed file, NOT in the
 * strict output (which forbids claiming a model ran or that a seed was
 * independently agent-verified).
 *
 * derived vs raw: output_json is the DERIVED understanding. The node/edge/
 * evidence ids it cites are mirrored into code_understanding_refs, but the raw
 * graph rows (code_symbols/code_edges/code_files) are never rewritten.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Store } from "../store.js";
import {
  codeRepositoryId,
  ensureCodeTables,
  fileIdFor,
  symbolIdFor,
} from "./store.js";
import {
  CodeRoleRegistry,
  validateCodeUnderstanding,
  stableDigest,
  type CodeSnapshot,
} from "../../../../packages/agent-runtime/src/code-understanding.js";
import type { CodeUnderstandingOutput } from "../../../../packages/agent-runtime/src/code-understanding.js";

const KNOWLEDGE_DIR = ".repo-review/knowledge/understandings";

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Curated seed asset shape (committed JSON).
// ---------------------------------------------------------------------------

type CuratedNodeLocator = { path: string; qualified: string; kind: string };

type CuratedSeedEvidence = {
  id_hint: string;
  kind: "decision" | "rule" | "doc" | "comment";
  ref: string;
  text: string;
  selector?: { path: string; start_line: number; end_line: number } | null;
};

type CuratedSeedClaim = {
  text: string;
  nodes?: CuratedNodeLocator[];
  evidence?: string[];
};

export type CuratedSeed = {
  result_id: string;
  target: { type: "module"; id: string; title: string };
  curated: { by: string; at: string; against_commit: string; note: string };
  output: {
    module_responsibilities: string[];
    boundaries: string[];
    key_flows: { name: string; description: string; nodes?: CuratedNodeLocator[] }[];
    entry_points: string[];
    exit_points: string[];
    risks_and_limits: string[];
    unknowns: string[];
    claims: CuratedSeedClaim[];
    evidence: CuratedSeedEvidence[];
  };
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? "" : String(v));

export function evidenceIdFor(e: { kind: string; ref: string; id_hint: string }): string {
  return "ev_" + sha1(`${e.kind}:${e.ref}:${e.id_hint}`).slice(0, 24);
}

/** Map a parsed DB symbol kind into the strict CodeSnapshot symbol enum.
 * Returns null for kinds the understanding snapshot does not model (route,
 * test, component, enum, ...) — those symbols simply cannot be cited. */
function mapSymbolKind(kind: string): CodeSnapshot["symbols"][number]["kind"] | null {
  switch (kind) {
    case "class":
    case "method":
    case "function":
    case "interface":
    case "type":
    case "module":
      return kind;
    case "const":
    case "constant":
    case "variable":
      return "constant";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Seed asset loading.
// ---------------------------------------------------------------------------

export function loadCuratedSeeds(repoRoot: string): CuratedSeed[] {
  const dir = join(repoRoot, KNOWLEDGE_DIR);
  if (!existsSync(dir)) return [];
  const out: CuratedSeed[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".seed.json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as CuratedSeed);
    } catch {
      // A malformed seed file must not take down the whole sync; it surfaces
      // as a rejected row when projection runs.
    }
  }
  return out.sort((a, b) => a.result_id.localeCompare(b.result_id));
}

// ---------------------------------------------------------------------------
// Build the fixed CodeSnapshot from the current head graph.
// ---------------------------------------------------------------------------

function buildSnapshot(
  store: Store,
  repoRoot: string,
  snapId: string,
  seeds: CuratedSeed[],
): CodeSnapshot {
  const db = store.db;
  const fileRows = db
    .prepare(
      `SELECT * FROM code_files WHERE head_snapshot_id=? OR file_id IN
       (SELECT DISTINCT file_id FROM code_symbols WHERE snapshot_id=?)`,
    )
    .all(snapId, snapId) as Row[];

  const files: CodeSnapshot["files"] = [];
  const fileIdToPath = new Map<string, string>();
  for (const f of fileRows) {
    const path = str(f.path);
    fileIdToPath.set(str(f.file_id), path);
    let text = "";
    try {
      text = readFileSync(join(repoRoot, path), "utf8");
    } catch {
      text = "";
    }
    files.push({
      id: str(f.file_id),
      path,
      language: str(f.language) || "text",
      text,
    });
  }

  const symRows = db
    .prepare("SELECT * FROM code_symbols WHERE snapshot_id=?")
    .all(snapId) as Row[];
  const symbols: CodeSnapshot["symbols"] = [];
  const symbolIdToFile = new Map<string, string>();
  for (const s of symRows) {
    const kind = mapSymbolKind(str(s.kind));
    if (!kind) continue;
    const start = JSON.parse(str(s.range_start)) as { line: number };
    const end = JSON.parse(str(s.range_end)) as { line: number };
    const id = str(s.symbol_id);
    symbolIdToFile.set(id, str(s.file_id));
    symbols.push({
      id,
      file_id: str(s.file_id),
      name: str(s.name),
      kind,
      start_line: start.line,
      end_line: Math.max(end.line, start.line),
      signature: str(s.signature),
    });
  }

  // Evidence docs: union across all curated seeds, deterministic ids. The
  // validator only needs them to exist; selectors are resolved per-seed.
  const seenEvidence = new Map<string, CodeSnapshot["evidence"][number]>();
  for (const seed of seeds) {
    for (const e of seed.output.evidence) {
      const id = evidenceIdFor(e);
      if (!seenEvidence.has(id))
        seenEvidence.set(id, { id, kind: e.kind, ref: e.ref, text: e.text });
    }
  }

  return {
    schema_version: 1,
    snapshot_id: snapId,
    commit: "",
    files,
    symbols,
    // The parser's calls edges are name-level with a null caller, so there are
    // no confirmed symbol->symbol edges to model; an empty edge set is honest.
    edges: [],
    evidence: [...seenEvidence.values()],
  };
}

// ---------------------------------------------------------------------------
// Projection.
// ---------------------------------------------------------------------------

export type ProjectResult = {
  projected: number;
  rejected: number;
  rejectedIds: string[];
};

export function projectCuratedSeeds(
  store: Store,
  repoRoot: string,
  snapId: string,
): ProjectResult {
  ensureCodeTables(store);
  const seeds = loadCuratedSeeds(repoRoot);
  if (!seeds.length) return { projected: 0, rejected: 0, rejectedIds: [] };

  const registry = new CodeRoleRegistry();
  const bundle = registry.load("module-architect", "1");
  const snapshot = buildSnapshot(store, repoRoot, snapId, seeds);
  const inputDigest = stableDigest(snapshot);
  const repoId = codeRepositoryId();

  let projected = 0;
  let rejected = 0;
  const rejectedIds: string[] = [];

  for (const seed of seeds) {
    const understandingId =
      "cu_" + sha1(`${seed.result_id}:${inputDigest}`).slice(0, 24);

    // Resolve node locators to concrete symbol ids present in this snapshot.
    // An unresolvable locator is a hard projection failure (not a silent
    // drop): the curated seed named a node that no longer exists, so the
    // result persists as rejected rather than silently citing nothing.
    const resolutionErrors: string[] = [];
    const referencedNodeIds = new Set<string>();
    const resolveNode = (loc: CuratedNodeLocator): string | null => {
      const sid = symbolIdFor(repoId, loc.path, loc.qualified, loc.kind);
      const row = store.db
        .prepare(
          "SELECT symbol_id FROM code_symbols WHERE symbol_id=? AND snapshot_id=?",
        )
        .get(sid, snapId) as { symbol_id: string } | undefined;
      if (!row) {
        resolutionErrors.push(
          `UNRESOLVED_NODE: ${loc.path}::${loc.qualified}(${loc.kind})`,
        );
        return null;
      }
      referencedNodeIds.add(sid);
      return sid;
    };

    const evidenceRefs: CodeUnderstandingOutput["evidence_refs"] = [];
    const evidenceById = new Map(
      seed.output.evidence.map((e) => [e.id_hint, e] as const),
    );
    for (const e of seed.output.evidence) {
      const evidenceId = evidenceIdFor(e);
      let selector: { file_id: string; start_line: number; end_line: number } | null = null;
      if (e.selector) {
        selector = {
          file_id: fileIdFor(repoId, e.selector.path),
          start_line: e.selector.start_line,
          end_line: e.selector.end_line,
        };
      }
      evidenceRefs.push({ evidence_id: evidenceId, selector, note: e.ref });
    }

    const claims: CodeUnderstandingOutput["claims"] = [];
    for (const c of seed.output.claims) {
      const nodeIdsResolved: string[] = [];
      for (const n of c.nodes ?? []) {
        const id = resolveNode(n);
        if (id) nodeIdsResolved.push(id);
      }
      const evidenceIds: string[] = [];
      for (const hint of c.evidence ?? []) {
        const e = evidenceById.get(hint);
        if (!e) resolutionErrors.push(`UNRESOLVED_EVIDENCE_HINT: ${hint}`);
        else evidenceIds.push(evidenceIdFor(e));
      }
      claims.push({
        text: c.text,
        kind: "raw_fact",
        node_ids: nodeIdsResolved,
        edge_ids: [],
        evidence_ids: evidenceIds,
      });
    }

    const flowNodes: { name: string; description: string; node_ids: string[] }[] = [];
    for (const flow of seed.output.key_flows) {
      const nodeIds: string[] = [];
      for (const n of flow.nodes ?? []) {
        const id = resolveNode(n);
        if (id) nodeIds.push(id);
      }
      flowNodes.push({ name: flow.name, description: flow.description, node_ids: nodeIds });
    }

    // Previous row for this curated module (any snapshot) becomes history.
    const prev = store.db
      .prepare(
        `SELECT understanding_id FROM code_understandings
         WHERE target_type='module' AND target_id=? AND understanding_id<>?
         ORDER BY generated_at DESC, rowid DESC LIMIT 1`,
      )
      .get(seed.target.id, understandingId) as { understanding_id: string } | undefined;

    const persistRejected = (errors: string[]) => {
      rejected++;
      rejectedIds.push(seed.result_id);
      store.db
        .prepare(
          `INSERT INTO code_understandings(
             understanding_id,target_type,target_id,snapshot_id,role_id,role_version,
             prompt_hash,schema_digest,input_hash,output_schema,output_json,confidence,
             unknowns,evidence_refs,status,model,effort,generated_at,supersedes_id,
             seed,verified_by_agent,verified_by,stale,source,curated_by,curated_at,curated_note)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(understanding_id) DO UPDATE SET
             output_json=excluded.output_json, status=excluded.status,
             snapshot_id=excluded.snapshot_id`,
        )
        .run(
          understandingId, "module", seed.target.id, snapId,
          bundle.manifest.role_id, bundle.manifest.role_version,
          bundle.promptDigest, bundle.schemaDigest, inputDigest,
          "CodeUnderstanding.v1",
          JSON.stringify({ errors, result_id: seed.result_id }),
          null, "[]", "[]",
          "rejected", null, null, seed.curated.at, prev?.understanding_id ?? null,
          1, 0, null, 0, "curated-seed",
          seed.curated.by, seed.curated.at, seed.curated.note,
        );
    };

    if (resolutionErrors.length) {
      persistRejected(resolutionErrors);
      continue;
    }

    const output = {
      schema_version: 1 as const,
      result_id: seed.result_id,
      role: "module-architect" as const,
      status: "seed" as const,
      module_responsibilities: seed.output.module_responsibilities,
      boundaries: seed.output.boundaries,
      key_flows: flowNodes,
      entry_points: seed.output.entry_points,
      exit_points: seed.output.exit_points,
      risks_and_limits: seed.output.risks_and_limits,
      claims,
      referenced_node_ids: [...referencedNodeIds],
      referenced_edge_ids: [],
      evidence_refs: evidenceRefs,
      unknowns: seed.output.unknowns,
      confidence: 0.1,
      model: null,
      prompt_digest: bundle.promptDigest,
      schema_digest: bundle.schemaDigest,
      input_digest: inputDigest,
      generated_at: seed.curated.at,
      seed: true,
      verified_by_agent: false,
      verified_by: null,
    };

    const result = validateCodeUnderstanding({
      bundle,
      snapshot,
      output,
      modelAvailable: false,
    });

    if (!result.ok) {
      persistRejected(result.errors);
      continue;
    }

    // Accepted: it is current for this snapshot.
    projected++;
    store.db
      .prepare(
        `INSERT INTO code_understandings(
           understanding_id,target_type,target_id,snapshot_id,role_id,role_version,
           prompt_hash,schema_digest,input_hash,output_schema,output_json,confidence,
           unknowns,evidence_refs,status,model,effort,generated_at,supersedes_id,
           seed,verified_by_agent,verified_by,stale,source,curated_by,curated_at,curated_note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(understanding_id) DO UPDATE SET
           output_json=excluded.output_json, snapshot_id=excluded.snapshot_id,
           status=excluded.status, confidence=excluded.confidence, stale=0,
           generated_at=excluded.generated_at`,
      )
      .run(
        understandingId, "module", seed.target.id, snapId,
        bundle.manifest.role_id, bundle.manifest.role_version,
        bundle.promptDigest, bundle.schemaDigest, inputDigest,
        "CodeUnderstanding.v1", JSON.stringify(result.output),
        result.output.confidence,
        JSON.stringify(result.output.unknowns),
        JSON.stringify(result.output.evidence_refs.map((r) => r.evidence_id)),
        result.output.status, null, null, result.output.generated_at,
        prev?.understanding_id ?? null,
        1, 0, null, 0, "curated-seed",
        seed.curated.by, seed.curated.at, seed.curated.note,
      );

    // Mirror references into the normalized side table.
    store.db
      .prepare("DELETE FROM code_understanding_refs WHERE understanding_id=?")
      .run(understandingId);
    const ins = store.db.prepare(
      "INSERT OR IGNORE INTO code_understanding_refs(understanding_id,ref_kind,ref_id,selector,note) VALUES(?,?,?,?,?)",
    );
    for (const nid of result.output.referenced_node_ids)
      ins.run(understandingId, "node", nid, null, "");
    for (const e of result.output.evidence_refs)
      ins.run(
        understandingId, "evidence", e.evidence_id,
        e.selector ? JSON.stringify(e.selector) : null, e.note,
      );

    // Any earlier row for this module (including a prior snapshot or the failed
    // attempt) is history: keep it, but mark stale so the list endpoint shows
    // exactly one current understanding per module.
    if (prev)
      store.db
        .prepare(
          "UPDATE code_understandings SET stale=1 WHERE understanding_id=?",
        )
        .run(prev.understanding_id);
  }

  return { projected, rejected, rejectedIds };
}

// ---------------------------------------------------------------------------
// Read surface for the review HTTP layer.
// ---------------------------------------------------------------------------

export function listUnderstandings(
  store: Store,
  opts: { all?: boolean } = {},
): Row[] {
  ensureCodeTables(store);
  // This surface is curated/seed understandings only; the deterministic
  // repository row (source='parser') lives in the code graph, not here.
  const where = opts.all
    ? "WHERE source='curated-seed'"
    : "WHERE source='curated-seed' AND stale=0 AND status IN ('seed','generated','verified')";
  return store.db
    .prepare(
      `SELECT understanding_id,target_type,target_id,snapshot_id,role_id,role_version,
              prompt_hash,schema_digest,input_hash,output_schema,confidence,status,model,
              generated_at,supersedes_id,seed,verified_by_agent,verified_by,stale,source,
              curated_by,curated_at,curated_note
       FROM code_understandings ${where}
       ORDER BY target_type, target_id, generated_at DESC`,
    )
    .all() as Row[];
}

export function understandingDetail(
  store: Store,
  id: string,
): (Row & { refs: Row[]; output: unknown }) | null {
  ensureCodeTables(store);
  const row = store.db
    .prepare("SELECT * FROM code_understandings WHERE understanding_id=?")
    .get(id) as Row | undefined;
  if (!row) return null;
  const refs = store.db
    .prepare("SELECT * FROM code_understanding_refs WHERE understanding_id=?")
    .all(id) as Row[];
  let output: unknown = null;
  try {
    output = JSON.parse(str(row.output_json));
  } catch {
    output = null;
  }
  return { ...row, refs, output };
}

/** There is deliberately no production model wired into the review side today.
 * The raw graph always works; this endpoint states the honest availability. */
export function modelAvailability(): { available: boolean; reason: string } {
  return {
    available: false,
    reason:
      "no production model configured in review mode; only curated seed projections are served",
  };
}
