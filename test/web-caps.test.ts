import { describe, expect, it } from "vitest";
import { capAnywhere, capIn, followMe, hasCap, hasPerm, type Me } from "../web/src/lib/caps.ts";

const person = (extra: Partial<Me> & Record<string, unknown> = {}): Me => ({ role: "observer", perms: [], spaces: ["shop", "personal-xiaozhou"], ...extra });

describe("what the page offers by capability (web/src/lib/caps.ts)", () => {
  it("lets the owner and the page before /api/me arrives do everything", () => {
    followMe(() => null);
    expect(hasCap("settings.members")).toBe(true);
    expect(capIn("items.edit", "shop")).toBe(true);
    const owner = person({ role: "owner", caps: [], spaceCaps: {} });
    expect(hasCap("rules.edit", owner)).toBe(true);
    expect(capAnywhere("work.view", {}, owner)).toBe(true);
    expect(hasPerm("code.delegate", owner)).toBe(true);
  });

  it("follows the person the store hands over", () => {
    let me: Me | null = person({ caps: ["rules.view"], spaceCaps: {} });
    followMe(() => me);
    expect(hasCap("rules.view")).toBe(true);
    expect(hasCap("rules.edit")).toBe(false);
    me = null;
    expect(hasCap("rules.edit")).toBe(true);
  });

  it("reads space capabilities per space, any space, and every space", () => {
    const me = person({ caps: [], spaceCaps: { "work.view": ["shop"], "sources.view": "*", "memories.view": [] }, ownSpaceCaps: { "items.view": ["personal-xiaozhou"] } });
    expect(capIn("work.view", "shop", {}, me)).toBe(true);
    expect(capIn("work.view", "refund", {}, me)).toBe(false);
    expect(capAnywhere("work.view", {}, me)).toBe(true);
    expect(capAnywhere("memories.view", {}, me)).toBe(false);
    expect(capIn("sources.view", "anything", {}, me)).toBe(true);
    expect(capAnywhere("runs.view", {}, me)).toBe(false);
  });

  it("counts the person's own items and runs only when asked", () => {
    const me = person({ caps: [], spaceCaps: { "items.view": [] }, ownSpaceCaps: { "items.view": ["personal-xiaozhou"] } });
    expect(capAnywhere("items.view", {}, me)).toBe(false);
    expect(capAnywhere("items.view", { own: true }, me)).toBe(true);
    expect(capIn("items.view", "personal-xiaozhou", { own: true }, me)).toBe(true);
  });

  it("falls back to the old permissions when the server sends no capabilities", () => {
    const member = person({ role: "member", perms: ["spaces.create"] });
    expect(capAnywhere("work.view", {}, member)).toBe(false);
    expect(capAnywhere("wiki.view", {}, member)).toBe(true);
    expect(capAnywhere("runs.view", { own: true }, member)).toBe(true);
    expect(capIn("sources.view", "shop", {}, member)).toBe(true);
    expect(capIn("sources.view", "refund", {}, member)).toBe(false);
    expect(hasCap("rules.view", member)).toBe(false);
    expect(hasCap("rules.view", person({ role: "admin", perms: ["agents.manage"] }))).toBe(true);
    expect(hasCap("settings.members", person({ role: "admin", perms: ["users.manage"] }))).toBe(true);
    expect(hasCap("ask.send", member)).toBe(true);
    expect(hasPerm("code.delegate", member)).toBe(false);
  });
});
