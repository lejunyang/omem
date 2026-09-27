import type {
  AgentProfile,
  ContextManifest,
} from "../../../../packages/contracts/src/index.js";
import type { JobHandler } from "../jobs/worker.js";
import type { JobRepository } from "../jobs/repository.js";
import { RoleRuntimeGateway, type ManagedTool } from "./gateway.js";

export function createRoleJobHandler(input: {
  gateway: RoleRuntimeGateway;
  jobs: JobRepository;
  roleId: ContextManifest["role_id"];
  roleVersion?: string;
  profile: AgentProfile;
  context: (jobId: string) => ContextManifest | Promise<ContextManifest>;
  managedTools?: ManagedTool[];
}): JobHandler {
  return async (job, signal) => {
    const context = await input.context(job.id);
    const run = await input.gateway.run({
      roleId: input.roleId,
      roleVersion: input.roleVersion,
      profile: input.profile,
      context,
      signal,
      managedTools: input.managedTools,
    });
    const sessionId = run.trace.sessionIds.at(-1);
    if (!sessionId) throw Error("ROLE_SESSION_ID_MISSING");
    const output = input.jobs.saveRoleOutput({
      jobId: job.id,
      leaseToken: job.leaseToken,
      model: run.trace.effectiveModel,
      effort: run.trace.effectiveEffort,
      promptHash: run.trace.promptHash,
      skillHash: run.trace.skillHash,
      toolHash: run.trace.toolHash,
      fingerprint: run.trace.fingerprint,
      roleBundleHash: run.trace.bundleHash,
      contextHash: run.trace.contextHash,
      outputSchema: run.trace.outputSchema,
      sessionId,
      loadedSkills: run.trace.loadedSkills,
      allowedTools: run.trace.allowedTools,
      usage: run.trace.usage,
      output: run.result,
      trace: run.trace,
    });
    return { resultRef: output.id, usage: run.trace.usage };
  };
}
