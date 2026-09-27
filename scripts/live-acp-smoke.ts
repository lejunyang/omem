import { loadConfig } from "../apps/server/src/config.js";
import { acp } from "../apps/server/src/agents.js";
import { assertNonAstra, selectNonAstraProfile } from "./live-model.js";

const config = loadConfig();
const base = config.profiles.find((profile) => profile.id === "traex")!;
const { probe, profile } = await selectNonAstraProfile(base, config.agentCwd);
let answer = "";
const events: string[] = [];
const live = await acp(
  profile,
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
const effectiveModel = live.configOptions.find(
  (option) => option.id === "model",
)?.currentValue;
assertNonAstra(effectiveModel);
console.log(
  JSON.stringify(
    {
      agent: probe.agentInfo,
      configuredModel: effectiveModel,
      configuredEffort: live.configOptions.find(
        (option) => option.id === "reasoning_effort",
      )?.currentValue,
      answer,
      eventTypes: [...new Set(events)],
    },
    null,
    2,
  ),
);
