export const RESPONSE_BODY_SIZE_LIMIT_BYTES = 1024 * 1024;

export type BodyState = "unloaded" | "loading" | "loaded" | "failed" | "skipped";

export interface NetworkRecord {
  id: string;
  url: string;
  name: string;
  method: string;
  status: number | null;
  statusText: string;
  resourceType: string;
  mimeType: string;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  queryParams: NameValuePair[];
  postParams: NameValuePair[];
  requestBody: string;
  responseBody: string;
  bodyState: BodyState;
  bodyEncoding: string;
  initiator: RequestInitiator | null;
  isMocked: boolean;
  size: number | null;
  duration: number | null;
  startedAt: number;
  finishedAt: number | null;
  har: DevtoolsRequest;
}

export interface HeaderPair {
  name: string;
  value: string;
}

export interface NameValuePair {
  name: string;
  value: string;
}

export interface RequestInitiator {
  type: string;
  url: string;
  lineNumber: number | null;
  columnNumber: number | null;
  stack: InitiatorStackFrame[];
}

export interface InitiatorStackFrame {
  functionName: string;
  url: string;
  lineNumber: number | null;
  columnNumber: number | null;
}

export interface DevtoolsRequest {
  startedDateTime?: string;
  time?: number;
  request?: {
    method?: string;
    url?: string;
    headers?: HeaderPair[];
    postData?: {
      mimeType?: string;
      text?: string;
      params?: Array<{ name: string; value?: string; fileName?: string; contentType?: string }>;
    };
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: HeaderPair[];
    content?: {
      mimeType?: string;
      size?: number;
    };
    bodySize?: number;
  };
  timings?: Record<string, number>;
  initiator?: RawInitiator;
  _initiator?: RawInitiator;
  getContent?: DevtoolsGetContent;
}

interface RawInitiator {
  type?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stack?: {
    callFrames?: RawCallFrame[];
    parent?: RawInitiator["stack"];
  };
}

interface RawCallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export type DevtoolsGetContent = (
  callback?: (content: string, encoding: string) => void
) => Promise<ContentResult> | ContentResult | void;

export type ContentResult =
  | {
      content?: string;
      encoding?: string;
    }
  | [string, string]
  | string;

export function toNetworkRecord(entry: DevtoolsRequest, index: number): NetworkRecord {
  const url = entry.request?.url ?? "";
  const startedAt = parseDate(entry.startedDateTime);
  const status = typeof entry.response?.status === "number" ? entry.response.status : null;
  const duration = typeof entry.time === "number" ? entry.time : null;

  return {
    id: `${startedAt}-${index}-${url}`,
    url,
    name: getRequestName(url),
    method: entry.request?.method ?? "GET",
    status,
    statusText: entry.response?.statusText ?? "",
    resourceType: inferResourceType(entry),
    mimeType: entry.response?.content?.mimeType ?? "",
    requestHeaders: entry.request?.headers ?? [],
    responseHeaders: entry.response?.headers ?? [],
    queryParams: parseQueryParams(url),
    postParams: parsePostParams(entry),
    requestBody: formatPayload(entry),
    responseBody: "",
    bodyState: "unloaded",
    bodyEncoding: "",
    initiator: normalizeInitiator(entry),
    isMocked: false,
    size: entry.response?.bodySize ?? entry.response?.content?.size ?? null,
    duration,
    startedAt,
    finishedAt: duration === null ? null : startedAt + duration,
    har: entry
  };
}

export function recordMatches(record: NetworkRecord, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) {
    return true;
  }

  const fields = [
    record.name,
    record.url,
    record.method,
    record.status?.toString() ?? "",
    record.resourceType,
    record.mimeType,
    record.requestBody,
    record.responseBody
  ];

  return fields.some((field) => field.toLowerCase().includes(normalizedKeyword));
}

export function getResponseBodySkipReason(record: NetworkRecord): string {
  if (record.size !== null && record.size > RESPONSE_BODY_SIZE_LIMIT_BYTES) {
    return `响应体大小 ${formatBytes(record.size)} 超过 ${formatBytes(RESPONSE_BODY_SIZE_LIMIT_BYTES)}，已跳过读取。`;
  }

  if (record.mimeType && !isTextLikeMimeType(record.mimeType)) {
    return `响应类型 ${record.mimeType} 可能为二进制内容，已跳过读取。`;
  }

  return "";
}

