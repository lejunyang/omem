import { getStorageItems, setStorageItemsAndVerify } from "../shared/extension-storage";
import type { UserStateMessage, UserStateMessageResponse } from "../shared/user-state-messages";
import {
  ACTIVE_USER_STATE_PROFILE_STORAGE_KEY,
  cookieIdentityKey,
  normalizeUserStateProfiles,
  patternMatchesUrl,
  storageScopeKey,
  tabStorageKey,
  USER_STATE_PROFILE_STORAGE_KEY,
  type StoredCookie,
  type StoredWebStorage,
  type UserStateProfile,
  withSingleActiveProfile
} from "../shared/user-state-profiles";

const cookieOperationGuard = new Map<string, number>();
const storageOperationGuard = new Set<string>();
let storageWriteQueue: Promise<void> = Promise.resolve();

export async function handleUserStateMessage(message: UserStateMessage): Promise<UserStateMessageResponse> {
  if (message.type === "advanced-network:user-state-disable-profile") {
    await persistProfiles((profiles) => withSingleActiveProfile(profiles, null));
    return { ok: true };
  }

  if (message.type === "advanced-network:user-state-apply-profile") {
    const operationId = createOperationId();
    const matchedTabs = await applyProfileToMatchingTabs(message.profile, operationId);
    await persistProfiles((profiles) => withSingleActiveProfile(upsertProfile(profiles, message.profile), message.profile.id));
    return { ok: true, matchedTabs };
  }

  if (message.type === "advanced-network:user-state-capture") {
    const matchedTabs = await captureProfileFromMatchingTabs(message.profile);
    return { ok: true, matchedTabs };
  }

  if (message.type === "advanced-network:user-state-storage-changed") {
    await handleStorageChangedMessage(message);
    return { ok: true };
  }

  return { ok: false, error: "Unknown user state message." };
}

export async function handleUserStateCookieChange(changeInfo: chrome.cookies.CookieChangeInfo): Promise<void> {
  const profile = await loadActiveProfile();
  if (!profile?.controls.cookie) {
    return;
  }

  const storedCookie = toStoredCookie(changeInfo.cookie);
  const key = cookieIdentityKey(storedCookie);
  if (consumeCookieGuard(key)) {
    return;
  }
  if (!cookieMatchesProfile(storedCookie, profile)) {
    return;
  }

  await persistProfiles((profiles) =>
    profiles.map((item) => {
      if (item.id !== profile.id) {
        return item;
      }
      const nextJar = item.cookieJar.filter((cookie) => cookieIdentityKey(cookie) !== key);
      return {
        ...item,
        cookieJar: changeInfo.removed ? nextJar : [...nextJar, storedCookie],
        updatedAt: Date.now()
      };
    })
  );
}

async function applyProfileToMatchingTabs(profile: UserStateProfile, operationId: string): Promise<number> {
  const tabs = await queryTabs();
  const matchedTabs = tabs.filter((tab) => typeof tab.id === "number" && tab.url && profileMatchesUrl(profile, tab.url));

  if (profile.controls.cookie) {
    await applyProfileCookies(profile, operationId);
  }

  if (profile.controls.webStorage) {
    await Promise.all(
      matchedTabs.map((tab) => applyProfileStorageToTab(profile, tab.id as number, tab.url ?? "", operationId))
    );
  }

  return matchedTabs.length;
}

async function captureProfileFromMatchingTabs(profile: UserStateProfile): Promise<number> {
  const tabs = await queryTabs();
  const matchedTabs = tabs.filter((tab) => typeof tab.id === "number" && tab.url && profileMatchesUrl(profile, tab.url));
  if (profile.controls.cookie) {
    await captureProfileCookies(profile);
  }
  if (profile.controls.webStorage) {
    await Promise.all(matchedTabs.map((tab) => installStorageBridgeAndHook(profile, tab.id as number)));
  }
  return matchedTabs.length;
}

async function applyProfileCookies(profile: UserStateProfile, operationId: string): Promise<void> {
  if (profile.applyMode === "clear-then-apply") {
    const cookies = await getCookies({});
    await Promise.all(
      cookies
        .map(toStoredCookie)
        .filter((cookie) => cookieMatchesProfile(cookie, profile))
        .map((cookie) => removeCookie(cookie, operationId))
    );
  }
  await Promise.all(profile.cookieJar.map((cookie) => setCookie(cookie, operationId)));
}

