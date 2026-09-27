import { loadConfig } from "../apps/server/src/config.js";
import { acp, optionValues } from "../apps/server/src/agents.js";
const config = loadConfig();
const base = config.profiles.find((p) => p.id === "traex")!;
const probe = await acp(
  base,
  config.agentCwd,
  null,
  () => {},
  new AbortController().signal,
);
const currentModel = probe.configOptions.find((o) => o.id === "model");
if (!currentModel || currentModel.type !== "select")
  throw Error("ACP did not expose selectable models");
const availableModels = optionValues(currentModel).map((option) => option.value);
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
let answer = "";
const events: string[] = [];
const live = await acp(
  {
    ...base,
    model,
    effort: process.env.OMEM_LIVE_EFFORT,
  },
  config.agentCwd,
  [
    {
      type: "text",
      text: "这是 omem ACP 接入测试。不要调用任何工具、不要读取文件、不要修改任何东西。提供的材料：有 3 组，每组 4 件。请仅回答总共几件。",
    },
  ],
  (type, text) => {
    events.push(type);
    if (type === "text") answer += text;
  },
  new AbortController().signal,
);
if (!answer.includes("12")) throw Error("Unexpected live ACP answer");
if (/astra/i.test(String(live.configOptions.find((o) => o.id === "model")?.currentValue)))
  throw Error("ACP verification unexpectedly used an Astra model");
console.log(
  JSON.stringify(
    {
      agent: probe.agentInfo,
      configuredModel: live.configOptions.find((o) => o.id === "model")
        ?.currentValue,
      configuredEffort: live.configOptions.find(
        (o) => o.id === "reasoning_effort",
      )?.currentValue,
      answer,
      eventTypes: [...new Set(events)],
    },
    null,
    2,
  ),
);
