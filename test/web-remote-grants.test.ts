import { describe, expect, it } from "vitest";
import { endedMessage, expiryLabel, grantCandidates, modesFor } from "../web/src/lib/remote-grants.ts";

describe("handing a remote session to a member (web/src/lib/remote-grants.ts)", () => {
  it("offers only active members with a remote capability, not yet given this session", () => {
    const users = [
      { id: "owner", name: "本人", role: "owner" },
      { id: "a", name: "小周", role: "observer" },
      { id: "b", name: "小林", role: "member" },
      { id: "c", name: "小吴", role: "member" },
      { id: "d", name: "小陈", role: "member", disabledAt: "2026-11-01T00:00:00Z" },
      { id: "e", name: "小赵", role: "member" },
    ];
    const caps = { a: ["remote.view"], b: ["remote.view", "remote.operate"], c: [], d: ["remote.view"], e: ["remote.view"] };
    expect(grantCandidates(users, caps, { sessionOwner: "owner", granted: ["e"] })).toEqual([
      { id: "a", name: "小周", view: true, operate: false },
      { id: "b", name: "小林", view: true, operate: true },
    ]);
    expect(modesFor({ view: true, operate: false })).toEqual(["view"]);
    expect(modesFor({ view: true, operate: true })).toEqual(["view", "operate"]);
    expect(modesFor(null)).toEqual(["view"]);
  });

  it("says how long a grant still lasts", () => {
    const now = new Date(2026, 10, 21, 18, 0).getTime();
    expect(expiryLabel(new Date(2026, 10, 21, 18, 25).toISOString(), now)).toBe("还剩 25 分钟");
    expect(expiryLabel(new Date(2026, 10, 21, 20, 30).toISOString(), now)).toBe("到今天 20:30");
    expect(expiryLabel(new Date(2026, 10, 22, 9, 0).toISOString(), now)).toBe("到明天 09:00");
    expect(expiryLabel(new Date(2026, 10, 24, 9, 0).toISOString(), now)).toBe("到 11 月 24 日 09:00");
    expect(expiryLabel(new Date(2026, 10, 21, 17, 0).toISOString(), now)).toBe("已到期");
  });

  it("tells an expired grant from one taken back", () => {
    const now = Date.parse("2026-11-21T10:00:00Z");
    expect(endedMessage({ expiresAt: "2026-11-21T09:59:59Z" }, "本人", now)).toBe("授权到期了");
    expect(endedMessage({ expiresAt: "2026-11-21T12:00:00Z" }, "本人", now)).toBe("本人收回了这次授权");
    expect(endedMessage({ expiresAt: "2026-11-21T12:00:00Z" }, null, now)).toBe("会话的主人收回了这次授权");
  });
});
