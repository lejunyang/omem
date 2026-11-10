export const RESOURCE_IGNORE_STORAGE_KEY = "advancedNetwork.resourceSearchIgnoredResources";
export const RESOURCE_CONTENT_SIZE_LIMIT_BYTES = 2 * 1024 * 1024;
export const RESOURCE_SEARCH_RESULT_LIMIT = 500;
export const RESOURCE_SEARCH_RESULT_LIMIT_PER_FILE = 50;

export type ResourceSearchScope = "generated" | "source-mapped" | "all";
export type ResourceSource = "page" | "network" | "debugger" | "css";
export type ResourceType = "document" | "script" | "stylesheet" | "source-map" | "json" | "text" | "other";
export type ResourceContentState = "unloaded" | "loading" | "loaded" | "failed" | "skipped";
export type IgnoreMatchType = "contains" | "exact" | "regex";
export type IgnoreTarget = "generated-url" | "source-path" | "both";

export interface ResourceFrameNode {
  frameId: string;
  parentFrameId: string | null;
  url: string;
  name: string;
  securityOrigin: string;
  children: ResourceFrameNode[];
}

export interface IndexedResource {
  id: string;
  frameId: string;
  url: string;
  origin: string;
  type: ResourceType;
  source: ResourceSource;
  mimeType: string;
  contentState: ResourceContentState;
  content: string;
  sourceMapUrl: string;
  generatedResourceId: string | null;
  ignored: boolean;
  error: string;
}

export interface SourceMappedResource {
  id: string;
  generatedResourceId: string;
  sourceMapUrl: string;
  path: string;
  url: string;
  contentState: "loaded" | "failed" | "missing";
  content: string;
  ignored: boolean;
  error: string;
}

export interface ResourceIgnoreRule {
  id: string;
  enabled: boolean;
  pattern: string;
  matchType: IgnoreMatchType;
  target: IgnoreTarget;
  createdAt: number;
  updatedAt: number;
}

export interface ResourceSearchOptions {
  query: string;
  scope: ResourceSearchScope;
  caseSensitive: boolean;
  regexEnabled: boolean;
  ignoredRules: ResourceIgnoreRule[];
  skipAnonymousScripts?: boolean;
}

export interface ResourceSearchResult {
  id: string;
  scope: "generated" | "source-mapped";
  resourceId: string;
  title: string;
  url: string;
  frameId: string;
  origin: string;
  lineNumber: number;
  columnNumber: number;
  snippet: string;
}

export interface ResourceDisplayTarget {
  id: string;
  url: string;
  source: ResourceSource;
  type: ResourceType;
}

export interface SourceMapParseResult {
  sources: SourceMappedResource[];
  error: string;
}

interface RawSourceMap {
  sourceRoot?: unknown;
  sources?: unknown;
  sourcesContent?: unknown;
}

export function normalizeIgnoreRules(value: unknown): ResourceIgnoreRule[] {
  // 忽略规则同样兼容数组和数字键对象，避免 DevTools storage 展示形态变化导致规则丢失。
  const rawItems = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>)
      : [];
  return rawItems
    .map((item) => normalizeIgnoreRule(item))
    .filter((item): item is ResourceIgnoreRule => item !== null);
}

export function createIgnoreRule(input: {
  pattern: string;
  target: IgnoreTarget;
  matchType?: IgnoreMatchType;
  now?: number;
}): ResourceIgnoreRule {
  const now = input.now ?? Date.now();
  return {
    id: crypto.randomUUID(),
    enabled: true,
    pattern: input.pattern.trim(),
    matchType: input.matchType ?? "exact",
    target: input.target,
    createdAt: now,
    updatedAt: now
  };
}

export function resourceMatchesIgnoreRules(
  value: string,
  target: Exclude<IgnoreTarget, "both">,
  rules: ResourceIgnoreRule[]
): boolean {
  // 生成资源和 Source Map 源文件使用不同 target；both 用于同时屏蔽编译前后两个视角。
  return rules.some((rule) => rule.enabled && (rule.target === target || rule.target === "both") && matchesIgnoreRule(value, rule));
}

