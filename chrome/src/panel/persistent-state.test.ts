import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceProfile, DEFAULT_DEVICE_PROFILES, DEVICE_PROFILE_STORAGE_KEY } from "../shared/device-emulation";
import { loadDeviceProfilesFromStorage, loadFilterPresetsFromStorage, PRESET_STORAGE_KEY } from "./persistent-state";

describe("persistent state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads numeric-key preset objects and repairs them without clearing saved filters", async () => {
    const storageData: Record<string, unknown> = {
      [PRESET_STORAGE_KEY]: {
        "0": {
          id: "ed09bcc0-4058-43c1-8f66-6a34ddb864a2",
          name: "test1",
          query: "-url:test",
          statusFilter: "all",
          typeFilter: "all"
        },
        "1": {
          id: "b0ebf304-b509-48ff-8b27-3a14acf9abcd",
          name: "test2",
          query: "-url:test -name:test",
          statusFilter: "all",
          typeFilter: "all"
        }
      }
    };
    vi.stubGlobal("chrome", createChromeStorageMock(storageData));

    const presets = await loadFilterPresetsFromStorage();

    expect(presets.map((preset) => preset.name)).toEqual(["test1", "test2"]);
    expect(storageData[PRESET_STORAGE_KEY]).toEqual(presets);
  });

  it("does not write an empty preset list when storage key is absent", async () => {
    const storageData: Record<string, unknown> = {};
    vi.stubGlobal("chrome", createChromeStorageMock(storageData));

    await expect(loadFilterPresetsFromStorage()).resolves.toEqual([]);

    expect(storageData).toEqual({});
  });

  it("loads numeric-key device profiles and repairs them without dropping builtin profiles", async () => {
    const customProfile = createDeviceProfile({
      id: "custom-device",
      name: "Custom Device",
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      userAgent: "Custom UA",
      platform: "iPhone",
      touchEnabled: true,
      maxTouchPoints: 5,
      now: 100
    });
    const storageData: Record<string, unknown> = {
      [DEVICE_PROFILE_STORAGE_KEY]: {
        "0": customProfile
      }
    };
    vi.stubGlobal("chrome", createChromeStorageMock(storageData));

    const profiles = await loadDeviceProfilesFromStorage();

    expect(profiles.map((profile) => profile.id)).toContain(DEFAULT_DEVICE_PROFILES[0].id);
    expect(profiles.find((profile) => profile.id === "custom-device")).toMatchObject({
      name: "Custom Device",
      width: 390
    });
    expect(storageData[DEVICE_PROFILE_STORAGE_KEY]).toEqual(profiles);
  });

  it("does not write default device profiles when storage key is absent", async () => {
    const storageData: Record<string, unknown> = {};
    vi.stubGlobal("chrome", createChromeStorageMock(storageData));

    await expect(loadDeviceProfilesFromStorage()).resolves.toEqual(DEFAULT_DEVICE_PROFILES);

    expect(storageData).toEqual({});
  });
});

function createChromeStorageMock(storageData: Record<string, unknown>) {
  return {
    runtime: {},
    storage: {
      local: {
        get(keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) {
          if (Array.isArray(keys)) {
            callback(Object.fromEntries(keys.map((key) => [key, storageData[key]])));
            return;
          }
          if (typeof keys === "string") {
            callback({ [keys]: storageData[keys] });
            return;
          }
          callback({ ...storageData });
        },
        set(items: Record<string, unknown>, callback: () => void) {
          Object.assign(storageData, items);
          callback();
        }
      }
    }
  };
}
