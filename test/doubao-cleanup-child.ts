import { resolve } from "node:path";
import { App } from "../src/core/app.ts";
import { runBackend } from "../src/agents/dispatch.ts";

// Exit immediately after the CLI reports its id: the turn's finally block never runs.
const app = App.open(process.argv[2]);
await runBackend(app, { id: "doubao-cli", transport: "doubao-cli", command: process.execPath, args: [resolve("test/fake-doubao-cli.ts")], env: {}, idleTimeoutMs: 5000 }, { cwd: app.home, prompt: "临时任务" }, e => {
  if (e.type === "session") process.exit(0);
});
