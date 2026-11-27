import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { startServer } from "../src/server/http.ts";
import { agentProfileSchema, keyedProfiles } from "../src/core/config.ts";
import { prepareRun, mcpBridge } from "../src/agents/runner.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { openAcp } from "../src/agents/acp.ts";
import { sandboxSupport, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { ownRun, sandboxStatus } from "../src/agents/own-run.ts";
import { launch } from "../src/agents/spawn.ts";
import { ownMounts } from "../src/agents/own-sandbox.ts";
import { resolveCommand } from "../src/agents/spawn.ts";

const support = sandboxSupport();
for (const real of [false, true]) {
  it.skipIf(process.platform !== "linux" || real && !support.ok).each(["claude", "claude-cli", "codex", "codex-cli"])(
    `API 档案 %s 首启 · ${real ? "bubblewrap 写入 " + (support.reason ?? "") : "挂载参数"}`, async backend => {
      const app = testApp();
      const home = mkdtempSync(join(tmpdir(), "own-login-"));
      const claude = backend.startsWith("claude");
      const variable = claude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const state = join(home, "profile-state");
      vi.stubEnv("HOME", home);
      vi.stubEnv(variable, state);
      if (!real) setSandboxSupportForTests({ ok: true, bwrap: "/bin/echo" });
      try {
        app.config.agents.ownSandbox.mode = "require";
        app.config.ai.providers = [
          { id: "fixture", name: "", kind: claude ? "anthropic" : "openai", backends: claude ? ["claude", "claude-cli"] : ["codex", "codex-cli"] },
        ];
        const profile = keyedProfiles(app.config).find(p => p.id === backend + "@fixture")!;
        expect(profile).toMatchObject({ source: "key:fixture", keyRef: "fixture" });
        profile.command = "/bin/sh";
        const cwd = join(app.home, "workspaces", "fixture");
        mkdirSync(cwd, { recursive: true });
        const status = sandboxStatus(app);
        const base = status.backends.find(p => p.id === backend)!;
        expect(status.backends.find(p => p.id === profile.id)?.state).toEqual(base.state);
        const box = ownRun(app, profile, cwd, false).box!;
        expect(box.plan.rw).toContain(state);
        expect(existsSync(state)).toBe(false);
        const child = launch(profile.command, ["-ec", 'echo written > "$1/session"', "sh", state], { cwd, ownSandbox: box });
        let output = "";
        for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => output += chunk);
        expect((await once(child, "close"))[0], output).toBe(0);
        expect(statSync(state).mode & 0o777).toBe(0o700);
        if (real) expect(readFileSync(join(state, "session"), "utf8")).toBe("written\n");
        else expect(output).toContain(`--bind ${state} ${state}`);
        if (claude) {
          const file = join(home, ".claude.json");
          expect(existsSync(file)).toBe(false);
          writeFileSync(file, "{}");
          expect(ownRun(app, profile, cwd, false).box!.plan.rw).toContain(file);
        }
      } finally {
        vi.unstubAllEnvs(); setSandboxSupportForTests(undefined); app.db.close();
        rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
      }
    });
}

