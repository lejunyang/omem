import { describe, expect, it } from "vitest";
import {
  appendAdvancedFilterToken,
  buildAdvancedFilterToken,
  getAdvancedFilterOperatorOptions,
  matchesAdvancedQuery,
  matchesStatus,
  matchesType,
  validateAdvancedQuery
} from "./network-filters";
import { toNetworkRecord, type DevtoolsRequest } from "./network";

describe("network filters", () => {
  it("matches status ranges", () => {
    expect(matchesStatus(record({ status: 204 }), "2xx")).toBe(true);
    expect(matchesStatus(record({ status: 302 }), "3xx")).toBe(true);
    expect(matchesStatus(record({ status: 404 }), "4xx")).toBe(true);
    expect(matchesStatus(record({ status: 503 }), "5xx")).toBe(true);
    expect(matchesStatus(record({ status: 204 }), "5xx")).toBe(false);
  });

  it("matches failed requests without a normal status", () => {
    expect(matchesStatus(record({ status: 0 }), "failed")).toBe(true);
    expect(matchesStatus(toNetworkRecord({ request: { url: "https://example.com" } }, 0), "failed")).toBe(
      true
    );
    expect(matchesStatus(record({ status: 200 }), "failed")).toBe(false);
  });

  it("matches common native Network resource buckets", () => {
    expect(matchesType(record({ mimeType: "application/json" }), "fetch/xhr")).toBe(true);
    expect(matchesType(record({ mimeType: "text/css" }), "stylesheet")).toBe(true);
    expect(matchesType(record({ mimeType: "font/woff2" }), "font")).toBe(true);
    expect(matchesType(record({ mimeType: "video/mp4" }), "media")).toBe(true);
    expect(matchesType(record({ url: "wss://example.com/socket" }), "websocket")).toBe(true);
  });

  it("matches other only when no known bucket matches", () => {
    expect(
      matchesType(
        record({ mimeType: "application/octet-stream", url: "https://example.com/download" }),
        "other"
      )
    ).toBe(true);
    expect(matchesType(record({ mimeType: "application/json" }), "other")).toBe(false);
  });

  it("matches advanced field queries", () => {
    const item = record({
      status: 201,
      mimeType: "application/json",
      url: "https://api.example.com/api/users?keyword=Ada"
    });
    item.requestBody = "Request Payload\n{\"name\":\"Ada\"}";
    item.responseBody = "{\"id\":1,\"name\":\"Ada\"}";

    expect(matchesAdvancedQuery(item, "method:GET status:2xx domain:api.example.com")).toBe(true);
    expect(matchesAdvancedQuery(item, "payload:Ada response:id")).toBe(true);
    expect(matchesAdvancedQuery(item, "url:\"/api/users\" -mime:image")).toBe(true);
    expect(matchesAdvancedQuery(item, "status:404")).toBe(false);
  });

  it("treats bare text and bare regex as URL filters and requires keyword for global search", () => {
    const item = record({
      status: 200,
      url: "https://api.example.com/api/users"
    });
    item.responseBody = "{\"traceId\":\"abc-123\"}";
    item.requestHeaders = [{ name: "x-request-id", value: "abc-123" }];

    expect(matchesAdvancedQuery(item, "api/users")).toBe(true);
    expect(matchesAdvancedQuery(item, "traceId")).toBe(false);
    expect(matchesAdvancedQuery(item, "~/api\\/users/")).toBe(true);
    expect(matchesAdvancedQuery(item, "~/traceId/")).toBe(false);
    expect(matchesAdvancedQuery(item, "keyword:traceId")).toBe(true);
    expect(matchesAdvancedQuery(item, "keyword~/traceId/")).toBe(true);
    expect(matchesAdvancedQuery(item, "keyword~/x-request-id/")).toBe(true);
    expect(matchesAdvancedQuery(item, "keyword!~/traceId/")).toBe(false);
  });

  it("matches has queries for structured request data", () => {
    const item = record({
      status: 200,
      url: "https://example.com/api/users?page=1"
    });
    item.requestHeaders = [{ name: "accept", value: "application/json" }];

    expect(matchesAdvancedQuery(item, "has:query has:headers")).toBe(true);
    expect(matchesAdvancedQuery(item, "has:response")).toBe(false);
  });

  it("matches OR groups with AND conditions inside each group", () => {
    const item = record({
      status: 404,
      url: "https://api.example.com/api/users"
    });

    expect(matchesAdvancedQuery(item, "(method:POST status:2xx) OR (method:GET status:4xx)")).toBe(true);
    expect(matchesAdvancedQuery(item, "(method:POST status:2xx) OR (method:GET status:5xx)")).toBe(false);
  });

  it("matches nested groups with implicit AND and OR precedence", () => {
    const item = record({
      status: 201,
      url: "https://api.example.com/api/users"
    });
    item.responseBody = "{\"ok\":true}";

    expect(matchesAdvancedQuery(item, "method:GET (status:2xx OR status:304) response:ok")).toBe(true);
    expect(matchesAdvancedQuery(item, "method:GET (status:4xx OR (status:3xx response:ok))")).toBe(false);
  });

  it("matches comparison expressions for status duration and size", () => {
    const item = record({
      status: 503,
      url: "https://api.example.com/api/users"
    });
    item.duration = 620;
    item.size = 2 * 1024 * 1024;

    expect(matchesAdvancedQuery(item, "status>=500 duration>500 size>=1mb")).toBe(true);
    expect(matchesAdvancedQuery(item, "status<500")).toBe(false);
    expect(validateAdvancedQuery("duration>slow").errors).toContain("duration 比较表达式的值无效。");
  });

  it("matches regex and negative regex expressions for text fields", () => {
    const item = record({
      status: 200,
      url: "https://api.example.com/api/users/42"
    });
    item.responseBody = "{\"traceId\":\"abc-123\"}";
    item.responseHeaders = [{ name: "x-trace-id", value: "abc-123" }];

    expect(matchesAdvancedQuery(item, "url~/api\\/users\\/\\d+/ response~/traceId/i")).toBe(true);
    expect(matchesAdvancedQuery(item, "header!~/cookie/i")).toBe(true);
    expect(matchesAdvancedQuery(item, "url!~/users/")).toBe(false);
    expect(validateAdvancedQuery("url~/[/").errors[0]).toContain("正则表达式无效");
  });

  it("validates unsupported fields and invalid field values", () => {
    expect(validateAdvancedQuery("methd:GET").errors).toContain("不支持的字段 methd。");
    expect(validateAdvancedQuery("status:9xx").errors).toContain(
      "status 仅支持 2xx/3xx/4xx/5xx、failed 或具体状态码。"
    );
    expect(validateAdvancedQuery("type:unknown").errors).toContain(
      "type 仅支持 all、fetch/xhr、document、stylesheet、script、image、media、font、websocket、other。"
    );
    expect(validateAdvancedQuery("has:cookie").errors).toContain(
      "has 仅支持 payload、response、query、form、headers、request-headers、response-headers。"
    );
  });

  it("validates broken grouping syntax", () => {
    expect(validateAdvancedQuery("(method:GET").errors).toContain("存在未闭合的左括号。");
    expect(validateAdvancedQuery("method:GET OR").errors).toContain("OR 后需要一个条件或分组。");
    expect(validateAdvancedQuery("OR method:GET").errors).toContain("OR 前需要一个条件或分组。");
    expect(validateAdvancedQuery('url:"/api/users').errors).toEqual([
      "从第 5 个字符开始的引号未闭合。"
    ]);
  });

  it("builds and appends visual filter conditions", () => {
    const token = buildAdvancedFilterToken({
      field: "domain",
      value: "api.example.com",
      negative: true
    });

    expect(token).toBe("-domain:api.example.com");
    expect(appendAdvancedFilterToken("method:GET", token, "and")).toBe("method:GET -domain:api.example.com");
    expect(appendAdvancedFilterToken("method:GET", token, "or")).toBe("(method:GET) OR (-domain:api.example.com)");
    expect(
      buildAdvancedFilterToken({
        field: "url",
        value: "/api/search users",
        negative: false
      })
    ).toBe('url:"/api/search users"');
    expect(
      buildAdvancedFilterToken({
        field: "duration",
        value: "500",
        negative: false,
        operator: "gt"
      })
    ).toBe("duration>500");
    expect(
      buildAdvancedFilterToken({
        field: "url",
        value: "/api/users",
        negative: false,
        operator: "regex"
      })
    ).toBe("url~/\\/api\\/users/");
    expect(
      buildAdvancedFilterToken({
        field: "keyword",
        value: "traceId",
        negative: false
      })
    ).toBe("keyword:traceId");
    expect(
      buildAdvancedFilterToken({
        field: "keyword",
        value: "traceId",
        negative: false,
        operator: "regex"
      })
    ).toBe("keyword~/traceId/");
    expect(getAdvancedFilterOperatorOptions("keyword").map((option) => option.value)).toEqual([
      "contains",
      "regex",
      "not-regex"
    ]);
    expect(getAdvancedFilterOperatorOptions("duration").map((option) => option.value)).toEqual([
      "contains",
      "equals",
      "gt",
      "gte",
      "lt",
      "lte"
    ]);
  });
});

function record(options: {
  status?: number;
  mimeType?: string;
  url?: string;
}) {
  const entry: DevtoolsRequest = {
    request: {
      url: options.url ?? "https://example.com/api/users"
    },
    response: {
      status: options.status,
      content: {
        mimeType: options.mimeType ?? "application/json"
      }
    }
  };

  return toNetworkRecord(entry, 0);
}
