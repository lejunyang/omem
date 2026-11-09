import {
  RESOURCE_CONTENT_SIZE_LIMIT_BYTES,
  applyIgnoreRulesToIndex,
  extractSourceMapUrl,
  inferResourceType,
  isSearchableResource,
  originFromUrl,
  parseSourceMap,
  resolveSourceMapUrl,
  searchResourceIndex,
  type IndexedResource,
  type ResourceFrameNode,
  type ResourceIgnoreRule,
  type ResourceSearchOptions,
  type SourceMappedResource
} from "../shared/resource-search";
import type {
  IngestedResource,
  ResourceSearchIndexSnapshot,
  ResourceSearchMessage,
  ResourceSearchResponse
} from "../shared/resource-search-messages";

interface ResourceSearchServiceDeps {
  attachDebugger: (tabId: number) => Promise<void>;
  sendDebuggerCommand: <T = unknown>(tabId: number, method: string, params?: Record<string, unknown>) => Promise<T>;
  /** 不用 CDP 时，索引由 DevTools 面板用 inspectedWindow.getResources() 读好内容后送过来（ingest）。缺省视为开启。 */
  isCdpEnabled?: () => boolean;
}

interface ResourceSearchTabState {
  frames: ResourceFrameNode[];
  resources: Map<string, IndexedResource>;
  sourceMappedResources: Map<string, SourceMappedResource>;
  requestIdByUrl: Map<string, string>;
  networkMetaByRequestId: Map<string, NetworkResponseMeta>;
  active: boolean;
  indexing: Promise<void> | null;
  message: string;
}

interface NetworkResponseMeta {
  requestId: string;
  frameId: string;
  url: string;
  mimeType: string;
  resourceType: string;
  loadingFinished: boolean;
}

interface PageResourceTreeResult {
  frameTree?: RawFrameTree;
}

interface RawFrameTree {
  frame?: RawFrame;
  resources?: RawPageResource[];
  childFrames?: RawFrameTree[];
}

interface RawFrame {
  id?: string;
  parentId?: string;
  url?: string;
  name?: string;
  securityOrigin?: string;
}

interface RawPageResource {
  url?: string;
  type?: string;
  mimeType?: string;
}

interface PageResourceContentResult {
  content?: string;
  base64Encoded?: boolean;
}

interface NetworkResponseReceivedEvent {
  requestId: string;
  frameId?: string;
  type?: string;
  response?: {
    url?: string;
    mimeType?: string;
  };
}

interface NetworkLoadingFinishedEvent {
  requestId: string;
}

interface NetworkBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

interface DebuggerScriptParsedEvent {
  scriptId: string;
  url?: string;
  sourceMapURL?: string;
}

interface DebuggerScriptSourceResult {
  scriptSource?: string;
}

interface CssStyleSheetAddedEvent {
  header?: {
    styleSheetId?: string;
    frameId?: string;
    sourceURL?: string;
    sourceMapURL?: string;
    title?: string;
  };
}

interface CssStyleSheetTextResult {
  text?: string;
}

const resourceSearchTabs = new Map<number, ResourceSearchTabState>();

