import { describe, expect, it } from "vitest";
import type { DevtoolsRequest } from "./network";
import {
  getResponseBodySkipReason,
  normalizeContentResult,
  recordMatches,
  RESPONSE_BODY_SIZE_LIMIT_BYTES,
  toNetworkRecord
} from "./network";

describe("network model", () => {
  it("formats query string parameters as payload", () => {
    const entry: DevtoolsRequest = {
      startedDateTime: "2026-07-02T00:00:00.000Z",
      request: {
        method: "GET",
        url: "https://example.com/api/users?page=1&keyword=Ada"
      },
      response: {
        status: 200,
        content: {
          mimeType: "application/json",
          size: 128
        }
      }
    };

    const record = toNetworkRecord(entry, 0);

    expect(record.queryParams).toEqual([
      { name: "page", value: "1" },
      { name: "keyword", value: "Ada" }
    ]);
    expect(record.requestBody).toContain("Query String Parameters");
    expect(record.requestBody).toContain("page: 1");
    expect(record.requestBody).toContain("keyword: Ada");
  });

  it("formats post data text as request payload", () => {
    const record = toNetworkRecord(
      {
        request: {
          method: "POST",
          url: "https://example.com/api/users",
          postData: {
            mimeType: "application/json",
            text: "{\"name\":\"Ada\"}"
          }
        }
      },
      0
    );

    expect(record.requestBody).toBe("Request Payload\n{\"name\":\"Ada\"}");
  });

  it("formats post data params as form data", () => {
    const record = toNetworkRecord(
      {
        request: {
          method: "POST",
          url: "https://example.com/login",
          postData: {
            params: [
              { name: "username", value: "ada" },
              { name: "remember", value: "true" }
            ]
          }
        }
      },
      0
    );

    expect(record.postParams).toEqual([
      { name: "username", value: "ada" },
      { name: "remember", value: "true" }
    ]);
    expect(record.requestBody).toContain("Form Data");
    expect(record.requestBody).toContain("username: ada");
  });

  it("formats mixed multipart form data and masks binary file fields", () => {
    const record = toNetworkRecord(
      {
        request: {
          method: "POST",
          url: "https://example.com/upload",
          postData: {
            mimeType: "multipart/form-data; boundary=----WebKitFormBoundary",
            text: "raw multipart body",
            params: [
              { name: "title", value: "avatar" },
              { name: "file", fileName: "avatar.png", contentType: "image/png" }
            ]
          }
        }
      },
      0
    );

    expect(record.postParams).toEqual([
      { name: "title", value: "avatar" },
      { name: "file", value: "<二进制>" }
    ]);
    expect(record.requestBody).toBe("Form Data\ntitle: avatar\nfile: <二进制>");
  });

  it("searches across formatted payload and response body", () => {
    const record = toNetworkRecord(
      {
        request: {
          method: "GET",
          url: "https://example.com/api/users?keyword=Ada"
        }
      },
      0
    );
    record.responseBody = "{\"traceId\":\"abc\"}";

    expect(recordMatches(record, "keyword")).toBe(true);
    expect(recordMatches(record, "traceId")).toBe(true);
  });

  it("normalizes undefined content without throwing", () => {
    expect(normalizeContentResult(undefined)).toEqual({
      content: "",
      encoding: ""
    });
  });

  it("skips response body loading for oversized responses", () => {
    const record = toNetworkRecord(
      {
        request: {
          url: "https://example.com/api/export"
        },
        response: {
          bodySize: RESPONSE_BODY_SIZE_LIMIT_BYTES + 1,
          content: {
            mimeType: "application/json"
          }
        }
      },
      0
    );

    expect(getResponseBodySkipReason(record)).toContain("超过 1.0 MB");
  });

  it("skips response body loading for binary mime types", () => {
    const record = toNetworkRecord(
      {
        request: {
          url: "https://example.com/avatar.png"
        },
        response: {
          content: {
            mimeType: "image/png",
            size: 1024
          }
        }
      },
      0
    );

    expect(getResponseBodySkipReason(record)).toContain("可能为二进制内容");
  });

  it("allows text-like response bodies under the limit", () => {
    const record = toNetworkRecord(
      {
        request: {
          url: "https://example.com/api/users"
        },
        response: {
          content: {
            mimeType: "application/json",
            size: RESPONSE_BODY_SIZE_LIMIT_BYTES
          }
        }
      },
      0
    );

    expect(getResponseBodySkipReason(record)).toBe("");
  });

  it("normalizes initiator call stacks when available", () => {
    const record = toNetworkRecord(
      {
        request: {
          url: "https://example.com/api/users"
        },
        _initiator: {
          type: "script",
          url: "https://example.com/app.js",
          lineNumber: 9,
          columnNumber: 4,
          stack: {
            callFrames: [
              {
                functionName: "loadUsers",
                url: "https://example.com/app.js",
                lineNumber: 12,
                columnNumber: 8
              }
            ]
          }
        }
      },
      0
    );

    expect(record.initiator).toEqual({
      type: "script",
      url: "https://example.com/app.js",
      lineNumber: 9,
      columnNumber: 4,
      stack: [
        {
          functionName: "loadUsers",
          url: "https://example.com/app.js",
          lineNumber: 12,
          columnNumber: 8
        }
      ]
    });
  });
});
