import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sandboxCommand, sandboxSupport } from "../src/agents/sandbox.ts";
import { leaseWorkspace, workspaceMounts } from "../src/agents/workspaces.ts";
import { createSpace, getSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => {
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
});

function repository(id: string) {
  const root = mkdtempSync(join(app.home, "repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "init", "--allow-empty");
  createSpace(app, { id, name: id, kind: "repo", rootPath: root });
  return { id, root, git };
}

const a = repository("web");
const b = repository("api");
function leased(run: string, repo = a) {
  const path = join(app.runsDir, run, "work", repo.id);
  const slot = leaseWorkspace(app, getSpace(app, repo.id), run, path, () => {})!.path;
  return { space: repo.id, path, slot };
}
const lead = leased("lead");
const helper = leased("helper");
const helperApi = leased("helper", b);
const group = dirname(lead.path);
const inline = { space: b.id, path: join(group, b.id) };
b.git("worktree", "add", "-q", "--detach", inline.path);

describe("delegation sandbox mounts", () => {
  it("mounts the assigned slot and reads Git metadata from the registered repository", () => {
    expect(workspaceMounts(app, [lead])).toEqual({ ro: [realpathSync(join(a.root, ".git"))], rw: [realpathSync(lead.slot)], links: [] });
    // An unreadable checkout pointer must never cause discovery of another mount.
    const pointer = join(inline.path, ".git");
    const gitdir = realpathSync(join(b.root, ".git"));
    const original = readFileSync(pointer);
    writeFileSync(pointer, "gitdir: missing\n");
    try {
      expect(workspaceMounts(app, [inline])).toEqual({ ro: [gitdir], rw: [realpathSync(inline.path)], links: [] });
    } finally {
      writeFileSync(pointer, original);
    }
  });

  it("recreates the multi-repo links and mounts only the selected trees writable", () => {
    expect(workspaceMounts(app, [lead, inline])).toEqual({
      ro: [join(a.root, ".git"), join(b.root, ".git")].map(p => realpathSync(p)),
      rw: [lead.slot, inline.path].map(p => realpathSync(p)),
      links: [{ path: join(realpathSync(group), a.id), target: realpathSync(lead.slot) }],
    });
  });

  it("uses the helper's lease for the same repository", () => {
    expect(workspaceMounts(app, [helper])).toEqual({ ro: [realpathSync(join(a.root, ".git"))], rw: [realpathSync(helper.slot)], links: [] });
  });

  it.skipIf(!sandboxSupport().ok)("opens both repositories in bubblewrap and keeps the helper's slot hidden", () => {
    const home = join(app.home, "account");
    mkdirSync(home);
    writeFileSync(join(group, "unassigned"), "host only");
    const probe = [
      'git -C web rev-parse --verify HEAD',
      'git -C api rev-parse --verify HEAD',
      'touch web/new-file api/new-file',
      'test ! -e unassigned && test ! -w "$1" && test ! -e "$2"',
    ].join(" && ");
    const acct = { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] };
    const command = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-c", probe, "sh", join(a.root, ".git"), helper.slot], {}, group,
      acct, workspaceMounts(app, [lead, inline]));
    execFileSync(command.file, command.args, { env: command.env });

    const child = sandboxCommand({ file: "/bin/sh", prefix: [] },
      ["-c", 'git -C web rev-parse --verify HEAD && git -C api rev-parse --verify HEAD && touch web/helper-file && test ! -e "$1" && test ! -e "$2"', "sh", lead.slot, inline.path],
      {}, dirname(helper.path), acct, workspaceMounts(app, [helper, helperApi]));
    execFileSync(child.file, child.args, { env: child.env });
  });
});
