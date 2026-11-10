import { describe, expect, it } from "vitest";
import {
  createFilterPreset,
  describeFilterPreset,
  matchesEnabledFilterPresets,
  moveFilterPreset,
  normalizeFilterPresets
} from "./filter-presets";
import { toNetworkRecord, type DevtoolsRequest } from "./network";

describe("filter presets", () => {
  it("creates presets with full filter state", () => {
    expect(
      createFilterPreset({
        id: "preset-1",
        name: "Errors",
        enabled: true,
        query: "domain:example.com",
        typeFilter: "fetch/xhr",
        statusFilter: "5xx"
      })
    ).toEqual({
      id: "preset-1",
      name: "Errors",
      enabled: true,
      query: "domain:example.com",
      typeFilter: "fetch/xhr",
      statusFilter: "5xx"
    });
  });

  it("normalizes legacy presets that only contain query text", () => {
    expect(
      normalizeFilterPresets([
        {
          id: "legacy",
          name: "Users",
          query: "users"
        }
      ])
    ).toEqual([
      {
        id: "legacy",
        name: "Users",
        enabled: false,
        query: "users",
        typeFilter: "all",
        statusFilter: "all"
      }
    ]);
  });

  it("normalizes numeric-key storage objects without dropping saved presets", () => {
    expect(
      normalizeFilterPresets({
        "0": {
          id: "ed09bcc0-4058-43c1-8f66-6a34ddb864a2",
          name: "test1",
          query: "-url:test",
          statusFilter: "all",
          typeFilter: "all"
        },
        "1": {
          id: "b0ebf304-b509-48ff-8b27-3a14acf9abcd",
          name: "test2",
          query: "-url:test -name:test",
          statusFilter: "all",
          typeFilter: "all"
        }
      })
    ).toEqual([
      {
        id: "ed09bcc0-4058-43c1-8f66-6a34ddb864a2",
        name: "test1",
        enabled: false,
        query: "-url:test",
        typeFilter: "all",
        statusFilter: "all"
      },
      {
        id: "b0ebf304-b509-48ff-8b27-3a14acf9abcd",
        name: "test2",
        enabled: false,
        query: "-url:test -name:test",
        typeFilter: "all",
        statusFilter: "all"
      }
    ]);
  });

  it("drops invalid presets and repairs invalid filter values", () => {
    expect(
      normalizeFilterPresets([
        null,
        { id: "bad" },
        {
          id: "preset-2",
          name: "Images",
          query: "-mime:image",
          typeFilter: "invalid",
          statusFilter: "also-invalid"
        }
      ])
    ).toEqual([
      {
        id: "preset-2",
        name: "Images",
        enabled: false,
        query: "-mime:image",
        typeFilter: "all",
        statusFilter: "all"
      }
    ]);
  });

  it("describes presets for hover tooltips", () => {
    expect(
      describeFilterPreset({
        id: "preset-3",
        name: "API Errors",
        enabled: true,
        query: "domain:api.example.com",
        typeFilter: "fetch/xhr",
        statusFilter: "5xx"
      })
    ).toBe("名称：API Errors\n启用：是\n筛选：domain:api.example.com\n类型：fetch/xhr\n状态：5xx");
  });

  it("moves presets up and down without mutating the original array", () => {
    const presets = [
      preset("a", "A"),
      preset("b", "B"),
      preset("c", "C")
    ];

    expect(moveFilterPreset(presets, "b", "up").map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(moveFilterPreset(presets, "b", "down").map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(presets.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps presets unchanged when moving outside bounds", () => {
    const presets = [
      preset("a", "A"),
      preset("b", "B")
    ];

    expect(moveFilterPreset(presets, "a", "up")).toBe(presets);
    expect(moveFilterPreset(presets, "b", "down")).toBe(presets);
    expect(moveFilterPreset(presets, "missing", "down")).toBe(presets);
  });

  it("matches enabled presets with AND semantics and ignores disabled presets", () => {
    const item = toNetworkRecord(
      {
        request: {
          method: "GET",
          url: "https://api.example.com/api/users"
        },
        response: {
          status: 200,
          content: {
            mimeType: "application/json",
            size: 128
          }
        }
      } satisfies DevtoolsRequest,
      0
    );

    expect(
      matchesEnabledFilterPresets(item, [
        { ...preset("a", "API"), enabled: true, query: "domain:api.example.com" },
        { ...preset("b", "OK"), enabled: true, statusFilter: "2xx" },
        { ...preset("c", "Disabled"), enabled: false, query: "status:5xx" }
      ])
    ).toBe(true);
    expect(
      matchesEnabledFilterPresets(item, [
        { ...preset("a", "API"), enabled: true, query: "domain:api.example.com" },
        { ...preset("b", "Images"), enabled: true, typeFilter: "image" }
      ])
    ).toBe(false);
  });
});

function preset(id: string, name: string) {
  return createFilterPreset({
    id,
    name,
    query: "",
    typeFilter: "all",
    statusFilter: "all"
  });
}
