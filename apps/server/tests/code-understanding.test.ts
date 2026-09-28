import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSeedOutput,
  codeSnapshotSchema,
  CodeRoleRegistry,
  stableDigest,
  validateCodeUnderstanding,
  type CodeSnapshot,
  type LoadedCodeRole,
  type ValidationResult,
} from "../../../packages/agent-runtime/src/code-understanding.js";

const roles = new CodeRoleRegistry();

// Narrowing helpers: after expect(result.ok).toBe(false), vitest does not narrow
// the discriminated union, so pull error text/status through these instead of
// touching .errors/.status on the possibly-ok variant.
const errText = (result: ValidationResult) =>
  result.ok ? "" : result.errors.join("\n");
const failStatus = (result: ValidationResult) =>
  result.ok ? "(unexpected ok)" : result.status;

// A tiny, self-consistent snapshot: two files, three symbol nodes, two edges,
// one decision evidence note. Every id the validator will be asked to accept or
// reject is derived from here.
const snapshot: CodeSnapshot = codeSnapshotSchema.parse({
  schema_version: 1,
  snapshot_id: "repo@deadbeef",
  commit: "deadbeef",
  files: [
    { id: "f1", path: "src/a.ts", language: "typescript", text: "line1\nline2\nline3\nline4\nline5" },
    { id: "f2", path: "src/b.ts", language: "typescript", text: "x\ny\nz" },
  ],
  symbols: [
    { id: "s1", file_id: "f1", name: "run", kind: "function", start_line: 1, end_line: 5 },
    { id: "s2", file_id: "f1", name: "Engine", kind: "class", start_line: 10, end_line: 20 },
    { id: "s3", file_id: "f2", name: "main", kind: "function", start_line: 1, end_line: 3 },
  ],
  edges: [
    { id: "e1", from_id: "s1", to_id: "s2", type: "calls" },
    { id: "e2", from_id: "s3", to_id: "s1", type: "imports" },
  ],
  evidence: [
    { id: "v1", kind: "decision", ref: "docs/decision.md::anchor", text: "Engine owns execution" },
  ],
});

const generatedAt = "2026-09-28T09:00:00+08:00";

// Build a fully-sealed, valid output for a given bundle + snapshot, then let a
// test mutate exactly one field to prove the validator catches it.
function validOutput(bundle: LoadedCodeRole, patch: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    result_id: "result-1",
    role: bundle.manifest.role_id,
    status: "generated",
    module_responsibilities: ["drive the pipeline"],
    boundaries: ["does not touch storage"],
    key_flows: [{ name: "boot", description: "main runs engine", node_ids: ["s3", "s1", "s2"] }],
    entry_points: ["main"],
    exit_points: [],
    risks_and_limits: [],
    claims: [
      {
        text: "run calls Engine",
        kind: "raw_fact",
        node_ids: ["s1", "s2"],
        edge_ids: ["e1"],
        evidence_ids: ["v1"],
      },
    ],
    referenced_node_ids: ["s1", "s2", "s3"],
    referenced_edge_ids: ["e1", "e2"],
    evidence_refs: [
      { evidence_id: "v1", selector: { file_id: "f1", start_line: 1, end_line: 5 }, note: "engine" },
    ],
    unknowns: [],
    confidence: 0.7,
    model: "fixture-model",
    prompt_digest: bundle.promptDigest,
    schema_digest: bundle.schemaDigest,
    input_digest: stableDigest(snapshot),
    generated_at: generatedAt,
    seed: false,
    verified_by_agent: false,
    verified_by: null,
    ...patch,
  };
}

