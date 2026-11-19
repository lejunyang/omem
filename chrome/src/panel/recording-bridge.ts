import { getRequestContent } from "./devtools-api";
import { clipBody, devtoolsType, redactHeaders, redactUrl, type RecordedRequest, wantsBody } from "../shared/recording";
import { RECORD_CHANGED_MESSAGE, type RecordStateResponse } from "../shared/recording-messages";
import type { DevtoolsRequest } from "../shared/network";

// 录制时 DevTools 开着：把这个标签页完成的请求连同请求体、响应体送给后台，和 webRequest 记的合并。
// 跑在 devtools_page（DevTools 一打开就加载，不用切到 omem 面板）。不用调试器：读的是 DevTools 自己的 HAR。
// 只读接口和文档的文字内容，每个最多 32K，先遮盖再送出；图片、脚本等不读。

type HarEntry = DevtoolsRequest & { _resourceType?: string };

/** HAR 里的一条换成录制的请求记录（不含响应体）。 */
export function harToRequest(entry: HarEntry, tabId: number): RecordedRequest {
  const at = Date.parse(entry.startedDateTime ?? "") || Date.now();
  const sent = clipBody(entry.request?.postData?.text);
  return {
    id: `dt-${at}-${Math.random().toString(36).slice(2, 8)}`,
    tabId,
    at,
    method: (entry.request?.method ?? "GET").toUpperCase(),
    url: redactUrl(entry.request?.url ?? ""),
    type: devtoolsType(entry._resourceType),
    status: typeof entry.response?.status === "number" && entry.response.status > 0 ? entry.response.status : null,
    durationMs: typeof entry.time === "number" ? Math.round(entry.time) : null,
    mimeType: entry.response?.content?.mimeType ?? "",
    requestHeaders: redactHeaders(entry.request?.headers),
    ...(sent.body ? { requestBody: sent.body, requestBodyTruncated: sent.truncated } : {}),
    source: "devtools"
  };
}

export function installRecordingBridge(): () => void {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  let active = false;

  const refresh = async () => {
    const state = (await chrome.runtime.sendMessage({ type: "omem-record:state" }).catch(() => null)) as RecordStateResponse | null;
    active = state?.session?.status === "recording" && state.session.tabIds.includes(tabId);
  };
  const onMessage = (message: unknown) => {
    if ((message as { type?: string } | null)?.type === RECORD_CHANGED_MESSAGE) void refresh();
  };
  const onFinished = (raw: unknown) => {
    if (!active) return;
    const entry = raw as HarEntry;
    const record = harToRequest(entry, tabId);
    if (!/^(https?|wss?):/.test(entry.request?.url ?? "")) return;
    void (async () => {
      const size = entry.response?.content?.size ?? 0;
      if (wantsBody(record.type, record.mimeType ?? "") && size <= 1024 * 1024) {
        const content = await getRequestContent(entry).catch(() => ({ content: "", encoding: "" }));
        if (content.encoding !== "base64") {
          const got = clipBody(content.content);
          if (got.body) Object.assign(record, { responseBody: got.body, responseBodyTruncated: got.truncated });
        }
      }
      await chrome.runtime.sendMessage({ type: "omem-record:har", tabId, entries: [record] }).catch(() => undefined);
    })();
  };

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.devtools.network.onRequestFinished.addListener(onFinished);
  void refresh();
  return () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.devtools.network.onRequestFinished.removeListener(onFinished);
  };
}
