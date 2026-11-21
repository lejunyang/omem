import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { sandboxCommand } from "../src/agents/sandbox.ts";
import { leaseWorkspace, workspaceMounts } from "../src/agents/workspaces.ts";
import { createSpace, getSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => { app.db.close(); rmSync(app.home, { recursive: true, force: true }); });

describe("conflict resolver in member sandbox", () => {
  it("tries git add with read-only common gitdir", () => {
    const root = mkdtempSync(join(app.home, "repo-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.org", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, "f.txt"), "base\n");
    git("add", "-A"); git("commit", "-qm", "init");
    git("checkout", "-qb", "topic");
    writeFileSync(join(root, "f.txt"), "topic\n"); git("commit", "-aqm", "topic");
    git("checkout", "-q", "main");
    writeFileSync(join(root, "f.txt"), "main-edit\n"); git("commit", "-aqm", "main edit");
    createSpace(app, { id: "cf", name: "cf", kind: "repo", rootPath: root });
    const path = join(app.runsDir, "cf-run", "work", "cf");
    const slot = leaseWorkspace(app, getSpace(app, "cf"), "cf-run", path, () => {})!.path;
    let cherryOk = true;
    try { execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.org", "cherry-pick", "topic"], { cwd: slot, encoding: "utf8", stdio: "pipe" }); }
    catch { cherryOk = false; }
    console.log("cherry-pick conflicted as expected:", !cherryOk);
    const wt = { space: "cf", path, slot, commits: true, branch: "main", base: "x" };
    const plan = workspaceMounts(app, [wt]);
    const home = join(app.home, "mh"); mkdirSync(home);
    const acct = { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] };
    const cmd = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-c", "echo resolved > f.txt; git add f.txt; echo EXIT=$?"], {}, slot, acct, plan);
    const r = spawnSync(cmd.file, cmd.args, { env: cmd.env, encoding: "utf8" });
    console.log("SANDBOX STDOUT:", JSON.stringify(r.stdout));
    console.log("SANDBOX STDERR:", String(r.stderr).slice(0, 600));
    console.log("SANDBOX CODE:", r.status);
  });
});
