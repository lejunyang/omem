import type {
  IndexedResource,
  ResourceFrameNode,
  ResourceIgnoreRule,
  ResourceSearchOptions,
  ResourceSearchResult,
  SourceMappedResource
} from "./resource-search";

export interface ResourceSearchIndexSnapshot {
  frames: ResourceFrameNode[];
  resources: IndexedResource[];
  sourceMappedResources: SourceMappedResource[];
  message: string;
}

/** 不用 CDP 时面板从 chrome.devtools.inspectedWindow.getResources() 读到的资源。 */
export interface IngestedResource {
  url: string;
  /** DevTools 的资源类型：document / script / stylesheet / image …… */
  type: string;
  mimeType?: string;
  content?: string;
  error?: string;
}

export type ResourceSearchMessage =
  | {
      type: "advanced-network:resource-search-start";
      tabId: number;
      ignoredRules?: ResourceIgnoreRule[];
      ingest?: IngestedResource[];
    }
  | {
      type: "advanced-network:resource-search-refresh";
      tabId: number;
      ignoredRules?: ResourceIgnoreRule[];
      ingest?: IngestedResource[];
    }
  | {
      type: "advanced-network:resource-search-get-index";
      tabId: number;
      ignoredRules?: ResourceIgnoreRule[];
    }
  | {
      type: "advanced-network:resource-search-search";
      tabId: number;
      options: ResourceSearchOptions;
    }
  | {
      type: "advanced-network:resource-search-open";
      tabId: number;
      resourceId: string;
      scope: "generated" | "source-mapped";
    };

export interface ResourceSearchResponse {
  ok: boolean;
  error?: string;
  debuggerUnavailable?: boolean;
  cdpDisabled?: boolean;
  /** 不用 CDP 且后台没有索引：面板需要重新读取资源并发 refresh。 */
  needsIngest?: boolean;
  recoveryHint?: string;
  index?: ResourceSearchIndexSnapshot;
  results?: ResourceSearchResult[];
}

export function isResourceSearchMessage(value: unknown): value is ResourceSearchMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === "advanced-network:resource-search-start" ||
    type === "advanced-network:resource-search-refresh" ||
    type === "advanced-network:resource-search-get-index" ||
    type === "advanced-network:resource-search-search" ||
    type === "advanced-network:resource-search-open"
  );
}
