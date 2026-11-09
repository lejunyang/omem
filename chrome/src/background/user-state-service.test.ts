import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_USER_STATE_PROFILE_STORAGE_KEY,
  USER_STATE_PROFILE_STORAGE_KEY,
  type UserStateProfile
} from "../shared/user-state-profiles";

describe("user state background service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("ignores cookie changes caused by applying a profile", async () => {
    const profile = createProfile({
      controls: { cookie: true, webStorage: false },
      cookieJar: [createCookie("from-profile")]
    });
    const chromeMock = installChromeMock({
      [USER_STATE_PROFILE_STORAGE_KEY]: [profile],
      [ACTIVE_USER_STATE_PROFILE_STORAGE_KEY]: null
    });
    const { handleUserStateCookieChange, handleUserStateMessage } = await import("./user-state-service");

    await handleUserStateMessage({
      type: "advanced-network:user-state-apply-profile",
      profile
    });
    expect(chromeMock.cookies.set).toHaveBeenCalledOnce();
    expect(chromeMock.storageSetCalls).toHaveLength(1);

    await handleUserStateCookieChange({
      cookie: createChromeCookie("from-profile"),
      cause: "explicit",
      removed: false
    });

    expect(chromeMock.storageSetCalls).toHaveLength(1);
    expect(chromeMock.data[USER_STATE_PROFILE_STORAGE_KEY]).toEqual([
      expect.objectContaining({
        cookieJar: [expect.objectContaining({ value: "from-profile" })]
      })
    ]);
  });

  it("ignores web storage messages emitted by extension writes", async () => {
    const profile = createProfile({
      controls: { cookie: false, webStorage: true },
      enabled: true,
      storageByScope: {}
    });
    const chromeMock = installChromeMock({
      [USER_STATE_PROFILE_STORAGE_KEY]: [profile],
      [ACTIVE_USER_STATE_PROFILE_STORAGE_KEY]: profile.id
    });
    const { handleUserStateMessage } = await import("./user-state-service");

    await handleUserStateMessage({
      type: "advanced-network:user-state-storage-changed",
      profileId: profile.id,
      source: "extension",
      url: "https://example.com/account",
      origin: "https://example.com",
      topLevelSite: "https://example.com",
      frameUrl: "https://example.com/account",
      area: "localStorage",
      action: "setItem",
      key: "token",
      value: "extension-write"
    });

    expect(chromeMock.storageSetCalls).toHaveLength(0);
    expect(chromeMock.data[USER_STATE_PROFILE_STORAGE_KEY]).toEqual([profile]);
  });

  it("persists browser web storage messages for the active profile", async () => {
    const profile = createProfile({
      controls: { cookie: false, webStorage: true },
      enabled: true,
      storageByScope: {}
    });
    const chromeMock = installChromeMock({
      [USER_STATE_PROFILE_STORAGE_KEY]: [profile],
      [ACTIVE_USER_STATE_PROFILE_STORAGE_KEY]: profile.id
    });
    const { handleUserStateMessage } = await import("./user-state-service");

    await handleUserStateMessage({
      type: "advanced-network:user-state-storage-changed",
      profileId: profile.id,
      source: "browser",
      url: "https://example.com/account",
      origin: "https://example.com",
      topLevelSite: "https://example.com",
      frameUrl: "https://example.com/account",
      area: "localStorage",
      action: "setItem",
      key: "token",
      value: "browser-write"
    });

    expect(chromeMock.storageSetCalls).toHaveLength(1);
    expect(chromeMock.data[USER_STATE_PROFILE_STORAGE_KEY]).toEqual([
      expect.objectContaining({
        storageByScope: {
          ["https://example.com\u0000https://example.com\u0000https://example.com/account"]: expect.objectContaining({
            localStorage: { token: "browser-write" }
          })
        }
      })
    ]);
  });
});

function createProfile(patch: Partial<UserStateProfile>): UserStateProfile {
  const controls = {
    cookie: patch.controls?.cookie ?? true,
    webStorage: patch.controls?.webStorage ?? false
  };

  return {
    id: "profile-1",
    name: "Profile 1",
    enabled: false,
    matchPatterns: ["https://example.com/*"],
    applyMode: "patch-only",
    cookieJar: [],
    storageByScope: {},
    createdAt: 100,
    updatedAt: 100,
    ...patch,
    controls
  };
}

function createCookie(value: string) {
  return {
    storeId: "0",
    name: "sid",
    value,
    domain: "example.com",
    path: "/",
    secure: true,
    httpOnly: false
  };
}

function createChromeCookie(value: string): chrome.cookies.Cookie {
  return {
    ...createCookie(value),
    hostOnly: true,
    session: true
  } as chrome.cookies.Cookie;
}

function installChromeMock(initialData: Record<string, unknown>) {
  const data = { ...initialData };
  const storageSetCalls: Record<string, unknown>[] = [];
  const chromeMock = {
    data,
    storageSetCalls,
    cookies: {
      getAll: vi.fn(async () => []),
      remove: vi.fn(async () => undefined),
      set: vi.fn(async () => createChromeCookie("from-profile"))
    },
    runtime: {},
    scripting: {
      executeScript: vi.fn(async () => [])
    },
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, data[key]]));
          }
          if (typeof keys === "string") {
            return { [keys]: data[keys] };
          }
          return { ...data };
        },
        async set(items: Record<string, unknown>) {
          storageSetCalls.push(items);
          Object.assign(data, items);
        }
      }
    },
    tabs: {
      query: vi.fn(async () => [])
    }
  };
  vi.stubGlobal("chrome", chromeMock);
  return chromeMock;
}
