import { describe, expect, it } from "vitest";
import { shouldLoadMore } from "../web/src/lib/sources.ts";

describe("web/src/lib/sources shouldLoadMore", () => {
  const base = { paged: true, loading: false, loaded: 200, total: 1000, distance: 100 };

  it("loads the next page near the bottom of a paged list", () => {
    expect(shouldLoadMore(base)).toBe(true);
    expect(shouldLoadMore({ ...base, distance: 900 })).toBe(false);
    expect(shouldLoadMore({ ...base, distance: 900, threshold: 1000 })).toBe(true);
  });

  it("never pages behind the catalog tree or a repository's full path list", () => {
    // The tree reports the space's total while the hidden flat list is empty: this used to page
    // through /api/sources on every scroll at the bottom.
    expect(shouldLoadMore({ ...base, paged: false, loaded: 0, total: 12000, distance: 0 })).toBe(false);
  });

  it("stops when everything is loaded, a request is in flight, or a page came back empty", () => {
    expect(shouldLoadMore({ ...base, loaded: 1000 })).toBe(false);
    expect(shouldLoadMore({ ...base, loaded: 1200 })).toBe(false);
    expect(shouldLoadMore({ ...base, loading: true })).toBe(false);
    expect(shouldLoadMore({ ...base, exhausted: true })).toBe(false);
  });
});
