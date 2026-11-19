// 录制：本人在自己的浏览器里把要教给助手的事做一遍，扩展记下打开的页面、点击和填写、本人加的标记、
// 请求和每步的截图；停止后上传给 omem（POST /api/remote/recordings/import），omem 写成和 aad 浏览器录制
// 一样的文件，助手按内置技能 skill-from-recording 整理成技能。
// 这里只放纯数据和规则（可单元测试）：步骤和请求的形状、哪些输入框不记值、请求的遮盖、DevTools 记录的合并、上传内容。

export type StepKind = "click" | "input" | "submit" | "enter" | "navigate" | "mark";

/** 一个动作作用在什么元素上；字段名和 omem 的导入接口一致（src/remote/import.ts）。 */
export interface StepAction {
  kind: StepKind;
  /** 元素的名字：aria-label、关联的 label、placeholder 或文字 */
  label?: string;
  role?: string;
  tag?: string;
  type?: string;
  /** 能在 DevTools 里 querySelector 回去的路径（element-context 的 cssPath） */
  selector?: string;
  /** 元素前面最近的标题，说明它在页面哪一块 */
  heading?: string;
  text?: string;
  /** 填写的内容；受保护的输入框为 null */
  value?: string | null;
  protected?: boolean;
  url?: string;
  title?: string;
  /** 标记：本人说的“这里看的是……” */
  note?: string;
}

export interface RecordedStep {
  /** 本地 id：删除用，也是截图在 IndexedDB 里的键 */
  id: string;
  at: number;
  tabId: number;
  kind: "action" | "mark";
  action: StepAction;
  screenshot?: string;
}

export interface RecordedRequest {
  /** webRequest 的 requestId，或 DevTools 记录的 dt-… */
  id: string;
  tabId: number;
  /** 开始时间（毫秒时间戳） */
  at: number;
  method: string;
  url: string;
  /** 和 CDP 一样的资源类型（XHR、Script、Image……），omem 按它分出静态资源和埋点 */
  type: string;
  status?: number | null;
  durationMs?: number | null;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  error?: string;
  source: "webRequest" | "devtools";
}

export interface RecordingSession {
  id: string;
  goal: string;
  /** 录哪些标签页：开始时选的，加上从它们打开的新标签页和本人中途加的 */
  tabIds: number[];
  startedAt: number;
  stoppedAt?: number;
  status: "recording" | "stopped";
  startUrl: string;
  startTitle: string;
  /** 计数：侧栏显示用，不用每次把上千个请求读出来数 */
  requests?: number;
  bodies?: number;
}

/** 请求体、响应体各留多少字（omem 那边每个上限 64K） */
export const BODY_LIMIT = 32 * 1024;
/** 输入框的值最多记多少字（同 aad） */
export const VALUE_LIMIT = 500;
export const MAX_UPLOAD_IMAGES = 80;
export const MAX_UPLOAD_REQUESTS = 5000;
export const BODY_BUDGET = 16 * 1024 * 1024;

// ---------- 哪些输入框不记值 ----------

const SECRET_NAME = /pass(word)?|pwd|passcode|token|secret|otp|api[\s_-]?key|cvv|cvc|card\s*number|cc-?num|卡号|验证码|密码|口令|安全码|身份证/i;

/**
 * 不记值的输入框：aad 的规则（password、file、hidden）之外，autocomplete 标成密码、一次性验证码或银行卡的，
 * 以及名字（name、id、label、placeholder）看起来是密码、令牌、验证码、卡号的。宁可多挡：挡住的只是值，动作照记。
 */
export function isSensitiveField(field: { type?: string | null; autocomplete?: string | null; name?: string | null; id?: string | null; label?: string | null; placeholder?: string | null }): boolean {
  const type = (field.type ?? "").toLowerCase();
  if (["password", "file", "hidden"].includes(type)) return true;
  const autocomplete = (field.autocomplete ?? "").toLowerCase();
  if (/(^|\s)(cc-|current-password|new-password|one-time-code)/.test(autocomplete)) return true;
  return [field.name, field.id, field.label, field.placeholder].some((value) => !!value && SECRET_NAME.test(value));
}