function parseDate(value: string | undefined): number {
  if (!value) {
    return Date.now();
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? Date.now() : time;
}

function getRequestName(url: string): string {
  if (!url) {
    return "(unknown)";
  }

  try {
    const parsedUrl = new URL(url);
    const lastSegment = parsedUrl.pathname.split("/").filter(Boolean).at(-1);
    return lastSegment || parsedUrl.hostname;
  } catch {
    return url;
  }
}

function inferResourceType(entry: DevtoolsRequest): string {
  const mimeType = entry.response?.content?.mimeType ?? "";
  const url = entry.request?.url ?? "";

  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return "websocket";
  }
  if (mimeType.includes("json")) {
    return "fetch/xhr";
  }
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
    return "media";
  }
  if (mimeType.startsWith("font/") || mimeType.includes("font")) {
    return "font";
  }
  if (mimeType.includes("javascript")) {
    return "script";
  }
  if (mimeType.includes("css")) {
    return "stylesheet";
  }
  if (mimeType.includes("html")) {
    return "document";
  }
  if (url.includes("/api/")) {
    return "fetch/xhr";
  }
  return mimeType || "other";
}

function isTextLikeMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  if (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded") ||
    normalized.includes("graphql")
  ) {
    return true;
  }

  return false;
}

export function normalizeContentResult(result: ContentResult | undefined): {
  content: string;
  encoding: string;
} {
  if (typeof result === "string") {
    return { content: result, encoding: "" };
  }

  if (Array.isArray(result)) {
    return { content: result[0] ?? "", encoding: result[1] ?? "" };
  }

  return {
    content: result?.content ?? "",
    encoding: result?.encoding ?? ""
  };
}

function formatPayload(entry: DevtoolsRequest): string {
  const sections: string[] = [];
  const queryParams = parseQueryParams(entry.request?.url ?? "");
  if (queryParams.length) {
    sections.push(formatParams("Query String Parameters", queryParams));
  }

  const postData = formatPostData(entry);
  if (postData) {
    sections.push(postData);
  }

  return sections.join("\n\n");
}

function formatPostData(entry: DevtoolsRequest): string {
  const postData = entry.request?.postData;
  if (!postData) {
    return "";
  }

  if (postData.params?.length && isFormDataMimeType(postData.mimeType)) {
    return formatParams("Form Data", parsePostParams(entry));
  }

  if (postData.text) {
    return `Request Payload\n${postData.text}`;
  }

  if (postData.params?.length) {
    return formatParams("Form Data", parsePostParams(entry));
  }

  return "";
}

function parseQueryParams(url: string): NameValuePair[] {
  if (!url) {
    return [];
  }

  try {
    const parsedUrl = new URL(url);
    return Array.from(parsedUrl.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function parsePostParams(entry: DevtoolsRequest): NameValuePair[] {
  return (
    entry.request?.postData?.params?.map((param) => ({
      name: param.name,
      value: param.value ?? (param.fileName || param.contentType ? "<二进制>" : "")
    })) ?? []
  );
}

function isFormDataMimeType(mimeType: string | undefined): boolean {
  const normalized = mimeType?.toLowerCase() ?? "";
  return normalized.includes("multipart/form-data") || normalized.includes("x-www-form-urlencoded");
}

function formatParams(title: string, params: NameValuePair[]): string {
  return [title, ...params.map((param) => `${param.name}: ${param.value}`)].join("\n");
}

function normalizeInitiator(entry: DevtoolsRequest): RequestInitiator | null {
  const initiator = entry.initiator ?? entry._initiator;
  if (!initiator) {
    return null;
  }

  return {
    type: initiator.type ?? "unknown",
    url: initiator.url ?? "",
    lineNumber: toNullableNumber(initiator.lineNumber),
    columnNumber: toNullableNumber(initiator.columnNumber),
    stack: flattenStackFrames(initiator.stack)
  };
}

function flattenStackFrames(stack: RawInitiator["stack"] | undefined): InitiatorStackFrame[] {
  if (!stack) {
    return [];
  }

  return [
    ...(stack.callFrames ?? []).map((frame) => ({
      functionName: frame.functionName || "(anonymous)",
      url: frame.url ?? "",
      lineNumber: toNullableNumber(frame.lineNumber),
      columnNumber: toNullableNumber(frame.columnNumber)
    })),
    ...flattenStackFrames(stack.parent)
  ];
}

function toNullableNumber(value: number | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
