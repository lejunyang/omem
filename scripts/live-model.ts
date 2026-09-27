import type { AgentProfile } from "../packages/contracts/src/index.js";
import { acp, optionValues } from "../apps/server/src/agents.js";

export async function selectNonAstraProfile(base: AgentProfile, cwd: string) {
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
  return {
    probe,
    profile: {
      ...base,
      model,
      effort: process.env.OMEM_LIVE_EFFORT,
    } satisfies AgentProfile,
  };
}

export function assertNonAstra(model: unknown) {
  if (/astra/i.test(String(model)))
    throw Error("ACP verification unexpectedly used an Astra model");
}
