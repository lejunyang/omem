import { describe, expect, it } from "vitest";
import { getHarLog, getRequestContent, type DevtoolsNetworkApi } from "./devtools-api";
import type { DevtoolsRequest } from "../shared/network";

describe("devtools-api", () => {
  it("supports callback-based getHAR", async () => {
    const api: DevtoolsNetworkApi = {
      getHAR(callback) {
        callback?.({ entries: [{ request: { url: "https://example.com/a" } }] });
      }
    };

    await expect(getHarLog(api)).resolves.toEqual({
      entries: [{ request: { url: "https://example.com/a" } }]
    });
  });

  it("supports promise-based getHAR", async () => {
    const api: DevtoolsNetworkApi = {
      getHAR() {
        return Promise.resolve({ entries: [{ request: { url: "https://example.com/b" } }] });
      }
    };

    await expect(getHarLog(api)).resolves.toEqual({
      entries: [{ request: { url: "https://example.com/b" } }]
    });
  });

  it("falls back to an empty HAR when callback returns undefined", async () => {
    const api: DevtoolsNetworkApi = {
      getHAR(callback) {
        callback?.(undefined);
      }
    };

    await expect(getHarLog(api)).resolves.toEqual({ entries: [] });
  });

  it("supports callback-based getContent", async () => {
    const request: DevtoolsRequest = {
      getContent(callback) {
        callback?.("{\"ok\":true}", "");
      }
    };

    await expect(getRequestContent(request)).resolves.toEqual({
      content: "{\"ok\":true}",
      encoding: ""
    });
  });

  it("supports promise-based getContent result objects", async () => {
    const request: DevtoolsRequest = {
      getContent() {
        return Promise.resolve({ content: "hello", encoding: "utf-8" });
      }
    };

    await expect(getRequestContent(request)).resolves.toEqual({
      content: "hello",
      encoding: "utf-8"
    });
  });

  it("returns empty content for requests without getContent", async () => {
    await expect(getRequestContent({})).resolves.toEqual({
      content: "",
      encoding: ""
    });
  });
});
