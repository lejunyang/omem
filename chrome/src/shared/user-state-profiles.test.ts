import { describe, expect, it } from "vitest";
import {
  cookieIdentityKey,
  createUserStateProfile,
  normalizeUserStateProfiles,
  originsFromMatchPatterns,
  patternMatchesUrl,
  storageScopeKey,
  userStateProfileMatchesUrl,
  withSingleActiveProfile
} from "./user-state-profiles";

describe("user state profiles", () => {
  it("creates profiles with cookie enabled and storage disabled by default", () => {
    expect(
      createUserStateProfile({
        id: "profile-1",
        name: "User A",
        matchPatterns: ["*.example.com"],
        now: 100
      })
    ).toMatchObject({
      id: "profile-1",
      enabled: false,
      controls: {
        cookie: true,
        webStorage: false
      },
      applyMode: "patch-only",
      matchPatterns: ["*.example.com"],
      createdAt: 100,
      updatedAt: 100
    });
  });

  it("normalizes stored profiles and keeps only one enabled profile when requested", () => {
    const profiles = normalizeUserStateProfiles({
      "0": {
        id: "a",
        name: "A",
        enabled: true,
        matchPatterns: { "0": "example.com" },
        controls: { cookie: false, webStorage: true },
        applyMode: "clear-then-apply"
      },
      "1": {
        id: "b",
        name: "B",
        enabled: true,
        matchPatterns: ["bad space"]
      }
    });

    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatchObject({
      matchPatterns: ["example.com"],
      controls: { cookie: false, webStorage: true },
      applyMode: "clear-then-apply"
    });
    expect(profiles[1].matchPatterns).toEqual([]);
    expect(withSingleActiveProfile(profiles, "b").map((profile) => profile.enabled)).toEqual([false, true]);
  });

  it("matches loose wildcard domain patterns and explicit schemes", () => {
    expect(patternMatchesUrl("*.example.com", "https://example.com/path")).toBe(true);
    expect(patternMatchesUrl("*.example.com", "https://api.example.com/path")).toBe(true);
    expect(patternMatchesUrl("https://*.example.com/api/*", "https://api.example.com/api/users")).toBe(true);
    expect(patternMatchesUrl("https://*.example.com/api/*", "http://api.example.com/api/users")).toBe(false);
    expect(patternMatchesUrl("https://*.example.com/api/*", "https://other.test/api/users")).toBe(false);
  });

  it("matches profiles against URLs and derives host permission origins", () => {
    const profile = createUserStateProfile({
      id: "profile-2",
      name: "User B",
      matchPatterns: ["example.com", "https://*.example.com/app/*", "http://localhost:*/*"],
      now: 100
    });

    expect(userStateProfileMatchesUrl(profile, "https://shop.example.com/app/home")).toBe(true);
    expect(userStateProfileMatchesUrl(profile, "http://localhost:5173/test-page.html")).toBe(true);
    expect(originsFromMatchPatterns(profile.matchPatterns)).toEqual([
      "http://example.com/*",
      "https://example.com/*",
      "https://*.example.com/*",
      "http://localhost/*"
    ]);
  });

  it("uses partition key when creating cookie identity keys", () => {
    const unpartitioned = cookieIdentityKey({
      storeId: "0",
      name: "sid",
      domain: ".example.com",
      path: "/"
    });
    const partitioned = cookieIdentityKey({
      storeId: "0",
      partitionKey: { topLevelSite: "https://shop.example" },
      name: "sid",
      domain: ".example.com",
      path: "/"
    });
    const samePartitionDifferentOrder = cookieIdentityKey({
      storeId: "0",
      partitionKey: { topLevelSite: "https://shop.example" },
      name: "sid",
      domain: ".example.com",
      path: "/"
    });

    expect(partitioned).not.toBe(unpartitioned);
    expect(partitioned).toBe(samePartitionDifferentOrder);
  });

  it("uses storage scope keys to keep partitioned storage separate", () => {
    expect(
      storageScopeKey({
        origin: "https://cdn.example.com",
        topLevelSite: "https://shop.example",
        frameUrl: "https://cdn.example.com/frame.html"
      })
    ).not.toBe(
      storageScopeKey({
        origin: "https://cdn.example.com",
        topLevelSite: "https://admin.example",
        frameUrl: "https://cdn.example.com/frame.html"
      })
    );
  });
});
