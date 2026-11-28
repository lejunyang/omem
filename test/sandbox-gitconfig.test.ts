import { once } from "node:events";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ownMounts } from "../src/agents/own-sandbox.ts";
import { sandboxSupport } from "../src/agents/sandbox.ts";
import { sandboxGitConfig } from "../src/agents/sandbox-gitconfig.ts";
import { launch } from "../src/agents/spawn.ts";

const roots: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "git-config-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it.skipIf(process.platform !== "linux")("配置只取稳定的普通文件，语法错误时整份舍弃", () => {
  const dir = fixture();
  const source = join(dir, "original");
  writeFileSync(source, "[user]\nname = Fixture\n");
  const config = join(dir, ".gitconfig");
  expect(sandboxGitConfig(config)).toHaveLength(0);
  symlinkSync(source, config);
  expect(sandboxGitConfig(config)).toHaveLength(0);
  rmSync(config);
  linkSync(source, config);
  expect(sandboxGitConfig(config)).toHaveLength(0);
  rmSync(config);
  writeFileSync(config, "[user]\nname = Fixture\n[unfinished\n");
  expect(sandboxGitConfig(config)).toHaveLength(0);
});

const support = sandboxSupport();
it.skipIf(!support.ok).each(["owner", "member"] as const)("%s 的两份 Git 配置可只读提交，登录和引用留在宿主", async kind => {
  const dir = fixture(), home = join(dir, "home"), cwd = join(dir, "work");
  mkdirSync(join(home, ".config/git"), { recursive: true });
  mkdirSync(cwd);
  const dot = join(home, ".gitconfig"), xdg = join(home, ".config/git/config");
  const npm = join(home, ".npmrc"), login = join(home, ".git-credentials");
  const original = [
    '[USER]', `  name = "Fixture # ${kind}" ; comment`,
    '[credential "https://example.test"]', '  helper = !echo fake-login',
    '[http "https://example.test"]', '  extraHeader = Authorization: Bearer fake-login',
    '[url "https://user:fake-login@example.test/"]', '  insteadOf = example:',
    '[url "https://example.test/"]', '  insteadOf = https://fake-login@example.test/', '  insteadOf = public:',
    '[includeIf "gitdir:**"]', '  path = ~/.git-credentials', '[include]', '  path = ~/.git-credentials',
    '[alias]', '  st = status -sb', '  auth = !echo fake-login',
    '[core]', '  sshCommand = ssh -i ~/.ssh/fake-login', '  quotePath = false',
  ].join("\n");
  writeFileSync(dot, original);
  writeFileSync(xdg, '[user]\nemail = fixture@example.test\nname = lower-priority\n[http]\nextraHeader = fake-login\n');
  writeFileSync(npm, 'registry=https://example.test/\n_authToken=fake-login\n');
  writeFileSync(login, 'fake-login');
  writeFileSync(join(home, "neighbor"), "pinned");
  const masked = [dot, xdg, npm, login];
  const box = { home, data: join(dir, "data"), state: [], writable: [], hidden: [], masked, runtime: [], secretEnv: [], readOnly: false };
  mkdirSync(box.data);
  const options = kind === "owner"
    ? { ownSandbox: { ...box, plan: ownMounts(box, cwd, { ro: [home], rw: [cwd] }) } }
    : { sandbox: { home, userId: "sample", backend: "fixture", env: {}, hide: [], ro: [], masked } };
  const child = launch("/bin/sh", ["-ec", [
    'test ! -w "$HOME/.gitconfig" && test ! -w "$HOME/.config/git/config" || exit 1',
    'if grep -Ei "fake-login|include|credential|extraheader|sshcommand" "$HOME/.gitconfig" "$HOME/.config/git/config" "$HOME/.npmrc"; then exit 1; fi',
    'test ! -s "$HOME/.git-credentials"',
    'test "$(cat "$HOME/neighbor")" = pinned',
    'test "$(cat "$HOME/.npmrc")" = registry=https://example.test/',
    'git init -q', 'git st', 'test "$(git config core.quotepath)" = false',
    'test "$(git config --get-all url.https://example.test/.insteadOf)" = public:',
    'git commit --allow-empty -qm fixture', 'git log -1 --format="%an <%ae>"',
  ].join("\n")], { ...options, cwd, baseEnv: { HOME: home, PATH: "/usr/bin:/bin" }, env: { OMEM_DESKTOP_TOOLS: "off" } });
  let output = "", errors = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => errors += chunk);
  expect((await once(child, "close"))[0], errors + output).toBe(0);
  expect(output).toContain(`Fixture # ${kind} <fixture@example.test>`);
  expect(readFileSync(dot, "utf8")).toBe(original);
});

it.skipIf(!support.ok).each(["borrowed", "hidden"] as const)("%s 路径不会重新挂入 Git 配置", async kind => {
  const dir = fixture(), home = join(dir, "home"), cwd = join(dir, "work");
  mkdirSync(join(home, ".config/git"), { recursive: true });
  mkdirSync(cwd);
  const dot = join(home, ".gitconfig"), xdg = join(home, ".config/git/config");
  for (const file of [dot, xdg]) writeFileSync(file, "[user]\nname = private-author\n");
  const masked = [dot, xdg];
  const box = { home, data: join(dir, "data"), state: [], writable: [], hidden: [join(home, ".config")], masked, runtime: [], secretEnv: [], readOnly: false };
  mkdirSync(box.data);
  const options = kind === "borrowed"
    ? { sandbox: { home, userId: "sample", backend: "fixture", env: {}, hide: [], ro: [], masked, borrowed: { state: [], dirs: [] } } }
    : { ownSandbox: { ...box, plan: ownMounts(box, cwd, { ro: [home], rw: [cwd] }) } };
  const script = kind === "borrowed" ? 'test ! -s "$HOME/.gitconfig" && test ! -s "$HOME/.config/git/config"'
    : 'test -s "$HOME/.gitconfig" && test ! -s "$HOME/.config/git/config"';
  const child = launch("/bin/sh", ["-ec", script], { ...options, cwd, baseEnv: { HOME: home, PATH: "/usr/bin:/bin" }, env: { OMEM_DESKTOP_TOOLS: "off" } });
  let errors = "";
  child.stderr.on("data", chunk => errors += chunk);
  expect((await once(child, "close"))[0], errors).toBe(0);
});
