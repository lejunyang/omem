/** Keep model-facing contracts identical to the schemas the host validates. */
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { proposalBatchSchema, assessmentBatchSchema } from "../packages/contracts/src/index.js";
import { knowledgeResearchSchema } from "../packages/contracts/src/knowledge.js";
writeFileSync("packages/agent-runtime/roles/knowledge-researcher/1/output.schema.json", JSON.stringify({ ...z.toJSONSchema(knowledgeResearchSchema), $id: "https://omem.invalid/contracts/KnowledgeResearch.v1" }, null, 2) + "\n");
for (const [role, schema] of [["extractor", proposalBatchSchema], ["verifier", assessmentBatchSchema]] as const) {
  writeFileSync(`packages/agent-runtime/roles/${role}/1/output.schema.json`, JSON.stringify({ ...z.toJSONSchema(schema, { reused: "ref" }), $id: `https://omem.invalid/contracts/${role === "extractor" ? "ProposalBatch" : "AssessmentBatch"}.v1` }, null, 2) + "\n");
}
