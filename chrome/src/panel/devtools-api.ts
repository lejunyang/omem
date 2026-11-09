import type { IngestedResource } from "../shared/resource-search-messages";
import {
  type ContentResult,
  type DevtoolsRequest,
  normalizeContentResult
} from "../shared/network";

export interface HarLog {
  entries?: DevtoolsRequest[];
}

export interface DevtoolsNetworkApi {
  getHAR: (callback?: (harLog: HarLog | undefined) => void) => Promise<HarLog> | HarLog | void;
}

// 读取 HAR 时统一兼容 callback 和 Promise 形态；Chrome/Edge 的 DevTools API 在不同版本里表现不一致。
export async function getHarLog(api: DevtoolsNetworkApi): Promise<HarLog> {
  const har = await callMaybeCallback<HarLog>((resolve) => api.getHAR(resolve));
  return har ?? { entries: [] };
}

// 读取响应体时同样走兼容封装，避免 callback 风格运行时直接 await 得到 undefined。
export async function getRequestContent(request: DevtoolsRequest): Promise<{
  content: string;
  encoding: string;
}> {
  if (!request.getContent) {
    return { content: "", encoding: "" };
  }

  const result = await callMaybeCallback<ContentResult>((resolve) =>
    request.getContent?.((content, encoding) => resolve({ content, encoding }))
  );
  return normalizeContentResult(result);
}

function callMaybeCallback<T>(
  invoke: (resolve: (value: T | undefined) => void) => Promise<T> | T | void
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;

    // 同一个 API 可能既调用 callback 又返回 Promise，必须只结算一次，避免状态被后续回调覆盖。
    const settle = (value: T | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    try {
      const maybeResult = invoke(settle);
      if (isPromiseLike<T>(maybeResult)) {
        void maybeResult.then(settle, reject);
        return;
      }
      if (maybeResult !== undefined) {
        settle(maybeResult);
      }
    } catch (error) {
      reject(error);
    }
  });
}

interface DevtoolsResource {
  url: string;
  type: string;
  getContent: (callback: (content: string, encoding: string) => void) => void;
}

const SKIPPED_RESOURCE_TYPES = new Set(["image", "font", "media", "other"]);

/**
 * 不用 CDP 时资源搜索的数据来源：DevTools 自己记录的页面资源（文档、脚本、样式表、XHR）。
 * 只读文本资源；base64 编码的（二进制）跳过。并发读取，单个失败不影响其他。
 */
export async function readInspectedResources(): Promise<IngestedResource[]> {
  const resources = await new Promise<DevtoolsResource[]>((resolve) =>
    chrome.devtools.inspectedWindow.getResources((items) => resolve((items ?? []) as unknown as DevtoolsResource[]))
  );
  return Promise.all(
    resources.map(async (resource): Promise<IngestedResource> => {
      if (SKIPPED_RESOURCE_TYPES.has(resource.type)) return { url: resource.url, type: resource.type };
      try {
        const result = await callMaybeCallback<{ content: string; encoding: string }>((resolve) =>
          resource.getContent((content, encoding) => resolve({ content, encoding }))
        );
        if (result?.encoding === "base64") return { url: resource.url, type: resource.type, error: "二进制内容已跳过。" };
        return { url: resource.url, type: resource.type, content: result?.content ?? "" };
      } catch (error) {
        return { url: resource.url, type: resource.type, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