// ---------- 遮盖（和 aad 的 redact_network、omem 的 src/remote/redact.ts 同一套规则） ----------

export const REDACTED = "[REDACTED]";
export const OPAQUE = "[REDACTED OPAQUE BODY]";
const WHOLE = new Set(["code", "returnto", "returnurl", "redirecturi", "redirecturl", "callback"]);
const PARTS = ["authorization", "cookie", "setcookie", "password", "passwd", "pwd", "secret", "token", "ticket", "credential", "apikey", "otp", "verificationcode"];

export function sensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  return WHOLE.has(k) || PARTS.some((part) => k.includes(part));
}

/**
 * 去掉地址里的账号密码和看起来是密钥的查询参数。片段（#…）只留前端路由（#/orders），
 * 去掉它后面的参数：OAuth 隐式登录会把令牌放在片段里。
 */
export function redactUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "[REDACTED URL]";
  }
  url.username = "";
  url.password = "";
  const route = /^#!?\//.test(url.hash) ? url.hash.split("?")[0] : "";
  url.hash = route;
  if ([...url.searchParams.keys()].some(sensitiveKey)) {
    url.search = new URLSearchParams([...url.searchParams].map(([k, v]) => [k, sensitiveKey(k) ? REDACTED : v])).toString();
  }
  return url.toString();
}

export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (sensitiveKey(k) || /^(location|referer)$/i.test(k)) out[k] = REDACTED;
    else if (/^(url|href|documentURL)$/.test(k) && typeof v === "string") out[k] = redactUrl(v);
    else out[k] = redactJson(v);
  }
  return out;
}

/** 请求头：最多留 40 个，密钥类的换成占位。 */
export function redactHeaders(headers: Array<{ name: string; value?: string }> | undefined): Record<string, string> | undefined {
  if (!headers?.length) return undefined;
  const out: Record<string, string> = {};
  for (const { name, value } of headers.slice(0, 40)) out[name] = sensitiveKey(name) || /^(location|referer)$/i.test(name) ? REDACTED : String(value ?? "").slice(0, 400);
  return out;
}

