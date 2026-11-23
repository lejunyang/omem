import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { allProfiles, configSchema, saveConfig, type AgentProfile } from "../core/config.ts";
import { HttpError } from "../core/util.ts";
import { audit } from "../auth/permissions.ts";
import { accountEntry, ensurePrivateDir, type AccountEntry } from "./accounts.ts";
import { sourceOf } from "./capacity.ts";
import { baseSource } from "./catalog.ts";

/**
 * More than one login of the same backend for the owner (docs/v2/agent-accounts.md “本人的多个账号”):
 * another backend `<base>-<n>` whose source is `<base>#<n>`, with a folder of its own under
 * `<data>/logins/<id>`. Only backends whose catalog entry keeps its login where environment variables
 * say (`account.env`) can have one: the variables point at that folder, HOME stays the owner's, so
 * the agent's own commands still find the owner's other tools and logins. Its quota, capacity and
 * login are its own (quota.ts keys by source); logging it in is the machine login of that source
 * (machine-login.ts), from settings → AI.
 */

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export const loginsRoot = (app: App) => join(app.home, "logins");

/** The saved profile behind an extra login (`<base>#<n>`), or null. */
export function slotProfile(app: App, source: string): AgentProfile | null {
  if (!source.includes("#")) return null;
  return app.config.agents.profiles.find(p => p.source === source && p.loginDir) ?? null;
}

/** The catalog's account entry for a source, extra logins included. */
export function slotEntry(app: App, source: string): AccountEntry | null {
  return accountEntry(app, baseSource(source));
}

/** The backend's `account.env` pointed at a folder (`{home}` → the folder). */
export function folderEnv(entry: AccountEntry, dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(entry.account.env).map(([k, v]) => [k, v.replaceAll("{home}", dir)]));
}

/** Whether the backend can have another login of the owner's here. */
export function canAddLogin(app: App, source: string) {
  const entry = source.includes("#") ? null : accountEntry(app, source);
  // It must also log in without a screen: the new login is made from the page.
  return !!entry?.account.login && Object.values(entry.account.env).some(v => v.includes("{home}"));
}

function save(app: App, profiles: AgentProfile[]) {
  const next = configSchema.parse({ ...app.config, agents: { ...app.config.agents, profiles } });
  saveConfig(next, app.home);
  Object.assign(app.config, next);
}

/** Another login of this backend: a new backend with its own folder, not logged in yet. */
export function addLogin(app: App, source: string, actor: string) {
  if (!canAddLogin(app, source)) throw new HttpError(400, `${source} 不能再加账号：它的登录不放在可指定的目录里`);
  const entry = accountEntry(app, source)!;
  const all = allProfiles(app.config);
  // The installed ACP profile of the backend is the one to copy (its command, arguments and settings).
  const basis = all.find(p => sourceOf(p) === source && p.transport === "acp" && !p.peer && !p.keyRef) ?? all.find(p => sourceOf(p) === source && !p.peer && !p.keyRef);
  if (!basis) throw new HttpError(404, `找不到 ${source} 的后端`);
  const taken = new Set(all.map(p => p.id));
  let n = 2;
  while (taken.has(`${source}-${n}`) || all.some(p => sourceOf(p) === `${source}#${n}`)) n++;
  const id = `${source}-${n}`;
  if (!ID.test(id)) throw new HttpError(400, `后端 ID ${id} 不合规`);
  const dir = join(loginsRoot(app), id);
  for (const d of ["", ...(entry.account.dirs ?? [])]) ensurePrivateDir(app.home, join("logins", id, d));
  const { model, effort, idleTimeoutMs, transport, command, args } = basis;
  const profile = {
    id, name: `${entry.name} · 账号 ${n}`, transport, command, args, ...(model ? { model } : {}), ...(effort ? { effort } : {}), idleTimeoutMs,
    env: { ...basis.env, ...folderEnv(entry, dir) }, source: `${source}#${n}`, loginDir: dir,
  } as AgentProfile;
  save(app, [...app.config.agents.profiles, profile]);
  audit(app, actor, "agents.login.add", id, { source: profile.source });
  return { id, source: profile.source, name: profile.name };
}

/** Remove an extra login: its backend, every place it was chosen, and its folder (that is the logout). */
export async function removeLogin(app: App, source: string, actor: string) {
  const p = slotProfile(app, source);
  if (!p) throw new HttpError(404, `${source} 不是另加的账号`);
  const { cancelMachineLogin } = await import("./machine-login.ts");
  cancelMachineLogin(app, source);
  const a = app.config.agents;
  const keep = (id?: string) => id !== p.id;
  const next = configSchema.parse({
    ...app.config,
    agents: {
      ...a,
      profiles: a.profiles.filter(x => x.id !== p.id),
      default: keep(a.default) ? a.default : undefined,
      roles: Object.fromEntries(Object.entries(a.roles).filter(([, v]) => keep(v))),
      roleModels: Object.fromEntries(Object.entries(a.roleModels).map(([r, m]) => [r, Object.fromEntries(Object.entries(m).filter(([k]) => keep(k)))])),
      tiers: Object.fromEntries(Object.entries(a.tiers).filter(([, t]) => keep(t.profile))),
      fallback: a.fallback.filter(f => keep(f.profile)),
      routing: { ...a.routing, candidates: a.routing.candidates.filter(c => keep(c.profile)) },
    },
  });
  saveConfig(next, app.home);
  Object.assign(app.config, next);
  const dir = join(loginsRoot(app), p.id);
  if (p.loginDir === dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  audit(app, actor, "agents.login.remove", p.id, { source });
  return { ok: true };
}
