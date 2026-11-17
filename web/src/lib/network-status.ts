import { reactive } from "vue";
import { get, post, put } from "../api";

/** A network condition (config agents.networkPolicies, src/agents/network-policy.ts). */
export type NetworkPolicy = {
  id: string; name: string; backends: string[];
  connection: { type: "system" } | { type: "proxy"; url: string };
  watch: { interface?: string };
  probe: { url: string; format: "cloudflare-trace" | "json"; ipField: string; countryField: string; timeoutMs: number; maxAgeSeconds: number };
  require: { countries: string[]; ips: string[] };
  ipv6: { enabled: boolean; doh: string[] };
  dns: { enabled: boolean; expectedServers: string[]; mihomoConfig?: string };
  onFailure: "stop-and-fallback" | "restrict-new";
};
export type NetworkStatus = {
  id: string; status: string; reason: string | null; localReason: string | null; checkedAt?: string; ip?: string; country?: string; runs: string[];
  ipv6?: { status: string; reason?: string; source?: string; checkedAt: string; observations: { address: string; ip: string; country: string }[] };
  dns?: { status: string; checkedAt: string; servers: string[]; source: string; warnings: string[] };
};

/**
 * The conditions and their live state, shared by every backend block on the settings page: one poll
 * for all of them (every 2.5 s while any block is open and there are conditions).
 */
export const network = reactive<{ policies: NetworkPolicy[]; states: NetworkStatus[]; interfaces: { name: string; addresses: string[] }[]; loading: boolean; error: string }>({
  policies: [], states: [], interfaces: [], loading: true, error: "",
});
let users = 0, timer: ReturnType<typeof setInterval> | undefined, fetching = false;

export async function loadNetwork() {
  if (fetching) return;
  fetching = true;
  try {
    const r = await get<{ states: NetworkStatus[]; interfaces: { name: string; addresses: string[] }[] }>("/api/agents/network-policies");
    network.states = r.states; network.interfaces = r.interfaces; network.error = "";
  } catch (e) { network.error = (e as Error).message; }
  finally { network.loading = false; fetching = false; }
}
export function watchNetwork() {
  if (users++ === 0) {
    void loadNetwork();
    timer = setInterval(() => { if (network.policies.length) void loadNetwork(); }, 2500);
  }
  return () => { if (--users === 0) clearInterval(timer); };
}
export async function saveNetwork(policies: NetworkPolicy[]) {
  const r = await put<{ policies: NetworkPolicy[]; states: NetworkStatus[] }>("/api/agents/network-policies", { policies });
  network.policies = r.policies; network.states = r.states;
  return r.policies;
}
export async function checkNetwork(id: string) {
  network.states = (await post<{ states: NetworkStatus[] }>(`/api/agents/network-policies/${encodeURIComponent(id)}/check`, {})).states;
}
export const statusOf = (id: string) => network.states.find((s) => s.id === id);
/** Why a backend cannot run now because of its network condition, or null. */
export function networkBlock(profileId: string) {
  const p = network.policies.find((n) => n.backends.includes(profileId));
  if (!p) return null;
  const s = statusOf(p.id);
  // Not checked yet is normal: the exit is checked when the backend is about to be used.
  if (!s || (s.status !== "unavailable" && s.status !== "recovering")) return null;
  return `${p.name}：${s.reason || "出口不符合要求"}`;
}
