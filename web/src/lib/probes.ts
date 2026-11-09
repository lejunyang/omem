import { reactive } from "vue";
import { post } from "../api";

/** The models and effort levels a backend offers (src/agents/probe.ts). */
export type Probe = { agent?: string; models: string[]; efforts: string[]; effortsByModel?: Record<string, string[]>; modes?: string[]; error?: string; at?: string };

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

/** The modes that mean 完全访问 (src/agents/acp.ts MODE_ALIASES["full-access"]). */
const FULL_MODES = ["agent-full-access", "full-access", "bypassPermissions", "bypass_permissions", "danger-full-access", "yolo"];

/**
 * Whether a backend can run 完全访问, by its last detection: the ACP mode it offers, or the
 * codex / claude command line (their own flags). Unknown until it has been detected again.
 */
export function fullAccessHint(backend: { id: string; name?: string; transport?: string } | undefined) {
  const consequence = "omem 自己的工具照旧逐次检查；shell 写文件、联网不再受沙箱限制。";
  if (!backend) return consequence;
  if (backend.transport === "codex-cli" || backend.transport === "claude-cli") return `${backend.name ?? backend.id} 支持（命令行参数）。${consequence}`;
  if (backend.transport && backend.transport !== "acp") return `${backend.name ?? backend.id} 没有完全访问，开了也仍按它自己的方式运行。`;
  const modes = probes.data[backend.id]?.modes;
  if (!modes) return `${backend.name ?? backend.id} 还不知道是否支持：在设置 → Agent 里重新检测一次。${consequence}`;
  const mode = modes.find((m) => FULL_MODES.includes(m));
  return mode ? `${backend.name ?? backend.id} 支持（${mode}）。${consequence}` : `${backend.name ?? backend.id} 没有完全访问模式，开了也仍按沙箱和审批运行。`;
}
