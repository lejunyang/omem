/**
 * The egress proxy of members' sandboxes (`GET /api/security/egress`, src/agents/egress-run.ts): the
 * settings, whether this machine can run it, and which hosts recent runs reached. Pure.
 */
export type EgressMode = "strict-only" | "all-sandboxed" | "off";
export type EgressAction = "allow" | "approve" | "deny";
export type EgressSettings = { mode: EgressMode; default: EgressAction; tunnelWhenUnsure: EgressAction; inspect: string[]; waitSeconds: number };
export type HostUsage = { host: string; count: number; bytes: number; denied: number; backend: boolean; lastDeniedAt?: number; error?: string };
export type EgressStatus = EgressSettings & {
  support: { ok: boolean; reason?: string };
  peer?: string;
  inspectionAvailable: boolean | null;
  rootGenerated: boolean;
  /** `title`: the run's own title (null when there is no such run; absent from an older server). */
  runs: { runId: string | null; title?: string | null; hosts: HostUsage[] }[];
  denied: { runId: string | null; title?: string | null; host: string; count: number; at: number; reason?: string }[];
  pending: { askId: string; runId: string | null; title?: string | null; target: string; at: string }[];
};

/** Only the fields `PUT /api/security/egress` takes (it refuses anything else). */
export const egressSettings = (s: EgressSettings): EgressSettings => ({ mode: s.mode, default: s.default, tunnelWhenUnsure: s.tunnelWhenUnsure, inspect: [...s.inspect], waitSeconds: s.waitSeconds });

/** One run's line: how many hosts, how many requests, how many refused. */
export function runSummary(hosts: HostUsage[]) {
  const requests = hosts.reduce((n, h) => n + h.count, 0);
  const denied = hosts.reduce((n, h) => n + h.denied, 0);
  return { hosts: hosts.length, requests, denied, text: `${hosts.length} 个主机 · ${requests} 次${denied ? ` · 拒绝 ${denied}` : ""}` };
}

/** A domain for the decrypting list as the server accepts it (`api.example.com`, `*.example.com`), or why not. */
export function inspectDomain(raw: string, list: string[]): { value: string } | { error: string } {
  const value = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!value) return { error: "先写一个域名" };
  if (!/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) || value.length > 253) return { error: "写成 api.example.com 或 *.example.com" };
  if (list.includes(value)) return { error: "已经在名单里" };
  if (list.length >= 32) return { error: "最多 32 个" };
  return { value };
}
