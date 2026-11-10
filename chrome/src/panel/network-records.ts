import type { DevtoolsRequest, NetworkRecord } from "../shared/network";
import { matchesAdvancedQuery, matchesStatus, matchesType, type StatusFilter, type TypeFilter } from "../shared/network-filters";

type ExtendedDevtoolsRequest = DevtoolsRequest & {
  _resourceType?: string;
  _documentURL?: string;
  documentURL?: string;
};

export function shouldReplaceRecordsFromHar(input: {
  currentCount: number;
  entryCount: number;
  force?: boolean;
}): boolean {
  // HAR 快照可能在 DevTools 初始化或页面忙碌时短暂返回空列表，不能因此覆盖已有请求。
  return Boolean(input.force) || input.entryCount > 0 || input.currentCount === 0;
}

// 处理单个请求到达前的兜底清空：只有能确认这是主文档导航时才清空，避免 iframe 或延迟 HTML 子请求误删列表。
export function shouldClearRecordsBeforeRequest(input: {
  preserveLog: boolean;
  record: NetworkRecord;
  currentCount: number;
}): boolean {
  return !input.preserveLog && input.currentCount > 0 && isMainDocumentNavigation(input.record);
}

// 处理 DevTools 导航事件触发的权威清空：刷新/跳转应遵循“保留日志”状态，而不是依赖 HAR 条目的非标准元数据。
export function shouldClearRecordsOnNavigation(input: {
  preserveLog: boolean;
  currentCount: number;
}): boolean {
  return !input.preserveLog && input.currentCount > 0;
}

// 识别主文档请求时只信任 DevTools 暴露的资源类型和 documentURL；缺少这些字段时宁可不清空，避免历史上的误清空回归。
export function isMainDocumentNavigation(record: NetworkRecord): boolean {
  if (record.method.toUpperCase() !== "GET") {
    return false;
  }

  const har = record.har as ExtendedDevtoolsRequest;
  const resourceType = har._resourceType?.toLowerCase();
  if (resourceType && resourceType !== "document") {
    return false;
  }

  const documentUrl = har._documentURL || har.documentURL;
  if (documentUrl) {
    return stripHash(documentUrl) === stripHash(record.url);
  }

  // When DevTools does not expose frame metadata, avoid clearing on late HTML
  // subresources; manual "清空" still provides an explicit reset.
  return false;
}

export function matchesPanelRecordFilters(input: {
  record: NetworkRecord;
  filter: string;
  typeFilter: TypeFilter;
  statusFilter: StatusFilter;
  matchesEnabledPresets: (record: NetworkRecord) => boolean;
}): boolean {
  return (
    matchesAdvancedQuery(input.record, input.filter) &&
    matchesType(input.record, input.typeFilter) &&
    matchesStatus(input.record, input.statusFilter) &&
    input.matchesEnabledPresets(input.record)
  );
}

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url.split("#", 1)[0] ?? url;
  }
}