async function captureProfileCookies(profile: UserStateProfile): Promise<void> {
  const cookies = (await getCookies({})).map(toStoredCookie).filter((cookie) => cookieMatchesProfile(cookie, profile));
  await persistProfiles((profiles) =>
    profiles.map((item) => (item.id === profile.id ? { ...item, cookieJar: cookies, updatedAt: Date.now() } : item))
  );
}

async function applyProfileStorageToTab(
  profile: UserStateProfile,
  tabId: number,
  tabUrl: string,
  operationId: string
): Promise<void> {
  await installStorageBridgeAndHook(profile, tabId);
  const origin = safeOrigin(tabUrl);
  const targetStorage = Object.values(profile.storageByScope).find((storage) => storage.scope.origin === origin);
  storageOperationGuard.add(operationId);
  await executeScript({
    target: { tabId },
    world: "MAIN",
    func: applyWebStorageState,
    args: [operationId, profile.applyMode, targetStorage?.localStorage ?? {}, targetStorage?.sessionStorageByTab ?? {}]
  });
  setTimeout(() => storageOperationGuard.delete(operationId), 2000);
}

async function installStorageBridgeAndHook(profile: UserStateProfile, tabId: number): Promise<void> {
  await executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: installUserStateBridge,
    args: [profile.id]
  });
  await executeScript({
    target: { tabId },
    world: "MAIN",
    func: installUserStateStorageHook,
    args: [profile.id]
  });
}

async function handleStorageChangedMessage(message: Extract<UserStateMessage, { type: "advanced-network:user-state-storage-changed" }>) {
  if (message.source === "extension" || (message.operationId && storageOperationGuard.has(message.operationId))) {
    return;
  }

  storageWriteQueue = storageWriteQueue.then(() => updateProfileStorage(message));
  await storageWriteQueue;
}

async function updateProfileStorage(
  message: Extract<UserStateMessage, { type: "advanced-network:user-state-storage-changed" }>
): Promise<void> {
  const profiles = await loadProfiles();
  const profile = profiles.find((item) => item.id === message.profileId && item.enabled && item.controls.webStorage);
  if (!profile || !profileMatchesUrl(profile, message.url)) {
    return;
  }

  const scope = {
    origin: message.origin,
    topLevelSite: message.topLevelSite,
    frameUrl: message.frameUrl
  };
  const scopeKey = storageScopeKey(scope);
  const tabKey = tabStorageKey(message.tabId ?? 0, message.frameId ?? 0);
  const current = profile.storageByScope[scopeKey] ?? {
    scope,
    localStorage: {},
    sessionStorageByTab: {}
  };
  const nextStorage = applyStorageMutation(current, tabKey, message);

  await persistProfiles((items) =>
    items.map((item) =>
      item.id === profile.id
        ? {
            ...item,
            storageByScope: {
              ...item.storageByScope,
              [scopeKey]: nextStorage
            },
            updatedAt: Date.now()
          }
        : item
    )
  );
}

function applyStorageMutation(
  storage: StoredWebStorage,
  tabKey: string,
  message: Extract<UserStateMessage, { type: "advanced-network:user-state-storage-changed" }>
): StoredWebStorage {
  const isLocal = message.area === "localStorage";
  const target = isLocal ? storage.localStorage : storage.sessionStorageByTab[tabKey] ?? {};
  const nextTarget = { ...target };
  if (message.action === "snapshot" && message.snapshot) {
    return isLocal
      ? { ...storage, localStorage: message.snapshot }
      : { ...storage, sessionStorageByTab: { ...storage.sessionStorageByTab, [tabKey]: message.snapshot } };
  }
  if (message.action === "clear") {
    return isLocal
      ? { ...storage, localStorage: {} }
      : { ...storage, sessionStorageByTab: { ...storage.sessionStorageByTab, [tabKey]: {} } };
  }
  if (message.action === "removeItem" && message.key) {
    delete nextTarget[message.key];
  }
  if (message.action === "setItem" && message.key && typeof message.value === "string") {
    nextTarget[message.key] = message.value;
  }
  return isLocal
    ? { ...storage, localStorage: nextTarget }
    : { ...storage, sessionStorageByTab: { ...storage.sessionStorageByTab, [tabKey]: nextTarget } };
}

