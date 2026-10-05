import { readFile } from "node:fs/promises";
import { captureSchema } from "../../../packages/contracts/src/index.js";
import { fileInput, gitInput, hookInput } from "./connectors.js";
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
const send = async (path: string, body?: unknown, method = "POST") => {
  const r = await fetch(base + path, {
    method,
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
  if (command === "messages") {
    const prefix = "/api/integrations/lark-personal";
    if (args[0] === "discover") result = await send(prefix + "/discover", {});
    else if (args[0] === "sync") result = await send(prefix + "/sync", {});
    else if (args[0] === "inbox") result = await send(prefix + "/inbox", undefined, "GET");
    else if (args[0] === "watch" || args[0] === "exclude" || args[0] === "unwatch") {
      if (!args[1]) throw Error("请指定会话 ID，先运行 messages discover");
      result = await send(prefix + "/chats/" + encodeURIComponent(args[1]), {mode: args[0] === "watch" ? "watch" : args[0] === "exclude" ? "excluded" : "off"}, "PUT");
    } else if (args[0] === "configure") {
      if (!args[1]) throw Error("请指定配置 JSON 文件；enabled、intervalMinutes、historyHours、mentionExceptions、resources");
      result = await send(prefix, JSON.parse(await readFile(args[1], "utf8")), "PUT");
    } else result = await send(prefix, undefined, "GET");
  } else if (command === "capture") {
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
      "/api/connectors/lark",
      { url: args[0] },
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
      "omem CLI: messages [status|discover|sync|inbox|watch|unwatch|exclude|configure] [chat-id|file] | capture [json-file] | file <path> | git <repo> <file> [ref] | lark <url> | hook < stdin | probe [profile]",
    );
    process.exit(0);
  }
  // Hook stdout must remain empty so it cannot accidentally become host instructions.
  if (command !== "hook") console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
