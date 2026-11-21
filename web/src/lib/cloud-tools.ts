/**
 * Cloud backends calling a few read-only tools over HTTP (`GET /api/cloud-tools`, src/agents/cloud-tools.ts,
 * cloud-probe.ts; the setting is `agents.cloudTools`). Off by default; a backend is used only when it is
 * named, its probe at the current address succeeded and the owner confirmed it. Pure.
 */
export type CloudToolsConfig = { enabled: boolean; tools: string[]; ttlMinutes: number; maxCalls: number; backends: string[]; credentialIn: "channel" | "message" };
export type CloudProbe = { id: string; url: string; at: string; mode: false | "header" | "url"; reason: string; confirmed: boolean };
export type CloudStatus = CloudToolsConfig & {
  url: string | null; addressError: string | null; activeCredentials: number;
  /** `title`: the run's own title (null when the run is gone; absent from an older server). */
  recent: { runId: string; title?: string | null; calls: number; errors: number; lastError: string | null; at: string }[];
  profiles: { backend: string; probe: CloudProbe | null; reason?: string }[];
  /** The read-only tools a cloud backend may be given (`cloudToolNames`), with the first sentence of each one's description. */
  availableTools?: { name: string; description: string }[];
};

/**
 * The tools to pick from, named by what they do (the description up to its first pause), the tool's
 * name as the hint. An older server does not list them: then only the ones already chosen, by name.
 */
export function toolOptions(s: Pick<CloudStatus, "availableTools" | "tools">): { value: string; label: string; hint?: string }[] {
  if (!s.availableTools) return s.tools.map((t) => ({ value: t, label: t }));
  return s.availableTools.map((t) => ({ value: t.name, label: t.description.split(/[：:，,。；;（(]/)[0].trim() || t.name, hint: t.name }));
}

export const cloudConfig = (s: CloudToolsConfig): CloudToolsConfig => ({ enabled: s.enabled, tools: [...s.tools], ttlMinutes: s.ttlMinutes, maxCalls: s.maxCalls, backends: [...s.backends], credentialIn: s.credentialIn });

/** What a backend's probe says, in a few words, and whether it waits for the owner's confirmation. */
export function probeState(p: CloudProbe | null, url: string | null): { text: string; tone: "ok" | "warn" | "muted"; confirm: boolean } {
  if (!p) return { text: "还没探测", tone: "muted", confirm: false };
  if (!p.mode) return { text: "探测没通过", tone: "warn", confirm: false };
  if (url && p.url !== url) return { text: "地址换过，要重新探测", tone: "warn", confirm: false };
  const how = p.mode === "header" ? "带鉴权头" : "无头 GET";
  return p.confirmed ? { text: `已确认 · ${how}`, tone: "ok", confirm: false } : { text: `探测通过 · ${how} · 等你确认`, tone: "warn", confirm: true };
}
