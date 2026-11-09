import { describe, expect, it } from "vitest";
import type { DevtoolsRequest, NetworkRecord } from "../shared/network";
import { toNetworkRecord } from "../shared/network";
import {
  isMainDocumentNavigation,
  matchesPanelRecordFilters,
  shouldClearRecordsBeforeRequest,
  shouldClearRecordsOnNavigation,
  shouldReplaceRecordsFromHar
} from "./network-records";

describe("panel network record guards", () => {
  it("keeps current records when a passive HAR snapshot is empty", () => {
    expect(shouldReplaceRecordsFromHar({ currentCount: 3, entryCount: 0 })).toBe(false);
  });

  it("allows initial empty HAR snapshots and explicit refreshes", () => {
    expect(shouldReplaceRecordsFromHar({ currentCount: 0, entryCount: 0 })).toBe(true);
    expect(shouldReplaceRecordsFromHar({ currentCount: 3, entryCount: 0, force: true })).toBe(true);
  });

  it("clears records only for confirmed main document navigation", () => {
    const mainDocument = record("https://business.example.com/site/brand", "text/html", {
      _resourceType: "document",
      _documentURL: "https://business.example.com/site/brand"
    });

    expect(isMainDocumentNavigation(mainDocument)).toBe(true);
    expect(
      shouldClearRecordsBeforeRequest({
        preserveLog: false,
        record: mainDocument,
        currentCount: 12
      })
    ).toBe(true);
  });

  it("does not clear records for document-like subresources without main document metadata", () => {
    const lateHtmlRequest = record("https://example.com/fragment", "text/html");

    expect(isMainDocumentNavigation(lateHtmlRequest)).toBe(false);
    expect(
      shouldClearRecordsBeforeRequest({
        preserveLog: false,
        record: lateHtmlRequest,
        currentCount: 12
      })
    ).toBe(false);
  });

  it("does not clear records when preserve log is enabled", () => {
    const mainDocument = record("https://business.example.com/site/brand", "text/html", {
      _resourceType: "document",
      _documentURL: "https://business.example.com/site/brand"
    });

    expect(
      shouldClearRecordsBeforeRequest({
        preserveLog: true,
        record: mainDocument,
        currentCount: 12
      })
    ).toBe(false);
  });

  it("clears current records on navigation unless preserve log is enabled", () => {
    expect(shouldClearRecordsOnNavigation({ preserveLog: false, currentCount: 12 })).toBe(true);
    expect(shouldClearRecordsOnNavigation({ preserveLog: true, currentCount: 12 })).toBe(false);
    expect(shouldClearRecordsOnNavigation({ preserveLog: false, currentCount: 0 })).toBe(false);
  });

  it("matches panel filters with temporary query and enabled preset callback", () => {
    const apiRecord = record("https://business.example.com/api/list", "application/json");

    expect(
      matchesPanelRecordFilters({
        record: apiRecord,
        filter: "url:/api/list",
        typeFilter: "all",
        statusFilter: "all",
        matchesEnabledPresets: () => true
      })
    ).toBe(true);
    expect(
      matchesPanelRecordFilters({
        record: apiRecord,
        filter: "url:/api/list",
        typeFilter: "all",
        statusFilter: "all",
        matchesEnabledPresets: () => false
      })
    ).toBe(false);
    expect(
      matchesPanelRecordFilters({
        record: apiRecord,
        filter: "url:/missing",
        typeFilter: "all",
        statusFilter: "all",
        matchesEnabledPresets: () => true
      })
    ).toBe(false);
  });
});

function record(
  url: string,
  mimeType: string,
  extra: Partial<DevtoolsRequest> & Record<string, unknown> = {}
): NetworkRecord {
  return toNetworkRecord(
    {
      request: {
        method: "GET",
        url
      },
      response: {
        status: 200,
        content: {
          mimeType,
          size: 128
        }
      },
      ...extra
    } as DevtoolsRequest,
    0
  );
}
