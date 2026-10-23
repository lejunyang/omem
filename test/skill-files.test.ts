import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteSkillFile, listSkillFiles, readSkill, readSkillFile, saveSkill, saveSkillFile } from "../src/agents/specs.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

describe("skill directory editor", () => {
  it("reads and edits nested files, preserves the entry and records file deletion", async () => {
    const app = testApp();
    saveSkill(app, { name: "sample-skill", description: "示例步骤", body: "查看附属文件", files: { "references/checks/one.md": "第一版" } }, "user");
    expect(readSkill(app, "sample-skill").files).toEqual(["references/checks/one.md"]);
    expect(listSkillFiles(app, "sample-skill")).toContainEqual({ path: "references/checks", type: "directory" });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const url = "/api/skills/sample-skill/file";
      expect((await server.inject({ method: "PUT", url, payload: { path: "references/checks/one.md", raw: "第二版" } })).statusCode).toBe(200);
      expect((await server.inject({ method: "GET", url: url + "?path=references%2Fchecks%2Fone.md" })).json()).toEqual({ raw: "第二版" });
      expect((await server.inject({ method: "PUT", url, payload: { path: "references/empty.md", raw: "", create: true } })).statusCode).toBe(200);
      expect((await server.inject({ method: "PUT", url, payload: { path: "references/empty.md", raw: "覆盖", create: true } })).statusCode).toBe(409);
      expect((await server.inject({ method: "PUT", url, payload: { path: "SKILL.md", raw: "无效入口" } })).statusCode).toBe(400);
      expect((await server.inject({ method: "DELETE", url: url + "?path=SKILL.md" })).statusCode).toBe(400);
      deleteSkillFile(app, "sample-skill", "references/checks/one.md");
      expect(readSkill(app, "sample-skill").files).toEqual(["references/empty.md"]);
      expect(readSkill(app, "sample-skill").body).toBe("查看附属文件");
    } finally { await server.close(); }
  });

  it("rejects traversal, links, non-text and large files without changing external files", () => {
    const app = testApp();
    saveSkill(app, { name: "sample-skill", description: "示例", body: "正文" }, "user");
    const root = join(app.libraryDir, "_skills", "sample-skill");
    const external = join(app.home, "external"); mkdirSync(external); writeFileSync(join(external, "secret.md"), "不改");
    symlinkSync(external, join(root, "linked"));
    symlinkSync(join(external, "missing"), join(root, "dangling"));
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 255, 12]));
    writeFileSync(join(root, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    for (const path of ["../external/secret.md", "/tmp/file", "a/../../file", "a\\file", "C:/file", "linked/secret.md", "dangling/new.md", ".git/config"]) {
      expect(() => readSkillFile(app, "sample-skill", path)).toThrow();
      expect(() => saveSkillFile(app, "sample-skill", path, "覆盖", true)).toThrow();
    }
    for (const path of ["binary.dat", "large.txt"]) expect(() => readSkillFile(app, "sample-skill", path)).toThrow();
    expect(readFileSync(join(external, "secret.md"), "utf8")).toBe("不改");
    expect(listSkillFiles(app, "sample-skill").some((f) => f.path.startsWith("linked"))).toBe(false);
    expect(() => saveSkill(app, { name: "sample-skill", description: "修改", body: "改", files: { "linked/secret.md": "覆盖" } })).toThrow();
    expect(readSkill(app, "sample-skill").description).toBe("示例");
  });
});
