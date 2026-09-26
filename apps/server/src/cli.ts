import { readFile } from "node:fs/promises";
import { captureSchema } from "../../../packages/contracts/src/index.js";
import { fileInput, gitInput, larkInput, hookInput } from "./connectors.js";
import { loadConfig } from "./config.js";
import { acp } from "./agents.js";
const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
const base = process.env.OMEM_URL || `http://127.0.0.1:${config.port}`;
const stdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString();
};
const send = async (path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw Error(JSON.stringify(value));
  return value;
};
try {
  let result: unknown;
  if (command === "capture") {
    const text = args[0] ? await readFile(args[0], "utf8") : await stdin();
    result = await send("/api/captures", captureSchema.parse(JSON.parse(text)));
  } else if (command === "file") {
    if (!args[0]) throw Error("file requires a path");
    result = await send(
      "/api/captures",
      captureSchema.parse(await fileInput(args[0], [process.cwd()])),
    );
  } else if (command === "git") {
    if (!args[0] || !args[1]) throw Error("git requires repository and path");
    result = await send(
      "/api/captures",
      captureSchema.parse(
        await gitInput(args[0], args[1], args[2] || "HEAD", [args[0]]),
      ),
    );
  } else if (command === "lark") {
    if (!args[0]) throw Error("lark requires document URL");
    result = await send(
      "/api/captures",
      captureSchema.parse(await larkInput(args[0])),
    );
  } else if (command === "hook") {
    result = await send(
      "/api/captures",
      captureSchema.parse(hookInput(JSON.parse(await stdin()))),
    );
  } else if (command === "probe") {
    const p = config.profiles.find((p) => p.id === (args[0] || "traex"));
    if (!p) throw Error("Profile not found");
    result = await acp(
      p,
      config.agentCwd,
      null,
      () => {},
      new AbortController().signal,
    );
  } else {
    console.log(
      "omem CLI: capture [json-file] | file <path> | git <repo> <file> [ref] | lark <url> | hook < stdin | probe [profile]",
    );
    process.exit(0);
  }
  // Hook stdout must remain empty so it cannot accidentally become host instructions.
  if (command !== "hook") console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
