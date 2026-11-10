import { describe, expect, it } from "vitest";
import { getCopyText, toCurl } from "./network-copy";
import { toNetworkRecord, type DevtoolsRequest } from "./network";

describe("network copy helpers", () => {
  it("copies request url", () => {
    const record = createRecord();

    expect(getCopyText(record, "url")).toBe("https://api.example.com/users");
  });

  it("formats requests as curl", () => {
    const record = createRecord();

    expect(toCurl(record)).toBe(
      "curl 'https://api.example.com/users' -X 'POST' -H 'content-type: application/json' --data-raw '{\"name\":\"Ada\"}'"
    );
  });

  it("copies headers and response body", () => {
    const record = createRecord();
    record.responseBody = "{\"ok\":true}";

    expect(getCopyText(record, "request-headers")).toBe("content-type: application/json");
    expect(getCopyText(record, "response-headers")).toBe("cache-control: no-cache");
    expect(getCopyText(record, "response")).toBe("{\"ok\":true}");
  });
});

function createRecord() {
  const entry: DevtoolsRequest = {
    request: {
      method: "POST",
      url: "https://api.example.com/users",
      headers: [{ name: "content-type", value: "application/json" }],
      postData: {
        text: "{\"name\":\"Ada\"}"
      }
    },
    response: {
      status: 200,
      headers: [{ name: "cache-control", value: "no-cache" }],
      content: {
        mimeType: "application/json"
      }
    }
  };

  return toNetworkRecord(entry, 0);
}
