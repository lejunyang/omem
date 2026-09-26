import { larkInput } from "../apps/server/src/connectors.js";
import { captureSchema } from "../packages/contracts/src/index.js";
const input = captureSchema.parse(
  await larkInput(
    "https://bytedance.larkoffice.com/wiki/DwxIwD5RtiF5LFk2MNvc853znmc",
  ),
);
console.log(
  JSON.stringify(
    {
      connector: "lark-cli",
      title: input.title,
      version: input.upstreamVersion,
      partTypes: input.parts.map((p) => p.type),
      textCharacters: input.parts.reduce(
        (sum, p) => sum + (p.type === "text" ? p.text.length : 0),
        0,
      ),
    },
    null,
    2,
  ),
);
