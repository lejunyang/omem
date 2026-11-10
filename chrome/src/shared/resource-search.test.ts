import { describe, expect, it, vi } from "vitest";
import {
  applyIgnoreRulesToIndex,
  createIgnoreRule,
  extractSourceMapUrl,
  getResourceDisplayTitle,
  hasOpenableResourceUrl,
  inferResourceType,
  isSearchableResource,
  isVirtualDebuggerScript,
  normalizeIgnoreRules,
  parseSourceMap,
  resourceMatchesIgnoreRules,
  resolveSourceMapUrl,
  searchResourceIndex,
  type IndexedResource,
  type ResourceIgnoreRule
} from "./resource-search";
import { isResourceSearchMessage } from "./resource-search-messages";

vi.stubGlobal("crypto", {
  randomUUID: () => "uuid"
});

const baseResource: IndexedResource = {
  id: "resource-1",
  frameId: "frame-1",
  url: "https://example.com/assets/app.js",
  origin: "https://example.com",
  type: "script",
  source: "debugger",
  mimeType: "text/javascript",
  contentState: "loaded",
  content: "const answer = 42;\nconsole.log(answer);",
  sourceMapUrl: "https://example.com/assets/app.js.map",
  generatedResourceId: null,
  ignored: false,
  error: ""
};