async function loadActiveProfile(): Promise<UserStateProfile | null> {
  const items = await getStorageItems(chrome.storage.local, [
    USER_STATE_PROFILE_STORAGE_KEY,
    ACTIVE_USER_STATE_PROFILE_STORAGE_KEY
  ]);
  const activeId = items[ACTIVE_USER_STATE_PROFILE_STORAGE_KEY];
  return normalizeUserStateProfiles(items[USER_STATE_PROFILE_STORAGE_KEY]).find(
    (profile) => profile.enabled && profile.id === activeId
  ) ?? null;
}

async function loadProfiles(): Promise<UserStateProfile[]> {
  const items = await getStorageItems(chrome.storage.local, USER_STATE_PROFILE_STORAGE_KEY);
  return normalizeUserStateProfiles(items[USER_STATE_PROFILE_STORAGE_KEY]);
}

async function persistProfiles(updater: (profiles: UserStateProfile[]) => UserStateProfile[]): Promise<void> {
  const profiles = updater(await loadProfiles());
  const activeProfile = profiles.find((profile) => profile.enabled);
  await setStorageItemsAndVerify(chrome.storage.local, {
    [USER_STATE_PROFILE_STORAGE_KEY]: profiles,
    [ACTIVE_USER_STATE_PROFILE_STORAGE_KEY]: activeProfile?.id ?? null
  });
}

function upsertProfile(profiles: UserStateProfile[], profile: UserStateProfile): UserStateProfile[] {
  if (profiles.some((item) => item.id === profile.id)) {
    return profiles.map((item) => (item.id === profile.id ? profile : item));
  }
  return [...profiles, profile];
}

function profileMatchesUrl(profile: UserStateProfile, url: string): boolean {
  return profile.matchPatterns.some((pattern) => patternMatchesUrl(pattern, url));
}

function cookieMatchesProfile(cookie: StoredCookie, profile: UserStateProfile): boolean {
  const host = cookie.domain.replace(/^\./, "");
  return profile.matchPatterns.some(
    (pattern) => patternMatchesUrl(pattern, `https://${host}${cookie.path}`) || patternMatchesUrl(pattern, `http://${host}${cookie.path}`)
  );
}

function toStoredCookie(cookie: chrome.cookies.Cookie): StoredCookie {
  const partitionKey = (cookie as chrome.cookies.Cookie & { partitionKey?: unknown }).partitionKey;
  return {
    storeId: cookie.storeId,
    partitionKey,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate
  };
}

async function setCookie(cookie: StoredCookie, operationId: string): Promise<void> {
  const url = `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`;
  addCookieGuard(cookie, operationId);
  await chrome.cookies.set(
    compactObject({
      url,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
      storeId: cookie.storeId,
      partitionKey: cookie.partitionKey
    }) as unknown as chrome.cookies.SetDetails
  );
}

async function removeCookie(cookie: StoredCookie, operationId: string): Promise<void> {
  const url = `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`;
  addCookieGuard(cookie, operationId);
  await chrome.cookies.remove(
    compactObject({
      url,
      name: cookie.name,
      storeId: cookie.storeId,
      partitionKey: cookie.partitionKey
    }) as unknown as chrome.cookies.Details
  );
}

function addCookieGuard(cookie: StoredCookie, operationId: string): void {
  cookieOperationGuard.set(cookieIdentityKey(cookie), Date.now() + 3000);
  cookieOperationGuard.set(`${operationId}:${cookieIdentityKey(cookie)}`, Date.now() + 3000);
}

function consumeCookieGuard(key: string): boolean {
  const expiresAt = cookieOperationGuard.get(key);
  if (!expiresAt) {
    return false;
  }
  cookieOperationGuard.delete(key);
  return expiresAt > Date.now();
}

function getCookies(details: chrome.cookies.GetAllDetails): Promise<chrome.cookies.Cookie[]> {
  return chrome.cookies.getAll(details);
}

function queryTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({});
}

