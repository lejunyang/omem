import { describe, expect, it } from "vitest";
import { paddedGroups } from "../src/search/embeddings.ts";
import { memoryHistory, memoryNow, startMemoryWatch } from "../src/core/memory-watch.ts";

describe("local embedding batches", () => {
  it("groups texts of similar length and keeps long ones in small groups, covering every text once", () => {
    const texts = [...Array(30).fill("短".repeat(100)), ...Array(10).fill("长".repeat(2000)), "中".repeat(800)];
    const groups = paddedGroups(texts);
    expect(groups.flat().sort((a, b) => a - b)).toEqual(texts.map((_, i) => i));
    for (const g of groups) {
      const longest = Math.max(...g.map((i) => texts[i].length));
      expect(g.length * longest).toBeLessThanOrEqual(16_000);
    }
    // The 30 short ones go together; the long ones at most 8 at a time.
    expect(groups.some((g) => g.length === 30)).toBe(true);
    expect(Math.max(...groups.filter((g) => g.some((i) => texts[i].length === 2000)).map((g) => g.length))).toBe(8);
  });

  it("a single text longer than the budget still forms its own group", () => {
    expect(paddedGroups(["x".repeat(50_000), "y"])).toEqual([[1], [0]]);
  });
});

describe("memory watch", () => {
  it("reports the breakdown and keeps samples", () => {
    startMemoryWatch();
    expect(memoryNow().heapUsedMb).toBeGreaterThan(0);
    const h = memoryHistory();
    expect(h.samples.length).toBeGreaterThan(0);
    expect(h.heapFloorLastQuarterMb).not.toBeNull();
  });
});
