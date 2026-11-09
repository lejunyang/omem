import { computed, onMounted, ref } from "vue";
import { getStorageItems, setStorageItemsAndVerify } from "../shared/extension-storage";
import {
  RESOURCE_IGNORE_STORAGE_KEY,
  createIgnoreRule,
  getResourceDisplayTitle,
  hasOpenableResourceUrl,
  isVirtualDebuggerScript,
  normalizeIgnoreRules,
  type IndexedResource,
  type IgnoreMatchType,
  type IgnoreTarget,
  type ResourceFrameNode,
  type ResourceIgnoreRule,
  type ResourceSearchResult,
  type ResourceSearchScope,
  type SourceMappedResource
} from "../shared/resource-search";
import type { ResourceSearchMessage, ResourceSearchResponse } from "../shared/resource-search-messages";
import { readInspectedResources } from "./devtools-api";

export interface NewIgnoreRuleInput {
  pattern: string;
  matchType: IgnoreMatchType;
  target: IgnoreTarget;
}

export interface ResourceSourcePreview {
  title: string;
  url: string;
  meta: string[];
  content: string;
  lineNumber: number;
  excerpt: string;
}

export function useResourceSearchContext() {
  const frames = ref<ResourceFrameNode[]>([]);
  const resources = ref<IndexedResource[]>([]);
  const sourceMappedResources = ref<SourceMappedResource[]>([]);
  const ignoredRules = ref<ResourceIgnoreRule[]>([]);
  const results = ref<ResourceSearchResult[]>([]);
  const query = ref("");
  const scope = ref<ResourceSearchScope>("all");
  const caseSensitive = ref(false);
  const regexEnabled = ref(false);
  const message = ref("");
  const sourcePreview = ref<ResourceSourcePreview | null>(null);
  const isIndexing = ref(false);
  const showIgnoreManager = ref(false);
  const skipChromeExtensionResources = ref(true);
  const skipAnonymousScripts = ref(true);
  const showSkippedResources = ref(false);
  const newIgnorePattern = ref("");
  const newIgnoreMatchType = ref<IgnoreMatchType>("contains");
  const newIgnoreTarget = ref<IgnoreTarget>("both");
  const ignoredRuleCount = computed(() => ignoredRules.value.filter((rule) => rule.enabled).length);

  onMounted(() => {
    void initialize();
  });

  async function initialize(): Promise<void> {
    await loadIgnoreRules();
    await refreshResourceIndex();
  }

  async function loadIgnoreRules(): Promise<void> {
    const items = await getStorageItems(chrome.storage.local, [RESOURCE_IGNORE_STORAGE_KEY]);
    ignoredRules.value = normalizeIgnoreRules(items[RESOURCE_IGNORE_STORAGE_KEY]);
  }

  async function persistIgnoreRules(): Promise<void> {
    await setStorageItemsAndVerify(chrome.storage.local, {
      [RESOURCE_IGNORE_STORAGE_KEY]: ignoredRules.value
    });
  }

  async function refreshResourceIndex(): Promise<void> {
    isIndexing.value = true;
    try {
      const response = await sendMessage({
        type: "advanced-network:resource-search-refresh",
        tabId: chrome.devtools.inspectedWindow.tabId,
        ignoredRules: ignoredRules.value
      });
      applyResponse(response);
      if (response.ok) {
        message.value = response.index?.message || "资源索引已刷新。";
      }
    } finally {
      isIndexing.value = false;
    }
  }

  async function searchResources(): Promise<void> {
    const response = await sendMessage({
      type: "advanced-network:resource-search-search",
      tabId: chrome.devtools.inspectedWindow.tabId,
      options: {
        query: query.value,
        scope: scope.value,
        caseSensitive: caseSensitive.value,
        regexEnabled: regexEnabled.value,
        ignoredRules: ignoredRules.value,
        skipAnonymousScripts: skipAnonymousScripts.value
      }
    });
    applyResponse(response);
    results.value = response.results ?? [];
    if (response.ok) {
      message.value = query.value.trim()
        ? `找到 ${results.value.length} 条结果。`
        : response.index?.message || "请输入搜索内容。";
    }
  }

  function openResourceResult(result: ResourceSearchResult): void {
    if (result.scope === "generated") {
      const resource = resources.value.find((item) => item.id === result.resourceId);
      if (resource && openGeneratedResourcePreview(resource, result.lineNumber)) {
        return;
      }
    } else {
      const resource = sourceMappedResources.value.find((item) => item.id === result.resourceId);
      if (resource) {
        openSourceMappedResourceAtLine(resource, result.lineNumber);
        return;
      }
    }
    if (!result.url) {
      message.value = "当前结果没有可打开的资源 URL。";
      return;
    }
    chrome.devtools.panels.openResource(result.url, Math.max(result.lineNumber - 1, 0), () => {
      const error = chrome.runtime.lastError;
      message.value = error ? `打开资源失败：${error.message}` : "";
    });
  }

  function openGeneratedResource(resource: IndexedResource): void {
    if (openGeneratedResourcePreview(resource, 1)) {
      return;
    }
    openResourceUrl(resource.url, 0);
  }

  function openSourceMappedResource(resource: SourceMappedResource): void {
    openSourceMappedResourceAtLine(resource, 1);
  }

  function openSourceMappedResourceAtLine(resource: SourceMappedResource, lineNumber: number): void {
    const generated = resources.value.find((item) => item.id === resource.generatedResourceId);
    const preview = () => openSourceMappedResourcePreview(resource, lineNumber, generated);
    if (resource.content) {
      preview();
      return;
    }
    if (!hasOpenableResourceUrl(resource.url)) {
      preview();
      return;
    }
    chrome.devtools.panels.openResource(resource.url, Math.max(lineNumber - 1, 0), () => {
      const error = chrome.runtime.lastError;
      if (error) {
        preview();
        return;
      }
      message.value = "";
    });
  }

  async function ignoreGeneratedResource(resource: IndexedResource): Promise<void> {
    if (!resource.url) {
      return;
    }
    await addIgnoreRule({
      pattern: resource.url,
      matchType: "exact",
      target: "generated-url"
    });
  }

  async function ignoreSourceMappedResource(resource: SourceMappedResource): Promise<void> {
    const pattern = resource.path || resource.url;
    if (!pattern) {
      return;
    }
    await addIgnoreRule({
      pattern,
      matchType: "exact",
      target: "source-path"
    });
  }

  async function ignoreSearchResult(result: ResourceSearchResult): Promise<void> {
    if (result.scope === "generated") {
      const resource = resources.value.find((item) => item.id === result.resourceId);
      if (resource) {
        await ignoreGeneratedResource(resource);
      }
      return;
    }
    const resource = sourceMappedResources.value.find((item) => item.id === result.resourceId);
    if (resource) {
      await ignoreSourceMappedResource(resource);
    }
  }

  async function addIgnoreRule(input?: NewIgnoreRuleInput): Promise<void> {
    const pattern = input?.pattern.trim() || newIgnorePattern.value.trim();
    if (!pattern) {
      message.value = "请填写忽略规则。";
      return;
    }
    ignoredRules.value = [
      ...ignoredRules.value,
      createIgnoreRule({
        pattern,
        matchType: input?.matchType ?? newIgnoreMatchType.value,
        target: input?.target ?? newIgnoreTarget.value
      })
    ];
    newIgnorePattern.value = "";
    await persistIgnoreRules();
    await searchResources();
  }

  async function deleteIgnoreRule(ruleId: string): Promise<void> {
    ignoredRules.value = ignoredRules.value.filter((rule) => rule.id !== ruleId);
    await persistIgnoreRules();
    await searchResources();
  }

  async function toggleIgnoreRule(ruleId: string): Promise<void> {
    ignoredRules.value = ignoredRules.value.map((rule) =>
      rule.id === ruleId
        ? {
            ...rule,
            enabled: !rule.enabled,
            updatedAt: Date.now()
          }
        : rule
    );
    await persistIgnoreRules();
    await searchResources();
  }

  function applyResponse(response: ResourceSearchResponse): void {
    if (!response.ok) {
      const hint = response.recoveryHint ? ` ${response.recoveryHint}` : "";
      message.value = `${response.error ?? "资源搜索失败。"}${hint}`;
    }
    if (response.index) {
      frames.value = response.index.frames;
      resources.value = response.index.resources;
      sourceMappedResources.value = response.index.sourceMappedResources;
    }
  }

  async function sendMessage(message: ResourceSearchMessage): Promise<ResourceSearchResponse> {
    const response = (await chrome.runtime.sendMessage(message)) as ResourceSearchResponse;
    if (!response?.needsIngest) return response;
    // 不用 CDP：后台没法自己读页面资源，由面板从 DevTools 读好送过去，再重发原请求。
    const refreshed = (await chrome.runtime.sendMessage({
      type: "advanced-network:resource-search-refresh",
      tabId: chrome.devtools.inspectedWindow.tabId,
      ignoredRules: ignoredRules.value,
      ingest: await readInspectedResources()
    } satisfies ResourceSearchMessage)) as ResourceSearchResponse;
    if (!refreshed?.ok || message.type === "advanced-network:resource-search-refresh" || message.type === "advanced-network:resource-search-start") {
      return refreshed;
    }
    return chrome.runtime.sendMessage(message) as Promise<ResourceSearchResponse>;
  }

  function openResourceUrl(url: string, lineNumber: number): void {
    if (!url) {
      message.value = "当前资源没有可打开的 URL。";
      return;
    }
    chrome.devtools.panels.openResource(url, lineNumber, () => {
      const error = chrome.runtime.lastError;
      message.value = error ? `打开资源失败：${error.message}` : "";
    });
  }

  function openGeneratedResourcePreview(resource: IndexedResource, lineNumber: number): boolean {
    if (!isVirtualDebuggerScript(resource) && hasOpenableResourceUrl(resource.url)) {
      return false;
    }
    if (!resource.content) {
      message.value = resource.contentState === "failed" ? `源码读取失败：${resource.error || "未知错误"}` : "当前脚本源码尚未加载，请先刷新索引或执行搜索。";
      return true;
    }
    sourcePreview.value = {
      title: getResourceDisplayTitle(resource),
      url: resource.url,
      meta: [`数据源：${resource.source} / Debugger.getScriptSource`, `资源 ID：${resource.id}`],
      content: resource.content,
      lineNumber: Math.max(lineNumber, 1),
      excerpt: createSourcePreviewExcerpt(resource.content, Math.max(lineNumber, 1))
    };
    message.value = "";
    return true;
  }

  function openSourceMappedResourcePreview(
    resource: SourceMappedResource,
    lineNumber: number,
    generated?: IndexedResource
  ): void {
    if (resource.content) {
      sourcePreview.value = {
        title: resource.path || resource.url || resource.id,
        url: resource.url,
        meta: [
          "数据源：Source Map sourcesContent",
          `Source Map：${resource.sourceMapUrl}`,
          generated ? `Generated：${generated.url}` : `Generated Resource ID：${resource.generatedResourceId}`
        ],
        content: resource.content,
        lineNumber: Math.max(lineNumber, 1),
        excerpt: createSourcePreviewExcerpt(resource.content, Math.max(lineNumber, 1))
      };
      message.value = "";
      return;
    }
    const fallbackUrl = generated?.url ?? "";
    if (fallbackUrl) {
      openSourceMappedGeneratedFallback(fallbackUrl, resource.error || "Source Map 未内联源码内容，已回退打开生成后资源。");
      return;
    }
    message.value = resource.error || "Source Map 未内联源码内容，且没有可回退打开的生成后资源。";
  }

  function openSourceMappedGeneratedFallback(url: string, successMessage: string): void {
    chrome.devtools.panels.openResource(url, 0, () => {
      const error = chrome.runtime.lastError;
      message.value = error ? `打开生成后资源失败：${error.message}` : successMessage;
    });
  }

  function closeSourcePreview(): void {
    sourcePreview.value = null;
  }

  function createSourcePreviewExcerpt(content: string, lineNumber: number): string {
    const lines = content.split(/\r?\n/);
    const targetIndex = Math.min(Math.max(lineNumber - 1, 0), Math.max(lines.length - 1, 0));
    const start = Math.max(0, targetIndex - 12);
    const end = Math.min(lines.length, targetIndex + 13);
    return lines
      .slice(start, end)
      .map((line, index) => {
        const currentLine = start + index + 1;
        const marker = currentLine === lineNumber ? ">" : " ";
        return `${marker} ${String(currentLine).padStart(5, " ")} | ${line}`;
      })
      .join("\n");
  }

  return {
    addIgnoreRule,
    caseSensitive,
    closeSourcePreview,
    deleteIgnoreRule,
    frames,
    ignoreGeneratedResource,
    ignoreSearchResult,
    ignoreSourceMappedResource,
    ignoredRuleCount,
    ignoredRules,
    isIndexing,
    message,
    newIgnoreMatchType,
    newIgnorePattern,
    newIgnoreTarget,
    openResourceResult,
    openGeneratedResource,
    openSourceMappedResource,
    query,
    refreshResourceIndex,
    regexEnabled,
    resources,
    results,
    scope,
    searchResources,
    showIgnoreManager,
    skipAnonymousScripts,
    skipChromeExtensionResources,
    sourcePreview,
    showSkippedResources,
    sourceMappedResources,
    toggleIgnoreRule
  };
}

export type ResourceSearchContext = ReturnType<typeof useResourceSearchContext>;