export function createResourceSearchService(deps: ResourceSearchServiceDeps) {
  async function handleMessage(message: ResourceSearchMessage): Promise<ResourceSearchResponse> {
    const state = getTabState(message.tabId);
    const cdpEnabled = deps.isCdpEnabled?.() ?? true;
    if (!cdpEnabled && (message.type === "advanced-network:resource-search-start" || message.type === "advanced-network:resource-search-refresh")) {
      if (!message.ingest) {
        return { ok: false, needsIngest: true, error: "需要由面板读取页面资源后再建立索引。" };
      }
      ingestIndex(state, message.ingest);
      await parseAllSourceMaps(message.tabId, state);
      state.message = `已索引 ${state.resources.size} 个资源，${state.sourceMappedResources.size} 个 sourcemap 源文件（未开启 CDP，只含 DevTools 能读到的资源）。`;
      return { ok: true, index: snapshot(state, message.ignoredRules ?? []) };
    }
    if (!cdpEnabled && !state.active && message.type !== "advanced-network:resource-search-open") {
      // 后台重启后内存里的索引没了；让面板重新读取资源。
      return { ok: false, needsIngest: true, error: "资源索引已失效，正在重新读取。" };
    }
    if (message.type === "advanced-network:resource-search-start" || message.type === "advanced-network:resource-search-refresh") {
      await refreshIndex(message.tabId, state);
      return {
        ok: true,
        index: snapshot(state, message.ignoredRules ?? [])
      };
    }

    if (message.type === "advanced-network:resource-search-get-index") {
      if (!state.active) {
        await refreshIndex(message.tabId, state);
      }
      return {
        ok: true,
        index: snapshot(state, message.ignoredRules ?? [])
      };
    }

    if (message.type === "advanced-network:resource-search-search") {
      if (!state.active) {
        await refreshIndex(message.tabId, state);
      }
      await ensureContentLoaded(message.tabId, state);
      const index = snapshot(state, message.options.ignoredRules);
      const search = searchResourceIndex({
        resources: index.resources,
        sourceMappedResources: index.sourceMappedResources,
        options: message.options
      });
      if (search.error) {
        return { ok: false, error: search.error, index };
      }
      return {
        ok: true,
        index,
        results: search.results
      };
    }

    return { ok: false, error: "Unknown resource search message." };
  }

  function handleDebuggerEvent(tabId: number, method: string, params: unknown): void {
    const state = resourceSearchTabs.get(tabId);
    if (!state?.active) {
      return;
    }
    if (method === "Network.responseReceived") {
      rememberNetworkResponse(state, params as NetworkResponseReceivedEvent);
    }
    if (method === "Network.loadingFinished") {
      markNetworkFinished(state, params as NetworkLoadingFinishedEvent);
    }
    if (method === "Debugger.scriptParsed") {
      rememberScript(state, params as DebuggerScriptParsedEvent);
    }
    if (method === "CSS.styleSheetAdded") {
      rememberStyleSheet(state, params as CssStyleSheetAddedEvent);
    }
  }

  function hasActiveTab(tabId: number): boolean {
    return resourceSearchTabs.get(tabId)?.active ?? false;
  }

  function clearTab(tabId: number): void {
    resourceSearchTabs.delete(tabId);
  }

  async function refreshIndex(tabId: number, state: ResourceSearchTabState): Promise<void> {
    if (state.indexing) {
      await state.indexing;
      return;
    }
    state.indexing = doRefreshIndex(tabId, state).finally(() => {
      state.indexing = null;
    });
    await state.indexing;
  }

  async function doRefreshIndex(tabId: number, state: ResourceSearchTabState): Promise<void> {
    state.active = true;
    state.frames = [];
    state.resources.clear();
    state.sourceMappedResources.clear();
    state.requestIdByUrl.clear();
    state.networkMetaByRequestId.clear();
    state.message = "";
    await deps.attachDebugger(tabId);
    await Promise.allSettled([
      deps.sendDebuggerCommand(tabId, "Page.enable"),
      deps.sendDebuggerCommand(tabId, "Network.enable"),
      deps.sendDebuggerCommand(tabId, "Debugger.enable"),
      deps.sendDebuggerCommand(tabId, "CSS.enable")
    ]);
    const tree = await deps.sendDebuggerCommand<PageResourceTreeResult>(tabId, "Page.getResourceTree");
    if (tree.frameTree) {
      state.frames = normalizeFrameTree(tree.frameTree);
      rememberPageResources(state, tree.frameTree);
    }
    await ensureContentLoaded(tabId, state);
    state.message = `已索引 ${state.resources.size} 个资源，${state.sourceMappedResources.size} 个 sourcemap 源文件。`;
  }

  async function ensureContentLoaded(tabId: number, state: ResourceSearchTabState): Promise<void> {
    for (const resource of state.resources.values()) {
      await ensureResourceContent(tabId, state, resource);
    }
    await parseAllSourceMaps(tabId, state);
  }

  async function ensureResourceContent(tabId: number, state: ResourceSearchTabState, resource: IndexedResource): Promise<void> {
    if (resource.contentState !== "unloaded") {
      return;
    }
    if (!isSearchableResource(resource)) {
      resource.contentState = "skipped";
      resource.error = "非文本资源已跳过。";
      return;
    }
    resource.contentState = "loading";
    try {
      const content = await loadResourceContent(tabId, state, resource);
      if (encodedSize(content) > RESOURCE_CONTENT_SIZE_LIMIT_BYTES) {
        resource.contentState = "skipped";
        resource.error = "资源超过大小限制，已跳过。";
        resource.content = "";
        return;
      }
      resource.content = content;
      resource.contentState = "loaded";
      resource.error = "";
      if (!resource.sourceMapUrl) {
        resource.sourceMapUrl = resolveSourceMapUrl(resource.url, extractSourceMapUrl(content));
      }
    } catch (error) {
      resource.contentState = "failed";
      resource.error = formatError(error);
    }
  }

  async function loadResourceContent(tabId: number, state: ResourceSearchTabState, resource: IndexedResource): Promise<string> {
    if (resource.source === "debugger" && resource.id.startsWith("script:")) {
      const scriptId = resource.id.slice("script:".length);
      const result = await deps.sendDebuggerCommand<DebuggerScriptSourceResult>(tabId, "Debugger.getScriptSource", { scriptId });
      return result.scriptSource ?? "";
    }

    if (resource.source === "css" && resource.id.startsWith("stylesheet:")) {
      const styleSheetId = resource.id.slice("stylesheet:".length);
      const result = await deps.sendDebuggerCommand<CssStyleSheetTextResult>(tabId, "CSS.getStyleSheetText", { styleSheetId });
      return result.text ?? "";
    }

    if (resource.frameId && resource.url && !resource.url.startsWith("debugger://") && !resource.url.startsWith("css://")) {
      try {
        const result = await deps.sendDebuggerCommand<PageResourceContentResult>(tabId, "Page.getResourceContent", {
          frameId: resource.frameId,
          url: resource.url
        });
        if (result.content !== undefined) {
          return decodeMaybeBase64(result.content, result.base64Encoded);
        }
      } catch {
        // Fall through to Network.getResponseBody; Page resources are not always retained.
      }
    }

    const requestId = state.requestIdByUrl.get(resource.url);
    if (requestId) {
      const result = await deps.sendDebuggerCommand<NetworkBodyResult>(tabId, "Network.getResponseBody", { requestId });
      return decodeMaybeBase64(result.body ?? "", result.base64Encoded);
    }

    if (resource.url.startsWith("http://") || resource.url.startsWith("https://")) {
      return fetchText(resource.url);
    }
    return "";
  }

  async function parseAllSourceMaps(tabId: number, state: ResourceSearchTabState): Promise<void> {
    const resources = Array.from(state.resources.values()).filter((resource) => resource.sourceMapUrl);
    for (const resource of resources) {
      if (!resource.sourceMapUrl) {
        continue;
      }
      const sourceMapContent = await loadSourceMapContent(tabId, state, resource.sourceMapUrl);
      if (!sourceMapContent) {
        continue;
      }
      const parsed = parseSourceMap({
        content: sourceMapContent,
        generatedResourceId: resource.id,
        sourceMapUrl: resource.sourceMapUrl
      });
      for (const source of parsed.sources) {
        if (source.contentState === "missing" && source.url) {
          try {
            source.content = await fetchText(source.url);
            source.contentState = source.content ? "loaded" : "missing";
            source.error = source.content ? "" : source.error;
          } catch (error) {
            source.contentState = "failed";
            source.error = formatError(error);
          }
        }
        state.sourceMappedResources.set(source.id, source);
      }
    }
  }

  async function loadSourceMapContent(tabId: number, state: ResourceSearchTabState, sourceMapUrl: string): Promise<string> {
    if (sourceMapUrl.startsWith("data:")) {
      return decodeDataUrl(sourceMapUrl);
    }
    const existing = state.resources.get(resourceId("page", sourceMapUrl)) ?? state.resources.get(resourceId("network", sourceMapUrl));
    if (existing) {
      await ensureResourceContent(tabId, state, existing);
      return existing.content;
    }
    try {
      return await fetchText(sourceMapUrl);
    } catch {
      return "";
    }
  }

  return {
    clearTab,
    handleDebuggerEvent,
    handleMessage,
    hasActiveTab
  };
}

