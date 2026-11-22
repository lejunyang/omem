import { describe, expect, it } from "vitest";
import {
  canCancel, coverage, credAnchor, expiryText, lendCandidates, lendingNote, lentTo, needsAction, overviewLines, settled, sharingBody, sharingSaved, sharingText, stateLabel, stateTone, suppliedBy,
  type CredentialOverview,
} from "../web/src/lib/credentials.ts";

const now = Date.UTC(2026, 10, 22, 8);
const H = 3600_000, D = 24 * H;

describe("credentials on the account and members pages (web/src/lib/credentials.ts)", () => {
  it("says when a login ends, and nothing without a login or an end", () => {
    expect(expiryText({ state: "ok", expiresAt: now + 6 * D }, now)).toBe("6 天后到期");
    expect(expiryText({ state: "expiring", expiresAt: now + 5 * H }, now)).toBe("5 小时后到期");
    expect(expiryText({ state: "expired", expiresAt: now - 3 * H }, now)).toBe("3 小时前过期");
    expect(expiryText({ state: "ok" }, now)).toBe("");
    expect(expiryText({ state: "none", expiresAt: now + D }, now)).toBe("");
    expect(expiryText({ state: "logging-in", expiresAt: now + D }, now)).toBe("");
  });
  it("distinguishes an unknown machine login from one confirmed missing on both pages", () => {
    expect(stateLabel({ machine: true, state: "unknown" })).toBe("状态未知");
    expect(stateLabel({ machine: true, state: "none" })).toBe("没登录（已停止出借）");
    expect(stateLabel({ machine: true, state: "expired" })).toBe("过期");
    expect(stateLabel({ machine: false, state: "none" })).toBe("没登录");
  });
  it("colours by state and marks only a required one not logged in, not the machine's own", () => {
    expect([stateTone("ok"), stateTone("expiring"), stateTone("expired"), stateTone("logging-in"), stateTone("none")]).toEqual(["ok", "warn", "danger", "accent", "muted"]);
    expect(needsAction({ required: true, state: "none", machine: false })).toBe(true);
    expect(needsAction({ required: true, state: "expired", machine: false })).toBe(true);
    expect(needsAction({ required: true, state: "expiring", machine: false })).toBe(false);
    expect(needsAction({ required: false, state: "none", machine: false })).toBe(false);
    expect(needsAction({ required: true, state: "none", machine: true })).toBe(false);
  });
  it("writes who may borrow it and sends members only with 指定成员, each once", () => {
    const name = (id: string) => ({ a: "小王", b: "小李" })[id] ?? id;
    expect(sharingText({ scope: "self", members: [] })).toBe("只给自己");
    expect(sharingText({ scope: "all", members: [] })).toBe("所有成员");
    expect(sharingText({ scope: "members", members: ["a", "b"] }, name)).toBe("小王、小李");
    expect(sharingText({ scope: "members", members: [] })).toBe("还没选人");
    expect(sharingBody("all", ["a"])).toEqual({ scope: "all", members: [] });
    expect(sharingBody("members", ["a", "a", "b"])).toEqual({ scope: "members", members: ["a", "b"] });
    expect(sharingSaved({ scope: "members", members: [] })).toContain("谁也借不到");
    expect(sharingSaved({ scope: "members", members: ["a"] }, name)).toBe("已保存：小王能借");
    expect([lentTo({ scope: "self", members: [] }), lentTo({ scope: "all", members: [] }), lentTo({ scope: "members", members: ["a", "b"] }, name), lentTo({ scope: "members", members: [] })])
      .toEqual(["不借出", "借给所有成员", "借给 小王、小李", "指定成员，还没选人"]);
  });
  it("offers to lend to active people other than oneself and the owner, by name", () => {
    const users = [
      { id: "owner", name: "本人", role: "owner" },
      { id: "b", name: "小李", role: "member" },
      { id: "a", name: "小王", role: "member" },
      { id: "c", name: "小陈", role: "member", disabledAt: "2026-11-01T00:00:00Z" },
      { id: "d", name: "小赵", role: "member", status: "pending" },
      { id: "e", name: "小周", role: "observer" },
    ];
    expect(lendCandidates(users, "a").map((o) => o.value)).toEqual(["b", "e"]);
    expect(lendCandidates(users, "owner").map((o) => o.label)).toEqual(["小李", "小王", "小周"].sort((x, y) => x.localeCompare(y, "zh")));
  });
  it("finds the credential that supplies a backend: the one that logged it in, else one covering it that was logged in", () => {
    const list = [
      { kind: "kit:corp", backends: ["echo", "other"], state: "expired" as const },
      { kind: "kit:repo", backends: ["echo"], state: "ok" as const },
      { kind: "kit:unknown", backends: ["solo"], state: "unknown" as const },
      { kind: "kit:none", backends: ["solo"], state: "none" as const },
    ];
    expect(suppliedBy({ id: "echo", method: "kit:repo" }, list)?.kind).toBe("kit:repo");
    expect(suppliedBy({ id: "other" }, list)?.kind).toBe("kit:corp");
    expect(suppliedBy({ id: "solo", method: "native" }, list)).toBeNull();
    expect(suppliedBy({ id: "claude" }, list)).toBeNull();
  });
  it("names what it covers, and offers 取消 only for a first login (DELETE would end an earlier one)", () => {
    expect(coverage({ backends: ["echo"], commands: ["acme"] }, (id) => (id === "echo" ? "回声" : id))).toEqual({ backends: ["回声"], commands: ["acme"], count: 2 });
    expect(canCancel({ state: "logging-in" })).toBe(true);
    expect(canCancel({ state: "logging-in", user: "ann" })).toBe(false);
    expect(canCancel({ state: "logging-in", expiresAt: now })).toBe(false);
    expect(canCancel({ state: "ok" })).toBe(false);
  });
  it("reports the logins that finished between two reads", () => {
    const before = [{ kind: "k:a", state: "logging-in" as const }, { kind: "k:b", state: "logging-in" as const }, { kind: "k:c", state: "none" as const }];
    const after = [{ kind: "k:a", state: "ok" as const, name: "A" }, { kind: "k:b", state: "expired" as const, name: "B", error: "授权或供给失败，请重新登录" }, { kind: "k:c", state: "ok" as const, name: "C" }];
    expect(settled(before, after)).toEqual([{ kind: "k:a", name: "A", ok: true, error: undefined }, { kind: "k:b", name: "B", ok: false, error: "授权或供给失败，请重新登录" }]);
  });
  it("says what the lending mode means to a holder, and makes an id-safe anchor", () => {
    expect(lendingNote("off")).toBe("管理员关了出借");
    expect(lendingNote("confirm")).toBe("别人要用时会先问你");
    expect(lendingNote("auto")).toBe("");
    expect(lendingNote(undefined)).toBe("");
    expect(credAnchor("acmeauth:demo")).toBe("cred-acmeauth-demo");
  });
  it("lists the overview with the people who need a look first, a name searched for", () => {
    const view = (kind: string, state: "ok" | "expiring" | "expired" | "none") => ({ kind, plugin: "kit", name: kind, describe: "", required: false, state, sharing: { scope: "self" as const, members: [] }, backends: [], commands: [], login: true, machine: false, missingInstall: [] });
    const o: CredentialOverview = { kinds: [{ kind: "k:a", name: "A" }, { kind: "k:b", name: "B" }], limit: 2000, people: [
      { userId: "wu", name: "小吴", credentials: [view("k:a", "ok")] },
      { userId: "owner", name: "本人", credentials: [{ ...view("k:a", "ok"), machine: true }] },
      { userId: "lin", name: "小林", credentials: [view("k:a", "expiring"), view("k:b", "none")] },
      { userId: "zhou", name: "小周", credentials: [view("k:a", "expired")] },
    ] };
    const lines = overviewLines(o);
    expect(lines.map((l) => `${l.person.userId}:${l.c.kind}:${l.first}`)).toEqual(["zhou:k:a:true", "lin:k:a:true", "lin:k:b:false", "owner:k:a:true", "wu:k:a:true"]);
    expect(overviewLines(o, "林").map((l) => l.person.userId)).toEqual(["lin", "lin"]);
  });
});
