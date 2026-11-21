import { describe, expect, it } from "vitest";
import { anyVisible, cardAccess, keyAccess, saveRefusal, sectionOfKey, type SettingsSections } from "../web/src/lib/settings-access.ts";
import { followMe, setSettingsSections, settingsAnywhere, settingsArea, settingsCard, settingsKey, type Me } from "../web/src/lib/caps.ts";
import { kindAllowed, outletMeta, outletSettings, withOutlet, type Outlet } from "../web/src/lib/outlets.ts";
import { egressSettings, inspectDomain, runSummary } from "../web/src/lib/egress.ts";
import { probeState } from "../web/src/lib/cloud-tools.ts";
import { routineText } from "../web/src/lib/routine.ts";

const sections: SettingsSections = {
  keys: { notify: "assistant", mentions: "assistant", agents: "ai", "agents.progress": "assistant", "agents.accounts": "members", auth: "members", lark: "channels", "lark.guests": "assistant" },
  ownerOnly: ["mentions.reply", "lark.guests", "auth", "agents.accounts"],
  sections: { assistant: { view: true, edit: false }, members: { view: true, edit: true }, ai: { view: false, edit: false } },
};

describe("settings by area (web/src/lib/settings-access.ts)", () => {
  it("finds the most specific area of a key", () => {
    expect(sectionOfKey(sections, "agents.progress")).toBe("assistant");
    expect(sectionOfKey(sections, "agents.default")).toBe("ai");
    expect(sectionOfKey(sections, "lark.guests.spaces")).toBe("assistant");
    expect(sectionOfKey(sections, "nothing")).toBeNull();
  });
  it("lets the owner do everything and others what their area and the owner-only list allow", () => {
    expect(keyAccess(sections, "agents.default", true)).toEqual({ view: true, edit: true, ownerOnly: false });
    expect(keyAccess(sections, "notify", false)).toEqual({ view: true, edit: false, ownerOnly: false });
    expect(keyAccess(sections, "agents.default", false).view).toBe(false);
    expect(keyAccess(sections, "auth", false)).toEqual({ view: true, edit: false, ownerOnly: true });
    expect(keyAccess(sections, "mentions.reply.lark", false).ownerOnly).toBe(true);
    expect(keyAccess(null, "notify", false).view).toBe(false);
  });
  it("shows a card when any key may be seen and lets it change only when every seen key may change", () => {
    expect(cardAccess(sections, ["agents.default", "agents.progress"], false)).toMatchObject({ view: true, edit: false });
    expect(cardAccess({ ...sections, sections: { ...sections.sections, assistant: { view: true, edit: true } } }, ["agents.default", "agents.progress"], false).edit).toBe(true);
    expect(cardAccess(sections, ["agents.default"], false).view).toBe(false);
    expect(cardAccess(sections, ["auth"], false)).toMatchObject({ edit: false, ownerOnly: true });
    expect(anyVisible(sections, ["agents.default", "notify"], false)).toBe(true);
  });
  it("turns a refused save into a sentence about whose it is", () => {
    expect(saveRefusal("没有修改设置 auth 的权限", sections, "老陈")).toBe("没有保存：这一项只有老陈能改（auth）");
    expect(saveRefusal("没有修改设置 notify 的权限", sections, "老陈")).toContain("“助手”区域");
    expect(saveRefusal("别的错", sections, "老陈")).toBe("别的错");
  });
});

describe("settings checks in lib/caps.ts", () => {
  const member = (extra: Partial<Me> = {}): Me => ({ role: "member", perms: [], spaces: [], caps: [], ...extra });
  it("reads the loaded areas, then /api/me's capabilities, then the old permissions", () => {
    let me: Me | null = member();
    followMe(() => me);
    setSettingsSections(sections);
    expect(settingsArea("assistant", "view")).toBe(true);
    expect(settingsArea("assistant", "edit")).toBe(false);
    expect(settingsKey("notify")).toMatchObject({ view: true, edit: false });
    expect(settingsCard(["auth"])).toMatchObject({ view: true, edit: false, ownerOnly: true });
    setSettingsSections(null);
    me = member({ caps: ["settings.ai.view"] });
    expect(settingsArea("ai", "view")).toBe(true);
    expect(settingsArea("assistant", "view")).toBe(false);
    me = { role: "admin", perms: ["users.manage"], spaces: [] };
    expect(settingsArea("members", "view")).toBe(true);
    expect(settingsAnywhere()).toBe(true);
    expect(settingsKey("notify").view).toBe(false);
    me = { role: "owner", perms: [], spaces: null };
    expect(settingsCard(["auth"]).edit).toBe(true);
    followMe(() => null);
  });
});

