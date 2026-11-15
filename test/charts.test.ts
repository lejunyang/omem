import { describe, expect, it } from "vitest";
import { dialTicks, rungUnit } from "../packages/plugin-sdk/charts.ts";

describe("countable units in charts", () => {
  it("a rung is one unit while the largest value can be counted, else a round number of units", () => {
    expect(rungUnit(14, true)).toBe(1);
    expect(rungUnit(45, true)).toBe(1);
    // The largest column gets about half to all of 45 rungs.
    expect(rungUnit(168, true)).toBe(5);
    expect(rungUnit(60, true)).toBe(2);
    expect(rungUnit(2300, true)).toBe(100);
    for (const top of [46, 99, 168, 731, 12_000, 3.4e6]) {
      const u = rungUnit(top, true);
      expect(top / u).toBeLessThanOrEqual(45);
      expect(top / u).toBeGreaterThan(45 / 2.5 - 1e-9);
      expect(String(u)).toMatch(/^[125]0*$/);
    }
    // Rates may take a fraction; whole counts never do.
    expect(rungUnit(4.6, false)).toBe(0.2);
    expect(rungUnit(3, true)).toBe(1);
    expect(rungUnit(0, true)).toBe(1);
  });

  it("a dial shares out a hundred ticks, every part above zero getting at least one", () => {
    expect(dialTicks([341, 97, 30, 14])).toEqual([71, 20, 6, 3]);
    expect(dialTicks([1, 1, 1])).toEqual([34, 33, 33]);
    const tiny = dialTicks([9990, 5, 5]);
    expect(tiny.reduce((a, b) => a + b, 0)).toBe(100);
    expect(tiny[1]).toBe(1);
    expect(tiny[2]).toBe(1);
    expect(dialTicks([0, 0])).toEqual([0, 0]);
    expect(dialTicks([5, 0, -2])).toEqual([100, 0, 0]);
  });
  it("折线是曲线，但不会冲过数据点：两个 0 之间不低于 0，峰值不被画高", async () => {
    const { curve } = await import("../packages/plugin-sdk/charts.ts");
    const pts: [number, number][] = [[0, 100], [10, 100], [20, 20], [30, 100], [40, 100], [50, 60]];
    const d = curve(pts);
    expect(d.startsWith("M0.0,100.0")).toBe(true);
    const segments = [...d.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/g)].map((m) => m.slice(1).map(Number));
    expect(segments).toHaveLength(pts.length - 1);
    // Every segment ends on a data point, and its control points stay between the two values it joins.
    segments.forEach(([, c1y, , c2y, x, y], i) => {
      expect([x, y]).toEqual(pts[i + 1]);
      const lo = Math.min(pts[i][1], pts[i + 1][1]), hi = Math.max(pts[i][1], pts[i + 1][1]);
      for (const c of [c1y, c2y]) { expect(c).toBeGreaterThanOrEqual(lo - 0.05); expect(c).toBeLessThanOrEqual(hi + 0.05); }
    });
    expect(curve([[0, 1], [5, 2]])).toBe("M0.0,1.0 L5.0,2.0");
  });
});
