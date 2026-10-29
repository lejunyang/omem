import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSkills, readSkill, saveSkill, seedBuiltinSkills } from "../src/agents/specs.ts";
import { agentPathDirs, desktopControl, installOptions, installSpec, installTool, toolCommand, toolStatus, withAgentPath } from "../src/core/tools.ts";
import { summarizeProbe } from "../src/setup.ts";
import { testApp } from "./helpers.ts";

const win = process.platform === "win32";
const root = join(import.meta.dirname, "..");

describe("desktop-control skill", () => {
  it("ships with references and reaches an install that already has other skills, without touching edited ones", () => {
    const app = testApp();
    saveSkill(app, { name: "lark-messaging", description: "owner edited", body: "我改过的内容" }, "user");
    const added = seedBuiltinSkills(app, root);
    expect(added).toContain("desktop-control");
    expect(added).not.toContain("lark-messaging");
    expect(readSkill(app, "lark-messaging").body).toBe("我改过的内容");
    const s = readSkill(app, "desktop-control");
    expect(s.files).toContain("references/aad.md");
    expect(s.description).toMatch(/aad/);
    expect(s.body).toMatch(/aad apps/);
    expect(listSkills(app).map((x) => x.name)).toContain("desktop-control");
    // The owner edits it; the next start leaves it alone.
    saveSkill(app, { name: "desktop-control", description: s.description, body: "改过" }, "user");
    expect(seedBuiltinSkills(app, root)).toEqual([]);
    expect(readSkill(app, "desktop-control").body).toBe("改过");
  });

  it("only teaches commands the aad CLI has, and keeps the safety rules", () => {
    const text = readFileSync(join(root, "skills/library/desktop-control/SKILL.md"), "utf8");
    for (const c of ["aad apps", "aad describe", "aad find", "aad do click", "aad do fill", "aad capture", "aad probe"]) expect(text).toContain(c);
    expect(text).toMatch(/不输入凭据/);
    expect(text).toMatch(/不是指令/);
    expect(text).not.toMatch(/--fraction|x=\d|坐标点击/);
  });
});

describe("aad install", () => {
  it("installs the GitHub release through osdk; Linux picks the static musl archive", () => {
    expect(installSpec("aad")).toBe("github:lejunyang/ai-auto-desktop");
    expect(installOptions("aad", "win32", "x64")).toEqual([]);
    expect(installOptions("aad", "darwin", "arm64")).toEqual([]);
    expect(installOptions("aad", "linux", "x64")).toEqual(["-o", "asset-template=aad-{version}-x86_64-unknown-linux-musl.tar.gz"]);
    expect(installOptions("aad", "linux", "arm64")).toEqual(["-o", "asset-template=aad-{version}-aarch64-unknown-linux-musl.tar.gz"]);
    expect(installOptions("uv", "linux", "x64")).toEqual([]);
  });

  it("reads probe output into one line and the things that are not fully available", () => {
    const probe = { summary: { available: 5, degraded: 1, unavailable: 1 }, checks: { "windows.uia": { state: "available", summary: "ok" }, "windows.dpi": { state: "degraded", summary: "DPI 未感知" }, "windows.input_desktop": { state: "unavailable", summary: "没有输入桌面" } } };
    expect(summarizeProbe(probe)).toEqual({ line: "可用 5、降级 1、不可用 1", notes: ["windows.dpi（degraded）：DPI 未感知", "windows.input_desktop（unavailable）：没有输入桌面"] });
    expect(summarizeProbe({ nope: 1 })).toBeNull();
  });
});

// A fake osdk and a fake aad on PATH: `osdk install` lays out an install directory like the real one,
// `osdk where` does not know the package (as for an install made with options), and an unselected-tool
// shim for aad sits earlier on PATH and fails the way osdk's does.
describe("finding an osdk-installed aad", () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-aad-"));
  const bin = join(dir, "bin");
  const shims = join(dir, "shims");
  const installs = join(dir, "installs");
  const log = join(dir, "osdk.log");
  const savedPath = process.env.PATH;
  const exe = (name: string) => name + (win ? ".exe" : "");

  beforeAll(() => {
    for (const d of [bin, shims]) mkdirSync(d, { recursive: true });
    const script = `import { appendFileSync, mkdirSync, linkSync, copyFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "doctor") console.log("  install_dir  : " + ${JSON.stringify(installs)});
else if (args[0] === "where") process.exit(1);
else if (args[0] === "install") {
  const d = join(${JSON.stringify(installs)}, "github", "lejunyang", "ai-auto-desktop", "0.0.2", "key1");
  mkdirSync(d, { recursive: true });
  const to = join(d, ${JSON.stringify(exe("aad"))});
  try { linkSync(process.execPath, to); } catch { copyFileSync(process.execPath, to); }
} else process.exit(1);
`;
    writeFileSync(join(bin, "osdk.mjs"), script);
    if (win) writeFileSync(join(bin, "osdk.cmd"), `@node "%~dp0osdk.mjs" %*\r\n`);
    else {
      writeFileSync(join(bin, "osdk"), `#!/bin/sh\nexec node "$(dirname "$0")/osdk.mjs" "$@"\n`);
      chmodSync(join(bin, "osdk"), 0o755);
    }
    if (win) writeFileSync(join(shims, "aad.cmd"), "@echo osdk-shim: no backend provides aad 1>&2\r\n@exit /b 1\r\n");
    else {
      writeFileSync(join(shims, "aad"), "#!/bin/sh\necho 'osdk-shim: no backend provides aad' >&2\nexit 1\n");
      chmodSync(join(shims, "aad"), 0o755);
    }
    process.env.PATH = [shims, bin, dirname(process.execPath)].join(delimiter);
  });
  afterAll(() => {
    process.env.PATH = savedPath;
  });

  it("is not fooled by a shim for a tool osdk has not selected, installs, then runs the managed copy", () => {
    expect(toolCommand("aad")).toBeNull();
    expect(toolStatus("aad")).toEqual({ installed: false, version: null, via: null });
    expect(agentPathDirs()).toEqual([]);

    expect(installTool("aad")).toBe(true);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const install = calls.find((c) => c[0] === "install")!;
    expect(install.slice(0, 2)).toEqual(["install", "github:lejunyang/ai-auto-desktop"]);
    expect(install.slice(2)).toEqual(installOptions("aad"));

    const cmd = toolCommand("aad")!;
    expect(cmd).toHaveLength(1);
    expect(cmd[0]).toBe(join(installs, "github", "lejunyang", "ai-auto-desktop", "0.0.2", "key1", exe("aad")));
    expect(existsSync(cmd[0])).toBe(true);
    const st = desktopControl.status();
    expect(st).toMatchObject({ installed: true, via: "osdk" });
    expect(st.version).toBe(process.versions.node);

    // Agent processes get that directory ahead of the failing shim, whatever case PATH is spelled in.
    const dirs = agentPathDirs();
    expect(dirs).toEqual([dirname(cmd[0])]);
    const env = withAgentPath({ [win ? "Path" : "PATH"]: process.env.PATH });
    const key = win ? "Path" : "PATH";
    expect(Object.keys(env)).toEqual([key]);
    expect(env[key]!.split(delimiter)[0]).toBe(dirs[0]);
    expect(env[key]!.split(delimiter)).toContain(shims);
    // A guest run (someone who is not a user) does not get it.
    const guest = withAgentPath({ [key]: process.env.PATH, OMEM_DESKTOP_TOOLS: "off" });
    expect(guest[key]!.split(delimiter)).not.toContain(dirs[0]);
  });
});