export type ResourceSearchService = ReturnType<typeof createResourceSearchService>;

function getTabState(tabId: number): ResourceSearchTabState {
  const existing = resourceSearchTabs.get(tabId);
  if (existing) {
    return existing;
  }
  const state: ResourceSearchTabState = {
    frames: [],
    resources: new Map(),
    sourceMappedResources: new Map(),
    requestIdByUrl: new Map(),
    networkMetaByRequestId: new Map(),
    active: false,
    indexing: null,
    message: ""
  };
  resourceSearchTabs.set(tabId, state);
  return state;
}

function snapshot(state: ResourceSearchTabState, ignoredRules: ResourceIgnoreRule[]): ResourceSearchIndexSnapshot {
  const ignored = applyIgnoreRulesToIndex({
    resources: Array.from(state.resources.values()),
    sourceMappedResources: Array.from(state.sourceMappedResources.values()),
    ignoredRules
  });
  return {
    frames: state.frames,
    resources: ignored.resources,
    sourceMappedResources: ignored.sourceMappedResources,
    message: state.message
  };
}

function normalizeFrameTree(tree: RawFrameTree): ResourceFrameNode[] {
  const node = normalizeFrameNode(tree);
  return node ? [node] : [];
}

function normalizeFrameNode(tree: RawFrameTree): ResourceFrameNode | null {
  const frame = tree.frame;
  if (!frame?.id) {
    return null;
  }
  return {
    frameId: frame.id,
    parentFrameId: frame.parentId ?? null,
    url: frame.url ?? "",
    name: frame.name || frame.url || frame.id,
    securityOrigin: frame.securityOrigin ?? originFromUrl(frame.url ?? ""),
    children: (tree.childFrames ?? []).map((child) => normalizeFrameNode(child)).filter((child): child is ResourceFrameNode => child !== null)
  };
}