it.skipIf(!support.ok)("本人沙箱中的工作区、快照、命令垫片和 MCP " + (support.reason ?? ""), async () => {
  const app = testApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  const root = mkdtempSync(join(tmpdir(), "own-mounts-"));
  const work = join(root, "work"), extra = join(root, "extra"), home = join(root, "home");
  const snapshot = join(app.runsDir, "sample", "snap");
  for (const dir of [work, extra, home, snapshot, join(app.home, "secrets")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(app.home, "secrets", "sample"), "private");
  app.config.agents.ownSandbox = { mode: "require", writable: [extra], hidden: [] };
  app.config.security.operationRules = [{ id: "blocked", enabled: true, revision: 1, action: "deny", match: { kind: "command", executable: "acme" } }];
  app.config.agents.fullAccess = "sandboxed";
  const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "peer-gate", FAKE_LEGACY: "1" } });
  const prep = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: null, profile, cwd: work });
  const box = prep.isolation.box!;
  box.state = [join(root, "cache")];
  box.runDir = join(app.runsDir, "sample", "scratch");
  box.runtime.push(home); // Restore the fixture HOME read-only under the private /tmp.
  box.snapshot = snapshot;
  const env = { ...prep.mcp.env, HOME: home };
  const exec = async (script: string, cwd = work, readOnly = false) => {
    const config = { ...box, readOnly };
    const plan = ownMounts(config, cwd, readOnly ? { ro: [work], rw: [] } : undefined, undefined, resolveCommand("/bin/sh"));
    const child = launch("/bin/sh", ["-ec", script], { cwd, env, ownSandbox: { ...config, plan } });
    let output = "";
    child.stderr.on("data", b => output += b); child.stdout.on("data", b => output += b);
    const [code] = await once(child, "close");
    expect(code, output).toBe(0);
    return output;
  };
  try {
    await exec(`touch created "${extra}/allowed"; touch "$OMEM_RUN_DIR/created"; test -d "$HOME"; ! touch "$HOME/elsewhere" || exit 1
      test ! -e "${app.home}/secrets/sample"; test ! -e "${app.home}/omem.db"
      omem tool help search
      curl -fsS -H "authorization: Bearer $OMEM_TOKEN" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$OMEM_URL/mcp" | grep -q '"tools"'
      acme && exit 1; test "$?" = 126`);
    expect(existsSync(join(work, "created"))).toBe(true);
    await exec(`! touch "${work}/forbidden" || exit 2; node -e "require('fs').writeFileSync('tested','ok')"`, snapshot, true);
    expect(existsSync(join(snapshot, "tested"))).toBe(true);
    const status: string[] = [];
    box.plan = ownMounts(box, work, undefined, undefined, resolveCommand(profile.command));
    const handle = await openAcp(profile, { cwd: work, ownSandbox: box, fullAccess: prep.fullAccess, mcp: prep.mcp, acpWritable: prep.acpWritable }, e => {
      if (e.type === "status") status.push(e.text);
    });
    try {
      const response = await handle.prompt("check", () => {});
      expect(status.join(" ")).toContain("完全访问：yolo（后端自己的沙箱和审批关了");
      expect(JSON.parse(response.text).status).toBe(126);
    } finally { handle.close(); }
    const reviewer = prepareRun(app, { actor: { role: "reviewer" }, reviewCheck: true, profile, cwd: work, spaceId: "personal", runId: null });
    const review = await openAcp({ ...profile, env: { ...profile.env, FAKE_MODE: "permission" } },
      { cwd: work, ownSandbox: { ...box, readOnly: true, plan: ownMounts({ ...box, readOnly: true }, work) }, fullAccess: reviewer.fullAccess, acpWritable: reviewer.acpWritable });
    try {
      for (const kind of ["edit", "delete", "move"]) {
        const result = await review.prompt(JSON.stringify({ toolCall: { toolCallId: "call", kind, title: kind },
          options: [{ kind: "allow_once", name: "yes", optionId: "yes" }, { kind: "reject_once", name: "no", optionId: "no" }] }), () => {});
        expect(JSON.parse(result.text).optionId).toBe("no");
      }
    } finally { review.close(); revokeToolToken(reviewer.token); }
    const bridge = mcpBridge();
    const child = launch(bridge.command, bridge.args, { cwd: work, env, ownSandbox: box });
    const result = once(child.stdout, "data");
    const closed = once(child, "close");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    try { expect(String(await Promise.race([result, closed]))).toContain('"tools"'); }
    finally { child.stdin.end(); await closed; }
  } finally { revokeToolToken(prep.token); await server.close(); app.db.close(); rmSync(root, { recursive: true, force: true }); rmSync(app.home, { recursive: true, force: true }); }
}, 30000);

it.skipIf(!support.ok)("默认登录文件和插件状态不会随工作区挂回 " + (support.reason ?? ""), async () => {
  const home = mkdtempSync(join(tmpdir(), "fixture-home-"));
  vi.stubEnv("HOME", home);
  const app = testApp();
  const { registerCredential } = await import("../src/agents/credential-registry.ts");
  const unregister = registerCredential("fixture", { id: "login", name: "示例", login: async () => ({ user: "example" }),
    provides: { commands: [{ name: "sample", state: [".cache/sample"] }] } });
  try {
    const cwd = join(home, "project");
    mkdirSync(cwd);
    mkdirSync(join(home, ".ssh"));
    mkdirSync(join(home, ".cache/sample"), { recursive: true });
    writeFileSync(join(home, ".ssh/example"), "fixture");
    writeFileSync(join(home, ".git-credentials"), "fixture");
    writeFileSync(join(home, ".cache/sample/login"), "fixture");
    app.config.agents.ownSandbox = { mode: "prefer", writable: [], hidden: [], excludeKinds: ["fixture"] };
    const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/sh" });
    expect(ownRun(app, profile, cwd, false, null, { kind: "fixture" }).box).toBeUndefined();
    const box = ownRun(app, profile, cwd, false).box!;
    box.plan.ro.push(home);
    const child = launch("/bin/sh", ["-ec", 'test ! -e "$HOME/.ssh/example"; test ! -s "$HOME/.git-credentials"; test ! -e "$HOME/.cache/sample/login"; test -d "$HOME/project"'],
      { cwd, ownSandbox: box });
    let errors = "";
    child.stderr.on("data", chunk => errors += chunk);
    expect((await once(child, "close"))[0], errors).toBe(0);
  } finally {
    unregister(); vi.unstubAllEnvs(); app.db.close();
    rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});
