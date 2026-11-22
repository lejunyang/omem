import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCodeRun } from "../src/agents/code.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { createSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(r.stderr);
  return r.stdout.trim();
}
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), `${file}\n`);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-qm", file);
};

/** A repository with origin and a work branch `feat/refund` cut from main, one commit on it. */
function repo(app: ReturnType<typeof testApp>, id: string) {
  const root = join(app.home, id);
  const remote = join(app.home, `${id}.git`);
  mkdirSync(root);
  mkdirSync(remote);
  sh(remote, "init", "--bare", "-q");
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.name", "Example");
  sh(root, "config", "user.email", "example@example.com");
  commit(root, "a.txt");
  sh(root, "remote", "add", "origin", remote);
  sh(root, "push", "-q", "origin", "main");
  const base = sh(root, "rev-parse", "HEAD");
  sh(root, "branch", "feat/refund");
  sh(root, "worktree", "add", "-q", join(app.home, `${id}-wt`), "feat/refund");
  commit(join(app.home, `${id}-wt`), `${id}.txt`);
  createSpace(app, { id, name: id, kind: "repo", rootPath: root });
  return { space: id, path: join(app.home, `${id}-wt`), branch: "feat/refund", base, start: base, commits: true, newBranch: true, cutFrom: "main" };
}

describe("confirming a delegation across repositories", () => {
  it("pushes only the repositories picked and leaves the others' branches as they are", () => {
    const app = testApp();
    const web = repo(app, "shop-web");
    const api = repo(app, "shop-api");
    const r = createRun(app, { kind: "code", spaceId: "shop-web", title: "退款状态", input: { task: "退款状态", repos: ["shop-web", "shop-api"] } });
    setRunOutput(app, r.id, { worktrees: [web, api] });
    run(app.db, "update runs set status = 'done' where id = ?", r.id);
    const apiTip = sh(join(app.home, "shop-api"), "rev-parse", "feat/refund");

    expect(() => applyCodeRun(app, r.id, { spaces: ["shop-other"] })).toThrow(/没有改到 shop-other/);
    expect(() => applyCodeRun(app, r.id, { spaces: [] })).toThrow(/至少选一个/);

    const res = applyCodeRun(app, r.id, { spaces: ["shop-web"] }) as ReturnType<typeof applyCodeRun> & { pushed: { space: string }[]; notes: string[] };
    expect(res.pushed.map((p) => p.space)).toEqual(["shop-web"]);
    expect(res.notes.join("\n")).toMatch(/shop-api：没动/);
    expect(sh(join(app.home, "shop-web.git"), "branch", "--list", "feat/refund")).toContain("feat/refund");
    expect(sh(join(app.home, "shop-api.git"), "branch", "--list", "feat/refund")).toBe("");
    // The repository left alone keeps its branch and commit.
    expect(sh(join(app.home, "shop-api"), "rev-parse", "feat/refund")).toBe(apiTip);
    expect(getRun(app, r.id).output.appliedAt).toBeTruthy();
  });
});
