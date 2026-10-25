import { reactive } from "vue";
import { post } from "../api";

/** The models and effort levels a backend offers (src/agents/probe.ts). */
export type Probe = { agent?: string; models: string[]; efforts: string[]; effortsByModel?: Record<string, string[]>; error?: string; at?: string };

/**
 * Probe results per backend, shared by every page for the life of the tab. They change rarely and
 * the server caches them too; "重新检测" is the way to ask the backend again.
 */
export const probes = reactive<{ data: Record<string, Probe>; pending: Record<string, boolean> }>({ data: {}, pending: {} });

/** Take a result the server already sent along (profile options carry the cached probe). */
export function seedProbe(id: string, probe: Probe | null | undefined) {
  if (probe && !probes.data[id]) probes.data[id] = probe;
}

export async function detectProbe(id: string, refresh = false): Promise<Probe | undefined> {
  if (probes.pending[id] || (!refresh && probes.data[id])) return probes.data[id];
  probes.pending[id] = true;
  try {
    probes.data[id] = await post<Probe>(`/api/agents/${encodeURIComponent(id)}/probe`, { refresh });
  } catch (e) {
    probes.data[id] = { models: [], efforts: [], error: (e as Error).message };
  } finally {
    delete probes.pending[id];
  }
  return probes.data[id];
}
