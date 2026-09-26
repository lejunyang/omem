import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acp, cliArgs } from "../src/agents.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";
const profile = () =>
  profileSchema.parse({
    id: "fixture",
    name: "Fixture",
    transport: "acp",
    command: process.execPath,
    args: [resolve("apps/server/tests/fixtures/acp-agent.mjs")],
    timeoutMs: 3000,
  });
async function run(
  text: string,
  patch: Record<string, unknown> = {},
  signal = new AbortController().signal,
) {
  const cwd = mkdtempSync(join(tmpdir(), "omem-acp-"));
  const events: { type: string; text: string }[] = [];
  try {
    const result = await acp(
      profileSchema.parse({ ...profile(), ...patch }),
      cwd,
      [{ type: "text", text }],
      (type, text) => events.push({ type, text }),
      signal,
    );
    return { result, events };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
it("negotiates model before validating new effort options; drops thoughts", async () => {
  const { events } = await run("hello", { model: "beta", effort: "high" });
  expect(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join(""),
  ).toContain("beta/high");
  expect(JSON.stringify(events)).not.toContain("PRIVATE_THOUGHT");
});
it("rejects unsupported effort instead of falling back", async () => {
  await expect(run("hello", { effort: "high" })).rejects.toThrow(
    "Unsupported reasoning_effort",
  );
});
it("does not grant permission requests", async () => {
  const { events } = await run("ASK_PERMISSION");
  expect(events.some((e) => e.type === "permission")).toBe(true);
  expect(events.some((e) => e.text === "Permission declined")).toBe(true);
});
it("bounds idle prompt duration", async () => {
  await expect(run("TIMEOUT", { timeoutMs: 1000 })).rejects.toThrow(
    "timed out",
  );
});
it("cancels an active prompt", async () => {
  const c = new AbortController();
  const promise = run("TIMEOUT", {}, c.signal);
  setTimeout(() => c.abort(), 100);
  await expect(promise).rejects.toThrow("CANCELLED");
});
it("builds explicit safe CLI argv without shell interpolation", () => {
  const p = profileSchema.parse({
    ...profile(),
    transport: "codex-cli",
    args: [],
    model: "literal$(pwd)",
    effort: "high",
  });
  const a = cliArgs(p);
  expect(a).toContain("read-only");
  expect(a).toContain("literal$(pwd)");
  expect(a).not.toContain("--dangerously-bypass-approvals-and-sandbox");
});
