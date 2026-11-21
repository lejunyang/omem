import { computed, inject, provide, ref, type InjectionKey, type Ref } from "vue";
import { ownerCalled } from "../../lib/owner-name";
import { get, put } from "../../api";
import { state, toast } from "../../store";
import { setSettingsSections, settingsSections } from "../../lib/caps";
import { saveRefusal, type SettingsSections } from "../../lib/settings-access";
import { network } from "../../lib/network-status";
import { detectProbe, probes as shared } from "../../lib/probes";

/**
 * What the settings tabs share (views/Settings.vue provides it, each tab in views/settings/ injects it):
 * the configuration as the server returned it, the installed backends, and one way to save a part of
 * the configuration (`PUT /api/settings`, which says when a change needs a restart).
 */
export type Profile = { id: string; name?: string; transport: string; command: string; args: string[]; model?: string; effort?: string; installed: boolean; install?: string; networkReason?: string | null; peer?: unknown; source?: string; pluginBackend?: { plugin: string; name: string; available: boolean; reason?: string } };
export type ModelSource = { via: "local" | "osdk" | "hub"; path?: string; syncing?: boolean; error?: string; osdk: boolean; known: boolean; cached?: boolean; size?: string };
export type RerankStatus = { enabled: boolean; model: string; state: "idle" | "loading" | "ready" | "failed"; error: string; calls: number; timeouts: number; lastMs: number; source?: ModelSource };

export type SettingsCtx = {
  config: Ref<any>;
  profiles: Ref<Profile[]>;
  home: Ref<string>;
  rerank: Ref<RerankStatus | null>;
  embeddingSource: Ref<ModelSource | null>;
  load: () => Promise<void>;
  /** Who may see and change what here (`GET /api/settings/sections`), handed on to lib/caps.ts. */
  loadSections: () => Promise<void>;
  /** The owner's display name, for “只有 ×× 能改” (`ownerName` in `/api/me`, lib/owner-name.ts). */
  ownerName: Readonly<Ref<string>>;
  saveConfig: (partial: Record<string, unknown>, note?: string) => Promise<void>;
};

const KEY: InjectionKey<SettingsCtx> = Symbol("settings");

export function provideSettings(): SettingsCtx {
  const config = ref<any>(null);
  const profiles = ref<Profile[]>([]);
  const home = ref("");
  const rerank = ref<RerankStatus | null>(null);
  const embeddingSource = ref<ModelSource | null>(null);
  const ownerName = computed(() => ownerCalled(state.me));
  async function loadSections() {
    // An older server has no areas: the page falls back to the old permissions (lib/caps.ts).
    setSettingsSections(await get<SettingsSections>("/api/settings/sections").catch(() => null));
  }
  async function load() {
    // Someone else gets only the areas they may see: the parts left out stay missing.
    const s = await get<{ config: any; agents?: Profile[]; home?: string; rerank?: RerankStatus; embeddingSource?: ModelSource | null }>("/api/settings");
    embeddingSource.value = s.embeddingSource ?? null;
    config.value = s.config;
    rerank.value = s.rerank ?? null;
    profiles.value = s.agents ?? [];
    home.value = s.home ?? "";
    network.policies = s.config.agents?.networkPolicies ?? [];
  }
  async function saveConfig(partial: Record<string, unknown>, note = "已保存") {
    try {
      const r = await put<{ config: any; restart?: string[] }>("/api/settings", partial);
      config.value = r.config;
      if (r.restart?.length) toast(`${note}。${r.restart.join("、")}要重启服务后才生效（omem service restart）`, "info");
      else toast(note, "ok");
    } catch (e) {
      toast(saveRefusal((e as Error).message, settingsSections(), ownerName.value), "error");
    }
  }
  const ctx = { config, profiles, home, rerank, embeddingSource, load, loadSections, ownerName, saveConfig };
  provide(KEY, ctx);
  return ctx;
}

/** The same, or null outside the settings page (a card shown on the account page too). */
export const settingsContext = (): SettingsCtx | null => inject(KEY, null);

export function useSettings(): SettingsCtx {
  const ctx = inject(KEY);
  if (!ctx) throw new Error("settings context missing");
  return ctx;
}

type ProbeData = { agent: string; models: string[]; efforts: string[]; effortsByModel?: Record<string, string[]>; error?: string; at?: string };

/** The installed backends and what each offers (models, effort levels): the pickers of several tabs use them. */
export function useBackends(profiles: Ref<Profile[]>) {
  const installedProfiles = computed(() => profiles.value.filter((p) => p.installed));
  const profileOptions = computed(() => installedProfiles.value.map((p) => ({ value: p.id, label: p.name ?? p.id, hint: p.networkReason ?? p.id })));
  // Shared with the profile forms (lib/probes.ts): a backend is asked once per tab unless refreshed.
  const probes = computed(() => {
    const out: Record<string, { loading?: boolean; error?: string; data?: ProbeData }> = {};
    for (const id of new Set([...Object.keys(shared.data), ...Object.keys(shared.pending)])) {
      const d = shared.data[id] as ProbeData | undefined;
      out[id] = { loading: !!shared.pending[id], ...(d?.error ? { error: d.error } : d ? { data: d } : {}) };
    }
    return out;
  });
  /** Effort levels for a model on a backend: per model when the probe knows them, else all levels. */
  function effortsOf(profileId: string | undefined, model?: string | null): string[] {
    const d = probes.value[profileId ?? ""]?.data;
    if (!d) return [];
    if (d.effortsByModel && model && model in d.effortsByModel) return d.effortsByModel[model];
    return d.efforts;
  }
  function modelOptionsFor(profileId: string | undefined, key: "model" | "effort", current?: string, model?: string) {
    const offered = (key === "model" ? probes.value[profileId ?? ""]?.data?.models : effortsOf(profileId, model ?? profiles.value.find((x) => x.id === profileId)?.model)) ?? [];
    const list = current && !offered.includes(current) ? [current, ...offered] : offered;
    return [{ value: "", label: "跟随默认" }, ...list.map((v) => ({ value: v, label: v }))];
  }
  /** Backends that can report their models and effort levels. */
  const probeable = (p: Profile) => p.transport === "acp" || p.transport === "doubao-cli";
  /** Read cached probes (or probe once) for every installed ACP agent so the dropdowns can fill. */
  async function loadProbes() {
    await Promise.all(installedProfiles.value.filter((p) => probeable(p) && !probes.value[p.id]).map((p) => detectProbe(p.id, false)));
  }
  return { installedProfiles, profileOptions, probes, effortsOf, modelOptionsFor, loadProbes };
}

/** A whole number typed into an input, held between `min` and `max`; `fallback` when it is not a number. */
export function intIn(e: Event, min: number, max: number, fallback: number) {
  const n = Number((e.target as HTMLInputElement).value);
  return Number.isFinite(n) && (e.target as HTMLInputElement).value.trim() !== "" ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
