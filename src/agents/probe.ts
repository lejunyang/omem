import type { AgentProfile } from "../core/config.ts";
import { commandExists } from "./spawn.ts";
import { runAcp } from "./acp.ts";

/**
 * The models and effort levels an ACP backend actually offers. Probes open
 * and close one short session and are cached in kv (backends change rarely;
 * probe again with /model refresh or setup "检测模型").
 */
export type ProbeInfo = {
  at: string;
  agent: string;
  models: string[];
  /** Every effort level any model offers (the union of effortsByModel when the agent reports per model). */
  efforts: string[];
  /** Levels per model; a model with [] has no effort setting. Absent when the agent does not tell. */
  effortsByModel?: Record<string, string[]>;
  error?: string;
};

/** Effort levels for one model: its own when the probe knows them, else every known level. */
export function effortsFor(probe: ProbeInfo | null | undefined, model?: string | null): string[] {
  if (!probe) return [];
  const by = probe.effortsByModel;
  if (by && model) {
    const key = Object.keys(by).find((k) => k === model) ?? Object.keys(by).find((k) => k.toLowerCase() === model.toLowerCase());
    if (key) return by[key];
  }
  return probe.efforts;
}

export function cachedProbe(app: { db: { prepare: (sql: string) => { get(...p: unknown[]): unknown } } }, profileId: string): ProbeInfo | null {
  const row = app.db.prepare("select value from kv where key = ?").get(`probe:${profileId}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as ProbeInfo;
  } catch {
    return null;
  }
}

export function saveProbe(app: { db: { prepare: (sql: string) => { run(...p: unknown[]): unknown } } }, profileId: string, probe: ProbeInfo) {
  app.db.prepare("insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value").run(`probe:${profileId}`, JSON.stringify(probe));
}

/** Probe a profile now (spawns the CLI briefly). */
export async function probeProfile(profile: AgentProfile): Promise<ProbeInfo> {
  if (profile.transport === "doubao")
    return { at: new Date().toISOString(), agent: "豆包 OpenAPI", models: [], efforts: [], error: "豆包后端没有可选模型和思考强度；授权状态用 omem doubao status 查看" };
  if (profile.transport !== "acp" || !commandExists(profile.command))
    return { at: new Date().toISOString(), agent: profile.command, models: [], efforts: [], error: "命令行 Agent 不支持探测" };
  try {
    const r = await runAcp({ ...profile, model: undefined, effort: undefined }, { cwd: process.cwd(), prompt: "", probe: true }, () => {});
    const opts = r.probe?.options ?? [];
    const modelOpt = opts.find((o) => o.id === "model" || o.category === "model");
    const effortOpt = opts.find((o) => o.id !== "model" && (o.category === "thought_level" || /effort|reasoning/i.test(o.id)));
    const by = r.probe?.effortsByModel;
    const union = by ? [...new Set(Object.values(by).flat())] : [];
    const efforts = union.length ? union : (effortOpt?.values ?? []).filter((v): v is string => typeof v === "string");
    return {
      at: new Date().toISOString(),
      agent: r.probe?.agent ?? profile.command,
      models: (modelOpt?.values ?? []).filter((v): v is string => typeof v === "string"),
      efforts,
      ...(by && union.length ? { effortsByModel: by } : {}),
    };
  } catch (e) {
    return { at: new Date().toISOString(), agent: profile.command, models: [], efforts: [], error: (e as Error).message.slice(0, 300) };
  }
}
