import { describe, expect, it } from "vitest";
import {
  normalizeNetworkControlSettings,
  toCdpNetworkConditions
} from "./network-controls";

describe("network controls", () => {
  it("normalizes stored control settings", () => {
    expect(
      normalizeNetworkControlSettings({
        preserveLog: true,
        disableCache: true,
        throttlingProfile: "slow-3g"
      })
    ).toEqual({
      preserveLog: true,
      disableCache: true,
      throttlingProfile: "slow-3g"
    });
    expect(normalizeNetworkControlSettings({ throttlingProfile: "bad" })).toEqual({
      preserveLog: false,
      disableCache: false,
      throttlingProfile: "none"
    });
  });

  it("maps throttling profiles to CDP network conditions", () => {
    expect(toCdpNetworkConditions("none")).toEqual({
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    expect(toCdpNetworkConditions("offline")).toEqual({
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0
    });
    expect(toCdpNetworkConditions("fast-3g").latency).toBe(150);
  });
});
