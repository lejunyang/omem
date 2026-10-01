import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessmentBatchSchema,
  correctionProposalSchema,
  proposalBatchSchema,
  proposalSchema,
} from "../../../packages/contracts/src/index.js";

const proposalFixture = JSON.parse(
  readFileSync("docs/archive/2026-10-01-baseline/implementation/batch2/examples/proposal.json", "utf8"),
);

describe("Batch 2 strict contracts", () => {
  it("accepts the documented Proposal v1 fixture without treating it as applied", () => {
    const proposal = proposalSchema.parse(proposalFixture);
    expect(proposal.proposal_id).toBe("fixture-proposal-1");
    expect(proposal.kind).toBe("task");
    expect(proposal).not.toHaveProperty("state");
  });

  it("rejects unknown fields, mismatched bodies and updates without CAS versions", () => {
    expect(() =>
      proposalSchema.parse({ ...proposalFixture, applied: true }),
    ).toThrow();
    expect(() =>
      proposalSchema.parse({
        ...proposalFixture,
        kind: "claim",
      }),
    ).toThrow();
    expect(() =>
      proposalSchema.parse({
        ...proposalFixture,
        operation: "update",
        target_id: "task-1",
        expected_versions: {},
      }),
    ).toThrow("expected version");
  });

  it("defines strict ProposalBatch, AssessmentBatch and CorrectionProposal envelopes", () => {
    const batch = proposalBatchSchema.parse({
      schema_version: 1,
      job_id: "job-1",
      role_id: "extractor@1",
      observations: [],
      proposals: [proposalFixture],
      abstentions: [],
    });
    expect(batch.proposals).toHaveLength(1);

    expect(
      assessmentBatchSchema.parse({
        schema_version: 1,
        job_id: "job-1",
        role_id: "verifier@1",
        assessments: [
          {
            proposal_id: "fixture-proposal-1",
            proposal_digest: "a".repeat(64),
            quote_asset_verdict: "valid",
            semantic_verdict: "supported",
            reason_code: "direct_statement",
            reason: "The exact quote supports the scoped task.",
            missing_context: [],
          },
        ],
      }).assessments[0]?.semantic_verdict,
    ).toBe("supported");

    expect(
      correctionProposalSchema.parse({
        schema_version: 1,
        correction_id: "correction-1",
        target: { type: "task", id: "task-1", expected_version: 1 },
        scope: {
          workspace_id: "personal",
          project_id: "payments",
          subject_id: "owner",
        },
        stop_using: "owner A",
        replacement: "owner B",
        evidence: proposalFixture.evidence,
        reason: "The authenticated owner corrected the assignment.",
        origin: proposalFixture.origin,
      }).target.expected_version,
    ).toBe(1);
  });
});
