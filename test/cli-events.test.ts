import { resolve } from "node:path";
import { expect, it } from "vitest";
import { runCli } from "../src/agents/cli.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import type { AgentEvent } from "../src/agents/types.ts";

it("codex exec --json: its reasoning, each step's start and end, and the reply", async () => {
  const profile = agentProfileSchema.parse({ id: "cli", transport: "codex-cli", command: process.execPath, args: [resolve("test/fake-codex-cli.ts")] });
  const events: AgentEvent[] = [];
  const r = await runCli(profile, { cwd: process.cwd(), prompt: "x" }, (e) => events.push(e));
  expect(r.text).toContain("ok");
  expect(events.filter((e) => e.type === "thought").map((e) => (e as { text: string }).text)).toEqual(["先跑一下命令"]);
  const tools = events.filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool").map((e) => [e.id, e.title, e.status]);
  expect(tools).toEqual([
    ["item_2", "echo hi", "in_progress"],
    ["item_2", "echo hi", "completed"],
    ["item_3", "omem.search", "in_progress"],
    ["item_3", "omem.search", "failed"],
  ]);
});

it("claude -p stream-json: thinking, each tool's start and its result", async () => {
  const profile = agentProfileSchema.parse({ id: "cc", transport: "claude-cli", command: process.execPath, args: [resolve("test/fake-claude-cli.ts")] });
  const events: AgentEvent[] = [];
  const r = await runCli(profile, { cwd: process.cwd(), prompt: "x" }, (e) => events.push(e));
  expect(r.text).toContain("ok");
  expect(events.some((e) => e.type === "thought" && e.text === "先看文件")).toBe(true);
  const tools = events.filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool").map((e) => [e.id, e.title, e.status]);
  expect(tools).toEqual([["tu_1", "Read", "in_progress"], ["tu_1", "Read", "completed"], ["tu_2", "Bash", "in_progress"], ["tu_2", "Bash", "failed"]]);
});
