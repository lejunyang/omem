import { describe, expect, it } from "vitest";
import { getStorageItems, setStorageItems, setStorageItemsAndVerify, type StorageAreaLike } from "./extension-storage";

describe("extension storage", () => {
  it("reads and writes with callback-style storage APIs", async () => {
    const area = createCallbackStorage();

    await setStorageItems(area, { key: "value" }, {});

    await expect(getStorageItems(area, "key", {})).resolves.toEqual({ key: "value" });
  });

  it("reads and writes with promise-style storage APIs", async () => {
    const data: Record<string, unknown> = {};
    const area: StorageAreaLike = {
      async get(keys) {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, data[key]]));
        }
        if (typeof keys === "string") {
          return { [keys]: data[keys] };
        }
        return { ...data };
      },
      async set(items) {
        Object.assign(data, items);
      }
    };

    await setStorageItemsAndVerify(area, { key: "value" }, {});

    await expect(getStorageItems(area, null, {})).resolves.toEqual({ key: "value" });
  });

  it("rejects chrome runtime lastError from callbacks", async () => {
    const area = createCallbackStorage();
    const runtime = { lastError: { message: "quota exceeded" } };

    await expect(setStorageItems(area, { key: "value" }, runtime)).rejects.toThrow("quota exceeded");
  });
});

function createCallbackStorage(): StorageAreaLike {
  const data: Record<string, unknown> = {};

  return {
    get(keys, callback) {
      if (Array.isArray(keys)) {
        callback?.(Object.fromEntries(keys.map((key) => [key, data[key]])));
        return;
      }
      if (typeof keys === "string") {
        callback?.({ [keys]: data[keys] });
        return;
      }
      callback?.({ ...data });
    },
    set(items, callback) {
      Object.assign(data, items);
      callback?.();
    }
  };
}
