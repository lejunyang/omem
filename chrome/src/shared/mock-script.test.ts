import { describe, expect, it } from "vitest";
import {
  createMockScriptRequest,
  headersArrayToRecord,
  headersRecordToArray,
  normalizeMockScriptResult,
  type MockScriptOutput
} from "./mock-script";

describe("mock script helpers", () => {
  const fallback: MockScriptOutput = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{\"ok\":true}"
  };

  it("converts headers between CDP arrays and script records", () => {
    expect(headersArrayToRecord([{ name: "x-token", value: "abc" }])).toEqual({ "x-token": "abc" });
    expect(headersRecordToArray({ "x-token": "abc" })).toEqual([{ name: "x-token", value: "abc" }]);
  });

  it("normalizes script result records and object bodies", () => {
    expect(
      normalizeMockScriptResult(
        {
          headers: { "x-mock": 1 },
          body: { mocked: true }
        },
        fallback
      )
    ).toEqual({
      status: 200,
      headers: { "x-mock": "1" },
      body: "{\n  \"mocked\": true\n}"
    });
  });

  it("normalizes status and parses request url details", () => {
    expect(normalizeMockScriptResult({ status: 201 }, fallback).status).toBe(201);
    expect(normalizeMockScriptResult({ status: 99 }, fallback).status).toBe(200);
    expect(
      createMockScriptRequest({
        method: "GET",
        url: "https://api.example.com:8443/users?page=1&tag=a&tag=b",
        headers: { Accept: "application/json" }
      })
    ).toMatchObject({
      method: "GET",
      origin: "https://api.example.com:8443",
      host: "api.example.com:8443",
      hostname: "api.example.com",
      port: "8443",
      pathname: "/users",
      queryString: "page=1&tag=a&tag=b",
      query: {
        page: "1",
        tag: ["a", "b"]
      },
      headers: {
        accept: "application/json"
      }
    });
  });

  it("falls back when the script returns no headers or body", () => {
    expect(normalizeMockScriptResult({}, fallback)).toEqual(fallback);
    expect(normalizeMockScriptResult(undefined, fallback)).toEqual(fallback);
  });
});
