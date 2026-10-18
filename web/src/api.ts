export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

import { promptDialog } from "./lib/dialog";

// Opening the page from another machine needs an API token (`omem user token owner`
// or a pairing token): `http://host:4317/?token=…` saves it, or the page asks on 401.
try {
  const u = new URL(location.href);
  const t = u.searchParams.get("token");
  if (t) {
    localStorage.setItem("omem-token", t);
    u.searchParams.delete("token");
    history.replaceState(null, "", u.toString());
  }
} catch {}

function token() {
  try {
    return localStorage.getItem("omem-token") ?? "";
  } catch {
    return "";
  }
}

/** A URL the browser loads itself (images, downloads): carries the token as a query. */
export function authUrl(path: string) {
  const t = token();
  return t ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}` : path;
}

let asking: Promise<string | null> | null = null;
async function askToken() {
  asking ??= promptDialog("需要访问令牌", { message: "从其他设备打开 omem 需要令牌：在运行 omem 的机器上执行 omem user token owner。", placeholder: "令牌", okText: "保存" }).finally(() => (asking = null));
  const t = (await asking)?.trim();
  if (!t) return false;
  try {
    localStorage.setItem("omem-token", t);
  } catch {}
  return true;
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body });
  if (res.status === 401 && !(init as { retried?: boolean }).retried && (await askToken())) return api<T>(path, { ...init, retried: true } as typeof init);
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new ApiError(res.status, (data && (data as { error?: string }).error) || res.statusText);
  return data as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, json?: unknown) => api<T>(path, { method: "POST", json: json ?? {} });
export const put = <T = any>(path: string, json?: unknown) => api<T>(path, { method: "PUT", json });
export const patch = <T = any>(path: string, json?: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });

export type ServerEvent =
  | { type: "run"; runId: string; status: string }
  | { type: "run-event"; runId: string; seq: number; event: { type: string; data: any; at: string } }
  | { type: "notification"; id: string; title: string; body: string; link?: string | null }
  | { type: "changed"; entity: string; id: string; spaceId?: string };

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
export function onServerEvent(fn: Listener) {
  listeners.add(fn);
  if (!source) {
    const t = token();
    source = new EventSource(`/api/events${t ? `?token=${encodeURIComponent(t)}` : ""}`);
    source.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as ServerEvent;
        for (const l of listeners) l(e);
      } catch {}
    };
  }
  return () => listeners.delete(fn);
}

// ---- shared types (mirrors server) ----
export type SpaceRelation = { space: string; name: string; kind: string; note: string; origin: "owner" | "agent"; evidence: string; updatedAt: string };
export type Space = { id: string; name: string; kind: string; description: string; rootPath: string | null; settings: Record<string, any>; sources?: number; pages?: number; related?: SpaceRelation[] };
export type Hit = { type: "chunk" | "page" | "memory" | "symbol"; id: string; spaceId: string; title: string; path: string; sourceId?: string; uri?: string; sourceKind?: string; lineStart?: number; lineEnd?: number; snippet: string; score: number; via: string[]; status?: string };
export type Memory = {
  id: string;
  spaceId: string;
  kind: string;
  subject: string;
  content: string;
  status: string;
  validFrom: string | null;
  validTo: string | null;
  supersededBy: string | null;
  supersedes: string | null;
  sourceRefs: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  agentProfile?: string | null;
  model?: string | null;
  effort?: string | null;
  runId?: string | null;
  agent?: string | null;
  tags?: string[];
  reviewedAt?: string | null;
  reviewVerdict?: string | null;
  reviewNote?: string | null;
};
export type ModelQuality = { model: string; stored: number; shadow: number; rejected: number; rejectedBy: Record<string, number>; reviewed: number; kept: number; rewritten: number; retracted: number; avgChars: number };
export type MemoryQuality = {
  stats: ModelQuality[];
  rejections: { id: string; space_id: string; tool: string; kind: string; content: string; codes: string[]; run_id: string | null; agent_profile: string | null; model: string | null; effort: string | null; shadow: boolean; at: string }[];
  pending: number;
  review: { enabled: boolean; profile?: string; model?: string; effort?: string; batch: number };
  compare: { profile: string; model?: string; effort?: string }[];
  runs: {
    run: { id: string; title: string; space_id: string; created_at: string; profile_id: string | null };
    live: { id: string; kind: string; content: string; status: string; review_verdict: string | null; model: string | null; agent_profile: string | null }[];
    rejected: { content: string; codes: string[] }[];
    shadows: { id: string; title: string; status: string; profile_id: string | null; writes: { id: string; tool: string; args: any; verdict: string | null; verdict_note: string | null; model: string | null }[]; rejected: { content: string; codes: string[] }[] }[];
  }[];
};
export type Item = { id: string; spaceId: string; kind: string; title: string; detail: string; status: string; priority: number; dueAt: string | null; remindAt: string | null; waitingOn: string | null; watch: any; sourceRefs: string[]; createdAt: string; updatedAt: string; closedAt: string | null };
export type ItemEvent = { id: number; itemId: string; at: string; kind: string; text: string; sourceRefs: string[]; actor: string };
export type Run = { id: string; kind: string; spaceId: string | null; status: string; title: string; input: any; output: any; profileId: string | null; parentId: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; quiet?: boolean };
export type RunEvent = { seq: number; at: string; type: string; data: any };
export type Source = { id: string; spaceId: string; kind: string; uri: string; title: string; mime: string | null; meta: any; capturedAt: string; updatedAt: string; deletedAt: string | null; lines?: number };
export type Card = { id: string; spaceId: string; front: string; back: string; sourceRefs: string[]; dueAt: string; reps: number; lapses: number; state: number; suspended: boolean };
