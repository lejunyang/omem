import type { HeaderPair, NetworkRecord } from "../shared/network";

export function formatStatus(record: NetworkRecord): string {
  if (record.status === null) {
    return "-";
  }
  return `${record.status}${record.statusText ? ` ${record.statusText}` : ""}`;
}

export function statusClass(status: number | null): string {
  if (status === null) {
    return "";
  }
  return status >= 400 ? "status-error" : "status-ok";
}

export function formatSize(size: number | null): string {
  if (size === null || size < 0) {
    return "-";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(duration: number | null): string {
  if (duration === null || duration < 0) {
    return "-";
  }
  return `${Math.round(duration)} ms`;
}

export function getProtocol(url: string): string {
  try {
    return new URL(url).protocol.replace(":", "");
  } catch {
    return "-";
  }
}

export function formatDate(time: number): string {
  return new Date(time).toLocaleString();
}

export function responseText(record: NetworkRecord): string {
  if (record.bodyState === "unloaded") {
    return "点击请求后将自动读取响应体。";
  }
  if (record.bodyState === "loading") {
    return "响应体读取中...";
  }
  if (record.bodyState === "skipped") {
    return record.responseBody;
  }
  const suffix = record.bodyEncoding ? `\n\n[encoding: ${record.bodyEncoding}]` : "";
  return `${record.responseBody || "(empty)"}${suffix}`;
}

export function timingRows(record: NetworkRecord): Array<[string, string]> {
  return Object.entries(record.har.timings ?? {}).map(([name, value]) => [name, `${value} ms`]);
}

export function headerRows(headers: HeaderPair[]): Array<[string, string]> {
  return headers.map((header) => [header.name, header.value]);
}

export function sourceLocation(url: string, lineNumber: number | null, columnNumber: number | null): string {
  const line = lineNumber === null ? "" : `:${lineNumber + 1}`;
  const column = columnNumber === null ? "" : `:${columnNumber + 1}`;
  return `${url || "(anonymous)"}${line}${column}`;
}
