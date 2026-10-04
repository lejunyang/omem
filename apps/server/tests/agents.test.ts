import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acp, cli, cliArgs, type AcpOptions } from "../src/agents.js";
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
  options: AcpOptions = {},
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
      options,
    );
    return { result, events };
  } finally {
    // acp() awaits the child's close event before returning, so the child has
    // fully exited and released its cwd handle. A single rmSync is sufficient;
    // no retry loop (which would mask real cleanup failures). If rmSync still
    // throws, that is a genuine cleanup error, not a swallowed race.
    rmSync(cwd, { recursive: true, force: true });
  }
}
it("negotiates model before validating new effort options; drops thoughts", async () => {
  const { events, result } = await run("hello", {
    model: "beta",
    effort: "high",
  });
  expect(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join(""),
  ).toContain("beta/high");
  expect(JSON.stringify(events)).not.toContain("PRIVATE_THOUGHT");
  expect(result.timings.initializeMs).toBeGreaterThanOrEqual(0);
  expect(result.timings.sessionSetupMs).toBeGreaterThanOrEqual(0);
  expect(result.timings.promptMs).toBeGreaterThanOrEqual(0);
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
it("finishes a validated final submission when the CLI never ends its prompt", async () => {
  const { result } = await run(
    "TIMEOUT",
    { model: "beta", effort: "high", timeoutMs: 1000 },
    new AbortController().signal,
    { finalSubmission: Promise.resolve() },
  );
  expect(result.completion).toBe("validated_submission");
  expect(result.configOptions.find(o => o.id === "model")?.currentValue).toBe("beta");
  expect(result.configOptions.find(o => o.id === "reasoning_effort")?.currentValue).toBe("high");
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

it("does not let captured-workspace Git commands discover the enclosing development checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "omem-research-git-"));
  const workspace = join(root, "runtime", "research");
  const originals = join(workspace, "originals");
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(originals, { recursive: true });
    // Demonstrate the bug with real Git, then invoke the same command through
    // the child launch shared by CLI and ACP. The model protocol is not tested.
    expect(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: originals, encoding: "utf8" }).trim()).toBe(realpathSync(root));
    vi.stubEnv("GIT_DIR", join(root, ".git"));
    vi.stubEnv("GIT_WORK_TREE", root);
    const probe = join(root, "probe.mjs");
    writeFileSync(probe, `import {spawnSync} from 'node:child_process';
      const results = ['.', 'originals'].map(cwd => {
        const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {cwd, encoding:'utf8'});
        return {status:result.status, stdout:result.stdout.trim()};
      });
      console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message',text:JSON.stringify(results)}}));`);
    let output = "";
    await cli(profileSchema.parse({ ...profile(), transport: "codex-cli", args: [probe] }), workspace, "probe",
      (type, text) => { if (type === "text") output += text; }, new AbortController().signal);
    expect(JSON.parse(output)).toEqual([{ status: 128, stdout: "" }, { status: 128, stdout: "" }]);
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
