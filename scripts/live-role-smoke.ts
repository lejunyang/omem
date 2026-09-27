import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../apps/server/src/config.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { stableDigest } from "../apps/server/src/storage/digest.js";
import { acp, optionValues } from "../apps/server/src/agents.js";
import { contextManifestSchema } from "../packages/contracts/src/index.js";

const config = loadConfig();
const profile = config.profiles.find((candidate) => candidate.id === "traex");
if (!profile) throw Error("TraeX profile is not configured");
const probe = await acp(
  profile,
  config.agentCwd,
  null,
  () => {},
  new AbortController().signal,
);
const modelOption = probe.configOptions.find((option) => option.id === "model");
if (!modelOption || modelOption.type !== "select")
  throw Error("ACP did not expose selectable models");
const availableModels = optionValues(modelOption).map((option) => option.value);
const requestedModel = process.env.OMEM_LIVE_MODEL;
if (requestedModel && /astra/i.test(requestedModel))
  throw Error("Astra models are forbidden for ACP verification");
const model = requestedModel
  ? availableModels.find((candidate) => candidate === requestedModel)
  : ["gpt-5.4", "gpt-5.2", ...availableModels].find(
      (candidate, index, values) =>
        !/astra/i.test(candidate) &&
        availableModels.includes(candidate) &&
        values.indexOf(candidate) === index,
    );
if (!model) throw Error("No non-Astra ACP model is available");
const liveProfile = {
  ...profile,
  model,
  effort: process.env.OMEM_LIVE_EFFORT,
};
const context = contextManifestSchema.parse(
  JSON.parse(
    readFileSync("docs/implementation/batch2/examples/context.json", "utf8"),
  ),
);
const gateway = new RoleRuntimeGateway(
  new RoleBundleRegistry(),
  config.agentCwd,
);
const extraction = await gateway.run({
  roleId: "extractor",
  profile: liveProfile,
  context,
});
const extractionResult = extraction.result as {
  proposals: Record<string, unknown>[];
};
const verificationContext = contextManifestSchema.parse({
  ...context,
  job_id: `${context.job_id}-verify`,
  role_id: "verifier",
  candidates: extractionResult.proposals.map((proposal) => ({
    ...proposal,
    proposal_digest: stableDigest(proposal),
  })),
});
const verification = await gateway.run({
  roleId: "verifier",
  profile: liveProfile,
  context: verificationContext,
});
const report = {
  createdAt: new Date().toISOString(),
  fixture: "docs/implementation/batch2/examples/context.json",
  extraction: { result: extraction.result, trace: extraction.trace },
  verification: {
    result: verification.result,
    trace: verification.trace,
  },
};
if (
  /astra/i.test(String(extraction.trace.effectiveModel)) ||
  /astra/i.test(String(verification.trace.effectiveModel))
)
  throw Error("Role verification unexpectedly used an Astra model");
const reportPath = resolve(
  process.env.OMEM_LIVE_ROLE_REPORT ||
    ".omem/verification/live-role-smoke.json",
);
mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  JSON.stringify(
    {
      reportPath,
      extraction: { result: extraction.result, trace: extraction.trace },
      verification: {
        result: verification.result,
        trace: verification.trace,
      },
    },
    null,
    2,
  ),
);
