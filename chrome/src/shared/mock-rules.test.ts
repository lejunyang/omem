import { describe, expect, it } from "vitest";
import {
  createBlankMockRule,
  createMockRuleFromRecord,
  createMockGroup,
  DEFAULT_MOCK_GROUP_ID,
  describeMockRule,
  filterMockRulesByDomain,
  groupMatchesPageUrl,
  normalizeMockGroups,
  normalizeMockRules,
  ruleMatchesRequest
} from "./mock-rules";
import { toNetworkRecord, type DevtoolsRequest } from "./network";

describe("mock rules", () => {
  it("creates a body replacement rule from a request", () => {
    const rule = createMockRuleFromRecord({
      id: "mock-1",
      record: createRecord(),
      scope: "domain",
      action: "replace-body",
      responseBody: "{\"ok\":true}",
      now: 100
    });

    expect(rule).toMatchObject({
      id: "mock-1",
      groupId: DEFAULT_MOCK_GROUP_ID,
      name: "替换响应体 users",
      enabled: true,
      scope: "domain",
      domain: "api.example.com",
      matcherQuery: "method:GET url:/api/users",
      action: "replace-body",
      responseBody: "{\"ok\":true}",
      createdAt: 100,
      updatedAt: 100
    });
    expect(rule.script).toContain("function mock");
    expect(rule.script).toContain("nextHeaders");
  });

  it("normalizes stored rules and repairs invalid optional values", () => {
    expect(
      normalizeMockRules([
        {
          id: "mock-2",
          name: "Rule",
          domain: "example.com",
          matcherQuery: "status:2xx",
          method: "GET",
          url: "https://example.com",
          action: "unknown",
          responseHeaders: [{ name: "x-mock", value: "1" }]
        },
        { id: "bad" }
      ])
    ).toHaveLength(1);
    expect(normalizeMockRules([{ id: "bad" }])).toEqual([]);
  });

  it("creates a blank enabled header replacement rule for manual setup", () => {
    const rule = createBlankMockRule({
      id: "manual-1",
      groupId: "checkout",
      now: 200
    });

    expect(rule).toMatchObject({
      id: "manual-1",
      groupId: "checkout",
      enabled: true,
      scope: "global",
      matcherQuery: "",
      action: "replace-headers",
      responseHeaders: [{ name: "x-mock", value: "1" }],
      createdAt: 200,
      updatedAt: 200
    });
    expect(normalizeMockRules([rule])).toHaveLength(1);
  });

  it("normalizes numeric-key storage objects for rules and groups", () => {
    const rules = normalizeMockRules({
      "0": {
        id: "mock-2",
        name: "Rule",
        domain: "example.com",
        matcherQuery: "status:2xx",
        method: "GET",
        url: "https://example.com",
        action: "replace-body"
      }
    });
    const groups = normalizeMockGroups({
      "0": {
        id: "checkout",
        name: "Checkout",
        enabled: true,
        pageUrlContains: "/checkout"
      }
    });

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("mock-2");
    expect(groups.map((group) => group.id)).toEqual([DEFAULT_MOCK_GROUP_ID, "checkout"]);
  });

  it("normalizes mock groups and matches page URL contains conditions", () => {
    const groups = normalizeMockGroups([
      createMockGroup({
        id: "checkout",
        name: "Checkout",
        pageUrlContains: "/checkout",
        now: 100
      })
    ]);

    expect(groups.map((group) => group.id)).toEqual([DEFAULT_MOCK_GROUP_ID, "checkout"]);
    expect(groupMatchesPageUrl(groups[1], "https://example.com/checkout/pay")).toBe(true);
    expect(groupMatchesPageUrl(groups[1], "https://example.com/home")).toBe(false);
    expect(groupMatchesPageUrl({ ...groups[1], enabled: false }, "https://example.com/checkout")).toBe(false);
  });

  it("filters mock rules by current domain while keeping global rules", () => {
    const rules = [
      createRule("a", "api.example.com", "domain"),
      createRule("b", "other.example.com", "domain"),
      createRule("c", "", "global")
    ];

    expect(filterMockRulesByDomain(rules, "api.example.com").map((rule) => rule.id)).toEqual(["a", "c"]);
  });

  it("describes mock rules for list display", () => {
    expect(describeMockRule(createRule("a", "api.example.com", "domain"))).toBe(
      "启用 / api.example.com / 组：default / method:GET url:/api/users / 替换响应体"
    );
  });

  it("matches paused requests with advanced matcher queries", () => {
    const rule = createRule("a", "api.example.com", "domain");
    rule.matcherQuery = "method:GET status>=200 status<300 url:/api/users";

    expect(
      ruleMatchesRequest(rule, {
        method: "GET",
        url: "https://api.example.com/api/users",
        status: 204,
        responseHeaders: []
      })
    ).toBe(true);
    expect(
      ruleMatchesRequest(rule, {
        method: "POST",
        url: "https://api.example.com/api/users",
        status: 204,
        responseHeaders: []
      })
    ).toBe(false);
  });
});

function createRecord() {
  const entry: DevtoolsRequest = {
    request: {
      method: "GET",
      url: "https://api.example.com/api/users"
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      content: {
        mimeType: "application/json"
      }
    }
  };
  const record = toNetworkRecord(entry, 0);
  record.responseBody = "{\"users\":[]}";
  return record;
}

function createRule(id: string, domain: string, scope: "domain" | "global") {
  const rule = createMockRuleFromRecord({
    id,
    record: createRecord(),
    scope,
    action: "replace-body",
    now: 100
  });
  return {
    ...rule,
    domain
  };
}
