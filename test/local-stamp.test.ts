import { describe, expect, it } from "vitest";
import { localStamp } from "../src/core/util.ts";

describe("localStamp", () => {
  it("shows stored UTC times in the owner's time zone", () => {
    expect(localStamp("2026-11-11T19:33:00.000Z", "Asia/Shanghai")).toBe("2026-11-12 03:33");
    expect(localStamp(Date.parse("2026-11-11T19:33:05Z"), "UTC", { seconds: true })).toBe("2026-11-11 19:33:05");
    expect(localStamp("2026-11-11T19:33:00Z", "Asia/Shanghai", { short: true })).toBe("11-12 03:33");
  });
  it("leaves unparsable input as it was", () => {
    expect(localStamp("not a time", "Asia/Shanghai")).toBe("not a time");
  });
});
