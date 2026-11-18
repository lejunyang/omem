import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentSkillDirs, groupHub, listSkillGroups, organizeSkills, restoreAgentSkills, sweepAgentSkills, writeAgentEntries } from "../src/agents/agent-skills.ts";
import { loadSkillGroups } from "../src/agents/skill-groups.ts";
import { deleteSkill, readSkill, saveSkill, skillIndex } from "../src/agents/specs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { testApp } from "./helpers.ts";

function skill(dir: string, name: string, description: string, extra: Record<string, string> = {}) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n正文\n`);
  for (const [p, t] of Object.entries(extra)) {
    mkdirSync(join(dir, name, p, ".."), { recursive: true });
    writeFileSync(join(dir, name, p), t);
  }
}

/** A home with the folders of three agents, as tools that install skills everywhere leave them. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "omem-agent-skills-"));
  const agents = join(home, ".agents/skills");
  const claude = join(home, ".claude/skills");
  const codex = join(home, ".codex/skills");
  for (const n of ["acme-logs", "acme-db", "acme-deploy", "acme-cache"]) skill(agents, n, `Acme ${n.slice(5)} 平台：查询和操作`, { "references/cmd.md": `# ${n} 命令\n` });
  skill(agents, "solo-tool", "一个单独的工具");
  mkdirSync(claude, { recursive: true });
  for (const n of ["acme-logs", "acme-db"]) symlinkSync(join(agents, n), join(claude, n));
  skill(claude, "acme-flow", "Acme 工作流");
  // The agents' built-in skills are left alone.
  skill(join(codex, ".system"), "skill-creator", "built in");
  return { home, agents, claude, codex, env: { ...process.env, HOME: home, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", TRAE_HOME: "" } };
}

describe("taking over the agents' skill folders", () => {
  it("finds the folders of the known agents and writes to one per agent", () => {
    const app = testApp();
    const h = fakeHome();
    const dirs = agentSkillDirs(app, h.env);
    const paths = dirs.map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining([h.agents, h.claude, h.codex, join(h.home, ".trae/skills")]));
    expect(dirs.filter((d) => d.write).map((d) => d.path).sort()).toEqual([h.agents, h.claude].sort());
    expect(dirs.find((d) => d.path === h.agents)!.agents).toEqual(expect.arrayContaining(["Codex", "TraeX"]));
  });

  it("moves the skills into the library, groups them and leaves the guide and one hub per group", () => {
    const app = testApp();
    const h = fakeHome();
    const dry = sweepAgentSkills(app, { dryRun: true, env: h.env });
    expect(dry.adopted.sort()).toEqual(["acme-cache", "acme-db", "acme-deploy", "acme-flow", "acme-logs", "solo-tool"]);
    expect(existsSync(join(h.agents, "acme-db"))).toBe(true);

    const r = sweepAgentSkills(app, { env: h.env });
    expect(r.adopted).toHaveLength(6);
    expect(readSkill(app, "acme-db").files).toContain("references/cmd.md");
    const state = loadSkillGroups(app);
    expect(state.skills["acme-db"].group).toBe("acme");
    expect(state.skills["acme-flow"].group).toBe("acme");
    expect(state.skills["solo-tool"].group).toBe("other");
    // The agent folders keep only omem's entries; the built-in .system is untouched.
    expect(readdirSync(h.agents).filter((n) => !n.startsWith(".")).sort()).toEqual(["acme", "omem", "other"]);
    expect(readdirSync(h.claude).filter((n) => !n.startsWith(".")).sort()).toEqual(["acme", "omem", "other"]);
    expect(existsSync(join(h.codex, ".system/skill-creator/SKILL.md"))).toBe(true);
    const hub = readFileSync(join(h.claude, "acme/SKILL.md"), "utf8");
    expect(hub).toMatch(/^---\nname: acme\ndescription: /);
    expect(hub).toContain("acme-deploy");
    expect(existsSync(join(h.claude, "omem/SKILL.md"))).toBe(true);
    expect(r.backup && existsSync(join(r.backup, "manifest.json"))).toBeTruthy();

    // Nothing new: nothing happens.
    const again = sweepAgentSkills(app, { env: h.env });
    expect(again.adopted).toEqual([]);
    expect(again.removed).toBe(0);
    expect(again.entries!.every((e) => !e.written.length)).toBe(true);
  });

  it("takes a reinstalled newer version without losing group, purpose or switch", () => {
    const app = testApp();
    const h = fakeHome();
    sweepAgentSkills(app, { env: h.env });
    organizeSkills(app, { skills: [{ name: "acme-db", purpose: "数据库", enabled: false }, { name: "solo-tool", group: "acme", purpose: "其他工具" }] });
    skill(h.agents, "acme-db", "Acme 数据库（新版）");
    const r = sweepAgentSkills(app, { env: h.env });
    expect(r.updated).toEqual(["acme-db"]);
    expect(readSkill(app, "acme-db").description).toBe("Acme 数据库（新版）");
    const s = loadSkillGroups(app).skills["acme-db"];
    expect(s).toMatchObject({ group: "acme", purpose: "数据库", enabled: false });
    // A skill of the library's own with the same name stays as it is.
    saveSkill(app, { name: "mine", description: "我自己的", body: "x" }, "user");
    skill(h.agents, "mine", "别的工具装的");
    const c = sweepAgentSkills(app, { env: h.env });
    expect(c.conflicts).toEqual(["mine"]);
    expect(readSkill(app, "mine").description).toBe("我自己的");
    // Deleted after the takeover: installed again, it comes back off.
    deleteSkill(app, "acme-cache");
    skill(h.agents, "acme-cache", "Acme 缓存");
    sweepAgentSkills(app, { env: h.env });
    expect(loadSkillGroups(app).skills["acme-cache"].enabled).toBe(false);
  });

  it("offers a group as one entry, routes by purpose and drops what is off", async () => {
    const app = testApp();
    const h = fakeHome();
    sweepAgentSkills(app, { env: h.env });
    saveSkill(app, { name: "weekly-report", description: "写周报", body: "x" }, "user");
    organizeSkills(app, {
      skills: [{ name: "acme-logs", purpose: "日志" }, { name: "acme-db", purpose: "数据库" }, { name: "acme-cache", enabled: false }],
      groups: [{ id: "acme", title: "Acme 平台", description: "Acme 内部平台的命令行：日志、数据库、发布" }],
    });
    const index = skillIndex(app);
    expect(index).toContain("weekly-report：写周报");
    expect(index).toMatch(/- acme（技能分组「Acme 平台」，4 个技能）：Acme 内部平台的命令行/);
    expect(index).not.toContain("acme-logs：");
    expect(index).not.toContain("acme-cache");
    // A profile that names a grouped skill still gets it with its description.
    expect(skillIndex(app, ["acme-db"])).toMatch(/- acme-db：/);

    const hub = groupHub(app, "acme")!;
    expect(hub.count).toBe(4);
    expect(hub.files["SKILL.md"]).toMatch(/## 日志\n\n- acme-logs/);
    expect(hub.files["SKILL.md"]).not.toContain("acme-cache");
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: ["personal"], tools: null, actor: "agent" };
    expect((await callTool(ctx, "read_skill", { name: "acme" })).text).toContain("## 数据库");
    expect((await callTool(ctx, "read_skill", { name: "acme-db" })).text).toContain("# acme-db");
    const out = (await callTool(ctx, "list_skills", {})).text;
    expect(out).toContain("- acme（分组「Acme 平台」，启用 4/5）");
    expect(out).not.toContain("acme-db");
    expect((await callTool(ctx, "list_skills", { group: "acme" })).text).toContain("acme-cache（停用）");

    // A group switched off: its hub leaves the agent folders.
    // (takeOver stays off here: refreshing would write to the real home's folders.)
    organizeSkills(app, { groups: [{ id: "other", enabled: false }] });
    const w = writeAgentEntries(app, agentSkillDirs(app, h.env));
    expect(w.find((e) => e.dir === h.claude)!.removed).toEqual(["other"]);
    expect(existsSync(join(h.claude, "other"))).toBe(false);
    expect(listSkillGroups(app).find((g) => g.id === "other")!.enabled).toBe(false);
    expect(() => organizeSkills(app, { skills: [{ name: "acme-db", group: "weekly-report" }] })).toThrow(/同名/);
  });

  it("puts everything back on restore", () => {
    const app = testApp();
    const h = fakeHome();
    sweepAgentSkills(app, { env: h.env });
    // restore reads the folders from the real environment; point it at the fake home.
    const prev = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TRAE_HOME: process.env.TRAE_HOME };
    Object.assign(process.env, { HOME: h.home, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", TRAE_HOME: "" });
    try {
      const r = restoreAgentSkills(app);
      expect(r.kept).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    expect(readdirSync(h.agents).sort()).toEqual(["acme-cache", "acme-db", "acme-deploy", "acme-logs", "solo-tool"]);
    expect(lstatSync(join(h.claude, "acme-db")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(h.claude, "acme-flow/SKILL.md"))).toBe(true);
    expect(existsSync(join(h.claude, "omem"))).toBe(false);
  });
});
