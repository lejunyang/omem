import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { codeRepos, homeSpace } from "../src/agents/code.ts";
import { createRun, listRuns } from "../src/agents/runs.ts";
import { can, spacesWith } from "../src/auth/permissions.ts";
import { repoSuggestions } from "../src/core/space-repos.ts";
import { businessOf, createSpace, getSpace, relatedSpaces, relateSpaces, setSpaceParent, spaceFamily } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

const repoDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), "{}\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"], { cwd: dir });
  return dir;
};

describe("repositories under a business space", () => {
  it("puts a repository under a business space in place of their relation, and only a repository under a business", () => {
    const app = testApp();
    try {
      createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
      const web = createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: repoDir() });
      const api = createSpace(app, { id: "shop-api", name: "商城后端", kind: "repo", rootPath: repoDir(), parentId: "shop" });
      relateSpaces(app, "shop", "shop-web", { note: "前端仓库", origin: "agent" });
      setSpaceParent(app, web.id, "shop");
      expect(getSpace(app, "shop-web").parentId).toBe("shop");
      // Repositories come by name.
      expect(spaceFamily(app, "shop")).toEqual(["shop", "shop-web", "shop-api"]);
      expect(businessOf(app, api.id)).toBe("shop");
      // The relation they had is gone: the parent stands in for it, and reads as related both ways.
      expect(relatedSpaces(app, "shop").map((r) => [r.space, r.via])).toEqual([["shop-web", "child"], ["shop-api", "child"]]);
      expect(relatedSpaces(app, "shop-web")).toMatchObject([{ space: "shop", via: "parent" }]);
      expect(() => setSpaceParent(app, "shop", "shop-web")).toThrow(/不是代码仓库/);
      expect(() => setSpaceParent(app, "shop-web", "shop-api")).toThrow(/不是业务空间/);
      setSpaceParent(app, "shop-web", null);
      expect(spaceFamily(app, "shop")).toEqual(["shop", "shop-api"]);
    } finally { app.db.close(); }
  });

  it("files work under the business space, and lets its members and searches reach the repositories", async () => {
    const app = testApp();
    try {
      createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
      createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: repoDir(), parentId: "shop" });
      expect(homeSpace(app, undefined, undefined, ["shop-web"])).toBe("shop");
      expect(homeSpace(app, "shop-web", undefined, ["shop-web"])).toBe("shop");
      // A business space with one repository stands for it; with two, which one has to be said.
      expect(codeRepos(app, "", ["shop"]).map((r) => r.id)).toEqual(["shop-web"]);
      createSpace(app, { id: "shop-api", name: "商城后端", kind: "repo", rootPath: repoDir(), parentId: "shop" });
      expect(() => codeRepos(app, "", ["shop"])).toThrow(/2 个仓库/);
      // The business space's run list includes work filed in its repositories before they moved under it.
      createRun(app, { kind: "code", spaceId: "shop-api", title: "旧交办", input: {} });
      expect(listRuns(app, { spaceIds: spaceFamily(app, "shop") }).map((r) => r.title)).toEqual(["旧交办"]);
      // A member of the business space may read its repository too.
      createUser(app, { name: "小王", id: "u-wang" });
      addMember(app, "shop", "u-wang", "reader");
      expect(spacesWith(app, "u-wang", "space.read")).toEqual(expect.arrayContaining(["shop", "shop-web"]));
      expect(can(app, "u-wang", "space.read", "shop-web")).toBe(true);
      // list_spaces shows the repository under its business.
      const ctx = { app, spaceId: "shop", runId: null, spaces: null, actor: "owner" } as unknown as ToolContext;
      const listed = (await callTool(ctx, "list_spaces", {})).text;
      expect(listed).toMatch(/- shop（示例商城[^\n]*\n(  [^\n]*\n)*  - shop-web（商城前端/);
    } finally { app.db.close(); }
  });

  it("suggests the repositories a business space already works with", () => {
    const app = testApp();
    try {
      createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
      createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: repoDir() });
      createSpace(app, { id: "shop-api", name: "商城后端", kind: "repo", rootPath: repoDir() });
      createSpace(app, { id: "tools", name: "工具", kind: "repo", rootPath: repoDir() });
      relateSpaces(app, "shop", "shop-api", { note: "是它的代码仓库", origin: "owner" });
      createRun(app, { kind: "code", spaceId: "shop", title: "退款", input: { task: "退款", repos: ["shop-web"] } });
      expect(repoSuggestions(app, "shop").map((s) => [s.space, s.reasons])).toEqual([
        ["shop-api", ["你关联过：是它的代码仓库"]],
        ["shop-web", ["1 次交办记在这里"]],
      ]);
      setSpaceParent(app, "shop-api", "shop");
      expect(repoSuggestions(app, "shop").map((s) => s.space)).toEqual(["shop-web"]);
    } finally { app.db.close(); }
  });
});