/** 请求体和响应体：JSON 和表单留下不敏感的部分，别的整个不要（同 aad：不认识的内容不假装安全）。 */
export function redactBody(text: string | undefined | null): string | undefined {
  if (text == null || text === "") return undefined;
  if (text === OPAQUE) return text;
  const trimmed = text.trim();
  if (/^[[{"]/.test(trimmed) || /^(true|false|null|-?\d)/.test(trimmed)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed)));
    } catch {
      // 截断的 JSON 解析不了：按不认识的内容处理
    }
  }
  if (/^[\w.%[\]-]+=[^&\s]*(&[\w.%[\]-]+=[^&\s]*)*$/.test(trimmed)) {
    return [...new URLSearchParams(trimmed)].map(([k, v]) => `${encodeURIComponent(k)}=${sensitiveKey(k) ? REDACTED : encodeURIComponent(v)}`).join("&");
  }
  return OPAQUE;
}

/** 先遮盖再截断：截断后的 JSON 解析不了，会被整个当成不认识的内容。 */
export function clipBody(text: string | undefined | null): { body?: string; truncated: boolean } {
  const redacted = redactBody(text);
  if (!redacted) return { truncated: false };
  return redacted.length > BODY_LIMIT ? { body: redacted.slice(0, BODY_LIMIT), truncated: true } : { body: redacted, truncated: false };
}

// ---------- 请求的类型 ----------

const WEB_REQUEST_TYPES: Record<string, string> = {
  main_frame: "Document",
  sub_frame: "Document",
  stylesheet: "Stylesheet",
  script: "Script",
  image: "Image",
  font: "Font",
  media: "Media",
  xmlhttprequest: "XHR",
  ping: "Ping",
  csp_report: "Ping",
  websocket: "WebSocket",
  object: "Other",
  other: "Other"
};

/** chrome.webRequest 的类型换成 CDP 的说法（fetch 和 XHR 在 webRequest 里都是 xmlhttprequest）。 */
export const webRequestType = (type: string) => WEB_REQUEST_TYPES[type] ?? "Other";

const DEVTOOLS_TYPES: Record<string, string> = {
  xhr: "XHR",
  fetch: "Fetch",
  document: "Document",
  script: "Script",
  stylesheet: "Stylesheet",
  image: "Image",
  font: "Font",
  media: "Media",
  ping: "Ping",
  preflight: "Preflight",
  websocket: "WebSocket",
  eventsource: "EventSource",
  manifest: "Manifest",
  other: "Other"
};

/** DevTools HAR 的 _resourceType 换成 CDP 的说法。 */
export const devtoolsType = (type: string | undefined) => DEVTOOLS_TYPES[(type ?? "").toLowerCase()] ?? "Other";

/** 值得读响应体的请求：接口和文档，文字类内容。 */
export function wantsBody(type: string, mimeType: string): boolean {
  return ["XHR", "Fetch", "Document", "Other"].includes(type) && /json|text|xml|javascript|x-www-form-urlencoded/i.test(mimeType) && !/text\/(css|javascript)/i.test(mimeType);
}

// ---------- webRequest 和 DevTools 记录的合并 ----------

/**
 * 同一个请求可能各记一次：webRequest（总有）和 DevTools 面板（开着时，带响应体）。两边哪个先到不一定，
 * 后到的找先到的：方法和地址相同、开始时间差 3 秒内、来源不同、还没合并过。
 */
export function findPartner(recent: RecordedRequest[], incoming: RecordedRequest): RecordedRequest | undefined {
  let best: RecordedRequest | undefined;
  for (const candidate of recent) {
    if (candidate.source === incoming.source || candidate.method !== incoming.method || candidate.url !== incoming.url || candidate.tabId !== incoming.tabId) continue;
    if (incoming.source === "devtools" && candidate.responseBody !== undefined) continue;
    const gap = Math.abs(candidate.at - incoming.at);
    if (gap > 3000) continue;
    if (!best || gap < Math.abs(best.at - incoming.at)) best = candidate;
  }
  return best;
}

/** 合并：保留先到那条的 id；webRequest 的类型、请求头、计时为准，DevTools 补上请求体和响应体。 */
export function mergeRequests(first: RecordedRequest, second: RecordedRequest): RecordedRequest {
  const web = first.source === "webRequest" ? first : second;
  const dev = first.source === "devtools" ? first : second;
  return {
    ...dev,
    ...web,
    id: first.id,
    status: web.status ?? dev.status,
    durationMs: web.durationMs ?? dev.durationMs,
    mimeType: web.mimeType || dev.mimeType,
    requestHeaders: web.requestHeaders ?? dev.requestHeaders,
    requestBody: dev.requestBody ?? web.requestBody,
    requestBodyTruncated: dev.requestBody !== undefined ? dev.requestBodyTruncated : web.requestBodyTruncated,
    responseBody: dev.responseBody,
    responseBodyTruncated: dev.responseBodyTruncated,
    source: "devtools"
  };
}

// ---------- 步骤 ----------

/** 连续在同一个输入框里打字只算一步（同 aad）：后一次的值覆盖前一次。 */
export function mergesWith(previous: RecordedStep | undefined, next: Omit<RecordedStep, "id">): boolean {
  return (
    !!previous &&
    previous.kind === "action" &&
    previous.action.kind === "input" &&
    next.action.kind === "input" &&
    previous.tabId === next.tabId &&
    previous.action.selector === next.action.selector &&
    previous.action.label === next.action.label &&
    next.at - previous.at < 120_000
  );
}

/** 侧栏里一步的说法；和 omem 读录制时的写法一致。 */
export function stepTitle(step: Pick<RecordedStep, "kind" | "action">): string {
  const a = step.action;
  const name = a.label || a.text || a.tag || "";
  switch (a.kind) {
    case "click":
      return `点击「${name}」`;
    case "input":
      return a.protected ? `填写「${name}」（受保护，不记内容）` : `填写「${name}」：${a.value ?? ""}`;
    case "enter":
      return `在「${name}」按 Enter`;
    case "submit":
      return `提交表单${name ? `「${name}」` : ""}`;
    case "navigate":
      return `打开页面「${a.title || a.url || ""}」`;
    case "mark":
      return `标记${a.label ? `「${a.label}」` : ""}：${a.note ?? ""}`;
    default:
      return a.kind;
  }
}

// ---------- 上传 ----------

export interface ImportRequest {
  goal: string;
  startUrl: string;
  startTitle: string;
  startedAt: number;
  steps: Array<{ at: number; tab: number; kind: "action" | "mark"; action: StepAction; screenshot?: string }>;
  network: Array<Omit<RecordedRequest, "id" | "tabId"> & { tab: number }>;
  images: Array<{ key: string; data: string }>;
  organize: boolean;
  contextId?: string;
  itemId?: string;
}

const STATIC = new Set(["Image", "Stylesheet", "Script", "Font", "Media"]);

/**
 * 上传的内容：步骤按时间排，请求太多时先丢静态资源再丢最早的；截图最多 80 张，先保标记的，
 * 其余按时间均匀挑。images 只是“要哪些截图”（键），图片数据由调用方按键读出来再填。
 */
export function planUpload(session: RecordingSession, steps: RecordedStep[], requests: RecordedRequest[]): { body: Omit<ImportRequest, "images" | "organize">; imageKeys: string[] } {
  const ordered = [...steps].sort((a, b) => a.at - b.at);
  let kept = [...requests].sort((a, b) => a.at - b.at);
  if (kept.length > MAX_UPLOAD_REQUESTS) {
    const dynamic = kept.filter((r) => !STATIC.has(r.type));
    kept = dynamic.length >= MAX_UPLOAD_REQUESTS ? dynamic.slice(-MAX_UPLOAD_REQUESTS) : [...kept.filter((r) => STATIC.has(r.type)).slice(-(MAX_UPLOAD_REQUESTS - dynamic.length)), ...dynamic].sort((a, b) => a.at - b.at);
  }
  // 请求体和响应体合计最多 16M 字：超出后的请求只留地址、状态和请求头（omem 的请求体上限 50 MB）。
  let budget = BODY_BUDGET;
  kept = kept.map((r) => {
    const size = (r.requestBody?.length ?? 0) + (r.responseBody?.length ?? 0);
    if (size <= budget) {
      budget -= size;
      return r;
    }
    const { requestBody: _sent, responseBody: _got, ...rest } = r;
    return { ...rest, ...(r.requestBody ? { requestBodyTruncated: true } : {}), ...(r.responseBody ? { responseBodyTruncated: true } : {}) };
  });
  const shots = ordered.filter((s) => s.screenshot);
  const marks = shots.filter((s) => s.kind === "mark");
  const others = shots.filter((s) => s.kind !== "mark");
  const room = Math.max(0, MAX_UPLOAD_IMAGES - marks.length);
  const step = others.length > room ? others.length / room : 1;
  const picked = new Set([...marks.slice(0, MAX_UPLOAD_IMAGES), ...(room ? Array.from({ length: Math.min(room, others.length) }, (_, i) => others[Math.floor(i * step)]) : [])].map((s) => s.screenshot!));
  return {
    body: {
      goal: session.goal,
      startUrl: session.startUrl,
      startTitle: session.startTitle,
      startedAt: session.startedAt,
      steps: ordered.map((s) => ({ at: Math.round(s.at), tab: s.tabId, kind: s.kind, action: s.action, ...(s.screenshot && picked.has(s.screenshot) ? { screenshot: s.screenshot } : {}) })),
      network: kept.map(({ id: _id, tabId, ...rest }) => ({ ...rest, at: Math.round(rest.at), tab: tabId }))
    },
    imageKeys: [...picked]
  };
}
