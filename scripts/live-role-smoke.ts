import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../apps/server/src/config.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { stableDigest } from "../apps/server/src/storage/digest.js";
import { contextManifestSchema } from "../packages/contracts/src/index.js";
import { selectLiveProfile } from "./live-model.js";

const config = loadConfig();
const profile = config.profiles.find((candidate) => candidate.id === "traex");
if (!profile) throw Error("TraeX profile is not configured");
const { profile: liveProfile } = await selectLiveProfile(
  profile,
  config.agentCwd,
);
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
