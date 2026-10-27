import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codeFolders, codeRunsAt, discardCodeRun } from "../src/agents/code.ts";
import { ideUrl } from "../web/src/lib/ide.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { leaseWorkspace, listWorkspaces, managedSlot, releaseWorkspace, setupDone, setupKey, workDirOf } from "../src/agents/workspaces.ts";
import { run as sql } from "../src/core/db.ts";
import { createSpace, getSpace, updateSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });

const root = mkdtempSync(join(tmpdir(), "omem-ws-"));
sh(root, "init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), "node_modules/\n");
writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
sh(root, "add", "-A");
sh(root, "commit", "-q", "-m", "init");
createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: root });
const repo = () => getSpace(app, "shop-web");
const head = sh(root, "rev-parse", "HEAD").trim();
const noLog = () => {};

describe("reusable workspaces", () => {
  it("creates omem's own slot on first use, keeps ignored files and drops the run's changes when given back", () => {
    updateSpace(app, "shop-web", { settings: { pool: 1 } });
    const link = join(app.runsDir, "r1", "work", "shop-web");
    const slot = leaseWorkspace(app, repo(), "r1", link, noLog)!;
    expect(slot).toBe(managedSlot(app, "shop-web", 1));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(workDirOf({ path: link })).toBe(slot);
    // The only slot is taken: the next run makes its own worktree.
    expect(leaseWorkspace(app, repo(), "r2", join(app.runsDir, "r2", "work", "shop-web"), noLog)).toBeNull();
    expect(listWorkspaces(app, repo())).toMatchObject([{ state: "leased", run: "r1" }]);

    sh(slot, "checkout", "-q", "-B", "omem/r1", head);
    mkdirSync(join(slot, "node_modules"), { recursive: true });
    writeFileSync(join(slot, "node_modules", "dep.js"), "installed");
    writeFileSync(join(slot, "app.ts"), "export const a = 2;\n");
    writeFileSync(join(slot, "new.ts"), "x");
    expect(releaseWorkspace("r1", { path: link, slot })).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(slot, "app.ts"), "utf8").trimEnd()).toBe("export const a = 1;");
    expect(existsSync(join(slot, "new.ts"))).toBe(false);
    expect(readFileSync(join(slot, "node_modules", "dep.js"), "utf8")).toBe("installed");
    expect(listWorkspaces(app, repo())).toMatchObject([{ state: "free" }]);
    // A lease whose run link is gone does not hold the slot.
    expect(leaseWorkspace(app, repo(), "r3", join(app.runsDir, "r3", "work", "shop-web"), noLog)).toBe(slot);
    releaseWorkspace("r3", { path: join(app.runsDir, "r3", "work", "shop-web"), slot });
  });

  it("lends the owner's worktree only while clean, and gives it back on its branch", () => {
    const mine = join(mkdtempSync(join(tmpdir(), "omem-ws-mine-")), "feature");
    sh(root, "worktree", "add", "-q", "-b", "feature-x", mine, head);
    const other = mkdtempSync(join(tmpdir(), "omem-ws-clone-"));
    sh(other, "clone", "-q", root, ".");
    updateSpace(app, "shop-web", { settings: { workspaces: [mine, other, join(root, "missing")] } });
    expect(listWorkspaces(app, repo()).map((s) => s.state)).toEqual(["free", "invalid", "invalid"]);

    writeFileSync(join(mine, "draft.ts"), "work in progress");
    const logs: string[] = [];
    expect(leaseWorkspace(app, repo(), "r4", join(app.runsDir, "r4", "work", "shop-web"), (t) => logs.push(t))).toBeNull();
    expect(logs.join("\n")).toMatch(/未提交|没提交/);
    expect(existsSync(join(mine, "draft.ts"))).toBe(true);

    sh(mine, "clean", "-fdq");
    const link = join(app.runsDir, "r5", "work", "shop-web");
    expect(leaseWorkspace(app, repo(), "r5", link, noLog)).toBe(mine);
    sh(mine, "checkout", "-q", "-B", "omem/r5", head);
    releaseWorkspace("r5", { path: link, slot: mine });
    expect(sh(mine, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature-x");
  });

  it("runs the setup command again only when a lockfile changed", () => {
    expect(setupKey(root, "pnpm install")).toBeTruthy();
    setupDone(root, setupKey(root, "pnpm install")!);
    expect(setupKey(root, "pnpm install")).toBeNull();
    expect(setupKey(root, "npm ci")).toBeTruthy();
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\npackages: {}\n");
    sh(root, "add", "pnpm-lock.yaml");
    expect(setupKey(root, "pnpm install")).toBeTruthy();
    sh(root, "reset", "-q", "--hard");
  });

  it("discarding a run gives its slot back and deletes the run's branch", () => {
    updateSpace(app, "shop-web", { settings: { pool: 1 } });
    const r = createRun(app, { kind: "code", spaceId: "shop-web", title: "改按钮", input: { task: "改按钮" } });
    const link = join(app.runsDir, r.id, "work", "shop-web");
    const slot = leaseWorkspace(app, repo(), r.id, link, noLog)!;
    sh(slot, "checkout", "-q", "-B", `omem/${r.id}`, head);
    writeFileSync(join(slot, "app.ts"), "export const a = 3;\n");
    setRunOutput(app, r.id, { worktrees: [{ space: "shop-web", path: link, branch: `omem/${r.id}`, base: head, slot }] });
    sql(app.db, "update runs set status = 'done' where id = ?", r.id);
    // An editor opens the slot itself, not the link to it.
    expect(codeFolders(app, r.id)).toEqual([{ space: "shop-web", path: slot, kind: "work", branch: `omem/${r.id}` }]);
    // The VS Code extension finds the run from the folder it opened, through the link or the slot.
    expect(codeRunsAt(app, slot, null)).toMatchObject([{ id: r.id, rounds: [r.id], folder: "work" }]);
    expect(codeRunsAt(app, slot, "someone-else")).toEqual([]);
    discardCodeRun(app, r.id);
    expect(codeFolders(app, r.id)).toEqual([]);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(slot)).toBe(true);
    expect(sh(root, "branch", "--list", `omem/${r.id}`).trim()).toBe("");
    expect(listWorkspaces(app, repo())).toMatchObject([{ state: "free" }]);
  });

  it("links to a folder in the editor, locally or over Remote-SSH", () => {
    expect(ideUrl("vscode", "E:\\work\\shop web")).toBe("vscode://file/E:/work/shop%20web");
    expect(ideUrl("cursor", "/home/me/repo#1")).toBe("cursor://file/home/me/repo%231");
    expect(ideUrl("vscode", "/srv/omem/runs/r1/work/shop-web", "devbox")).toBe("vscode://vscode-remote/ssh-remote+devbox/srv/omem/runs/r1/work/shop-web");
  });
});
