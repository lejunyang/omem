import type { CopyAction } from "../shared/network-copy";
import type { AdvancedFilterField } from "../shared/network-filters";
import type { DetailTab } from "./panel-types";

export const COPY_ACTIONS: Array<{ label: string; value: CopyAction }> = [
  { label: "复制 URL", value: "url" },
  { label: "复制为 cURL", value: "curl" },
  { label: "复制请求头", value: "request-headers" },
  { label: "复制响应头", value: "response-headers" },
  { label: "复制响应", value: "response" },
  { label: "复制 HAR 条目", value: "har-entry" }
];

export const DETAIL_TABS: Array<{ label: string; value: DetailTab }> = [
  { label: "Headers", value: "headers" },
  { label: "Payload", value: "payload" },
  { label: "Response", value: "response" },
  { label: "Timing", value: "timing" },
  { label: "Initiator", value: "initiator" }
];

export const FILTER_FIELD_OPTIONS: Array<{ label: string; value: AdvancedFilterField; placeholder: string }> = [
  { label: "全局关键字", value: "keyword", placeholder: "traceId / token / keyword~/trace/i" },
  { label: "方法", value: "method", placeholder: "GET / POST" },
  { label: "状态", value: "status", placeholder: "2xx / 404 / failed" },
  { label: "类型", value: "type", placeholder: "fetch/xhr / image" },
  { label: "域名", value: "domain", placeholder: "api.example.com" },
  { label: "URL", value: "url", placeholder: "/api/users" },
  { label: "名称", value: "name", placeholder: "users.json" },
  { label: "MIME", value: "mime", placeholder: "json / image" },
  { label: "Payload", value: "payload", placeholder: "request 中的内容" },
  { label: "Response", value: "response", placeholder: "response 中的内容" },
  { label: "Header", value: "header", placeholder: "authorization" },
  { label: "Has", value: "has", placeholder: "query / response / headers" },
  { label: "耗时", value: "duration", placeholder: ">500 / <=1200" },
  { label: "大小", value: "size", placeholder: ">10kb / <=1mb" }
];

export const FILTER_EXAMPLES = [
  "/api/users method:GET",
  "~/api\\/users/i",
  "keyword:traceId",
  "keyword~/traceId/i",
  "method:GET (status:2xx OR status:304)",
  "status>=400 duration>500 size<=1mb",
  "domain:example.com -mime:image has:response",
  "type:fetch/xhr status:failed",
  "payload:token OR response:traceId"
];
