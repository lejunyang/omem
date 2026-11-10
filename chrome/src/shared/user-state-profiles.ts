import { normalizeStoredList } from "./stored-list";

export const USER_STATE_PROFILE_STORAGE_KEY = "advancedNetwork.userStateProfiles";
export const ACTIVE_USER_STATE_PROFILE_STORAGE_KEY = "advancedNetwork.activeUserStateProfileId";

export type UserStateApplyMode = "clear-then-apply" | "patch-only";

export interface UserStateControls {
  cookie: boolean;
  webStorage: boolean;
}

export interface StoredCookie {
  storeId?: string;
  partitionKey?: unknown;
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
}

export interface StoredWebStorageScope {
  origin: string;
  topLevelSite: string;
  frameUrl: string;
}

export interface StoredWebStorage {
  scope: StoredWebStorageScope;
  localStorage: Record<string, string>;
  sessionStorageByTab: Record<string, Record<string, string>>;
}

export interface UserStateProfile {
  id: string;
  name: string;
  enabled: boolean;
  matchPatterns: string[];
  controls: UserStateControls;
  applyMode: UserStateApplyMode;
  cookieJar: StoredCookie[];
  storageByScope: Record<string, StoredWebStorage>;
  createdAt: number;
  updatedAt: number;
}

interface ParsedPattern {
  schemes: Array<"http" | "https">;
  hostPattern: string;
  pathPattern: string;
}

export function createUserStateProfile(input: {
  id: string;
  name: string;
  matchPatterns: string[];
  now: number;
  controls?: Partial<UserStateControls>;
  applyMode?: UserStateApplyMode;
}): UserStateProfile {
  // 新配置默认只控制 cookie；storage 需要注入脚本监听，默认关闭以降低对页面运行时的影响。
  return {
    id: input.id,
    name: input.name,
    enabled: false,
    matchPatterns: normalizeMatchPatterns(input.matchPatterns),
    controls: {
      cookie: input.controls?.cookie ?? true,
      webStorage: input.controls?.webStorage ?? false
    },
    applyMode: input.applyMode ?? "patch-only",
    cookieJar: [],
    storageByScope: {},
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function normalizeUserStateProfiles(value: unknown): UserStateProfile[] {
  // 用户状态配置会长期保存在 chrome.storage.local，所有字段都要容忍旧结构和缺省值。
  return normalizeStoredList(value).flatMap((item) => {
    if (!isProfileLike(item)) {
      return [];
    }
    const now = Date.now();
    return [
      {
        id: item.id,
        name: item.name,
        enabled: typeof item.enabled === "boolean" ? item.enabled : false,
        matchPatterns: normalizeMatchPatterns(item.matchPatterns),
        controls: normalizeControls(item.controls),
        applyMode: item.applyMode === "clear-then-apply" ? "clear-then-apply" : "patch-only",
        cookieJar: normalizeStoredCookies(item.cookieJar),
        storageByScope: normalizeStorageByScope(item.storageByScope),
        createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now
      }
    ];
  });
}

export function withSingleActiveProfile(profiles: UserStateProfile[], profileId: string | null): UserStateProfile[] {
  // 同一时间只允许一个用户状态配置生效，避免多个配置同时写 cookie/storage 造成循环覆盖。
  return profiles.map((profile) => ({
    ...profile,
    enabled: Boolean(profileId) && profile.id === profileId
  }));
}

export function normalizeMatchPatterns(patterns: unknown): string[] {
  // 域名规则允许用户输入宽松格式，但保存前只保留能解析成 http/https match pattern 的条目。
  const rawPatterns = normalizeStoredList(patterns);
  const normalized = rawPatterns
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => (parsePattern(item) ? [item] : []));
  return [...new Set(normalized)];
}

export function userStateProfileMatchesUrl(profile: UserStateProfile, url: string): boolean {
  return profile.matchPatterns.some((pattern) => patternMatchesUrl(pattern, url));
}

export function patternMatchesUrl(pattern: string, url: string): boolean {
  const parsed = parsePattern(pattern);
  const parsedUrl = safeUrl(url);
  if (!parsed || !parsedUrl) {
    return false;
  }
  const scheme = parsedUrl.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") {
    return false;
  }
  return (
    parsed.schemes.includes(scheme) &&
    hostMatches(parsed.hostPattern, parsedUrl.hostname) &&
    pathMatches(parsed.pathPattern, `${parsedUrl.pathname}${parsedUrl.search}`)
  );
}

export function originsFromMatchPatterns(patterns: string[]): string[] {
  // 动态申请 cookie 权限需要 Chrome match pattern；这里把宽松域名规则转换为权限可识别的 origin。
  const origins = patterns.flatMap((pattern) => {
    const parsed = parsePattern(pattern);
    if (!parsed) {
      return [];
    }
    const permissionHost = toPermissionHost(parsed.hostPattern);
    return parsed.schemes.map((scheme) => `${scheme}://${permissionHost}/*`);
  });
  return [...new Set(origins)];
}