describe("notification outlets (web/src/lib/outlets.ts)", () => {
  const plugin: Outlet = { id: "notice:file", name: "本地文件", plugin: "notice", builtin: false, supportsAsk: true, reachable: { ok: true }, setting: null, lastDelivery: null };
  const web: Outlet = { id: "web", name: "网页", plugin: null, builtin: true, supportsAsk: true, reachable: { ok: true }, setting: null, lastDelivery: null };
  it("turns an outlet on with a first setting and sends back only plugin outlets that are on", () => {
    const on = withOutlet([web, plugin], "notice:file", { on: true });
    expect(on[1].setting).toEqual({ id: "notice:file", minUrgency: "normal", askKinds: ["question"] });
    expect(outletSettings(withOutlet(on, "notice:file", { minUrgency: "urgent" }))).toEqual([{ id: "notice:file", minUrgency: "urgent", askKinds: ["question"] }]);
    expect(outletSettings(withOutlet(on, "notice:file", { on: false }))).toEqual([]);
    expect(withOutlet([web], "web", { on: true })[0].setting).toBeNull();
  });
  it("offers approvals to the owner, and to others only once opened for the outlet", () => {
    expect(kindAllowed(plugin, "question", false)).toBe(true);
    expect(kindAllowed(plugin, "approval", false)).toBe(false);
    expect(kindAllowed(plugin, "approval", true)).toBe(true);
    expect(kindAllowed({ ...plugin, setting: { id: plugin.id, minUrgency: "later", askKinds: ["approval"] } }, "approval", false)).toBe(true);
  });
  it("says where an outlet comes from and when it last delivered", () => {
    expect(outletMeta(plugin, () => "")).toBe("插件 notice · 还没投递过");
    expect(outletMeta({ ...web, lastDelivery: "2026-11-21T01:00:00Z" }, () => "3 分钟前")).toBe("内置 · 上次投递 3 分钟前");
  });
});

describe("egress, cloud tools and the routine", () => {
  it("keeps only the fields the egress interface takes and checks a domain for the decrypting list", () => {
    expect(Object.keys(egressSettings({ mode: "off", default: "allow", tunnelWhenUnsure: "deny", inspect: [], waitSeconds: 90, ...{ runs: [] } } as never))).toEqual(["mode", "default", "tunnelWhenUnsure", "inspect", "waitSeconds"]);
    expect(inspectDomain(" https://API.example.com/v1 ", [])).toEqual({ value: "api.example.com" });
    expect(inspectDomain("*.example.com", [])).toEqual({ value: "*.example.com" });
    expect(inspectDomain("not a domain", [])).toHaveProperty("error");
    expect(inspectDomain("a.example.com", ["a.example.com"])).toHaveProperty("error");
    expect(runSummary([{ host: "a", count: 3, bytes: 0, denied: 1, backend: false }, { host: "b", count: 2, bytes: 0, denied: 0, backend: true }]).text).toBe("2 个主机 · 5 次 · 拒绝 1");
  });
  it("reads a cloud backend's probe", () => {
    const p = { id: "x", url: "https://omem.example.com", at: "", mode: "header" as const, reason: "", confirmed: false };
    expect(probeState(null, null).text).toBe("还没探测");
    expect(probeState(p, p.url)).toMatchObject({ tone: "warn", confirm: true });
    expect(probeState({ ...p, confirmed: true }, p.url)).toMatchObject({ tone: "ok", confirm: false });
    expect(probeState(p, "https://other.example.com").confirm).toBe(false);
    expect(probeState({ ...p, mode: false }, p.url).text).toBe("探测没通过");
  });
  it("says whose account the routine runs on", () => {
    expect(routineText({ on: false, ready: false, reason: null }, "小林")).toBe("打开后每晚的整理用小林自己的 AI 账号跑");
    expect(routineText({ on: true, ready: false, reason: "还没有登录自己的 AI 账号" })).toBe("开着，但现在不会跑：还没有登录自己的 AI 账号");
  });
});