describe("Code Understanding role assets", () => {
  it("loads all four allowlisted roles with matching digests/budgets", () => {
    for (const roleId of [
      "repo-profiler",
      "module-architect",
      "symbol-explainer",
      "relation-verifier",
    ] as const) {
      const bundle = roles.load(roleId, "1");
      expect(bundle.manifest.role_id).toBe(roleId);
      expect(bundle.manifest.output_schema).toBe("CodeUnderstanding.v1");
      expect(bundle.manifest.budget.max_context_tokens).toBeGreaterThanOrEqual(256);
      expect(bundle.manifest.budget.max_output_tokens).toBeGreaterThanOrEqual(128);
      expect(bundle.promptDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(bundle.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(bundle.skills).toHaveLength(1);
      expect(bundle.skills[0]!.content).toContain(bundle.skills[0]!.canonical_name);
    }
  });

  it("rejects roles outside the allowlist", () => {
    expect(() => roles.load("extractor")).toThrow("CODE_ROLE_NOT_ALLOWLISTED");
    expect(() => roles.load("root")).toThrow("CODE_ROLE_NOT_ALLOWLISTED");
  });

  it("produces a stable bundle digest that changes when the skill changes", () => {
    const first = roles.load("repo-profiler", "1");
    const second = roles.load("repo-profiler", "1");
    expect(first.bundleDigest).toBe(second.bundleDigest);
    expect(first.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("CodeUnderstanding.v1 schema", () => {
  it("parses a well-formed sealed output", () => {
    const bundle = roles.load("repo-profiler");
    const result = validateCodeUnderstanding({
      bundle,
      snapshot,
      output: validOutput(bundle),
      modelAvailable: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown properties and wrong role", () => {
    const bundle = roles.load("repo-profiler");
    const bad = validOutput(bundle, { unexpected_field: 1 });
    expect(() =>
      validateCodeUnderstanding({ bundle, snapshot, output: bad, modelAvailable: true }),
    );
    const result = validateCodeUnderstanding({ bundle, snapshot, output: bad, modelAvailable: true });
    expect(result.ok).toBe(false);
    expect(failStatus(result)).toBe("failed");
  });
});

describe("deterministic reference validation", () => {
  it("rejects hallucinated node/edge/evidence ids", () => {
    const bundle = roles.load("repo-profiler");
    const out = validOutput(bundle, {
      referenced_node_ids: ["s1", "ghost-node"],
      referenced_edge_ids: ["e1", "ghost-edge"],
      evidence_refs: [{ evidence_id: "ghost-evidence", selector: null, note: "" }],
    });
    const result = validateCodeUnderstanding({ bundle, snapshot, output: out, modelAvailable: true });
    expect(result.ok).toBe(false);
    expect(failStatus(result)).toBe("rejected");
    expect(errText(result)).toContain("UNKNOWN_NODE_REFS");
    expect(errText(result)).toContain("UNKNOWN_EDGE_REFS");
    expect(errText(result)).toContain("UNKNOWN_EVIDENCE_REF: ghost-evidence");
  });

  it("rejects a line selector that falls outside the file", () => {
    const bundle = roles.load("repo-profiler");
    const out = validOutput(bundle, {
      evidence_refs: [
        { evidence_id: "v1", selector: { file_id: "f1", start_line: 1, end_line: 999 }, note: "" },
      ],
    });
    const result = validateCodeUnderstanding({ bundle, snapshot, output: out, modelAvailable: true });
    expect(result.ok).toBe(false);
    expect(errText(result)).toContain("SELECTOR_OUT_OF_RANGE");
  });

  it("rejects an evidence selector pointing at an unknown file", () => {
    const bundle = roles.load("repo-profiler");
    const out = validOutput(bundle, {
      evidence_refs: [
        { evidence_id: "v1", selector: { file_id: "ghost-file", start_line: 1, end_line: 2 }, note: "" },
      ],
    });
    const result = validateCodeUnderstanding({ bundle, snapshot, output: out, modelAvailable: true });
    expect(result.ok).toBe(false);
    expect(errText(result)).toContain("SELECTOR_UNKNOWN_FILE");
  });

  it("rejects a seal mismatch (prompt / schema / input digest)", () => {
    const bundle = roles.load("repo-profiler");
    const wrongInput = validOutput(bundle, { input_digest: "0".repeat(64) });
    expect(
      errText(validateCodeUnderstanding({ bundle, snapshot, output: wrongInput, modelAvailable: true })),
    ).toContain("INPUT_DIGEST_MISMATCH");
    const wrongPrompt = validOutput(bundle, { prompt_digest: "1".repeat(64) });
    expect(
      errText(validateCodeUnderstanding({ bundle, snapshot, output: wrongPrompt, modelAvailable: true })),
    ).toContain("PROMPT_DIGEST_MISMATCH");
    const wrongSchema = validOutput(bundle, { schema_digest: "2".repeat(64) });
    expect(
      errText(validateCodeUnderstanding({ bundle, snapshot, output: wrongSchema, modelAvailable: true })),
    ).toContain("SCHEMA_DIGEST_MISMATCH");
  });

  it("rejects references nested inside claims that do not exist", () => {
    const bundle = roles.load("repo-profiler");
    const out = validOutput(bundle, {
      referenced_node_ids: [],
      referenced_edge_ids: [],
      evidence_refs: [],
      claims: [
        {
          text: "nonsense",
          kind: "raw_fact",
          node_ids: ["nope"],
          edge_ids: [],
          evidence_ids: [],
        },
      ],
    });
    const result = validateCodeUnderstanding({ bundle, snapshot, output: out, modelAvailable: true });
    expect(result.ok).toBe(false);
    expect(errText(result)).toContain("CLAIM_0_UNKNOWN_NODE_REF: nope");
  });
});

describe("seed / model-unavailable degradation", () => {
  it("builds a seed skeleton that validates with no model", () => {
    const bundle = roles.load("relation-verifier");
    const seed = buildSeedOutput({ bundle, snapshot, resultId: "seed-1", generatedAt });
    expect(seed.seed).toBe(true);
    expect(seed.model).toBeNull();
    expect(seed.verified_by_agent).toBe(false);
    expect(seed.status).toBe("seed");
    const result = validateCodeUnderstanding({
      bundle,
      snapshot,
      output: seed,
      modelAvailable: false,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a generated output when no model is available", () => {
    const bundle = roles.load("repo-profiler");
    const out = validOutput(bundle);
    const result = validateCodeUnderstanding({ bundle, snapshot, output: out, modelAvailable: false });
    expect(result.ok).toBe(false);
    expect(errText(result)).toContain("MODEL_UNAVAILABLE_BUT_NOT_SEED");
  });

  it("refuses a seed that carries interpretation claims or names a model", () => {
    const bundle = roles.load("repo-profiler");
    const seed = buildSeedOutput({ bundle, snapshot, resultId: "seed-2", generatedAt });
    // Inject an interpretation claim — a seed must not contain agent narrative.
    seed.claims.push({
      text: "I guess the module does X",
      kind: "interpretation",
      node_ids: [],
      edge_ids: [],
      evidence_ids: [],
    });
    const result = validateCodeUnderstanding({ bundle, snapshot, output: seed, modelAvailable: false });
    expect(result.ok).toBe(false);
    expect(errText(result)).toContain("SEED_CARRIES_INTERPRETATION_CLAIMS");
  });

  it("refuses to mark seed output as agent-verified", () => {
    const bundle = roles.load("repo-profiler");
    const seed = buildSeedOutput({ bundle, snapshot, resultId: "seed-3", generatedAt });
    seed.verified_by_agent = true;
    seed.verified_by = "some-agent";
    seed.status = "verified";
    const result = validateCodeUnderstanding({ bundle, snapshot, output: seed, modelAvailable: false });
    expect(result.ok).toBe(false);
    expect(errText(result)).toMatch(/agent-verified|CLAIMS_VERIFIED/);
  });
});

describe("verified-by-agent vs raw fact distinction", () => {
  it("requires verified_by when verified_by_agent is true, and forbids self-verification in seed", () => {
    const bundle = roles.load("relation-verifier");
    const out = validOutput(bundle, {
      status: "verified",
      verified_by_agent: true,
      verified_by: null,
    });
    const result = validateCodeUnderstanding({ bundle, snapshot, output: out, modelAvailable: true });
    expect(result.ok).toBe(false);
    expect(errText(result)).toContain("verified_by_agent requires a verified_by");
  });

  it("accepts a properly independently-verified output", () => {
    const bundle = roles.load("relation-verifier");
    const out = validOutput(bundle, {
      status: "verified",
      verified_by_agent: true,
      verified_by: "relation-verifier@1",
    });
    const result = validateCodeUnderstanding({ bundle, snapshot, output: out, modelAvailable: true });
    expect(result.ok).toBe(true);
  });
});

// Budget guard: a manifest declaring an oversized node budget must be rejected by
// the loader's zod schema. We drop a temp role directory with a bad manifest.
describe("manifest budget / allowlist guards", () => {
  const tmpRoot = join(process.cwd(), ".tmp-code-roles");
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects a manifest that exceeds the node budget", () => {
    mkdirSync(join(tmpRoot, "repo-profiler", "1", "skills", "x"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "repo-profiler", "1", "skills", "x", "SKILL.md"),
      "---\nname: x\ndescription: t\n---\nbody\n",
    );
    writeFileSync(
      join(tmpRoot, "repo-profiler", "1", "prompt.md"),
      "prompt",
    );
    writeFileSync(
      join(tmpRoot, "repo-profiler", "1", "output.schema.json"),
      JSON.stringify({ $id: "https://omem.invalid/contracts/CodeUnderstanding.v1" }),
    );
    writeFileSync(
      join(tmpRoot, "repo-profiler", "1", "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        role_id: "repo-profiler",
        role_version: "1",
        output_schema: "CodeUnderstanding.v1",
        prompt_templates: ["prompt.md"],
        skill_bundles: [],
        budget: { max_context_tokens: 100, max_output_tokens: 128 },
        max_referenced_nodes: 5,
      }),
    );
    const reg = new CodeRoleRegistry(tmpRoot);
    expect(() => reg.load("repo-profiler")).toThrow();
  });
});