export function applyIgnoreRulesToIndex(input: {
  resources: IndexedResource[];
  sourceMappedResources: SourceMappedResource[];
  ignoredRules: ResourceIgnoreRule[];
}): {
  resources: IndexedResource[];
  sourceMappedResources: SourceMappedResource[];
} {
  // 搜索前再次应用忽略规则，确保后台索引刷新和前台规则编辑之间不会出现旧 ignored 状态。
  return {
    resources: input.resources.map((resource) => ({
      ...resource,
      ignored: resource.ignored || resourceMatchesIgnoreRules(resource.url, "generated-url", input.ignoredRules)
    })),
    sourceMappedResources: input.sourceMappedResources.map((resource) => ({
      ...resource,
      ignored: resource.ignored || resourceMatchesIgnoreRules(resource.path || resource.url, "source-path", input.ignoredRules)
    }))
  };
}

export function searchResourceIndex(input: {
  resources: IndexedResource[];
  sourceMappedResources: SourceMappedResource[];
  options: ResourceSearchOptions;
}): {
  results: ResourceSearchResult[];
  error: string;
} {
  // 搜索同时支持生成资源和 source map 源文件；所有结果共享全局上限，避免大站点搜索卡住面板。
  const query = input.options.query.trim();
  if (!query) {
    return { results: [], error: "" };
  }
  const index = applyIgnoreRulesToIndex({
    resources: input.resources,
    sourceMappedResources: input.sourceMappedResources,
    ignoredRules: input.options.ignoredRules
  });

  const matcher = createSearchMatcher(query, input.options);
  if (!matcher.ok) {
    return { results: [], error: matcher.error };
  }

  const results: ResourceSearchResult[] = [];
  if (input.options.scope === "generated" || input.options.scope === "all") {
    for (const resource of index.resources) {
      if (results.length >= RESOURCE_SEARCH_RESULT_LIMIT) {
        break;
      }
      if (resource.ignored || resource.contentState !== "loaded" || !resource.content) {
        continue;
      }
      if (input.options.skipAnonymousScripts && isVirtualDebuggerScript(resource)) {
        continue;
      }
      results.push(
        ...searchContent({
          content: resource.content,
          matcher: matcher.match,
          resultLimit: RESOURCE_SEARCH_RESULT_LIMIT - results.length,
          perFileLimit: RESOURCE_SEARCH_RESULT_LIMIT_PER_FILE,
          createResult: (match, matchIndex) => ({
            id: `generated:${resource.id}:${match.lineNumber}:${match.columnNumber}:${matchIndex}`,
            scope: "generated",
            resourceId: resource.id,
            title: getResourceDisplayTitle(resource),
            url: resource.url,
            frameId: resource.frameId,
            origin: resource.origin,
            lineNumber: match.lineNumber,
            columnNumber: match.columnNumber,
            snippet: match.snippet
          })
        })
      );
    }
  }

  if (input.options.scope === "source-mapped" || input.options.scope === "all") {
    const generatedById = new Map(index.resources.map((resource) => [resource.id, resource]));
    for (const resource of index.sourceMappedResources) {
      if (results.length >= RESOURCE_SEARCH_RESULT_LIMIT) {
        break;
      }
      if (resource.ignored || resource.contentState !== "loaded" || !resource.content) {
        continue;
      }
      const generated = generatedById.get(resource.generatedResourceId);
      results.push(
        ...searchContent({
          content: resource.content,
          matcher: matcher.match,
          resultLimit: RESOURCE_SEARCH_RESULT_LIMIT - results.length,
          perFileLimit: RESOURCE_SEARCH_RESULT_LIMIT_PER_FILE,
          createResult: (match, matchIndex) => ({
            id: `source:${resource.id}:${match.lineNumber}:${match.columnNumber}:${matchIndex}`,
            scope: "source-mapped",
            resourceId: resource.id,
            title: resource.path || resourceTitle(resource.url),
            url: resource.url || generated?.url || "",
            frameId: generated?.frameId ?? "",
            origin: generated?.origin ?? originFromUrl(resource.url),
            lineNumber: match.lineNumber,
            columnNumber: match.columnNumber,
            snippet: match.snippet
          })
        })
      );
    }
  }

  return { results, error: "" };
}

