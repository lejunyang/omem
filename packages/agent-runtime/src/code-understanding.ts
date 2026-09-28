// Bounded, deterministic Code Understanding subsystem.
//
// This module is intentionally self-contained: it owns its own versioned output
// contract (CodeUnderstanding.v1), its own role-asset loader with digest/budget/
// allowlist checks, and a deterministic cross-reference validator. It never calls
// a real model. When no model is available the only legal product is a `seed`
// skeleton; the validator rejects any output that pretends a model ran.
//
// The input snapshot is fixed before the run: files, symbol nodes, edges, and the
// decisions/rules/docs that back claims. Material text is untrusted data and is
// never treated as an instruction to the model or to this validator.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Deterministic hashing (self-contained copy of apps/server digest utils so this
// subsystem has zero coupling to the memory/storage layer it must not touch).
// ---------------------------------------------------------------------------

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  return value;
}

export const canonicalJson = (value: unknown) =>
  JSON.stringify(normalize(value));

export const stableDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const sha256Text = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Input snapshot: the fixed, trusted reference set for one understanding run.
// Every id the model may cite must exist here, or the validator rejects it.
// ---------------------------------------------------------------------------

export const codeFileSchema = z
  .object({
    id: z.string().min(1).max(300),
    path: z.string().min(1).max(1000),
    language: z.string().min(1).max(100),
    text: z.string().max(2_000_000),
  })
  .strict();

export const symbolNodeSchema = z
  .object({
    id: z.string().min(1).max(300),
    file_id: z.string().min(1).max(300),
    name: z.string().min(1).max(300),
    kind: z.enum([
      "module",
      "class",
      "function",
      "method",
      "interface",
      "type",
      "constant",
      "variable",
    ]),
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
    signature: z.string().max(1000).default(""),
  })
  .strict()
  .refine((n) => n.end_line >= n.start_line, {
    message: "symbol end_line must be >= start_line",
    path: ["end_line"],
  });

export const codeEdgeSchema = z
  .object({
    id: z.string().min(1).max(300),
    from_id: z.string().min(1).max(300),
    to_id: z.string().min(1).max(300),
    type: z.enum([
      "calls",
      "imports",
      "extends",
      "implements",
      "uses",
      "contains",
      "references",
    ]),
  })
  .strict();

export const evidenceDocSchema = z
  .object({
    id: z.string().min(1).max(300),
    kind: z.enum(["decision", "rule", "doc", "comment"]),
    ref: z.string().min(1).max(1000),
    text: z.string().max(50_000),
  })
  .strict();

export const codeSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    snapshot_id: z.string().min(1).max(300),
    commit: z.string().max(200).default(""),
    files: z.array(codeFileSchema).max(2000),
    symbols: z.array(symbolNodeSchema).max(5000),
    edges: z.array(codeEdgeSchema).max(20000),
    evidence: z.array(evidenceDocSchema).max(2000),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const fileIds = new Set(snapshot.files.map((f) => f.id));
    const symbolIds = new Set(snapshot.symbols.map((s) => s.id));
    const evidenceIds = new Set(snapshot.evidence.map((e) => e.id));
    const dup = (ids: string[], label: string) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id))
          ctx.addIssue({
            code: "custom",
            path: [label],
            message: `duplicate ${label} id: ${id}`,
          });
        seen.add(id);
      }
    };
    dup(snapshot.files.map((f) => f.id), "file");
    dup(snapshot.symbols.map((s) => s.id), "symbol");
    dup(snapshot.edges.map((e) => e.id), "edge");
    dup(snapshot.evidence.map((e) => e.id), "evidence");
    for (const symbol of snapshot.symbols) {
      if (!fileIds.has(symbol.file_id))
        ctx.addIssue({
          code: "custom",
          path: ["symbols"],
          message: `symbol ${symbol.id} references unknown file_id ${symbol.file_id}`,
        });
    }
    for (const edge of snapshot.edges) {
      if (!symbolIds.has(edge.from_id))
        ctx.addIssue({
          code: "custom",
          path: ["edges"],
          message: `edge ${edge.id} references unknown from_id ${edge.from_id}`,
        });
      if (!symbolIds.has(edge.to_id))
        ctx.addIssue({
          code: "custom",
          path: ["edges"],
          message: `edge ${edge.id} references unknown to_id ${edge.to_id}`,
        });
    }
    void evidenceIds;
  });

