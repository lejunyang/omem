import { resolve } from "node:path";
import { App } from "../src/core/app.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { allProfiles } from "../src/core/config.ts";

// Exit immediately after the CLI reports its id: the turn's finally block never runs.
const app = App.open(process.argv[2]);
const profile = process.argv[3] ? allProfiles(app.config).find(p => p.id === process.argv[3])! : { id: "doubao-cli", transport: "doubao-cli" as const, command: process.execPath, args: [resolve("test/fake-doubao-cli.ts")], env: {}, idleTimeoutMs: 5000 };
await runBackend(app, profile, { cwd: app.home, prompt: "临时任务", persistSession: process.argv[4] === "keep" }, e => {
  if (e.type === "session") process.exit(0);
});
