import { describe, expect, it } from "vitest";
import { checkPath, defaultLabel, fmtBytes, fullAccessNote, grantLinks, hiddenLabel, kindOptions, layerRows, sandboxBody, splitDefaults, tilde } from "../web/src/lib/sandbox.ts";
import { commandSummary, draftOf, parseCommand } from "../web/src/lib/protected-commands.ts";

const home = "/home/xiaowang";
const data = `${home}/.omem`;

describe("the owner's sandbox (web/src/lib/sandbox.ts)", () => {
  it("writes paths under the server's home directory with ~", () => {
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
  it("links what has 完全访问 on by itself to where it is changed", () => {
    expect(grantLinks(undefined)).toEqual([]);
    expect(grantLinks({ roles: [{ id: "assistant", name: "主助手" }], profiles: [{ id: "inspect", name: "inspect" }], rules: [{ id: "r1", name: "夜里整理" }] })).toEqual([
      { kind: "内置角色", id: "assistant", name: "assistant", title: "主助手", to: { path: "/agents", query: { role: "assistant" } } },
      { kind: "Agent 档案", id: "inspect", name: "inspect", title: "inspect", to: { path: "/agents", query: { name: "inspect" } } },
      { kind: "规则", id: "r1", name: "夜里整理", title: "夜里整理", to: { path: "/rules", query: { id: "r1" } } },
    ]);
  });
  it("says when 进了沙箱的都开 changes nothing", () => {
    expect(fullAccessNote({ mode: "off", fullAccess: "sandboxed", support: { ok: true } })).toContain("等于按角色");
    expect(fullAccessNote({ mode: "prefer", fullAccess: "sandboxed", support: { ok: false } })).toContain("这台");
    expect(fullAccessNote({ mode: "prefer", fullAccess: "sandboxed", support: { ok: true } })).toBe("");
    expect(fullAccessNote({ mode: "off", fullAccess: "per-role", support: { ok: true } })).toBe("");
  });

  it("names the default hidden entries and lists run kinds with saved unknown ones last", () => {
    expect(hiddenLabel(data, data)).toBe("omem 的数据目录");
    expect(hiddenLabel(`${home}/.config/acme-cli`, data)).toBe("插件命令的登录");
    const opts = kindOptions({ "thread-summary": "会话摘要", ask: "问答" }, ["ask", "new-kind"]);
    expect(opts.map((o) => o.value)).toEqual(["thread-summary", "ask", "new-kind"]);
    expect(opts[0]).toEqual({ value: "thread-summary", label: "会话摘要", hint: "thread-summary" });
    expect(opts[2]).toEqual({ value: "new-kind", label: "new-kind" });
    expect(kindOptions({ ask: "问答" }, ["toString"]).map((o) => o.value)).toEqual(["ask", "toString"]);
  });
  it("lists the HOME layers largest first, the owner as 你 and a member by name", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(layerRows([{ identity: "owner", bytes: 2048 }, { identity: "u1", bytes: 4 * 1024 * 1024 }, { identity: "u9", bytes: 10 }], { u1: "小王" }))
      .toEqual([{ identity: "u1", name: "小王", size: "4.0 MB" }, { identity: "owner", name: "你", size: "2.0 KB" }, { identity: "u9", name: "u9", size: "10 B" }]);
    expect(layerRows(undefined, {})).toEqual([]);
  });
});

describe("commands the owner registers (web/src/lib/protected-commands.ts)", () => {
  const sample = { name: "sample-cli", state: [".config/sample"], loginEnv: ["SAMPLE_TOKEN"] };
  it("turns the form into what the server takes: ~/ taken off, words split, duplicates dropped", () => {
    expect(parseCommand({ name: " sample-cli ", state: "~/.config/sample\n~/.config/sample/\n.sample", loginEnv: "SAMPLE_TOKEN，SAMPLE_TOKEN SAMPLE_API_KEY" }, []))
      .toEqual({ command: { name: "sample-cli", state: [".config/sample", ".sample"], loginEnv: ["SAMPLE_TOKEN", "SAMPLE_API_KEY"] } });
    expect(parseCommand(draftOf(sample), [])).toEqual({ command: sample });
    expect(draftOf()).toEqual({ name: "", state: "", loginEnv: "" });
  });
  it("refuses what the server would refuse, in words", () => {
    const err = (d: Partial<ReturnType<typeof draftOf>>, others = [] as typeof sample[]) => {
      const r = parseCommand({ ...draftOf(), name: "tool", ...d }, others);
      return "error" in r ? r.error : "";
    };
    expect(err({ name: "/usr/bin/tool" })).toMatch(/程序名/);
    expect(err({ name: "sample-cli" }, [sample])).toMatch(/已经登记/);
    expect(err({ state: "/etc/tool" })).toMatch(/主目录下/);
    expect(err({ state: "~/../x" })).toMatch(/主目录下/);
    expect(err({ state: "~" })).toMatch(/主目录下/);
    expect(err({ loginEnv: "TOOL-TOKEN" })).toMatch(/只写名字/);
    expect(err({ loginEnv: "OMEM_TOKEN" })).toMatch(/omem 自己/);
  });
  it("says where a command's login lives", () => {
    expect(commandSummary(sample)).toBe("登录目录 ~/.config/sample · 变量 SAMPLE_TOKEN");
    expect(commandSummary({ name: "x", state: [], loginEnv: [] })).toMatch(/执行器/);
  });
});
