import { describe, expect, it } from "vitest";
import { ownerCalled, ownerWord } from "../web/src/lib/owner-name.ts";
import { kindAllowed, type Outlet } from "../web/src/lib/outlets.ts";
import { toolOptions } from "../web/src/lib/cloud-tools.ts";
import { runName } from "../web/src/lib/run-titles.ts";
import { httpPlaces } from "../web/src/lib/rule-places.ts";
import { originText } from "../web/src/lib/work.ts";

describe("the fields the server now sends", () => {
  it("names the owner from /api/me, “主人” without it, and “你” to the owner", () => {
    expect(ownerCalled({ role: "member", ownerName: "老陈" })).toBe("老陈");
    expect(ownerCalled({ role: "member" })).toBe("主人");
    expect(ownerWord({ role: "owner", ownerName: "老陈" })).toBe("你");
    expect(ownerWord({ role: "member", ownerName: "老陈" })).toBe("老陈");
    expect(originText("owner", "老陈")).toBe("老陈定的");
    expect(originText("owner")).toBe("你定的");
    expect(originText("flow", "老陈")).toBe("流程");
  });
  it("lets a member tick approvals only where the owner opened them", () => {
    const o: Outlet = { id: "pager:phone", name: "手机", plugin: "pager", builtin: false, supportsAsk: true, reachable: { ok: true }, setting: { id: "pager:phone", minUrgency: "normal", askKinds: [] }, lastDelivery: null, grantedAskKinds: ["approval"] };
    expect(kindAllowed(o, "approval", false)).toBe(true);
    expect(kindAllowed({ ...o, grantedAskKinds: [], setting: { ...o.setting!, askKinds: ["approval"] } }, "approval", false)).toBe(false);
  });
  it("offers the cloud tools the server lists, by what they do", () => {
    expect(toolOptions({ tools: ["search"], availableTools: [{ name: "search", description: "在知识库中检索：原件片段、Wiki 页面。" }, { name: "read_page", description: "读取 Wiki 页面全文，以及反向链接。" }] }))
      .toEqual([{ value: "search", label: "在知识库中检索", hint: "search" }, { value: "read_page", label: "读取 Wiki 页面全文", hint: "read_page" }]);
    expect(toolOptions({ tools: ["search"] })).toEqual([{ value: "search", label: "search" }]);
    expect(runName({ runId: "r1", title: "整理退款口径" })).toBe("整理退款口径");
    expect(runName({ runId: "r1" })).toBe("运行");
    expect(runName({ runId: null })).toBe("不属于某个运行");
  });
  it("says where HTTP rules act on this machine", () => {
    expect(httpPlaces(["browser", "egress"])).toMatch(/^在两处生效/);
    expect(httpPlaces(["egress"])).toContain("没有装 aad");
    expect(httpPlaces(["browser"])).toContain("出网代理用不了");
    expect(httpPlaces([])).toContain("没有地方执行");
  });
});