export type CodeSnapshot = z.infer<typeof codeSnapshotSchema>;

// ---------------------------------------------------------------------------
// CodeUnderstanding.v1 — the strict, versioned output contract shared by all
// four code-understanding roles. Free-text interpretation is allowed, but every
// pointer into the snapshot is enumerated and cross-checked deterministically.
// ---------------------------------------------------------------------------

export const CODE_UNDERSTANDING_ROLES = [
  "repo-profiler",
  "module-architect",
  "symbol-explainer",
  "relation-verifier",
] as const;
export type CodeUnderstandingRole = (typeof CODE_UNDERSTANDING_ROLES)[number];

export const codeUnderstandingRoleSchema = z.enum(CODE_UNDERSTANDING_ROLES);

export const lineSelectorSchema = z
  .object({
    file_id: z.string().min(1).max(300),
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
  })
  .strict()
  .refine((s) => s.end_line >= s.start_line, {
    message: "end_line must be >= start_line",
    path: ["end_line"],
  });

export const evidenceRefSchema = z
  .object({
    evidence_id: z.string().min(1).max(300),
    selector: lineSelectorSchema.nullable().default(null),
    note: z.string().max(1000).default(""),
  })
  .strict();

export const flowStepSchema = z
  .object({
    name: z.string().min(1).max(300),
    description: z.string().max(2000).default(""),
    node_ids: z.array(z.string().min(1).max(300)).max(50).default([]),
  })
  .strict();

// Each claim is explicitly tagged so raw facts (mechanically present in the
// snapshot) are never conflated with an agent's interpretation.
export const claimSchema = z
  .object({
    text: z.string().min(1).max(2000),
    kind: z.enum(["raw_fact", "interpretation"]),
    node_ids: z.array(z.string().min(1).max(300)).max(50).default([]),
    edge_ids: z.array(z.string().min(1).max(300)).max(50).default([]),
    evidence_ids: z.array(z.string().min(1).max(300)).max(50).default([]),
  })
  .strict();

