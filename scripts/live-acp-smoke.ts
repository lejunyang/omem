import { loadConfig } from "../apps/server/src/config.js";
import { acp } from "../apps/server/src/agents.js";
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
const currentEffort = probe.configOptions.find(
  (o) => o.id === "reasoning_effort",
);
let answer = "";
const events: string[] = [];
await acp(
  {
    ...base,
    model:
      currentModel?.type === "select" ? currentModel.currentValue : undefined,
    effort:
      currentEffort?.type === "select" ? currentEffort.currentValue : undefined,
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
console.log(
  JSON.stringify(
    {
      agent: probe.agentInfo,
      configuredModel: currentModel?.currentValue,
      configuredEffort: currentEffort?.currentValue,
      answer,
      eventTypes: [...new Set(events)],
    },
    null,
    2,
  ),
);
