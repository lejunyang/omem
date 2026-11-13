/**
 * The requests a browser recording made (aad's evidence/network.jsonl), sorted into the ones worth an
 * agent's attention and the rest. A page keeps making requests nobody acted for: scripts and images,
 * CORS preflights, telemetry batches, a login page polling. Those are set aside by their shape (the
 * browser's resource type, a telemetry-looking path or body, the same call repeated without a step),
 * never by site, and what remains is grouped by endpoint so 30 calls to one API read as one line.
 */

export type Req = {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  type: string;
  status: number | string;
  step: number | null;
  sent: unknown;
  got: unknown;
};

export type Endpoint = {
  key: string;
  method: string;
  host: string;
  path: string;
  requests: Req[];
  steps: number[];
  statuses: (number | string)[];
  /** Why it was set aside, or null when it is worth reading. */
  noise: string | null;
};

export function toReq(q: any): Req {
  const req = q.request ?? q;
  const res = q.response ?? q;
  const url = String(req.url ?? "");
  let host = "";
  let path = url;
  try {
    const u = new URL(url);
    host = u.host;
    path = u.pathname;
  } catch { /* not a URL: keep it whole */ }
  return {
    id: String(q.id ?? ""),
    method: String(req.method ?? "").toUpperCase(),
    url,
    host,
    path,
    type: String(q.type ?? ""),
    status: res.status ?? q.status ?? "?",
    step: typeof q.step_id === "number" ? q.step_id : q.step_id != null && /^\d+$/.test(String(q.step_id)) ? Number(q.step_id) : null,
    sent: req.body ?? req.postData ?? req.post_data ?? null,
    got: q.body ?? res.body ?? null,
  };
}

// The browser's own word for what a request was for (CDP Network.ResourceType).
const STATIC = new Set(["Image", "Stylesheet", "Script", "Font", "Media", "Manifest", "TextTrack", "SignedExchange"]);
// Path segments telemetry endpoints are named with; whole segments only, so /login or /catalog do not match.
const TELEMETRY_SEGMENT = /^(collect|collector|track|tracking|tracker|beacon|beacons|log|logs|logger|report|reports|monitor|monitor_browser|monitor_web|metric|metrics|telemetry|analytics|stat|stats|statistics|event|events|batch|ping|heartbeat|rum|apm|sentry|perf|webvitals|v\d+_log)$/i;
const TELEMETRY_HOST = /^(mon|monitor|log|logs|logger|stat|stats|analytics|track|tracking|telemetry|metrics|rum|apm|sentry|collect|collector)[.-]/i;
const STATIC_PATH = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm|mp3)$/i;

const bodyText = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** A request body that is a batch of analytics events: `{events: [...]}`, or a list of such. */
function eventBatch(sent: unknown): boolean {
  const text = bodyText(sent).slice(0, 4000);
  return /^\s*\[?\s*\{\s*"(events?|event_name|ev_type|logs?|metrics)"\s*:/.test(text) || /"(user_unique_id|session_id|ev_type|event_name)"\s*:/.test(text) && /"events?"\s*:/.test(text);
}

/** Numbers, ids and hashes in a path are values, not endpoints. */
const shape = (path: string) =>
  path
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) ? ":id" : seg))
    .join("/");

function noiseOf(e: Omit<Endpoint, "noise">): string | null {
  const first = e.requests[0];
  if (e.method === "OPTIONS" || first.type === "Preflight") return "预检";
  if (first.type === "Ping" || e.requests.some((r) => eventBatch(r.sent))) return "埋点";
  if (STATIC.has(first.type) || (!first.type && STATIC_PATH.test(e.path))) return "静态资源";
  const segments = e.path.split("/").filter(Boolean);
  if (segments.some((s) => TELEMETRY_SEGMENT.test(s)) && (TELEMETRY_HOST.test(e.host) || e.method === "POST" && e.requests.length >= 3)) return "埋点";
  if (TELEMETRY_HOST.test(e.host) && e.method === "POST") return "埋点";
  // The same read again and again with nothing new: a page polling (a login QR code, a status badge).
  if (e.method === "GET" && e.requests.length >= 5 && new Set(e.requests.map((r) => bodyText(r.got).slice(0, 500))).size <= 2) return "轮询";
  return null;
}

/** The recording's requests grouped by endpoint, in the order each was first called. */
export function endpoints(records: any[]): Endpoint[] {
  const by = new Map<string, Omit<Endpoint, "noise">>();
  for (const q of records) {
    const r = toReq(q);
    const key = `${r.method} ${r.host}${shape(r.path)}`;
    let e = by.get(key);
    if (!e) by.set(key, (e = { key, method: r.method, host: r.host, path: shape(r.path), requests: [], steps: [], statuses: [] }));
    e.requests.push(r);
    if (r.step != null && !e.steps.includes(r.step)) e.steps.push(r.step);
    if (!e.statuses.includes(r.status)) e.statuses.push(r.status);
  }
  return [...by.values()].map((e) => ({ ...e, noise: noiseOf(e) }));
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const isWrite = (e: Endpoint) => WRITE.has(e.method);

/** The request of an endpoint best shown as its example: one that sent a body, else one that got one. */
export const example = (e: Endpoint) => e.requests.find((r) => bodyText(r.sent)) ?? e.requests.find((r) => bodyText(r.got) && String(r.status).startsWith("2")) ?? e.requests[0];

/** Counts of what was set aside, as one phrase: "埋点 62 个、轮询 14 个". */
export function noiseNote(list: Endpoint[]): string {
  const n = new Map<string, number>();
  for (const e of list) if (e.noise) n.set(e.noise, (n.get(e.noise) ?? 0) + e.requests.length);
  return [...n].map(([k, v]) => `${k} ${v} 个`).join("、");
}