function executeScript<Args extends unknown[]>(details: chrome.scripting.ScriptInjection<Args, void>): Promise<void> {
  return chrome.scripting.executeScript(details).then(() => undefined);
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function createOperationId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function installUserStateBridge(profileId: string): void {
  const marker = "__advancedNetworkUserStateBridgeInstalled";
  if ((window as unknown as Record<string, unknown>)[marker]) {
    return;
  }
  (window as unknown as Record<string, unknown>)[marker] = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.type !== "advanced-network:user-state-storage-changed") {
      return;
    }
    chrome.runtime.sendMessage({
      ...event.data,
      profileId
    });
  });
}

function installUserStateStorageHook(profileId: string): void {
  const stateKey = "__advancedNetworkUserStateHook";
  const windowState = window as unknown as Record<string, { profileId?: string; applyingOperationId?: string } | undefined>;
  if (windowState[stateKey]) {
    windowState[stateKey] = { ...windowState[stateKey], profileId };
    return;
  }
  windowState[stateKey] = { profileId };
  const originalSetItem = Storage.prototype.setItem;
  const originalRemoveItem = Storage.prototype.removeItem;
  const originalClear = Storage.prototype.clear;

  function storageArea(storage: Storage): "localStorage" | "sessionStorage" {
    return storage === window.localStorage ? "localStorage" : "sessionStorage";
  }

  function snapshot(storage: Storage): Record<string, string> {
    return Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) ?? "";
      return [key, storage.getItem(key) ?? ""];
    }).filter(([key]) => key));
  }

  function emit(storage: Storage, action: string, key?: string | null, value?: string | null): void {
    const state = windowState[stateKey];
    if (state?.applyingOperationId) {
      return;
    }
    window.postMessage(
      {
        type: "advanced-network:user-state-storage-changed",
        profileId: state?.profileId ?? profileId,
        source: "browser",
        url: location.href,
        origin: location.origin,
        topLevelSite: location.origin,
        frameUrl: location.href,
        area: storageArea(storage),
        action,
        key,
        value
      },
      "*"
    );
  }

  Storage.prototype.setItem = function setItem(key: string, value: string): void {
    originalSetItem.call(this, key, value);
    emit(this, "setItem", key, value);
  };
  Storage.prototype.removeItem = function removeItem(key: string): void {
    originalRemoveItem.call(this, key);
    emit(this, "removeItem", key, null);
  };
  Storage.prototype.clear = function clear(): void {
    originalClear.call(this);
    emit(this, "clear", null, null);
  };
  window.addEventListener("storage", (event) => {
    const storage = event.storageArea === window.localStorage ? window.localStorage : window.sessionStorage;
    emit(storage, event.key ? "setItem" : "clear", event.key, event.newValue);
  });
  [window.localStorage, window.sessionStorage].forEach((storage) => {
    window.postMessage(
      {
        type: "advanced-network:user-state-storage-changed",
        profileId,
        source: "browser",
        url: location.href,
        origin: location.origin,
        topLevelSite: location.origin,
        frameUrl: location.href,
        area: storageArea(storage),
        action: "snapshot",
        snapshot: snapshot(storage)
      },
      "*"
    );
  });
}

function applyWebStorageState(
  operationId: string,
  applyMode: "clear-then-apply" | "patch-only",
  localStorageState: Record<string, string>,
  sessionStorageByTab: Record<string, Record<string, string>>
): void {
  function applyTargetStorage(
    storage: Storage,
    nextValues: Record<string, string>,
    mode: "clear-then-apply" | "patch-only"
  ): void {
    if (mode === "clear-then-apply") {
      storage.clear();
    }
    Object.entries(nextValues).forEach(([key, value]) => storage.setItem(key, value));
  }

  const stateKey = "__advancedNetworkUserStateHook";
  const windowState = window as unknown as Record<string, { applyingOperationId?: string } | undefined>;
  windowState[stateKey] = { ...windowState[stateKey], applyingOperationId: operationId };
  try {
    applyTargetStorage(window.localStorage, localStorageState, applyMode);
    applyTargetStorage(window.sessionStorage, Object.values(sessionStorageByTab)[0] ?? {}, applyMode);
  } finally {
    windowState[stateKey] = { ...windowState[stateKey], applyingOperationId: undefined };
  }
}
