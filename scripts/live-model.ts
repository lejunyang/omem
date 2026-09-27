import type { AgentProfile } from "../packages/contracts/src/index.js";
import { acp, optionValues } from "../apps/server/src/agents.js";

export async function selectLiveProfile(base: AgentProfile, cwd: string) {
  const probe = await acp(
    base,
    cwd,
    null,
    () => {},
    new AbortController().signal,
  );
  const modelOption = probe.configOptions.find(
    (option) => option.id === "model",
  );
  if (!modelOption || modelOption.type !== "select")
    throw Error("ACP did not expose selectable models");
  const availableModels = optionValues(modelOption).map(
    (option) => option.value,
  );
  const requestedModel = process.env.OMEM_LIVE_MODEL;
  const model = requestedModel
    ? availableModels.find((candidate) => candidate === requestedModel)
    : base.model && availableModels.includes(base.model)
      ? base.model
      : modelOption.currentValue || availableModels[0];
  if (!model) throw Error("No ACP model is available");
  if (requestedModel && model !== requestedModel)
    throw Error(`Requested ACP model is unavailable: ${requestedModel}`);
  return {
    probe,
    profile: {
      ...base,
      model,
      effort: process.env.OMEM_LIVE_EFFORT,
    } satisfies AgentProfile,
  };
}