export const codeUnderstandingOutputSchema = z
  .object({
    schema_version: z.literal(1),
    result_id: z.string().min(1).max(500),
    role: codeUnderstandingRoleSchema,
    // seed = produced with no model; generated = model produced it;
    // verified = an independent agent re-checked the content; failed/rejected
    // = the deterministic validator refused the run.
    status: z.enum(["seed", "generated", "verified", "failed", "rejected"]),
    // Domain content.
    module_responsibilities: z.array(z.string().min(1).max(1000)).max(100),
    boundaries: z.array(z.string().min(1).max(1000)).max(100),
    key_flows: z.array(flowStepSchema).max(50),
    entry_points: z.array(z.string().min(1).max(500)).max(100),
    exit_points: z.array(z.string().min(1).max(500)).max(100),
    risks_and_limits: z.array(z.string().min(1).max(1000)).max(100),
    claims: z.array(claimSchema).max(200),
    // References into the fixed snapshot (validator cross-checks every one).
    referenced_node_ids: z.array(z.string().min(1).max(300)).max(500),
    referenced_edge_ids: z.array(z.string().min(1).max(300)).max(500),
    evidence_refs: z.array(evidenceRefSchema).max(500),
    // Honesty fields.
    unknowns: z.array(z.string().min(1).max(1000)).max(100),
    confidence: z.number().min(0).max(1),
    // Provenance seal — all pinned so a reproduced run hashes identically.
    model: z.string().min(1).max(300).nullable(),
    prompt_digest: z.string().regex(/^[a-f0-9]{64}$/),
    schema_digest: z.string().regex(/^[a-f0-9]{64}$/),
    input_digest: z.string().regex(/^[a-f0-9]{64}$/),
    generated_at: z.string().min(1).max(100),
    seed: z.boolean(),
    // true ONLY when an independent verifier agent actually re-checked this
    // output. Raw facts and agent assertions both live in the same fields; this
    // flag is the only thing that promotes the latter to "verified".
    verified_by_agent: z.boolean(),
    verified_by: z.string().min(1).max(300).nullable(),
  })
  .strict()
  .superRefine((out, ctx) => {
    // Internal consistency of the provenance seal.
    if (out.seed && out.model !== null)
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "seed output must not name a model",
      });
    if (!out.seed && out.model === null)
      ctx.addIssue({
        code: "custom",
        path: ["seed"],
        message: "non-seed output must name the model that produced it",
      });
    if (out.verified_by_agent && out.verified_by === null)
      ctx.addIssue({
        code: "custom",
        path: ["verified_by"],
        message: "verified_by_agent requires a verified_by identifier",
      });
    if (!out.verified_by_agent && out.verified_by !== null)
      ctx.addIssue({
        code: "custom",
        path: ["verified_by"],
        message: "verified_by must be null when verified_by_agent is false",
      });
    if (out.seed && out.verified_by_agent)
      ctx.addIssue({
        code: "custom",
        path: ["verified_by_agent"],
        message: "seed output cannot be agent-verified",
      });
    if (out.status === "verified" && !out.verified_by_agent)
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "status=verified requires verified_by_agent=true",
      });
    if (out.status === "seed" && !out.seed)
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "status=seed requires seed=true",
      });
  });

export type CodeUnderstandingOutput = z.infer<typeof codeUnderstandingOutputSchema>;

// ---------------------------------------------------------------------------
// Role asset loading: versioned manifest + prompt + output.schema.json + minimal
// inline skill. Mirrors the production RoleBundleRegistry discipline (digest,
// budget, path safety, no symlinks) but with its own allowlist so it never
// accidentally widens the production role set.
// ---------------------------------------------------------------------------