export function cookieIdentityKey(cookie: Pick<StoredCookie, "storeId" | "partitionKey" | "name" | "domain" | "path">): string {
  // partitioned cookie 与普通 cookie 可能同名同域，身份键必须包含 storeId 和 partitionKey 才不会互相覆盖。
  return [
    cookie.storeId ?? "",
    stableStringify(cookie.partitionKey ?? null),
    cookie.name,
    cookie.domain,
    cookie.path
  ].join("\u0000");
}

export function storageScopeKey(scope: StoredWebStorageScope): string {
  // storage 按 origin、顶层站点和 frameUrl 分桶，兼容第三方 iframe 与未来 partitioned storage 的区分。
  return [scope.origin, scope.topLevelSite, scope.frameUrl].join("\u0000");
}

export function tabStorageKey(tabId: number, frameId = 0): string {
  // sessionStorage 生命周期绑定 tab/frame，不能只按 origin 保存，否则多标签页会互相污染。
  return `${tabId}:${frameId}`;
}

function normalizeControls(value: unknown): UserStateControls {
  if (!value || typeof value !== "object") {
    return { cookie: true, webStorage: false };
  }
  const controls = value as Record<string, unknown>;
  return {
    cookie: typeof controls.cookie === "boolean" ? controls.cookie : true,
    webStorage: typeof controls.webStorage === "boolean" ? controls.webStorage : false
  };
}

function normalizeStoredCookies(value: unknown): StoredCookie[] {
  return normalizeStoredList(value).flatMap((item) => {
    if (!isStoredCookieLike(item)) {
      return [];
    }
    return [
      {
        storeId: typeof item.storeId === "string" ? item.storeId : undefined,
        partitionKey: item.partitionKey,
        name: item.name,
        value: item.value,
        domain: item.domain,
        path: item.path,
        secure: typeof item.secure === "boolean" ? item.secure : false,
        httpOnly: typeof item.httpOnly === "boolean" ? item.httpOnly : false,
        sameSite: typeof item.sameSite === "string" ? item.sameSite : undefined,
        expirationDate: typeof item.expirationDate === "number" ? item.expirationDate : undefined
      }
    ];
  });
}

function normalizeStorageByScope(value: unknown): Record<string, StoredWebStorage> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.values(value as Record<string, unknown>).flatMap((item) => {
      if (!isStoredWebStorageLike(item)) {
        return [];
      }
      const storage = {
        scope: item.scope,
        localStorage: normalizeStringRecord(item.localStorage),
        sessionStorageByTab: normalizeNestedStringRecord(item.sessionStorageByTab)
      };
      return [[storageScopeKey(storage.scope), storage]];
    })
  );
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function normalizeNestedStringRecord(value: unknown): Record<string, Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeStringRecord(item)])
  );
}

function parsePattern(pattern: string): ParsedPattern | null {
  const value = pattern.trim().toLowerCase();
  const match = /^(?:(https?|\*):\/\/)?([^/]+)(\/.*)?$/.exec(value);
  if (!match) {
    return null;
  }
  const [, rawScheme, rawHost, rawPath] = match;
  const hostPattern = stripPort(rawHost);
  if (!hostPattern || !isValidHostPattern(hostPattern)) {
    return null;
  }
  return {
    schemes: rawScheme === "http" || rawScheme === "https" ? [rawScheme] : ["http", "https"],
    hostPattern,
    pathPattern: rawPath || "/*"
  };
}

function hostMatches(hostPattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (hostPattern === "*") {
    return true;
  }
  if (hostPattern.startsWith("*.")) {
    const suffix = hostPattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === hostPattern;
}

function pathMatches(pathPattern: string, path: string): boolean {
  const escaped = pathPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function toPermissionHost(hostPattern: string): string {
  return hostPattern === "*" ? "*" : hostPattern;
}

function stripPort(host: string): string {
  return host.replace(/:\*$/, "").replace(/:\d+$/, "");
}

function isValidHostPattern(value: string): boolean {
  return value === "*" || /^[a-z0-9.-]+$/.test(value) || /^\*\.[a-z0-9.-]+$/.test(value);
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function isProfileLike(value: unknown): value is {
  id: string;
  name: string;
  enabled?: unknown;
  matchPatterns?: unknown;
  controls?: unknown;
  applyMode?: unknown;
  cookieJar?: unknown;
  storageByScope?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

function isStoredCookieLike(value: unknown): value is Record<string, unknown> & {
  name: string;
  value: string;
  domain: string;
  path: string;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.value === "string" &&
    typeof candidate.domain === "string" &&
    typeof candidate.path === "string"
  );
}

function isStoredWebStorageLike(value: unknown): value is {
  scope: StoredWebStorageScope;
  localStorage?: unknown;
  sessionStorageByTab?: unknown;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const scope = candidate.scope as Record<string, unknown> | undefined;
  return (
    Boolean(scope) &&
    typeof scope?.origin === "string" &&
    typeof scope.topLevelSite === "string" &&
    typeof scope.frameUrl === "string"
  );
}
