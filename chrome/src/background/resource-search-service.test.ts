import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResourceSearchService } from "./resource-search-service";

const tabId = 88;

describe("resource-search-service", () => {
  const attachDebugger = vi.fn<() => Promise<void>>();
  const sendDebuggerCommandMock = vi.fn<(tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>();
  const sendDebuggerCommand = (<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> => sendDebuggerCommandMock(tabId, method, params) as Promise<T>);

  beforeEach(() => {
    attachDebugger.mockReset();
    sendDebuggerCommandMock.mockReset();
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        text: async () =>
          url.endsWith(".map")
            ? JSON.stringify({
                sources: ["src/from-map.ts"],
                sourcesContent: ["export const fromMap = 'source-map-service-needle';"]
              })
            : "export const fetchedSource = 'remote-source-needle';"
      }))
    );
  });

  it("indexes page resources and source maps during refresh", async () => {
    sendDebuggerCommandMock.mockImplementation(async (_tabId, method, params) => {
      if (method.endsWith(".enable")) {
        return {};
      }
      if (method === "Page.getResourceTree") {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              url: "https://example.com/index.html",
              securityOrigin: "https://example.com"
            },
            resources: [
              {
                url: "https://example.com/app.js",
                type: "Script",
                mimeType: "text/javascript"
              },
              {
                url: "https://example.com/image.png",
                type: "Image",
                mimeType: "image/png"
              }
            ],
            childFrames: [
              {
                frame: {
                  id: "child-frame",
                  parentId: "main-frame",
                  url: "https://child.example.com/frame.html",
                  securityOrigin: "https://child.example.com"
                },
                resources: []
              }
            ]
          }
        };
      }
      if (method === "Page.getResourceContent") {
        if (params?.url === "https://example.com/app.js") {
          return {
            content: "console.log('generated-service-needle');\n//# sourceMappingURL=app.js.map",
            base64Encoded: false
          };
        }
        return { content: "", base64Encoded: false };
      }
      return {};
    });

    const service = createResourceSearchService({ attachDebugger, sendDebuggerCommand });
    const response = await service.handleMessage({
      type: "advanced-network:resource-search-refresh",
      tabId,
      ignoredRules: []
    });

    expect(response.ok).toBe(true);
    expect(response.index?.frames).toMatchObject([
      {
        frameId: "main-frame",
        children: [
          {
            frameId: "child-frame",
            parentFrameId: "main-frame"
          }
        ]
      }
    ]);
    expect(response.index?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.com/app.js",
          contentState: "loaded",
          type: "script"
        }),
        expect.objectContaining({
          url: "https://example.com/image.png",
          contentState: "skipped",
          error: "非文本资源已跳过。"
        })
      ])
    );
    expect(response.index?.sourceMappedResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/from-map.ts",
          content: "export const fromMap = 'source-map-service-needle';",
          contentState: "loaded"
        })
      ])
    );
    expect(attachDebugger).toHaveBeenCalledWith(tabId);
  });

  it("uses debugger, css and network events as searchable resources", async () => {
    sendDebuggerCommandMock.mockImplementation(async (_tabId, method, params) => {
      if (method.endsWith(".enable")) {
        return {};
      }
      if (method === "Page.getResourceTree") {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              url: "https://example.com/index.html"
            },
            resources: []
          }
        };
      }
      if (method === "Debugger.getScriptSource") {
        expect(params).toEqual({ scriptId: "script-1" });
        return { scriptSource: "const scriptValue = 'debugger-service-needle';" };
      }
      if (method === "CSS.getStyleSheetText") {
        expect(params).toEqual({ styleSheetId: "style-1" });
        return { text: ".fixture { color: red; --css-service-needle: 1; }" };
      }
      if (method === "Network.getResponseBody") {
        expect(params).toEqual({ requestId: "request-1" });
        return { body: "network-service-needle", base64Encoded: false };
      }
      return {};
    });

    const service = createResourceSearchService({ attachDebugger, sendDebuggerCommand });
    await service.handleMessage({
      type: "advanced-network:resource-search-refresh",
      tabId: tabId + 1,
      ignoredRules: []
    });
    service.handleDebuggerEvent(tabId + 1, "Debugger.scriptParsed", {
      scriptId: "script-1",
      url: "https://example.com/debugger.js"
    });
    service.handleDebuggerEvent(tabId + 1, "CSS.styleSheetAdded", {
      header: {
        styleSheetId: "style-1",
        frameId: "main-frame",
        sourceURL: "https://example.com/app.css"
      }
    });
    service.handleDebuggerEvent(tabId + 1, "Network.responseReceived", {
      requestId: "request-1",
      frameId: "main-frame",
      type: "Fetch",
      response: {
        url: "https://example.com/data.json",
        mimeType: "application/json"
      }
    });

    const response = await service.handleMessage({
      type: "advanced-network:resource-search-search",
      tabId: tabId + 1,
      options: {
        query: "service-needle",
        scope: "generated",
        caseSensitive: false,
        regexEnabled: false,
        ignoredRules: []
      }
    });

    expect(response.ok).toBe(true);
    expect(response.results?.map((result) => result.title).sort()).toEqual(["app.css", "data.json", "debugger.js"]);
  });

  it("applies ignored rules to service search snapshots", async () => {
    sendDebuggerCommandMock.mockImplementation(async (_tabId, method) => {
      if (method.endsWith(".enable")) {
        return {};
      }
      if (method === "Page.getResourceTree") {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              url: "https://example.com/index.html"
            },
            resources: [
              {
                url: "https://example.com/vendor.js",
                type: "Script",
                mimeType: "text/javascript"
              }
            ]
          }
        };
      }
      if (method === "Page.getResourceContent") {
        return { content: "vendor-service-needle", base64Encoded: false };
      }
      return {};
    });

    const service = createResourceSearchService({ attachDebugger, sendDebuggerCommand });
    const response = await service.handleMessage({
      type: "advanced-network:resource-search-search",
      tabId: tabId + 2,
      options: {
        query: "vendor-service-needle",
        scope: "generated",
        caseSensitive: false,
        regexEnabled: false,
        ignoredRules: [
          {
            id: "ignore-1",
            enabled: true,
            pattern: "https://example.com/vendor.js",
            matchType: "exact",
            target: "generated-url",
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.results).toHaveLength(0);
    expect(response.index?.resources[0]).toMatchObject({
      url: "https://example.com/vendor.js",
      ignored: true
    });
  });

  it("clears tab state and reports inactive after detach", async () => {
    sendDebuggerCommandMock.mockImplementation(async (_tabId, method) => {
      if (method.endsWith(".enable")) {
        return {};
      }
      if (method === "Page.getResourceTree") {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              url: "https://example.com/index.html"
            },
            resources: []
          }
        };
      }
      return {};
    });

    const service = createResourceSearchService({ attachDebugger, sendDebuggerCommand });
    await service.handleMessage({
      type: "advanced-network:resource-search-refresh",
      tabId: tabId + 3,
      ignoredRules: []
    });

    expect(service.hasActiveTab(tabId + 3)).toBe(true);
    service.clearTab(tabId + 3);
    expect(service.hasActiveTab(tabId + 3)).toBe(false);
  });
});
