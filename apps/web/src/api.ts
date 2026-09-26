import type {
  Revision,
  Fragment,
  Change,
  RunEvent,
} from "../../../packages/contracts/src/index";
export type { Revision, Fragment, Change };
export type Source = {
  id: string;
  title: string;
  source: string;
  version: number;
  sourceId: string;
  externalId: string;
  createdAt: string;
};
export type Edge = {
  id: string;
  kind: string;
  targetId: string;
  text: string;
  title: string;
  version: number;
};
export type Evidence = {
  fragment: Fragment;
  revision: Revision;
  outgoing: Edge[];
  backlinks: Edge[];
};
export type Notification = {
  id: string;
  title: string;
  body: string;
  changeId: string | null;
  createdAt: string;
  readAt: string | null;
};
export type Task = {
  id: string;
  title: string;
  detail: string;
  dueAt: string | null;
  evidenceId: string | null;
  status: "open" | "done";
  version: number;
};
export type Profile = {
  id: string;
  name: string;
  transport: string;
  model?: string;
  effort?: string;
  maxContextChars: number;
};
export type Run = {
  id: string;
  state: "running" | "done" | "error" | "cancelled";
  events: RunEvent[];
  answerId?: string;
};
export function headers(): Record<string, string> {
  const token = sessionStorage.getItem("omem-token");
  return token ? { Authorization: "Bearer " + token } : {};
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const r = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || "请求失败");
  return value;
}