export function parseSourceMap(input: {
  content: string;
  generatedResourceId: string;
  sourceMapUrl: string;
}): SourceMapParseResult {
  // 只索引 sourcesContent 已内联的源文件；未内联时浏览器未必允许扩展按 sources 路径直接读取内容。
  let raw: RawSourceMap;
  try {
    raw = JSON.parse(input.content) as RawSourceMap;
  } catch (error) {
    return { sources: [], error: `Source map JSON 解析失败：${formatError(error)}` };
  }

  if (!Array.isArray(raw.sources)) {
    return { sources: [], error: "Source map 缺少 sources 字段。" };
  }

  const sourceRoot = typeof raw.sourceRoot === "string" ? raw.sourceRoot : "";
  const sourcesContent = Array.isArray(raw.sourcesContent) ? raw.sourcesContent : [];
  const sources = raw.sources.map((source, index) => {
    const path = String(source ?? "");
    const content = typeof sourcesContent[index] === "string" ? sourcesContent[index] : "";
    return {
      id: `source-map:${input.generatedResourceId}:${index}:${path}`,
      generatedResourceId: input.generatedResourceId,
      sourceMapUrl: input.sourceMapUrl,
      path,
      url: resolveSourceUrl(input.sourceMapUrl, sourceRoot, path),
      contentState: content ? "loaded" : "missing",
      content,
      ignored: false,
      error: content ? "" : "Source map 未内联 sourcesContent。"
    } satisfies SourceMappedResource;
  });

  return { sources, error: "" };
}

export function inferResourceType(input: { url: string; mimeType?: string; resourceType?: string }): ResourceType {
  const mimeType = (input.mimeType ?? "").toLowerCase();
  const resourceType = (input.resourceType ?? "").toLowerCase();
  const pathname = pathnameFromUrl(input.url).toLowerCase();
  if (resourceType.includes("script") || mimeType.includes("javascript") || pathname.endsWith(".js")) {
    return "script";
  }
  if (resourceType.includes("stylesheet") || mimeType.includes("css") || pathname.endsWith(".css")) {
    return "stylesheet";
  }
  if (mimeType.includes("html") || resourceType.includes("document") || pathname.endsWith(".html")) {
    return "document";
  }
  if (mimeType.includes("json") || pathname.endsWith(".json")) {
    return pathname.endsWith(".map") ? "source-map" : "json";
  }
  if (pathname.endsWith(".map")) {
    return "source-map";
  }
  if (mimeType.startsWith("text/") || mimeType.includes("xml")) {
    return "text";
  }
  return "other";
}

export function isSearchableResource(resource: Pick<IndexedResource, "type" | "mimeType" | "content">): boolean {
  return (
    resource.type === "document" ||
    resource.type === "script" ||
    resource.type === "stylesheet" ||
    resource.type === "source-map" ||
    resource.type === "json" ||
    resource.type === "text" ||
    isTextMimeType(resource.mimeType)
  );
}

export function isVirtualDebuggerScript(resource: Pick<ResourceDisplayTarget, "id" | "url" | "source" | "type">): boolean {
  if (resource.source !== "debugger" || resource.type !== "script") {
    return false;
  }
  return resource.url.startsWith("debugger://inline-script/") || /^\d+$/.test(resource.url.trim()) || !hasOpenableResourceUrl(resource.url);
}

export function getResourceDisplayTitle(resource: Pick<ResourceDisplayTarget, "id" | "url" | "source" | "type">): string {
  if (isVirtualDebuggerScript(resource)) {
    return `匿名脚本 #${debuggerScriptLabel(resource)}`;
  }
  return resourceTitle(resource.url);
}

export function hasOpenableResourceUrl(url: string): boolean {
  return /^(https?|file|webpack|ng|vite|blob):/.test(url);
}