describe("resource-search", () => {
  it("normalizes ignore rules from numeric-key objects", () => {
    expect(
      normalizeIgnoreRules({
        0: {
          pattern: "vendor",
          matchType: "contains",
          target: "generated-url"
        }
      })
    ).toMatchObject([
      {
        pattern: "vendor",
        matchType: "contains",
        target: "generated-url",
        enabled: true
      }
    ]);
  });

  it("matches ignore rules by target and matcher type", () => {
    const rules: ResourceIgnoreRule[] = [
      {
        id: "1",
        enabled: true,
        pattern: "vendor",
        matchType: "contains",
        target: "generated-url",
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: "2",
        enabled: true,
        pattern: "src/.+\\.ts$",
        matchType: "regex",
        target: "source-path",
        createdAt: 1,
        updatedAt: 1
      }
    ];

    expect(resourceMatchesIgnoreRules("https://cdn.example.com/vendor.js", "generated-url", rules)).toBe(true);
    expect(resourceMatchesIgnoreRules("src/main.ts", "source-path", rules)).toBe(true);
    expect(resourceMatchesIgnoreRules("src/main.ts", "generated-url", rules)).toBe(false);
  });

  it("creates ignore rules with default exact matching and timestamps", () => {
    expect(
      createIgnoreRule({
        pattern: " https://example.com/app.js ",
        target: "generated-url",
        now: 123
      })
    ).toMatchObject({
      id: "uuid",
      enabled: true,
      pattern: "https://example.com/app.js",
      matchType: "exact",
      target: "generated-url",
      createdAt: 123,
      updatedAt: 123
    });
  });

  it("searches generated and source mapped resources", () => {
    const result = searchResourceIndex({
      resources: [baseResource],
      sourceMappedResources: [
        {
          id: "source-1",
          generatedResourceId: "resource-1",
          sourceMapUrl: "https://example.com/assets/app.js.map",
          path: "src/App.ts",
          url: "https://example.com/src/App.ts",
          contentState: "loaded",
          content: "export const label = 'needle';",
          ignored: false,
          error: ""
        }
      ],
      options: {
        query: "answer|needle",
        scope: "all",
        caseSensitive: false,
        regexEnabled: true,
        ignoredRules: []
      }
    });

    expect(result.error).toBe("");
    expect(result.results).toHaveLength(3);
    expect(result.results.map((item) => item.scope)).toEqual(["generated", "generated", "source-mapped"]);
  });

  it("labels virtual debugger scripts and keeps them searchable", () => {
    const virtualScript: IndexedResource = {
      ...baseResource,
      id: "script:1206",
      url: "1206",
      origin: "null",
      content: "const anonymousNeedle = true;"
    };
    const result = searchResourceIndex({
      resources: [virtualScript],
      sourceMappedResources: [],
      options: {
        query: "anonymousNeedle",
        scope: "generated",
        caseSensitive: false,
        regexEnabled: false,
        ignoredRules: []
      }
    });

    expect(isVirtualDebuggerScript(virtualScript)).toBe(true);
    expect(hasOpenableResourceUrl(virtualScript.url)).toBe(false);
    expect(getResourceDisplayTitle(virtualScript)).toBe("匿名脚本 #1206");
    expect(result.results[0]).toMatchObject({
      title: "匿名脚本 #1206",
      resourceId: "script:1206"
    });
  });

  it("skips virtual debugger scripts when requested", () => {
    const virtualScript: IndexedResource = {
      ...baseResource,
      id: "script:1206",
      url: "1206",
      origin: "null",
      content: "const anonymousNeedle = true;"
    };
    const result = searchResourceIndex({
      resources: [virtualScript],
      sourceMappedResources: [],
      options: {
        query: "anonymousNeedle",
        scope: "generated",
        caseSensitive: false,
        regexEnabled: false,
        ignoredRules: [],
        skipAnonymousScripts: true
      }
    });

    expect(result.results).toHaveLength(0);
  });

  it("filters ignored resources before searching", () => {
    const { resources } = applyIgnoreRulesToIndex({
      resources: [baseResource],
      sourceMappedResources: [],
      ignoredRules: [
        {
          id: "1",
          enabled: true,
          pattern: "https://example.com/assets/app.js",
          matchType: "exact",
          target: "generated-url",
          createdAt: 1,
          updatedAt: 1
        }
      ]
    });

    expect(resources[0].ignored).toBe(true);
    expect(
      searchResourceIndex({
        resources,
        sourceMappedResources: [],
        options: {
          query: "answer",
          scope: "generated",
          caseSensitive: false,
          regexEnabled: false,
          ignoredRules: []
        }
      }).results
    ).toHaveLength(0);
  });

  it("uses ignoredRules passed to search options", () => {
    const result = searchResourceIndex({
      resources: [baseResource],
      sourceMappedResources: [],
      options: {
        query: "answer",
        scope: "generated",
        caseSensitive: false,
        regexEnabled: false,
        ignoredRules: [
          {
            id: "1",
            enabled: true,
            pattern: "https://example.com/assets/app.js",
            matchType: "exact",
            target: "generated-url",
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    });

    expect(result.results).toHaveLength(0);
  });

  it("returns validation errors for invalid search regex", () => {
    const result = searchResourceIndex({
      resources: [baseResource],
      sourceMappedResources: [],
      options: {
        query: "[",
        scope: "generated",
        caseSensitive: false,
        regexEnabled: true,
        ignoredRules: []
      }
    });

    expect(result.error).toContain("正则表达式无效");
    expect(result.results).toHaveLength(0);
  });

  it("parses source maps with sourcesContent and resolves source urls", () => {
    const parsed = parseSourceMap({
      generatedResourceId: "resource-1",
      sourceMapUrl: "https://example.com/assets/app.js.map",
      content: JSON.stringify({
        sourceRoot: "../",
        sources: ["src/App.ts"],
        sourcesContent: ["export const answer = 42;"]
      })
    });

    expect(parsed.error).toBe("");
    expect(parsed.sources).toMatchObject([
      {
        path: "src/App.ts",
        url: "https://example.com/src/App.ts",
        contentState: "loaded",
        content: "export const answer = 42;"
      }
    ]);
  });

  it("marks source map entries without sourcesContent as missing", () => {
    const parsed = parseSourceMap({
      generatedResourceId: "resource-1",
      sourceMapUrl: "https://example.com/assets/app.css.map",
      content: JSON.stringify({
        sources: ["../src/App.css"]
      })
    });

    expect(parsed.sources).toMatchObject([
      {
        path: "../src/App.css",
        url: "https://example.com/src/App.css",
        contentState: "missing",
        content: "",
        error: "Source map 未内联 sourcesContent。"
      }
    ]);
  });

  it("returns source map parse errors for invalid payloads", () => {
    expect(
      parseSourceMap({
        generatedResourceId: "resource-1",
        sourceMapUrl: "https://example.com/app.js.map",
        content: "{"
      }).error
    ).toContain("Source map JSON 解析失败");
    expect(
      parseSourceMap({
        generatedResourceId: "resource-1",
        sourceMapUrl: "https://example.com/app.js.map",
        content: "{}"
      }).error
    ).toBe("Source map 缺少 sources 字段。");
  });

  it("infers searchable resource types", () => {
    expect(inferResourceType({ url: "https://example.com/app.js", mimeType: "text/javascript" })).toBe("script");
    expect(inferResourceType({ url: "https://example.com/app.css", mimeType: "text/css" })).toBe("stylesheet");
    expect(inferResourceType({ url: "https://example.com/app.js.map", mimeType: "application/json" })).toBe("source-map");
  });

  it("extracts and resolves source map urls", () => {
    expect(extractSourceMapUrl("console.log(1);\n//# sourceMappingURL=app.js.map")).toBe("app.js.map");
    expect(resolveSourceMapUrl("https://example.com/assets/app.js", "app.js.map")).toBe(
      "https://example.com/assets/app.js.map"
    );
    expect(resolveSourceMapUrl("https://example.com/assets/app.js", "data:application/json,{}")).toBe(
      "data:application/json,{}"
    );
  });

  it("detects searchable text resources", () => {
    expect(isSearchableResource({ type: "other", mimeType: "application/octet-stream", content: "" })).toBe(false);
    expect(isSearchableResource({ type: "other", mimeType: "application/xml", content: "" })).toBe(true);
  });

  it("recognizes resource search messages", () => {
    expect(isResourceSearchMessage({ type: "advanced-network:resource-search-search", tabId: 1 })).toBe(true);
    expect(isResourceSearchMessage({ type: "advanced-network:unknown" })).toBe(false);
  });
});
