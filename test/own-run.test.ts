import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentProfileSchema } from "../src/core/config.ts";
import { ownRun, sandboxStatus } from "../src/agents/own-run.ts";
import { shortPath } from "../src/agents/own-sandbox.ts";
import { setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { launch } from "../src/agents/spawn.ts";
import { testApp } from "./helpers.ts";

afterEach(() => { vi.unstubAllEnvs(); setSandboxSupportForTests(undefined); });

it.skipIf(process.platform !== "linux")("reports exactly the writable plan used to launch multiple worktrees", async () => {
  const app = testApp();
  const home = mkdtempSync(join(tmpdir(), "own-plan-"));
  vi.stubEnv("HOME", home);
  setSandboxSupportForTests({ ok: true, bwrap: "/bin/echo" });
  const root = join(app.home, "workspaces", "fixture");
  const first = join(root, "first"), second = join(root, "second"), hidden = join(root, "hidden"), ro = join(home, "readonly");
  const inbox = join(app.home, "artifacts", "inbox", "sample");
  const program = join(home, "program");
  for (const dir of [first, second, hidden, ro, inbox, program]) mkdirSync(dir, { recursive: true });
  app.config.agents.ownSandbox = { mode: "require", hidden: [hidden], writable: [ro] };
  const workspace = { rw: [first, second, hidden], ro: [ro],
    links: [{ path: join(root, "link"), target: first }], pointers: [{ path: join(first, ".git"), source: join(program, "pointer") }] };
  const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/true" });
  try {
    const { box, note } = ownRun(app, profile, root, false, "sample", { workspace: () => workspace, inbox });
    expect(box!.plan.rw).toEqual(expect.arrayContaining([first, second, inbox]));
    for (const path of [root, hidden, ro]) expect(box!.plan.rw).not.toContain(path);
    expect(box!.plan.links).toEqual(workspace.links);
    expect(box!.plan.pointers).toEqual(workspace.pointers);
    expect(note).toBe("在 omem 沙箱里。可写：" + [...box!.plan.rw.map(p => shortPath(p, box!.home)), "/tmp（本轮临时目录）"].join("、") + "。写别处会失败，要放开在 设置 → 安全 里加可写目录。");
    const child = launch(profile.command, [], { cwd: root, ownSandbox: box, env: { OMEM_ARTIFACTS: inbox } });
    let args = "";
    child.stdout.on("data", chunk => args += chunk);
    expect((await once(child, "close"))[0]).toBe(0);
    for (const path of box!.plan.rw) expect(args).toContain(`--bind ${path} ${path}`);
    expect(args).toContain(`--ro-bind-try ${ro} ${ro}`);
    const review = ownRun(app, profile, first, true, "sample", { workspace: () => ({ ro: [first, second], rw: [] }) }).box!;
    expect(review.plan.rw).not.toContain(first);
    expect(review.plan.rw).not.toContain(second);
    const snapshot = join(app.runsDir, "sample", "snap");
    const check = ownRun(app, profile, snapshot, true, "sample", { workspace: () => ({ ro: [first, second], rw: [] }) }).box!;
    expect(check.plan.rw).toContain(snapshot);
  } finally {
    app.db.close(); rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

it("validates default backend state in the settings example just as in a run", () => {
  const app = testApp();
  const home = mkdtempSync(join(tmpdir(), "own-default-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("CODEX_HOME", join(app.home, "secrets"));
  setSandboxSupportForTests({ ok: true, bwrap: "/bin/echo" });
  app.config.agents.ownSandbox.mode = "require";
  const profile = agentProfileSchema.parse({ id: "codex", transport: "acp", command: "/bin/true" });
  try {
    expect(() => ownRun(app, profile, join(app.home, "workspaces", "fixture"), false)).toThrow("不能配置这个沙箱目录");
    expect(() => sandboxStatus(app)).toThrow("不能配置这个沙箱目录");
    vi.stubEnv("CODEX_HOME", join(home, ".codex"));
    const status = sandboxStatus(app);
    expect(status.defaults.writable).toContain(join(home, ".codex"));
    expect(status.defaults.writable).toContain(join(app.home, "artifacts", "inbox", "example"));
  } finally {
    app.db.close(); rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});
