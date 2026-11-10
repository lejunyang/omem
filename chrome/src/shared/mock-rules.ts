import type { HeaderPair, NetworkRecord } from "./network";
import { matchesAdvancedQuery } from "./network-filters";
import { normalizeStoredList } from "./stored-list";

export const MOCK_RULE_STORAGE_KEY = "advancedNetwork.mockRules";
export const MOCK_GROUP_STORAGE_KEY = "advancedNetwork.mockGroups";
export const DEFAULT_MOCK_GROUP_ID = "default";

export type MockScope = "domain" | "global";
export type MockAction = "replace-headers" | "replace-body" | "script";

export interface MockGroup {
  id: string;
  name: string;
  enabled: boolean;
  pageUrlContains: string;
  createdAt: number;
  updatedAt: number;
}

export interface MockRule {
  id: string;
  groupId: string;
  name: string;
  enabled: boolean;
  scope: MockScope;
  domain: string;
  matcherQuery: string;
  method: string;
  url: string;
  action: MockAction;
  responseHeaders: HeaderPair[];
  responseBody: string;
  script: string;
  createdAt: number;
  updatedAt: number;
}

export function createMockRuleFromRecord(input: {
  id: string;
  record: NetworkRecord;
  scope: MockScope;
  action: MockAction;
  groupId?: string;
  responseBody?: string;
  now: number;
}): MockRule {
  // 从右键请求生成规则时，只固定 method 与 path/query，避免同域不同环境的 origin 变化让规则失效。
  const domain = hostname(input.record.url);
  const responseBody = input.responseBody ?? input.record.responseBody;

  return {
    id: input.id,
    groupId: input.groupId ?? DEFAULT_MOCK_GROUP_ID,
    name: `${mockActionLabel(input.action)} ${input.record.name}`,
    enabled: true,
    scope: input.scope,
    domain,
    matcherQuery: `method:${input.record.method} url:${quoteIfNeeded(pathWithSearch(input.record.url))}`,
    method: input.record.method,
    url: input.record.url,
    action: input.action,
    responseHeaders: input.record.responseHeaders,
    responseBody: responseBody || defaultJsonBody(),
    script: defaultMockScript(responseBody || defaultJsonBody(), input.record.responseHeaders),
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function createBlankMockRule(input: {
  id: string;
  groupId: string;
  now: number;
}): MockRule {
  // 主动新增规则没有来源请求，默认使用最安全的替换响应头，避免空 JSON/JS 规则误影响请求体。
  return {
    id: input.id,
    groupId: input.groupId,
    name: "替换响应头 新规则",
    enabled: true,
    scope: "global",
    domain: "",
    matcherQuery: "",
    method: "GET",
    url: "",
    action: "replace-headers",
    responseHeaders: [{ name: "x-mock", value: "1" }],
    responseBody: defaultJsonBody(),
    script: defaultMockScript(defaultJsonBody(), [{ name: "x-mock", value: "1" }]),
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function normalizeMockRules(value: unknown): MockRule[] {
  // storage 里可能保存数组，也可能在 DevTools 展示/迁移中变成数字键对象，统一走 normalizeStoredList。
  return normalizeStoredList(value).flatMap((item) => {
    if (!isMockRuleLike(item)) {
      return [];
    }
    return [
      {
        id: item.id,
        groupId: typeof item.groupId === "string" ? item.groupId : DEFAULT_MOCK_GROUP_ID,
        name: item.name,
        enabled: typeof item.enabled === "boolean" ? item.enabled : true,
        scope: item.scope === "global" ? "global" : "domain",
        domain: item.domain,
        matcherQuery: item.matcherQuery,
        method: item.method,
        url: item.url,
        action: normalizeAction(item.action),
        responseHeaders: normalizeHeaders(item.responseHeaders),
        responseBody: typeof item.responseBody === "string" ? item.responseBody : defaultJsonBody(),
        script: typeof item.script === "string" ? item.script : defaultMockScript(defaultJsonBody(), []),
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now()
      }
    ];
  });
}

export function normalizeMockGroups(value: unknown): MockGroup[] {
  // Mock 组缺失时仍要保留默认组，否则旧规则或新建草稿会失去挂载位置。
  const storedGroups = normalizeStoredList(value);
  if (!storedGroups.length) {
    return [createDefaultMockGroup(Date.now())];
  }

  const groups = storedGroups.flatMap((item) => {
    if (!isMockGroupLike(item)) {
      return [];
    }
    return [
      {
        id: item.id,
        name: item.name,
        enabled: typeof item.enabled === "boolean" ? item.enabled : true,
        pageUrlContains: typeof item.pageUrlContains === "string" ? item.pageUrlContains : "",
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now()
      }
    ];
  });

  return ensureDefaultMockGroup(groups);
}

export function createMockGroup(input: {
  id: string;
  name: string;
  pageUrlContains?: string;
  now: number;
}): MockGroup {
  return {
    id: input.id,
    name: input.name,
    enabled: true,
    pageUrlContains: input.pageUrlContains ?? "",
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function groupMatchesPageUrl(group: MockGroup | undefined, pageUrl: string): boolean {
  // 组条件目前使用“包含”语义，便于 SSO 和目标站点这类多路径场景用一段 URL 片段统一控制。
  if (!group || !group.enabled) {
    return false;
  }
  const condition = group.pageUrlContains.trim().toLowerCase();
  if (!condition) {
    return true;
  }
  return pageUrl.toLowerCase().includes(condition);
}

export function filterMockRulesByDomain(rules: MockRule[], domain: string): MockRule[] {
  return rules.filter((rule) => rule.scope === "global" || rule.domain === domain);
}

export function ruleMatchesRequest(
  rule: MockRule,
  request: {
    method: string;
    url: string;
    status: number | null;
    responseHeaders: HeaderPair[];
  }
): boolean {
  // 复用高级筛选 DSL 作为 Mock 匹配语言，让筛选和 Mock 的 method/status/header 语义保持一致。
  const record = createMatchRecord(rule, request);
  return matchesAdvancedQuery(record, rule.matcherQuery);
}

export function describeMockRule(rule: MockRule): string {
  return [
    `${rule.enabled ? "启用" : "停用"} / ${rule.scope === "global" ? "全部域名" : rule.domain}`,
    `组：${rule.groupId}`,
    rule.matcherQuery,
    mockActionLabel(rule.action)
  ].join(" / ");
}

function mockActionLabel(action: MockAction): string {
  if (action === "replace-headers") {
    return "替换响应头";
  }
  if (action === "script") {
    return "JS 修改响应";
  }
  return "替换响应体";
}

function createMatchRecord(
  rule: MockRule,
  request: {
    method: string;
    url: string;
    status: number | null;
    responseHeaders: HeaderPair[];
  }
): NetworkRecord {
  return {
    id: `${request.method}-${request.url}`,
    url: request.url,
    name: request.url,
    method: request.method,
    status: request.status,
    statusText: "",
    resourceType: "fetch/xhr",
    mimeType: "application/json",
    requestHeaders: [],
    responseHeaders: request.responseHeaders,
    queryParams: [],
    postParams: [],
    requestBody: "",
    responseBody: rule.responseBody,
    bodyState: "loaded",
    bodyEncoding: "",
    initiator: null,
    isMocked: false,
    size: null,
    duration: null,
    startedAt: Date.now(),
    finishedAt: null,
    har: {
      request: {
        method: request.method,
        url: request.url
      },
      response: {
        status: request.status ?? undefined,
        headers: request.responseHeaders,
        content: {
          mimeType: "application/json"
        }
      }
    }
  };
}

function isMockRuleLike(value: unknown): value is {
  id: string;
  groupId?: unknown;
  name: string;
  domain: string;
  matcherQuery: string;
  method: string;
  url: string;
  enabled?: unknown;
  scope?: unknown;
  action?: unknown;
  responseHeaders?: unknown;
  responseBody?: unknown;
  script?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.domain === "string" &&
    typeof candidate.matcherQuery === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.url === "string"
  );
}

function isMockGroupLike(value: unknown): value is {
  id: string;
  name: string;
  enabled?: unknown;
  pageUrlContains?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

function ensureDefaultMockGroup(groups: MockGroup[]): MockGroup[] {
  if (groups.some((group) => group.id === DEFAULT_MOCK_GROUP_ID)) {
    return groups;
  }
  return [createDefaultMockGroup(Date.now()), ...groups];
}

function createDefaultMockGroup(now: number): MockGroup {
  return {
    id: DEFAULT_MOCK_GROUP_ID,
    name: "默认组",
    enabled: true,
    pageUrlContains: "",
    createdAt: now,
    updatedAt: now
  };
}

function normalizeAction(value: unknown): MockAction {
  if (value === "replace-headers" || value === "replace-body" || value === "script") {
    return value;
  }
  return "replace-body";
}

function normalizeHeaders(value: unknown): HeaderPair[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.name !== "string" || typeof candidate.value !== "string") {
      return [];
    }
    return [{ name: candidate.name, value: candidate.value }];
  });
}

function defaultMockScript(responseBody: string, headers: HeaderPair[]): string {
  return [
    "function mock({ request, response }) {",
    "  const nextHeaders = { ...response.headers };",
    ...headers.map((header) => `  nextHeaders[${JSON.stringify(header.name)}] = ${JSON.stringify(header.value)};`),
    `  const nextBody = ${JSON.stringify(responseBody)};`,
    "  return { status: response.status, headers: nextHeaders, body: nextBody };",
    "}"
  ].join("\n");
}

function defaultJsonBody(): string {
  return JSON.stringify({ mocked: true }, null, 2);
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function pathWithSearch(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    return url;
  }
}

function quoteIfNeeded(value: string): string {
  if (/[\s()]/.test(value)) {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return value;
}
