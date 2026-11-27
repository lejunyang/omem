import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { startServer } from "../src/server/http.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { launch, stop } from "../src/agents/spawn.ts";
import { registerCredential } from "../src/agents/credential-registry.ts";
import { createRun } from "../src/agents/runs.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { launchRun } from "../src/agents/egress-run.ts";
import { egressSupport, sandboxSupport } from "../src/agents/sandbox.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { remoteGit } from "../src/agents/git-command.ts";
import { accountEntry, accountRun, ensureAccountHome } from "../src/agents/accounts.ts";
import { createUser, OWNER, personalSpaceId } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

it("识别 Git 远端操作及其全局选项", () => {
  expect(remoteGit(["-C", "project", "ls-remote", "origin"])).toBe(true);
  expect(remoteGit(["--git-dir=.git", "fetch"])).toBe(true);
  expect(remoteGit(["-C", "project", "remote", "-v", "update", "--prune"])).toBe(true);
  expect(remoteGit(["submodule", "--quiet", "update", "--jobs", "2", "--remote", "--", "lib"])).toBe(true);
  for (const args of [
    ["remote", "-v"], ["remote", "add", "update", "url"], ["remote", "remove", "update"],
    ["submodule", "update", "--init"], ["submodule", "update", "--", "--remote"],
    ["submodule", "update", "--reference", "--remote"], ["submodule", "status", "--remote"],
  ]) expect(remoteGit(args), args.join(" ")).toBe(false);
  expect(remoteGit(["status"])).toBe(false);
});

const support = sandboxSupport();
for (const proxy of [false, true]) {
const network = proxy ? egressSupport() : support;
it.skipIf(!network.ok)("同身份执行器流式回传、stdin、退出码和取消 " + (proxy ? "（出网代理）" : "") + (network.reason ?? ""), async () => {
  const app = testApp();
  const root = mkdtempSync(join(tmpdir(), "gate-integration-"));
  const home = join(root, "account"), cwd = join(root, "work"), bin = join(root, "bin");
  for (const dir of [join(home, ".fixture"), join(home, ".other"), cwd, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".fixture", "value"), "ready");
  writeFileSync(join(home, ".other", "login"), "other");
  const file = join(bin, "samplecli");
  writeFileSync(file, '#!/bin/sh\ntest ! -e "$HOME/.backend/session" && test ! -e "$HOME/.other/login" || exit 3\ncat "$HOME/.fixture/value" || exit 2\nprintf "\\n"\nif test "$1" = hold; then sleep 2; touch late; exit; fi\nread line\nprintf "%s" "$line" >&2\nexit 17\n', { mode: 0o755 });
  vi.stubEnv("HOME", home); vi.stubEnv("OMEM_DESKTOP_TOOLS", "off"); vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/sh",
    account: { dirs: [".backend"], owns: [".backend"] } });
  app.config.agents.profiles = [profile];
  const unregister = registerCredential("fixture", { id: "sample", name: "示例", login: async () => ({ user: "example" }),
    provides: { backends: [profile.id], commands: [{ name: "samplecli", state: [".fixture"] }, { name: "othercli", state: [".other"] }] } }, undefined, app);
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  app.config.agents.ownSandbox.mode = "require";
  if (proxy) app.config.security.egress.mode = "all-sandboxed";
  const runId = createRun(app, { kind: "code", title: "示例" }).id;
  const prep = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId, profile, cwd });
  function invoke(command: string) {
    return launchRun(profile, { app, mcp: prep.mcp, ownSandbox: prep.isolation.box, runId }, (_account, ownSandbox) =>
      launch("/bin/sh", ["-ec", command], { cwd, ownSandbox, env: prep.mcp.env }));
  }
  try {
    const child = await invoke('echo active > "$HOME/.backend/session"; test ! -e "$HOME/.fixture/value"; exec samplecli');
    let stderr = "";
    child.stderr.on("data", chunk => stderr += chunk);
    const closed = once(child, "close");
    const first = await Promise.race([once(child.stdout, "data").then(([data]) => String(data)), closed.then(() => stderr)]);
    expect(first.trimEnd()).toBe("ready");
    child.stdin.end("from stdin\n");
    expect((await closed)[0]).toBe(17);
    expect(stderr).toBe("from stdin");
    expect(readFileSync(join(home, ".backend/session"), "utf8")).toBe("active\n");
    const interrupted = await invoke('exec samplecli hold');
    const exit = once(interrupted, "close");
    await Promise.race([once(interrupted.stdout, "data"), exit.then(() => { throw new Error("未进入执行器"); })]);
    stop(interrupted); await exit;
    await new Promise(resolve => setTimeout(resolve, 2250));
    expect(() => readFileSync(join(cwd, "late"))).toThrow();
  } finally {
    revokeToolToken(prep.token); await server.close(); unregister(); vi.unstubAllEnvs();
    app.db.close(); rmSync(app.home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
}, 45000);
}

