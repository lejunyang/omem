import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentProfileSchema } from "../src/core/config.ts";
import { ownRun, sandboxStatus } from "../src/agents/own-run.ts";
import { shortPath } from "../src/agents/own-sandbox.ts";
import { bwrapArgs, sandboxSupport, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { agentSpecSchema } from "../src/agents/specs.ts";
import { launch } from "../src/agents/spawn.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

afterEach(() => { vi.unstubAllEnvs(); setSandboxSupportForTests(undefined); });

// A successful sandbox settings example requires POSIX mount paths.
it.skipIf(process.platform === "win32")("validates and returns the externally edited backend on a sandbox PUT", async () => {
  const app = testApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  const path = join(app.home, "config.json");
  const url = app.baseUrl + "/api/security/sandbox";
  const patch = { mode: "require", writable: [], hidden: [], fullAccess: "per-role" };
  const put = () => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  const audits = app.db.prepare("select detail from audit_events where action = 'sandbox.settings'");
  const before = structuredClone(app.config.agents);
  const editBackend = (state: string) => {
    const profile = { id: "codex", transport: "acp", command: "fixture", env: { CODEX_HOME: state } };
    const text = JSON.stringify({ agents: { profiles: [profile], fullAccess: "sandboxed" } });
    writeFileSync(path, text);
    return text;
  };
  const valid = realpathSync(mkdtempSync(join(tmpdir(), "external-state-")));
  try {
    const file = join(valid, "ordinary-file");
    writeFileSync(file, "keep");
    for (const invalid of [join(app.home, "secrets"), file]) {
      const edited = editBackend(invalid);
      const rejected = await put();
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain(invalid);
      expect(readFileSync(path, "utf8")).toBe(edited);
      expect(app.config.agents).toEqual(before);
      expect(audits.all()).toHaveLength(0);
    }
    expect(readFileSync(file, "utf8")).toBe("keep");

    editBackend(valid);
    const saved = await put();
    expect(saved.status).toBe(200);
    const status = await saved.json();
    const effective = { ...patch, fullAccess: "sandboxed" };
    expect(status).toMatchObject({ ...effective, defaults: { exampleBackend: "codex", writable: expect.arrayContaining([valid]) } });
    expect(await (await fetch(url)).json()).toEqual(status);
    const agents = { profiles: [{ id: "codex", env: { CODEX_HOME: valid } }], ownSandbox: { mode: "require" }, fullAccess: "sandboxed" };
    expect(app.config.agents).toMatchObject(agents);
    expect(JSON.parse(readFileSync(path, "utf8")).agents).toMatchObject(agents);
    expect(audits.all().map(row => JSON.parse(String(row.detail)))).toEqual([effective]);
  } finally {
    await server.close(); app.db.close();
    rmSync(app.home, { recursive: true, force: true }); rmSync(valid, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("checks required state directories and only mounts existing optional state files", () => {
  const app = testApp();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "state-types-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  app.config.agents.ownSandbox.mode = "require";
  setSandboxSupportForTests({ ok: true, bwrap: "/bin/echo" });
  const profile = agentProfileSchema.parse({ id: "claude", transport: "acp", command: "/bin/true" });
  const state = join(home, ".claude");
  const optional = join(home, ".claude.json");
  const plan = () => ownRun(app, profile, join(app.home, "workspaces", "fixture"), true).box!.plan;
  try {
    expect(plan().rw).toContain(state);
    expect(plan().rw).not.toContain(optional);
    writeFileSync(optional, "{}");
    expect(plan().rw).toContain(optional);
    writeFileSync(state, "{}");
    expect(plan).toThrow(state);
    rmSync(state);
    rmSync(optional);
    mkdirSync(optional);
    expect(plan).toThrow(optional);
  } finally {
    app.db.close(); rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

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

it.skipIf(!sandboxSupport().ok)("keeps a read-only profile's /tmp cwd private while mounting an allowed child", async () => {
  const app = testApp();
  const home = mkdtempSync(join(tmpdir(), "tmp-cwd-"));
  const allowed = join(home, "allowed");
  mkdirSync(allowed);
  writeFileSync(join(home, "host-file"), "host");
  vi.stubEnv("HOME", home);
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.ownSandbox = { mode: "require", writable: [allowed], hidden: [] };
  const spec = { ...agentSpecSchema.parse({ name: "reader", description: "阅读", cwd: "/tmp", writes: false }), prompt: "读资料" };
  const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/sh" });
  const prep = prepareRun(app, { actor: { spec }, spaceId: "personal", runId: null, profile });
  try {
    const box = prep.isolation.box!;
    expect(box.readOnly).toBe(true);
    const args = bwrapArgs({ ...box.plan, cwd: prep.cwd, command: profile.command, args: [] });
    expect(args.slice(args.indexOf("--tmpfs"), args.indexOf("--tmpfs") + 2)).toEqual(["--tmpfs", "/tmp"]);
    expect([...box.plan.ro, ...box.plan.rw]).not.toContain("/tmp");
    expect(box.plan.rw).toContain(allowed);
    const name = "private-" + app.home.split("/").at(-1);
    const child = launch(profile.command, ["-ec", 'test ! -e "$1/host-file"; echo private > "$2"; echo visible > "$1/allowed/result"', "sh", home, name],
      { cwd: prep.cwd, ownSandbox: box });
    expect((await once(child, "close"))[0]).toBe(0);
    expect(existsSync(join("/tmp", name))).toBe(false);
    expect(existsSync(join(allowed, "result"))).toBe(true);
  } finally {
    revokeToolToken(prep.token); app.db.close();
    rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
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
