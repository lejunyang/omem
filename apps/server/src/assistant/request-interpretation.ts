import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../../../../packages/contracts/src/index.js";
import { contextManifestSchema } from "../../../../packages/contracts/src/index.js";
import {
  requestInterpretationSchema,
  type RequestInterpretation,
  type WorkActor,
} from "../../../../packages/contracts/src/work.js";
import { RoleBundleRegistry } from "../agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../agent-runtime/gateway.js";
import type { RuntimeRequestRepository } from "../agent-runtime/requests.js";

export type RequestInterpretationInput = {
  actor: WorkActor;
  candidate: unknown;
  target: unknown;
  priorTurns?: { userText: string; result: string }[];
  activeProjectId?: string;
  signal?: AbortSignal;
};
export type RequestInterpreter = (
  input: RequestInterpretationInput,
) => Promise<RequestInterpretation>;

/** Independent, tool-free interpretation using the configured Agent transport.
 * Never silently substitutes a keyword classifier when the model is absent. */
export function configuredRequestInterpreter(options: {
  profile: () => AgentProfile | null;
  directory: string;
  requests?: RuntimeRequestRepository;
}): RequestInterpreter {
  return async (input) => {
    const profile = options.profile();
    if (!profile) throw Error("交办判断模型未配置，请在能力与连接中设置主助手");
    input.signal?.throwIfAborted();
    const roleId = "request-interpreter",
      runId = randomUUID();
    const registry = new RoleBundleRegistry();
    const gateway = new RoleRuntimeGateway(
      registry,
      options.directory,
      options.requests,
    );
    const run = await gateway.run({
      roleId,
      profile: structuredClone(profile),
      profileBinding: { roleId, profileId: profile.id },
      signal: input.signal,
      context: contextManifestSchema.parse({
        schema_version: 1,
        job_id: input.actor.requestId,
        role_id: roleId,
        trusted_context: {
          workspace_id: "personal",
          project_id: null,
          owner_id: input.actor.principalId,
          observed_at: new Date().toISOString(),
          timezone: "Asia/Shanghai",
          actor_binding: {
            id: input.actor.principalId,
            verified_by: "conversation-owner",
          },
          source_kind: "manual",
          is_forwarded: false,
          producer_kind: "original",
        },
        materials: [
          {
            fragment_revision_id: "request:" + input.actor.requestId,
            source_revision_id: "turn:" + input.actor.requestId,
            text: input.actor.userText,
          },
        ],
        related_memories: [],
        confirmed_corrections: [],
        task: {
          candidate: input.candidate,
          target: input.target,
          priorTurns: input.priorTurns?.slice(-4) ?? [],
          activeProjectId: input.activeProjectId ?? null,
        },
      }),
    });
    const result = requestInterpretationSchema.parse(run.result);
    const directory = join(options.directory, "interpretations");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, runId + ".json"),
      JSON.stringify(
        {
          requestId: input.actor.requestId,
          candidate: input.candidate,
          target: input.target,
          result,
          trace: run.trace,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (
      result.instruction &&
      !input.actor.userText.includes(result.instruction)
    )
      throw Error("交办判断未对应当前原话，未执行操作");
    return result;
  };
}