it.skipIf(!support.ok)("多个调用入口使用同一条拒绝规则，模拟登录只在执行器可读 " + (support.reason ?? ""), async () => {
  const { symlinkSync, copyFileSync, existsSync } = await import("node:fs");
  const app = testApp();
  const root = mkdtempSync(join(tmpdir(), "gate-paths-"));
  const home = join(root, "account"), cwd = join(root, "work"), bin = join(root, "bin");
  const pkg = join(root, "install", "node_modules", "samplecli");
  const python = join(root, "python");
  const modules = join(python, "lib", "python3", "site-packages");
  const module = join(modules, "samplepkg");
  for (const dir of [home, cwd, bin, pkg, join(python, "bin"), module]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".git-credentials"), "fixture");
  vi.stubEnv("GH_TOKEN", "fixture-gh");
  writeFileSync(join(bin, "gh"), '#!/bin/sh\ntest "$GH_TOKEN" = fixture-gh && test -z "${NPM_TOKEN+x}"\n', { mode: 0o755 });
  writeFileSync(join(home, ".npmrc"), 'registry=https://registry.example.org/\n//registry.example.org/:_authToken=${NPM_TOKEN}\n');
  writeFileSync(join(bin, "npm"), String.raw`#!/usr/bin/env node
const config = require("node:fs").readFileSync(process.env.HOME + "/.npmrc", "utf8");
const token = config.match(/^\/\/registry\.example\.org\/:_authToken=\$\{(\w+)\}$/m)?.[1];
process.exit(token && process.env[token] === "fixture-npm" && !("GH_TOKEN" in process.env) ? 0 : 23);
`, { mode: 0o755 });
  const entry = join(pkg, "cli.js"), link = join(bin, "samplecli");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ bin: { samplecli: "./cli.js" } }));
  writeFileSync(entry, '#!/usr/bin/env node\nconst fs=require("node:fs"); process.exit(fs.existsSync(process.env.HOME+"/.git-credentials") && fs.statSync(process.env.HOME+"/.git-credentials").size ? 0 : 23);', { mode: 0o755 });
  symlinkSync(entry, link);
  writeFileSync(join(module, "__main__.py"), "print('fixture')\n");
  writeFileSync(join(module, "__init__.py"), "def main(): pass\n");
  writeFileSync(join(python, "bin", "samplepy"), "#!/usr/bin/env python3\nfrom samplepkg import main\nmain()\n", { mode: 0o755 });
  const dispatcher = join(bin, "fixture-dispatch");
  copyFileSync("/bin/true", dispatcher);
  symlinkSync(dispatcher, join(bin, "guarded-tool"));
  symlinkSync(dispatcher, join(bin, "ordinary-tool"));
  const git = join(bin, "git");
  writeFileSync(git, `#!/bin/sh
case "$1 $2" in
  'status '| 'remote -v'| 'remote add'| 'remote remove') test ! -s "$HOME/.git-credentials" ;;
  *) test -s "$HOME/.git-credentials" || exit 23 ;;
esac
`, { mode: 0o755 });
  copyFileSync(git, join(cwd, "git-fixture"));
  copyFileSync(entry, join(cwd, "copy.js"));
  vi.stubEnv("HOME", home); vi.stubEnv("OMEM_DESKTOP_TOOLS", "off"); vi.stubEnv("PATH", [bin, join(python, "bin"), process.env.PATH].join(":"));
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  app.config.agents.ownSandbox.mode = "require";
  app.config.security.operationRules = ["samplecli", "guarded-tool", "samplepy"].map(executable => ({
    id: executable, revision: 1, enabled: true, action: "deny", match: { kind: "command", executable },
  }));
  app.config.security.operationRules.push({ id: "npm-install", revision: 1, enabled: true, action: "allow", match: { kind: "command", executable: "npm" } });
  const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/sh", env: { NPM_TOKEN: "fixture-npm" } });
  const prep = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: null, profile, cwd });
  const box = prep.isolation.box!;
  box.plan.ro.push(home, bin, pkg, python);
  async function invoke(exe: string, args: string[]) {
    const child = launch(exe, args, { cwd, ownSandbox: box, env: { ...profile.env, ...prep.mcp.env } });
    let out = "";
    child.stderr.on("data", b => out += b);
    const [code] = await once(child, "close");
    return { code, out };
  }
  try {
    const cases: [string, string[]][] = [
      [link, []], ["/usr/bin/env", ["-i", link]], ["/usr/bin/env", ["PATH=" + bin, "samplecli"]],
      ["/bin/sh", ["-c", 'exec "$1"', "sh", link]], [process.execPath, [entry]],
      [process.execPath, ["-e", 'process.exit(require("node:child_process").spawnSync(process.argv[1],{stdio:"inherit"}).status)', link]],
    ];
    if (existsSync("/usr/bin/python3")) cases.push(["/usr/bin/python3", ["-c", "import subprocess,sys; sys.exit(subprocess.call(sys.argv[1:]))", link]]);
    if (existsSync("/usr/bin/python3")) cases.push(["/usr/bin/env", ["PYTHONPATH=" + modules, "/usr/bin/python3", "-m", "samplepkg"]]);
    for (const [exe, args] of cases) {
      const { code, out } = await invoke(exe, args);
      expect(code, exe + " " + out).toBe(126);
      expect(out).toContain("[omem]");
    }
    expect((await invoke(join(bin, "ordinary-tool"), [])).code).toBe(0);
    expect((await invoke(join(bin, "guarded-tool"), [])).code).toBe(126);
    expect((await invoke(dispatcher, [])).code).toBe(126);
    expect((await invoke(process.execPath, [join(cwd, "copy.js")])).code).toBe(23);
    const auth = await invoke("/bin/sh", ["-ec", [
      'test -z "${GH_TOKEN+x}${NPM_TOKEN+x}"',
      'GH_TOKEN=from-request gh auth status',
      'NPM_TOKEN=from-request npm install',
    ].join("\n")]);
    expect(auth.code, auth.out).toBe(0);
    const logins = app.db.prepare("select target, detail from audit_events where action='command.execute' and target in ('gh','npm') order by rowid").all();
    expect(logins.map(row => [row.target, JSON.parse(String(row.detail))])).toEqual([
      ["gh", { runId: null, argv: ["auth", "status"], cwd }],
      ["npm", { runId: null, argv: ["install"], cwd }],
    ]);
    const remote = await invoke("/bin/sh", ["-ec", [
      "git status", "git remote -v", "git remote add update url", "git remote remove update",
      "git push", "git -C . remote update --prune origin",
      "git submodule update --init --remote -- 'vendor/private lib'",
    ].join("\n")]);
    expect(remote.code, remote.out).toBe(0);
    expect((await invoke(join(cwd, "git-fixture"), ["push"])).code).toBe(23);
    const rows = app.db.prepare("select detail from audit_events where action='command.execute' and target='git' order by rowid").all();
    expect(rows.map(row => JSON.parse(String(row.detail)))).toEqual([
      expect.objectContaining({ argv: ["push"], cwd }),
      expect.objectContaining({ argv: ["-C", ".", "remote", "update", "--prune", "origin"], cwd }),
      expect.objectContaining({ argv: ["submodule", "update", "--init", "--remote", "--", "vendor/private lib"], cwd }),
    ]);
    expect((await invoke("/bin/sh", ["-ec", 'test ! -s "$HOME/.git-credentials"; test ! -e "$1/omem.db"', "sh", app.home])).code).toBe(0);
  } finally {
    revokeToolToken(prep.token); await server.close(); vi.unstubAllEnvs();
    app.db.close(); rmSync(app.home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
}, 45000);