function rememberPageResources(state: ResourceSearchTabState, tree: RawFrameTree): void {
  const frameId = tree.frame?.id ?? "";
  for (const resource of tree.resources ?? []) {
    if (!resource.url) {
      continue;
    }
    upsertResource(state, {
      id: resourceId("page", resource.url),
      frameId,
      url: resource.url,
      origin: originFromUrl(resource.url),
      type: inferResourceType({
        url: resource.url,
        mimeType: resource.mimeType,
        resourceType: resource.type
      }),
      source: "page",
      mimeType: resource.mimeType ?? "",
      contentState: "unloaded",
      content: "",
      sourceMapUrl: "",
      generatedResourceId: null,
      ignored: false,
      error: ""
    });
  }
  for (const child of tree.childFrames ?? []) {
    rememberPageResources(state, child);
  }
}

function rememberNetworkResponse(state: ResourceSearchTabState, event: NetworkResponseReceivedEvent): void {
  const url = event.response?.url ?? "";
  if (!url) {
    return;
  }
  const meta: NetworkResponseMeta = {
    requestId: event.requestId,
    frameId: event.frameId ?? "",
    url,
    mimeType: event.response?.mimeType ?? "",
    resourceType: event.type ?? "",
    loadingFinished: false
  };
  state.networkMetaByRequestId.set(event.requestId, meta);
  state.requestIdByUrl.set(url, event.requestId);
  upsertResource(state, {
    id: resourceId("network", url),
    frameId: meta.frameId,
    url,
    origin: originFromUrl(url),
    type: inferResourceType({
      url,
      mimeType: meta.mimeType,
      resourceType: meta.resourceType
    }),
    source: "network",
    mimeType: meta.mimeType,
    contentState: "unloaded",
    content: "",
    sourceMapUrl: "",
    generatedResourceId: null,
    ignored: false,
    error: ""
  });
}

function markNetworkFinished(state: ResourceSearchTabState, event: NetworkLoadingFinishedEvent): void {
  const meta = state.networkMetaByRequestId.get(event.requestId);
  if (meta) {
    meta.loadingFinished = true;
  }
}

