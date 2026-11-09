import type { HeaderPair, NetworkRecord } from "./network";

export type CopyAction =
  | "url"
  | "curl"
  | "request-headers"
  | "response-headers"
  | "response"
  | "har-entry";

export function getCopyText(record: NetworkRecord, action: CopyAction): string {
  switch (action) {
    case "url":
      return record.url;
    case "curl":
      return toCurl(record);
    case "request-headers":
      return formatHeaders(record.requestHeaders);
    case "response-headers":
      return formatHeaders(record.responseHeaders);
    case "response":
      return record.responseBody || "";
    case "har-entry":
      return JSON.stringify(record.har, null, 2);
  }
}

export function toCurl(record: NetworkRecord): string {
  const parts = ["curl", shellQuote(record.url)];
  if (record.method && record.method.toUpperCase() !== "GET") {
    parts.push("-X", shellQuote(record.method.toUpperCase()));
  }

  for (const header of record.requestHeaders) {
    parts.push("-H", shellQuote(`${header.name}: ${header.value}`));
  }

  const postText = record.har.request?.postData?.text;
  if (postText) {
    parts.push("--data-raw", shellQuote(postText));
  }

  return parts.join(" ");
}

function formatHeaders(headers: HeaderPair[]): string {
  return headers.map((header) => `${header.name}: ${header.value}`).join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