it.skipIf(!support.ok)("成员执行器仅恢复本账号的声明目录和登录变量 " + (support.reason ?? ""), async () => {
  const { localAccount, ensureAccountHome } = await import("../src/agents/accounts.ts");
  const { issueToolToken } = await import("../src/agents/tools.ts");
  const { createUser } = await import("../src/core/users.ts");
  const { agentToolEnv } = await import("../src/agents/tool-cli.ts");
  const { commandGateDir } = await import("../src/agents/command-gate.ts");
  const app = testApp();
  const root = mkdtempSync(join(tmpdir(), "member-command-"));
  const home = join(root, "owner"), cwd = join(root, "work"), bin = join(root, "bin");
  for (const dir of [join(home, ".fixture"), cwd, bin]) mkdirSync(dir, { recursive: true });
  vi.stubEnv("HOME", home); vi.stubEnv("OMEM_DESKTOP_TOOLS", "off"); vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  vi.stubEnv("SAMPLE_TOKEN", "owner"); vi.stubEnv("ALTERNATE_TOKEN", "owner");
  const unregister = registerCredential("fixture", { id: "sample", name: "示例", login: async () => ({ user: "example" }),
    provides: { commands: [{ name: "samplecli", state: [".fixture"], loginEnv: ["SAMPLE_TOKEN", "ALTERNATE_TOKEN"] }] } });
  createUser(app, { id: "member", name: "示例成员", role: "member" });
  const member = ensureAccountHome(app, "member");
  writeFileSync(join(member, ".fixture", "login"), "member");
  writeFileSync(join(home, ".fixture", "login"), "owner");
  writeFileSync(join(bin, "samplecli"), '#!/bin/sh -e\ntest "$SAMPLE_TOKEN" = member\ntest -z "${ALTERNATE_TOKEN+x}${OTHER_TOKEN+x}"\ncat "$HOME/.fixture/login"\n', { mode: 0o755 });
  const account = localAccount(app, "member", "fixture");
  account.env = { SAMPLE_TOKEN: "member", OTHER_TOKEN: "unrelated" };
  const profile = { ...agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/sh", env: { ALTERNATE_TOKEN: "shared-profile" } }), ownAccount: account };
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  const token = issueToolToken({ actor: "agent", userId: "member", commandHomeUser: "member", runId: null, spaceId: "", spaces: [], tools: null, commandSandbox: { profile, workspace: { ro: [], rw: [cwd] } } });
  try {
    const child = launch("/bin/sh", ["-ec", 'test -z "${SAMPLE_TOKEN+x}${ALTERNATE_TOKEN+x}${OTHER_TOKEN+x}"; test ! -e "$HOME/.fixture/login"; test ! -e "$1/.fixture/login"; exec samplecli', "sh", home],
      { cwd, sandbox: account, env: agentToolEnv(app.home, app.baseUrl, token, commandGateDir(app, true)) });
    child.stdin.end();
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", b => output += b);
    expect((await once(child, "close"))[0], output).toBe(0);
    expect(output).toBe("member");
  } finally {
    revokeToolToken(token); await server.close(); unregister(); vi.unstubAllEnvs();
    app.db.close(); rmSync(app.home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
}, 45000);

const kubeconfigs = [
  { name: "默认目录", keys: ["standard"] },
  { name: "自定义目录", keys: ["external"] },
  { name: "多文件列表", keys: ["external", "standard"] },
] as const;
for (const user of [OWNER, "member"]) {
  const denied = user === OWNER ? ["hidden", "state", "data"] as const : ["other", "link", "state", "data"] as const;
  const cases = [...kubeconfigs.map(item => ({ ...item, allowed: true })), ...denied.map(key => ({ name: key, keys: [key], allowed: false }))];
  it.skipIf(!support.ok).each(cases)(`kubectl 按 ${user} 的 KUBECONFIG 读取配置：$name`, async ({ name, keys, allowed }) => {
    const app = testApp();
    const root = mkdtempSync(join(tmpdir(), "kube-login-"));
    const ownerHome = join(root, "owner"), cwd = join(root, "work"), bin = join(root, "bin");
    const member = user !== OWNER;
    if (member) createUser(app, { id: user, name: "示例成员", role: "member" });
    const home = member ? ensureAccountHome(app, user) : ownerHome;
    const external = join(member ? home : root, "external");
    const paths = {
      standard: join(home, ".kube", "project.yaml"), external: join(external, "other project.yaml"),
      hidden: join(home, ".kube", "private.yaml"), state: join(home, ".codex", "session"),
      data: join(app.home, "private.yaml"), other: join(ownerHome, "other.yaml"), link: join(home, "linked.yaml"),
    };
    for (const dir of [cwd, bin, ...Object.values(paths).map(dirname)]) mkdirSync(dir, { recursive: true });
    for (const [key, path] of Object.entries(paths)) {
      if (key === "link") symlinkSync(paths.other, path);
      else writeFileSync(path, key + "\n");
    }
    writeFileSync(join(external, "sibling"), "private");
    writeFileSync(join(bin, "kubectl"), `#!/bin/sh -e
test ! -e "$1/sibling"
IFS=:
for file in $KUBECONFIG; do cat "$file"; done
`, { mode: 0o755 });
    const files = keys.map(key => paths[key]);
    const config = files.join(":");
    vi.stubEnv("HOME", ownerHome); vi.stubEnv("PATH", bin + ":" + process.env.PATH);
    vi.stubEnv("OMEM_DESKTOP_TOOLS", "off");
    vi.stubEnv("KUBECONFIG", !member && files.length === 1 ? config : paths.other);
    const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/sh", stateLayout: "codex" });
    if (files.length > 1 || member) profile.env.KUBECONFIG = member ? paths.other : config;
    const entry = accountEntry(app, "codex")!;
    const account = member ? accountRun(app, user, { ...entry, account: { ...entry.account, env: { KUBECONFIG: config } } }) : undefined;
    account?.ro.push(bin);
    app.config.agents.ownSandbox.mode = "require";
    if (name === "hidden") app.config.agents.ownSandbox.hidden = [dirname(paths.hidden)];
    const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
    const runProfile = { ...profile, ownAccount: account };
    const prep = prepareRun(app, { actor: { role: "coder" }, spaceId: personalSpaceId(user), userId: user, runId: null, profile: runProfile, cwd });
    prep.isolation.box?.plan.ro.push(home, external, bin);
    try {
      const child = launch("/bin/sh", ["-ec", `
test -z "$KUBECONFIG"
dir=$1
shift
for file do test ! -s "$file"; done
echo agent-checked
KUBECONFIG=from-request exec kubectl "$dir"
`, "sh", external, ...files], { cwd, ownSandbox: prep.isolation.box, sandbox: account, env: { ...profile.env, ...prep.mcp.env } });
      child.stdin.end();
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => stdout += chunk);
      child.stderr.on("data", chunk => stderr += chunk);
      const [code] = await once(child, "close");
      if (allowed) {
        expect(code, stderr).toBe(0);
        expect(stdout).toBe(["agent-checked", ...keys, ""].join("\n"));
      } else {
        expect(stdout, stderr).toBe("agent-checked\n");
        expect(code, stderr).not.toBe(0);
        expect(stderr).toMatch(/KUBECONFIG|账号状态目录/);
      }
    } finally {
      revokeToolToken(prep.token); await server.close(); vi.unstubAllEnvs();
      app.db.close(); rmSync(app.home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
    }
  });
}
