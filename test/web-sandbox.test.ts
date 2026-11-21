import { describe, expect, it } from "vitest";
import { checkPath, defaultLabel, fullAccessNote, homeOf, sandboxBody, splitDefaults, tilde } from "../web/src/lib/sandbox.ts";

const home = "/home/xiaowang";
const data = `${home}/.omem`;

describe("the owner's sandbox (web/src/lib/sandbox.ts)", () => {
  it("reads the home directory off the paths and writes paths under it with ~", () => {
    expect(homeOf([`${home}/.cache`, `${home}/.npm`, "/tmp", "/home/other/x"])).toBe(home);
    expect(homeOf(["/tmp"])).toBeNull();
    expect(tilde(`${home}/work/tools`, home)).toBe("~/work/tools");
    expect(tilde(home, home)).toBe("~");
    expect(tilde("/home/xiaowangzi/x", home)).toBe("/home/xiaowangzi/x");
    expect(tilde("/srv/x", null)).toBe("/srv/x");
  });
  it("names the example run's own folders and keeps the backends' state apart", () => {
    expect(defaultLabel(`${data}/runs/example/scratch`, data, home).text).toBe("这次运行的临时目录");
    expect(defaultLabel(`${data}/workspaces/example/1`, data, home).text).toBe("这次运行的工作目录");
    expect(defaultLabel(`${home}/.cache`, data, home)).toEqual({ text: "~/.cache" });
    const split = splitDefaults({
      writable: [`${home}/work/tools`],
      backends: [{ id: "codex", state: [`${home}/.codex`] }, { id: "doubao", state: [] }],
      defaults: { writable: [`${home}/.codex`, `${home}/.cache`, `${home}/work/tools`, "/tmp"], hidden: [data] },
    });
    expect(split.common).toEqual([`${home}/.cache`, "/tmp"]);
    expect(split.backends.map((b) => b.id)).toEqual(["codex"]);
  });
  it("checks a directory before it is sent and sends confirmAll only for 全部开", () => {
    expect(checkPath(" ~/work/tools/ ", [], home)).toEqual({ value: "~/work/tools" });
    expect(checkPath("work/tools", [], home)).toHaveProperty("error");
    expect(checkPath("", [], home)).toHaveProperty("error");
    expect(checkPath("~/work/tools", [`${home}/work/tools`], home)).toEqual({ error: "已经在清单里" });
    expect(checkPath("/x", Array.from({ length: 32 }, (_, i) => `/d${i}`), home)).toEqual({ error: "最多 32 个" });
    const s = { mode: "prefer" as const, writable: ["/a"], hidden: [], fullAccess: "per-role" as const };
    expect(sandboxBody(s, { writable: ["/a", "/b"] })).toEqual({ mode: "prefer", writable: ["/a", "/b"], hidden: [], fullAccess: "per-role" });
    expect(sandboxBody(s, { fullAccess: "all" })).toMatchObject({ fullAccess: "all", confirmAll: true });
    expect(sandboxBody({ ...s, fullAccess: "all" }, { mode: "off" })).toMatchObject({ mode: "off", confirmAll: true });
  });
  it("says when 进了沙箱的都开 changes nothing", () => {
    expect(fullAccessNote({ mode: "off", fullAccess: "sandboxed", support: { ok: true } })).toContain("等于按角色");
    expect(fullAccessNote({ mode: "prefer", fullAccess: "sandboxed", support: { ok: false } })).toContain("这台");
    expect(fullAccessNote({ mode: "prefer", fullAccess: "sandboxed", support: { ok: true } })).toBe("");
    expect(fullAccessNote({ mode: "off", fullAccess: "per-role", support: { ok: true } })).toBe("");
  });
});
