import { withNetworkPolicy } from "./network-policy.ts";
import type { AgentProfile } from "../core/config.ts";
import { commandExists } from "./spawn.ts";
import { runAcp } from "./acp.ts";
import { probeDoubaoCli } from "./doubao-cli.ts";
import type { App } from "../core/app.ts";
import { allProfiles } from "../core/config.ts";
import { OWNER } from "../core/users.ts";
import { sessionCleanup } from "./session-cleanup.ts";
import { accountFor } from "./accounts.ts";
import { accountOf } from "./sandbox.ts";

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
  /** The agent's permission modes (ACP); whether it has a full-access one decides 完全访问. */
  modes?: string[];
  /** The agent's own words about each model (description, _meta), when it gives any. */
  modelNotes?: Record<string, string>;
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

/** `probe:<profile>`, and `probe:<profile>@acct:<user>` for one user's own account (plans differ: so may the models). */
const probeKey = (profileId: string, userId?: string) => `probe:${profileId}${userId ? `@acct:${userId}` : ""}`;

export function cachedProbe(app: { db: { prepare: (sql: string) => { get(...p: unknown[]): unknown } } }, profileId: string, userId?: string): ProbeInfo | null {
  const row = app.db.prepare("select value from kv where key = ?").get(probeKey(profileId, userId)) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as ProbeInfo;
  } catch {
    return null;
  }
}

export function saveProbe(app: { db: { prepare: (sql: string) => { run(...p: unknown[]): unknown } } }, profileId: string, probe: ProbeInfo, userId?: string) {
  app.db.prepare("insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value").run(probeKey(profileId, userId), JSON.stringify(probe));
}

/** What a run on this profile can choose from: its user's own account's probe when it runs with one (falling back to the machine's). */
export function probeFor(app: App, p: AgentProfile): ProbeInfo | null {
  const a = accountOf(p);
  return (a ? cachedProbe(app, p.id, a.userId) : null) ?? cachedProbe(app, p.id);
}

/** The models a user sees for a backend: their own account's when they are logged in to it, else the machine's. */
export function userProbe(app: App, userId: string | undefined, profileId: string): ProbeInfo | null {
  if (userId && userId !== OWNER) {
    const p = allProfiles(app.config).find((x) => x.id === profileId);
    if (p && accountOf(accountFor(app, userId, p))) return cachedProbe(app, profileId, userId) ?? cachedProbe(app, profileId);
  }
  return cachedProbe(app, profileId);
}

/** Probe each installed profile of this backend with one user's own account, and keep what it found under that account. */
export async function probeAccount(app: App, userId: string, backend: string) {
  const { accountProfiles } = await import("./accounts.ts");
  for (const p of accountProfiles(app, userId, backend)) {
    const probe = await probeProfile(p, app);
    if (!probe.error) saveProbe(app, p.id, probe, userId);
  }
}

/** Probe a profile now (spawns the CLI briefly). */
export async function probeProfile(profile: AgentProfile, app?: App): Promise<ProbeInfo> {
  try {
    return app ? await withNetworkPolicy(app, profile, {}, (p, signal) => probeOn(p, app, signal)) : await probeOn(profile);
  } catch (e) { return { at: new Date().toISOString(), agent: profile.command, models: [], efforts: [], error: (e as Error).message.slice(0, 300) }; }
}

async function probeOn(profile: AgentProfile, app?: App, signal?: AbortSignal): Promise<ProbeInfo> {
  if (profile.transport === "doubao")
    return { at: new Date().toISOString(), agent: "豆包 OpenAPI", models: [], efforts: [], error: "豆包后端没有可选模型和思考强度；授权状态用 omem doubao status 查看" };
  if (profile.transport === "doubao-cli" && commandExists(profile.command))
    try {
      const { models, effortsByModel } = await probeDoubaoCli(profile);
      return { at: new Date().toISOString(), agent: "豆包 CLI", models, efforts: [...new Set(Object.values(effortsByModel).flat())], effortsByModel };
    } catch (e) {
      return { at: new Date().toISOString(), agent: "豆包 CLI", models: [], efforts: [], error: (e as Error).message.slice(0, 300) };
    }
  if (profile.transport !== "acp" || !commandExists(profile.command))
    return { at: new Date().toISOString(), agent: profile.command, models: [], efforts: [], error: "命令行后端报不出可选的模型，可以手填" };
  try {
    // A user's own account: in their account folder (the sandbox mounts the folder it starts in writable).
    const cwd = accountOf(profile)?.home ?? process.cwd();
    const cleanup = app ? await sessionCleanup(app, profile, { cwd }, e => { if (e.type === "status") console.log(`[omem] ${e.text}`); }) : undefined;
    const r = await runAcp({ ...profile, model: undefined, effort: undefined }, { app, cwd, cleanup, prompt: "", probe: true, signal }, () => {});
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
      ...(by ? { effortsByModel: by } : {}),
      modes: r.probe?.modes ?? [],
      ...(r.probe?.modelNotes ? { modelNotes: r.probe.modelNotes } : {}),
    };
  } catch (e) {
    return { at: new Date().toISOString(), agent: profile.command, models: [], efforts: [], error: (e as Error).message.slice(0, 300) };
  }
}
