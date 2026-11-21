import { describe, expect, it } from "vitest";
import { chainEmpty, chainRoute, chainSummary, connected, type ChainEntry } from "../web/src/lib/chain.ts";

const e = (key: string, links: string[] = []): ChainEntry => ({ key, kind: key.split(":")[0] as ChainEntry["kind"], title: key, status: "", cls: "", now: "", href: "", links });

describe("an item's chain on the page (web/src/lib/chain.ts)", () => {
  it("says the counts in one line, without the empty ones", () => {
    expect(chainSummary({ reqs: 3, findings: 2, designs: 1, works: 2, reviewing: 1, waiting: 0 })).toBe("3 条需求 · 2 个发现 · 1 份方案 · 2 次交付，1 次在评审");
    expect(chainSummary({ reqs: 1, findings: 0, designs: 0, works: 1, reviewing: 0, waiting: 1 })).toBe("1 条需求 · 1 次交付，1 次等你");
  });

  it("lights what is linked, both ways and on along the chain, and nothing unlinked", () => {
    const g = {
      reqs: [e("req:a"), e("req:b")],
      findings: [e("finding:f")],
      designs: [e("design:d", ["req:a"])],
      works: [e("work:w", ["req:a", "finding:f"]), e("work:x", ["req:b"]), e("object:o")],
    };
    expect([...connected(g, "req:a")].sort()).toEqual(["design:d", "finding:f", "req:a", "work:w"]);
    expect([...connected(g, "work:x")].sort()).toEqual(["req:b", "work:x"]);
    expect([...connected(g, "object:o")]).toEqual(["object:o"]);
  });

  it("knows an empty chain and an app page from an outside link", () => {
    expect(chainEmpty(null)).toBe(true);
    expect(chainEmpty({ itemId: "i", line: false, groups: [], moreGroups: 0, counts: { reqs: 0, findings: 0, designs: 0, works: 0, reviewing: 0, waiting: 0 } })).toBe(true);
    expect(chainRoute("#/reqs/q1")).toBe("/reqs/q1");
    expect(chainRoute("https://git.example.com/mr/12")).toBeNull();
  });
});
