/** Keep model-facing contracts identical to the schemas the host validates. */
import { readFileSync, writeFileSync } from "node:fs";
import { directoryDigest } from "../apps/server/src/agent-runtime/bundles.js";
import { z } from "zod";
import { proposalBatchSchema, assessmentBatchSchema } from "../packages/contracts/src/index.js";
import { knowledgeBatchSchema, knowledgePlanSchema, knowledgeReviewSchema, knowledgeResearchSchema } from "../packages/contracts/src/knowledge.js";
import { assistantReplySchema } from "../packages/contracts/src/assistant.js";
import { contextResolutionSchema } from "../packages/contracts/src/contexts.js";
writeFileSync("packages/agent-runtime/roles/context-resolver/1/output.schema.json", JSON.stringify({ ...z.toJSONSchema(contextResolutionSchema), $id: "https://omem.invalid/contracts/ContextResolution.v1" }, null, 2) + "\n");
writeFileSync("packages/agent-runtime/roles/daily-assistant/1/output.schema.json", JSON.stringify({ ...z.toJSONSchema(assistantReplySchema), $id: "https://omem.local/schema/AssistantReply.v1" }, null, 2) + "\n");
for (const role of ["knowledge-writer", "knowledge-refresher", "code-analyst", "material-analyst", "conversation-analyst", "visual-analyst"]) {
  writeFileSync(`packages/agent-runtime/roles/${role}/1/output.schema.json`, JSON.stringify({ ...z.toJSONSchema(knowledgeBatchSchema), $id: "https://omem.invalid/contracts/KnowledgeBatch.v1" }, null, 2) + "\n");
}
for (const [role, schema, id] of [["knowledge-planner", knowledgePlanSchema, "KnowledgePlan"], ["knowledge-verifier", knowledgeReviewSchema, "KnowledgeReview"]] as const) {
  writeFileSync(`packages/agent-runtime/roles/${role}/1/output.schema.json`, JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://omem.invalid/contracts/${id}.v1` }, null, 2) + "\n");
}
writeFileSync("packages/agent-runtime/roles/knowledge-researcher/1/output.schema.json", JSON.stringify({ ...z.toJSONSchema(knowledgeResearchSchema), $id: "https://omem.invalid/contracts/KnowledgeResearch.v1" }, null, 2) + "\n");
for (const [role, schema] of [["extractor", proposalBatchSchema], ["verifier", assessmentBatchSchema]] as const) {
  writeFileSync(`packages/agent-runtime/roles/${role}/1/output.schema.json`, JSON.stringify({ ...z.toJSONSchema(schema, { reused: "ref" }), $id: `https://omem.invalid/contracts/${role === "extractor" ? "ProposalBatch" : "AssessmentBatch"}.v1` }, null, 2) + "\n");
}
for (const role of ["context-resolver", "extractor", "verifier", "daily-assistant", "knowledge-writer", "knowledge-refresher", "knowledge-planner", "knowledge-researcher", "knowledge-verifier", "code-analyst", "material-analyst", "conversation-analyst", "visual-analyst"]) {
  const root = `packages/agent-runtime/roles/${role}/1`;
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
  for (const skill of manifest.skill_bundles) skill.artifact_digest = directoryDigest(`${root}/skills/${skill.canonical_name}`);
  writeFileSync(`${root}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
}