export const codeRoleManifestSchema = z
  .object({
    schema_version: z.literal(1),
    role_id: codeUnderstandingRoleSchema,
    role_version: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(100),
    output_schema: z.literal("CodeUnderstanding.v1"),
    prompt_templates: z.array(z.string().min(1).max(500)).min(1).max(5),
    skill_bundles: z
      .array(
        z
          .object({
            canonical_name: z.string().regex(/^[a-z0-9-]+$/).max(64),
            version: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(100),
            artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(3),
    budget: z
      .object({
        max_context_tokens: z.number().int().min(256).max(200_000),
        max_output_tokens: z.number().int().min(128).max(100_000),
      })
      .strict(),
    // Hard cap on how many snapshot rows a run may cite. Guards against a model
    // dumping the whole graph into one answer.
    max_referenced_nodes: z.number().int().min(1).max(2000).default(200),
  })
  .strict();

export type CodeRoleManifest = z.infer<typeof codeRoleManifestSchema>;

export type LoadedCodeSkill = {
  canonical_name: string;
  version: string;
  content: string;
  digest: string;
};

export type LoadedCodeRole = {
  manifest: CodeRoleManifest;
  prompt: string;
  outputSchema: Record<string, unknown>;
  skills: LoadedCodeSkill[];
  promptDigest: string;
  schemaDigest: string;
  bundleDigest: string;
};

const inside = (root: string, candidate: string) => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function safeFile(root: string, path: string) {
  const candidate = resolve(root, path);
  if (!inside(resolve(root), candidate) || !existsSync(candidate))
    throw Error(`CODE_ROLE_ASSET_PATH_INVALID: ${path}`);
  const actual = realpathSync(candidate);
  if (!inside(realpathSync(root), actual) || lstatSync(candidate).isSymbolicLink())
    throw Error(`CODE_ROLE_ASSET_SYMLINK_REJECTED: ${path}`);
  return actual;
}

function walkFiles(directory: string, root = directory): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const p = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw Error(`CODE_ROLE_ASSET_SYMLINK_REJECTED: ${relative(root, p)}`);
    if (entry.isDirectory()) out.push(...walkFiles(p, root));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort((l, r) => relative(root, l).localeCompare(relative(root, r)));
}

// Same LF/normalization discipline as the production registry so digests are
// stable across CRLF checkouts.
export function directoryDigest(directory: string): string {
  const hash = createHash("sha256");
  for (const p of walkFiles(directory)) {
    const normalized = relative(directory, p).split(sep).join("/");
    hash.update(normalized);
    hash.update("\0");
    const raw = readFileSync(p).toString("binary").replace(/\r\n/g, "\n");
    hash.update(Buffer.from(raw, "binary"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export class CodeRoleRegistry {
  constructor(readonly root: string = resolve("packages/agent-runtime/roles")) {}

  load(roleId: string, version = "1"): LoadedCodeRole {
    if (!CODE_UNDERSTANDING_ROLES.includes(roleId as CodeUnderstandingRole))
      throw Error(`CODE_ROLE_NOT_ALLOWLISTED: ${roleId}`);
    if (!/^[a-z0-9-]+$/.test(roleId) || !/^[a-zA-Z0-9._-]+$/.test(version))
      throw Error("CODE_ROLE_ID_OR_VERSION_INVALID");
    const directory = resolve(this.root, roleId, version);
    if (!inside(resolve(this.root), directory))
      throw Error("CODE_ROLE_PATH_INVALID");
    const manifest = codeRoleManifestSchema.parse(
      JSON.parse(readFileSync(safeFile(directory, "manifest.json"), "utf8")),
    );
    if (manifest.role_id !== roleId || manifest.role_version !== version)
      throw Error("CODE_ROLE_MANIFEST_ID_MISMATCH");
    const prompt = manifest.prompt_templates
      .map((p) => readFileSync(safeFile(directory, p), "utf8"))
      .join("\n\n");
    const outputSchemaRaw = readFileSync(
      safeFile(directory, "output.schema.json"),
      "utf8",
    );
    const outputSchema = JSON.parse(outputSchemaRaw) as Record<string, unknown>;
    if (
      String(outputSchema.$id || "").split("/").at(-1) !==
      manifest.output_schema
    )
      throw Error("CODE_ROLE_OUTPUT_SCHEMA_MISMATCH");
    const seen = new Set<string>();
    const skills: LoadedCodeSkill[] = manifest.skill_bundles.map((entry) => {
      if (seen.has(entry.canonical_name))
        throw Error("CODE_ROLE_SKILL_DUPLICATE");
      seen.add(entry.canonical_name);
      const skillDir = resolve(directory, "skills", entry.canonical_name);
      if (!inside(directory, skillDir) || !existsSync(skillDir))
        throw Error(`CODE_ROLE_SKILL_MISSING: ${entry.canonical_name}`);
      const digest = directoryDigest(skillDir);
      if (digest !== entry.artifact_digest)
        throw Error(`CODE_ROLE_SKILL_DIGEST_MISMATCH: ${entry.canonical_name}`);
      const skillFile = readFileSync(safeFile(skillDir, "SKILL.md"), "utf8");
      const frontmatter = skillFile.match(
        /^---\s*\nname:\s*([^\n]+)\n/m,
      )?.[1]?.trim();
      if (frontmatter !== entry.canonical_name)
        throw Error(`CODE_ROLE_SKILL_NAME_MISMATCH: ${entry.canonical_name}`);
      return {
        canonical_name: entry.canonical_name,
        version: entry.version,
        content: skillFile,
        digest,
      };
    });
    const promptDigest = sha256Text(prompt);
    const schemaDigest = sha256Text(outputSchemaRaw.replace(/\r\n/g, "\n"));
    return {
      manifest,
      prompt,
      outputSchema,
      skills,
      promptDigest,
      schemaDigest,
      bundleDigest: stableDigest({
        role: manifest.role_id,
        version: manifest.role_version,
        promptDigest,
        schemaDigest,
        skills: skills.map((s) => ({
          n: s.canonical_name,
          v: s.version,
          d: s.digest,
        })),
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic validator. Returns a discriminated result instead of throwing
// on cross-reference problems, so callers can record status=failed/rejected and
// never promote a hallucinated id into the knowledge graph.
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; output: CodeUnderstandingOutput }
  | { ok: false; errors: string[]; status: "failed" | "rejected" };

const lineCount = (text: string) =>
  text === "" ? 0 : text.split("\n").length;

export function validateCodeUnderstanding(args: {
  bundle: LoadedCodeRole;
  snapshot: CodeSnapshot;
  output: unknown;
  /** Whether a model was actually available for this run. */
  modelAvailable: boolean;
}): ValidationResult {
  const errors: string[] = [];
  let parsed: CodeUnderstandingOutput;
  try {
    parsed = codeUnderstandingOutputSchema.parse(args.output);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => i.message).join("; ")
        : String(error);
    return { ok: false, errors: [`SCHEMA: ${message}`], status: "failed" };
  }

  // Seal checks: the output must describe exactly the bundle + snapshot it ran on.
  if (parsed.role !== args.bundle.manifest.role_id)
    errors.push(`ROLE_MISMATCH: ${parsed.role} != ${args.bundle.manifest.role_id}`);
  if (parsed.prompt_digest !== args.bundle.promptDigest)
    errors.push("PROMPT_DIGEST_MISMATCH");
  if (parsed.schema_digest !== args.bundle.schemaDigest)
    errors.push("SCHEMA_DIGEST_MISMATCH");
  const expectedInputDigest = stableDigest(args.snapshot);
  if (parsed.input_digest !== expectedInputDigest)
    errors.push("INPUT_DIGEST_MISMATCH");

  // Model availability / seed honesty.
  if (!args.modelAvailable) {
    if (!parsed.seed)
      errors.push("MODEL_UNAVAILABLE_BUT_NOT_SEED");
    if (parsed.model !== null)
      errors.push("MODEL_UNAVAILABLE_BUT_NAMES_MODEL");
    if (parsed.verified_by_agent)
      errors.push("MODEL_UNAVAILABLE_BUT_CLAIMS_VERIFIED");
  } else if (parsed.seed) {
    errors.push("MODEL_AVAILABLE_BUT_OUTPUT_MARKED_SEED");
  }

  // Build the trusted reference sets from the fixed snapshot.
  const nodes = new Map(args.snapshot.symbols.map((s) => [s.id, s]));
  const edges = new Map(args.snapshot.edges.map((e) => [e.id, e]));
  const evidence = new Map(args.snapshot.evidence.map((e) => [e.id, e]));
  const files = new Map(args.snapshot.files.map((f) => [f.id, f]));

  const unknownNodes: string[] = [];
  for (const id of parsed.referenced_node_ids)
    if (!nodes.has(id)) unknownNodes.push(id);
  if (unknownNodes.length)
    errors.push(`UNKNOWN_NODE_REFS: ${unknownNodes.join(",")}`);

  const unknownEdges: string[] = [];
  for (const id of parsed.referenced_edge_ids)
    if (!edges.has(id)) unknownEdges.push(id);
  if (unknownEdges.length)
    errors.push(`UNKNOWN_EDGE_REFS: ${unknownEdges.join(",")}`);

  // Evidence refs must exist AND their line selector must be inside the file.
  for (const ref of parsed.evidence_refs) {
    if (!evidence.has(ref.evidence_id))
      errors.push(`UNKNOWN_EVIDENCE_REF: ${ref.evidence_id}`);
    if (ref.selector) {
      const file = files.get(ref.selector.file_id);
      if (!file) {
        errors.push(
          `SELECTOR_UNKNOWN_FILE: ${ref.evidence_id} -> ${ref.selector.file_id}`,
        );
      } else {
        const lines = lineCount(file.text);
        if (ref.selector.start_line < 1 || ref.selector.end_line > lines)
          errors.push(
            `SELECTOR_OUT_OF_RANGE: ${ref.evidence_id} on ${file.path} ` +
              `[${ref.selector.start_line},${ref.selector.end_line}] > ${lines} lines`,
          );
      }
    }
  }

  // Same cross-check for references nested inside claims.
  for (const [i, claim] of parsed.claims.entries()) {
    for (const id of claim.node_ids)
      if (!nodes.has(id))
        errors.push(`CLAIM_${i}_UNKNOWN_NODE_REF: ${id}`);
    for (const id of claim.edge_ids)
      if (!edges.has(id))
        errors.push(`CLAIM_${i}_UNKNOWN_EDGE_REF: ${id}`);
    for (const id of claim.evidence_ids)
      if (!evidence.has(id))
        errors.push(`CLAIM_${i}_UNKNOWN_EVIDENCE_REF: ${id}`);
  }

  // Budget: cap cited nodes per the manifest.
  if (
    parsed.referenced_node_ids.length >
    args.bundle.manifest.max_referenced_nodes
  )
    errors.push(
      `TOO_MANY_NODE_REFS: ${parsed.referenced_node_ids.length} > ${args.bundle.manifest.max_referenced_nodes}`,
    );

  // A seed skeleton must not carry agent interpretation claims.
  if (parsed.seed) {
    const interpretations = parsed.claims.filter(
      (c) => c.kind === "interpretation",
    );
    if (interpretations.length)
      errors.push("SEED_CARRIES_INTERPRETATION_CLAIMS");
    if (parsed.confidence > 0.1)
      errors.push("SEED_CONFIDENCE_TOO_HIGH");
  }

  if (errors.length) return { ok: false, errors, status: "rejected" };
  return { ok: true, output: parsed };
}

/**
 * Build a deterministic seed output when no model is available. It lists only
 * mechanically-derived facts (counts, declared files/symbols/edges) and cites
 * nothing the validator cannot check. It never fabricates module narrative.
 */
export function buildSeedOutput(args: {
  bundle: LoadedCodeRole;
  snapshot: CodeSnapshot;
  resultId: string;
  generatedAt: string;
}): CodeUnderstandingOutput {
  const { bundle, snapshot, resultId, generatedAt } = args;
  return {
    schema_version: 1,
    result_id: resultId,
    role: bundle.manifest.role_id,
    status: "seed",
    module_responsibilities: [],
    boundaries: [],
    key_flows: [],
    entry_points: [],
    exit_points: [],
    risks_and_limits: [
      "no_model_available: structural seed only; module narrative was not produced",
    ],
    claims: snapshot.symbols.slice(0, bundle.manifest.max_referenced_nodes).map((s) => ({
      text: `${s.kind} ${s.name} declared in ${snapshot.files.find((f) => f.id === s.file_id)?.path ?? s.file_id}:${s.start_line}-${s.end_line}`,
      kind: "raw_fact" as const,
      node_ids: [s.id],
      edge_ids: [],
      evidence_ids: [],
    })),
    referenced_node_ids: snapshot.symbols
      .slice(0, bundle.manifest.max_referenced_nodes)
      .map((s) => s.id),
    referenced_edge_ids: [],
    evidence_refs: [],
    unknowns: [
      "module responsibilities, boundaries, key flows and entry/exit points are undetermined without a model",
    ],
    confidence: 0,
    model: null,
    prompt_digest: bundle.promptDigest,
    schema_digest: bundle.schemaDigest,
    input_digest: stableDigest(snapshot),
    generated_at: generatedAt,
    seed: true,
    verified_by_agent: false,
    verified_by: null,
  };
}