export function extractSourceMapUrl(content: string): string {
  const match = content.match(/[#@]\s*sourceMappingURL=([^\s]+)/);
  return match?.[1]?.trim() ?? "";
}

export function resolveSourceMapUrl(resourceUrl: string, sourceMapUrl: string): string {
  if (!sourceMapUrl) {
    return "";
  }
  if (sourceMapUrl.startsWith("data:")) {
    return sourceMapUrl;
  }
  try {
    return new URL(sourceMapUrl, resourceUrl).href;
  } catch {
    return sourceMapUrl;
  }
}

export function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function normalizeIgnoreRule(value: unknown): ResourceIgnoreRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as Record<string, unknown>;
  const pattern = typeof item.pattern === "string" ? item.pattern.trim() : "";
  if (!pattern) {
    return null;
  }
  const now = Date.now();
  return {
    id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
    enabled: item.enabled !== false,
    pattern,
    matchType: normalizeMatchType(item.matchType),
    target: normalizeIgnoreTarget(item.target),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now
  };
}

function normalizeMatchType(value: unknown): IgnoreMatchType {
  return value === "contains" || value === "regex" || value === "exact" ? value : "exact";
}

function normalizeIgnoreTarget(value: unknown): IgnoreTarget {
  return value === "generated-url" || value === "source-path" || value === "both" ? value : "both";
}

function matchesIgnoreRule(value: string, rule: ResourceIgnoreRule): boolean {
  if (rule.matchType === "exact") {
    return value === rule.pattern;
  }
  if (rule.matchType === "contains") {
    return value.includes(rule.pattern);
  }
  try {
    return new RegExp(rule.pattern).test(value);
  } catch {
    return false;
  }
}

function createSearchMatcher(
  query: string,
  options: Pick<ResourceSearchOptions, "caseSensitive" | "regexEnabled">
): { ok: true; match: (line: string) => Array<{ index: number; text: string }> } | { ok: false; error: string } {
  if (!options.regexEnabled) {
    const needle = options.caseSensitive ? query : query.toLowerCase();
    return {
      ok: true,
      match: (line) => {
        const haystack = options.caseSensitive ? line : line.toLowerCase();
        const matches: Array<{ index: number; text: string }> = [];
        let index = haystack.indexOf(needle);
        while (index >= 0) {
          matches.push({ index, text: line.slice(index, index + query.length) });
          index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
        }
        return matches;
      }
    };
  }

  try {
    const regex = new RegExp(query, options.caseSensitive ? "g" : "gi");
    return {
      ok: true,
      match: (line) =>
        Array.from(line.matchAll(regex)).map((match) => ({
          index: match.index ?? 0,
          text: match[0]
        }))
    };
  } catch (error) {
    return { ok: false, error: `正则表达式无效：${formatError(error)}` };
  }
}

function searchContent(input: {
  content: string;
  matcher: (line: string) => Array<{ index: number; text: string }>;
  resultLimit: number;
  perFileLimit: number;
  createResult: (
    match: { lineNumber: number; columnNumber: number; snippet: string },
    matchIndex: number
  ) => ResourceSearchResult;
}): ResourceSearchResult[] {
  const results: ResourceSearchResult[] = [];
  const lines = input.content.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (results.length >= input.resultLimit || results.length >= input.perFileLimit) {
      break;
    }
    const matches = input.matcher(line);
    for (const match of matches) {
      if (results.length >= input.resultLimit || results.length >= input.perFileLimit) {
        break;
      }
      results.push(
        input.createResult(
          {
            lineNumber: lineIndex + 1,
            columnNumber: match.index + 1,
            snippet: createSnippet(line, match.index, match.text.length)
          },
          results.length
        )
      );
    }
  }
  return results;
}

function createSnippet(line: string, index: number, length: number): string {
  const start = Math.max(0, index - 48);
  const end = Math.min(line.length, index + Math.max(length, 1) + 80);
  return `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`;
}

function resolveSourceUrl(sourceMapUrl: string, sourceRoot: string, path: string): string {
  const rawPath = sourceRoot ? `${sourceRoot.replace(/\/$/, "")}/${path}` : path;
  try {
    return new URL(rawPath, sourceMapUrl).href;
  } catch {
    return rawPath;
  }
}

function pathnameFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function resourceTitle(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.pathname.split("/").filter(Boolean).at(-1) || parsedUrl.hostname;
  } catch {
    return url || "(inline)";
  }
}

function debuggerScriptLabel(resource: Pick<ResourceDisplayTarget, "id" | "url">): string {
  const id = resource.id.startsWith("script:") ? resource.id.slice("script:".length) : resource.id;
  const inlinePrefix = "debugger://inline-script/";
  if (resource.url.startsWith(inlinePrefix)) {
    return resource.url.slice(inlinePrefix.length) || id;
  }
  return resource.url.trim() || id;
}

function isTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript")
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
