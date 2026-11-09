import { describe, expect, it } from "vitest";
import {
  createDeviceProfile,
  DEFAULT_DEVICE_PROFILES,
  normalizeDeviceEmulationSettings,
  normalizeDeviceProfiles,
  toDeviceMetricsOverrideParams,
  toTouchEmulationParams
} from "./device-emulation";

describe("device emulation", () => {
  it("keeps builtin profiles and accepts numeric-key stored custom profiles", () => {
    const custom = createDeviceProfile({
      id: "custom-phone",
      name: "Custom Phone",
      width: 360,
      height: 780,
      deviceScaleFactor: 3,
      mobile: true,
      userAgent: "UA",
      platform: "Android",
      touchEnabled: true,
      maxTouchPoints: 5,
      now: 100
    });

    const profiles = normalizeDeviceProfiles({ 0: custom });

    expect(profiles.map((profile) => profile.id)).toContain(DEFAULT_DEVICE_PROFILES[0].id);
    expect(profiles.find((profile) => profile.id === "custom-phone")).toMatchObject({
      width: 360,
      height: 780,
      mobile: true
    });
  });

  it("normalizes invalid settings to safe defaults", () => {
    expect(
      normalizeDeviceEmulationSettings({
        enabled: true,
        profileId: " ",
        orientation: "bad",
        scaleMode: "bad",
        scale: 100
      })
    ).toMatchObject({
      enabled: true,
      orientation: "portrait",
      scaleMode: "fit-window",
      scale: 5
    });
  });

  it("swaps width and height for landscape and keeps orientation metadata", () => {
    const profile = DEFAULT_DEVICE_PROFILES[0];
    const params = toDeviceMetricsOverrideParams({
      profile,
      settings: {
        enabled: true,
        profileId: profile.id,
        orientation: "landscape",
        scaleMode: "fixed",
        scale: 0.75
      }
    });

    expect(params).toMatchObject({
      width: profile.height,
      height: profile.width,
      scale: 1,
      screenOrientation: {
        type: "landscapePrimary",
        angle: 90
      }
    });
  });

  it("keeps real tab device metrics scale at 1 even when fit-window would shrink", () => {
    const profile = createDeviceProfile({
      id: "large-device",
      name: "Large Device",
      width: 1000,
      height: 2000,
      deviceScaleFactor: 2,
      mobile: true,
      userAgent: "UA",
      platform: "Phone",
      touchEnabled: true,
      maxTouchPoints: 5,
      now: 1
    });

    const params = toDeviceMetricsOverrideParams({
      profile,
      settings: {
        enabled: true,
        profileId: profile.id,
        orientation: "portrait",
        scaleMode: "fit-window",
        scale: 1
      },
      availableSize: {
        width: 500,
        height: 600
      }
    });

    expect(params.scale).toBe(1);
    expect(params.viewport).toBeUndefined();
    expect(params.positionX).toBeUndefined();
    expect(params.positionY).toBeUndefined();
  });

  it("adds explicitly enabled advanced CDP metrics params", () => {
    const profile = {
      ...DEFAULT_DEVICE_PROFILES[0],
      metricsAdvanced: {
        ...DEFAULT_DEVICE_PROFILES[0].metricsAdvanced,
        scale: { enabled: true, value: 0.8 },
        screenWidth: { enabled: true, value: 390 },
        screenHeight: { enabled: true, value: 844 },
        positionX: { enabled: true, value: 12 },
        positionY: { enabled: true, value: 34 },
        dontSetVisibleSize: { enabled: true, value: true },
        viewport: { enabled: true, x: 1, y: 2, width: 300, height: 600, scale: 1 },
        displayFeature: { enabled: true, orientation: "vertical" as const, offset: 100, maskLength: 10 }
      }
    };
    const params = toDeviceMetricsOverrideParams({
      profile,
      settings: {
        enabled: true,
        profileId: profile.id,
        orientation: "portrait",
        scaleMode: "fit-window",
        scale: 1
      }
    });

    expect(params).toMatchObject({
      scale: 0.8,
      screenWidth: 390,
      screenHeight: 844,
      positionX: 12,
      positionY: 34,
      dontSetVisibleSize: true,
      viewport: {
        x: 1,
        y: 2,
        width: 300,
        height: 600,
        scale: 1
      },
      displayFeature: {
        orientation: "vertical",
        offset: 100,
        maskLength: 10
      }
    });
  });

  it("normalizes invalid advanced params to disabled safe values", () => {
    const profile = createDeviceProfile({
      id: "advanced-device",
      name: "Advanced Device",
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
      userAgent: "UA",
      platform: "iPhone",
      touchEnabled: true,
      maxTouchPoints: 5,
      metricsAdvanced: {
        scale: { enabled: true, value: 10 },
        viewport: { enabled: true, x: -1, y: -2, width: -3, height: -4, scale: 9 },
        displayFeature: { enabled: true, orientation: "bad", offset: -10, maskLength: -10 }
      },
      now: 1
    });

    expect(profile.metricsAdvanced.scale).toEqual({ enabled: true, value: 5 });
    expect(profile.metricsAdvanced.viewport).toEqual({
      enabled: true,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      scale: 5
    });
    expect(profile.metricsAdvanced.displayFeature).toEqual({
      enabled: true,
      orientation: "vertical",
      offset: 0,
      maskLength: 0
    });
  });

  it("treats max touch points 0 as disabled touch emulation", () => {
    const profile = {
      ...DEFAULT_DEVICE_PROFILES[0],
      touchEnabled: true,
      maxTouchPoints: 0
    };

    expect(toTouchEmulationParams(profile)).toEqual({ enabled: false });
  });
});
