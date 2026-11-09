import type { HeaderPair } from "./network";
import type { MockRule } from "./mock-rules";
import { headersArrayToRecord, headersRecordToArray, type MockScriptInput, type MockScriptOutput } from "./mock-script";

// CDP（后台 Fetch 域）和页面钩子共用的静态 Mock 计算，保证两种模式下「替换响应体 / 响应头」的结果一致。

export function mergeMockHeaders(originalHeaders: HeaderPair[], mockHeaders: HeaderPair[]): HeaderPair[] {
  const headerMap = new Map(originalHeaders.map((header) => [header.name.toLowerCase(), header]));
  for (const header of mockHeaders) {
    headerMap.set(header.name.toLowerCase(), header);
  }
  headerMap.set("content-type", { name: "content-type", value: "application/json; charset=utf-8" });
  return sanitizeMockHeaders(Array.from(headerMap.values()));
}

/** 正文被替换后原 content-length 不再准确，留着会让浏览器截断或等待。 */
export function sanitizeMockHeaders(headers: HeaderPair[]): HeaderPair[] {
  return headers.filter((header) => header.name.toLowerCase() !== "content-length");
}

/** 「替换响应头」「替换响应体」两种规则；「JS 修改响应」要进沙箱执行，调用方另行处理。 */
export function applyStaticMock(rule: MockRule, input: MockScriptInput): MockScriptOutput {
  const nextHeaders = mergeMockHeaders(headersRecordToArray(input.response.headers), rule.responseHeaders);
  return {
    status: input.response.status,
    headers: headersArrayToRecord(nextHeaders),
    body: rule.action === "replace-headers" ? input.response.body : rule.responseBody
  };
}