function rememberScript(state: ResourceSearchTabState, event: DebuggerScriptParsedEvent): void {
  const url = event.url || `debugger://inline-script/${event.scriptId}`;
  upsertResource(state, {
    id: `script:${event.scriptId}`,
    frameId: "",
    url,
    origin: originFromUrl(url),
    type: "script",
    source: "debugger",
    mimeType: "text/javascript",
    contentState: "unloaded",
    content: "",
    sourceMapUrl: resolveSourceMapUrl(url, event.sourceMapURL ?? ""),
    generatedResourceId: null,
    ignored: false,
    error: ""
  });
}

function rememberStyleSheet(state: ResourceSearchTabState, event: CssStyleSheetAddedEvent): void {
  const header = event.header;
  if (!header?.styleSheetId) {
    return;
  }
  const url = header.sourceURL || `css://inline-stylesheet/${header.styleSheetId}`;
  upsertResource(state, {
    id: `stylesheet:${header.styleSheetId}`,
    frameId: header.frameId ?? "",
    url,
    origin: originFromUrl(url),
    type: "stylesheet",
    source: "css",
    mimeType: "text/css",
    contentState: "unloaded",
    content: "",
    sourceMapUrl: resolveSourceMapUrl(url, header.sourceMapURL ?? ""),
    generatedResourceId: null,
    ignored: false,
    error: ""
  });
}

function ingestIndex(state: ResourceSearchTabState, ingest: IngestedResource[]): void {
  state.active = true;
  state.frames = [];
  state.resources.clear();
  state.sourceMappedResources.clear();
  state.requestIdByUrl.clear();
  state.networkMetaByRequestId.clear();
  ingest.forEach((item, index) => {
    if (!item.url) return;
    const isInline = !/^https?:/.test(item.url);
    const url = isInline ? `inline://${item.type}/${index}` : item.url;
    const base: IndexedResource = {
      id: resourceId("page", url),
      frameId: "",
      url,
      origin: originFromUrl(url),
      type: inferResourceType({ url, mimeType: item.mimeType, resourceType: item.type }),
      source: "page",
      mimeType: item.mimeType ?? "",
      contentState: "unloaded",
      content: "",
      sourceMapUrl: "",
      generatedResourceId: null,
      ignored: false,
      error: ""
    };
    if (!isSearchableResource(base)) {
      upsertResource(state, { ...base, contentState: "skipped", error: "非文本资源已跳过。" });
      return;
    }
    if (typeof item.content !== "string") {
      upsertResource(state, { ...base, contentState: "failed", error: item.error || "DevTools 没有返回内容。" });
      return;
    }
    if (encodedSize(item.content) > RESOURCE_CONTENT_SIZE_LIMIT_BYTES) {
      upsertResource(state, { ...base, contentState: "skipped", error: "资源超过大小限制，已跳过。" });
      return;
    }
    upsertResource(state, {
      ...base,
      contentState: "loaded",
      content: item.content,
      sourceMapUrl: isInline ? "" : resolveSourceMapUrl(url, extractSourceMapUrl(item.content))
    });
  });
}

function upsertResource(state: ResourceSearchTabState, resource: IndexedResource): void {
  const existing = state.resources.get(resource.id);
  if (!existing) {
    state.resources.set(resource.id, resource);
    return;
  }
  state.resources.set(resource.id, {
    ...existing,
    ...resource,
    contentState: existing.contentState === "loaded" ? existing.contentState : resource.contentState,
    content: existing.content || resource.content,
    sourceMapUrl: existing.sourceMapUrl || resource.sourceMapUrl,
    error: existing.error || resource.error
  });
}

function resourceId(source: "page" | "network", url: string): string {
  return `${source}:${url}`;
}

function decodeMaybeBase64(value: string, base64Encoded: boolean | undefined): string {
  if (!base64Encoded) {
    return value;
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeDataUrl(url: string): string {
  const commaIndex = url.indexOf(",");
  if (commaIndex < 0) {
    return "";
  }
  const meta = url.slice(0, commaIndex);
  const data = url.slice(commaIndex + 1);
  return meta.includes(";base64") ? decodeMaybeBase64(data, true) : decodeURIComponent(data);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`读取资源失败：${response.status}`);
  }
  return response.text();
}

function encodedSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
