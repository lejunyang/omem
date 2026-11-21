import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { sandboxCommand, sandboxSupport } from "../src/agents/sandbox.ts";
import { receiveMemberGit } from "../src/agents/member-git.ts";
import { leaseWorkspace, workspaceMounts } from "../src/agents/workspaces.ts";
import { createSpace, getSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => { app.db.close(); rmSync(app.home, { recursive: true, force: true }); });

describe("rename inside member sandbox", () => {
  it("shows the exact error", async () => {
    const root = mkdtempSync(join(app.home, "repo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.name=Test", "-c", "user.email=t@e.org", "commit", "-qm", "init", "--allow-empty");
    createSpace(app, { id: "rr", name: "rr", kind: "repo", rootPath: root });
    const path = join(app.runsDir, "rr-round", "work", "rr");
    const slot = leaseWorkspace(app, getSpace(app, "rr"), "rr-round", path, () => {})!.path;
    git("-C", slot, "checkout", "-qb", "omem/rr-round");
    const wt = { space: "rr", path, slot, commits: true, branch: "omem/rr-round", base: git("-C", slot, "rev-parse", "HEAD").trim() };
    const plan = workspaceMounts(app, [wt], "rr-round");
    const home = join(app.home, "mh");
    mkdirSync(home);
    const acct = { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] };
    const run = (script: string) => {
      const cmd = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-ec", script], {}, slot, acct, plan);
      return execFileSync(cmd.file, cmd.args, { env: cmd.env, encoding: "utf8" });
    };
    run('git branch -m omem/rr-round feat/rename && echo x > f && git add f && git commit -qm c1');
    try {
      await receiveMemberGit(app, "rr-round", "rr", slot, "round title");
      console.log("RECEIVED OK");
    } catch (e) {
      console.log("ERROR:", (e as Error).message);
    }
  });
});
