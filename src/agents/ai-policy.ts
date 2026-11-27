import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { all } from "../core/db.ts";
import { builtinGroups, type AiGroup, type Policy } from "../core/ai-policy-schema.ts";
import { HttpError } from "../core/util.ts";
import { modelDisplayName } from "../core/ai-keys.ts";
import { backendAvailable } from "./availability.ts";
import { downReason, excluded, hasRoom } from "./capacity.ts";
import { backendProgram, commonBackendAliases, defaultModelFamilies, normalizeProgram } from "./backend-names.ts";
import { modelFamily } from "./families.ts";
import { quotaAvoid } from "./quota.ts";
import { runClass, runClasses, type RunClass } from "./run-classes.ts";
import type { AgentSpec } from "./specs.ts";

type PickAI = { profile: string; model?: string; effort?: string };
export const pickOf = (p: AgentProfile): PickAI => ({ profile: p.id, model: p.model, effort: p.effort });
const parseAI = (text: string): PickAI => {
  const [profile, model, effort] = text.split("·").map(x => x.trim());
  return { profile, model, effort };
};
export type PolicyAI = Pick<AgentProfile, "id" | "model" | "effort" | "peer" | "keyRef" | "source" | "stateLayout"> & { command?: string };
const sameAI = (ai: PickAI, p: PolicyAI) => ai.profile === p.id && (!ai.model || ai.model === p.model) && (!ai.effort || ai.effort === p.effort);
export function matchesSelector(selector: string, p: PolicyAI): boolean {
  const pos = selector.indexOf(":");
  const value = selector.slice(pos + 1).trim();
  switch (selector.slice(0, pos)) {
    case "backend": {
      const program = backendProgram(p);
      const wanted = normalizeProgram(value);
      return program === wanted || program === commonBackendAliases[wanted];
    }
    case "model": {
      const family = p.model ? modelFamily({ model: p.model }) : defaultModelFamilies[backendProgram(p)];
      return family === (modelFamily({ model: value }) ?? value);
    }
    case "key": return p.keyRef === value;
    case "ai": return sameAI(parseAI(value), p);
    default: return false;
  }
}

export function inHours(hours: string | undefined, time: string) {
  if (!hours) return true;
  const [start, end] = hours.split("-");
  return start < end ? start <= time && time < end : time >= start || time < end;
}
export function groupItems(app: Pick<App, "config">, id: string): AiGroup["items"] {
  const group = app.config.agents.groups.find(g => g.id === id);
  if (group?.items.length) return group.items;
  const old = Object.hasOwn(builtinGroups, id) ? app.config.agents.tiers[id as keyof typeof builtinGroups] : undefined;
  if (old) return [old];
  if (id === "candidates") return app.config.agents.routing.candidates.map(({ when, ...p }) => ({ ...p, note: when }));
  return [];
}
function effectivePick(item: PickAI, base: AgentProfile | undefined): PickAI {
  return {
    profile: item.profile, model: item.model || base?.model,
    effort: item.effort || (!item.model || item.model === base?.model ? base?.effort : undefined)
  };
}

export function profilesFor(app: App, items: AiGroup["items"], profiles: AgentProfile[]) {
  const time = new Date().toLocaleTimeString("en-GB", { timeZone: app.config.timezone, hour: "2-digit", minute: "2-digit", hour12: false });
  return items.flatMap(item => {
    const base = profiles.find(p => p.id === item.profile);
    if (!base) return [];
    const { model, effort } = effectivePick(item, base);
    const p = { ...base, model, effort };
    const available = backendAvailable(p, app.home) && !excluded(app, p);
    const delayed = !inHours(item.hours, time) || !hasRoom(app, p) || !!quotaAvoid(app, p) || !!downReason(app, p);
    return [{ p, item, available, rank: available ? Number(delayed) : 2 }];
  }).sort((a, b) => a.rank - b.rank);
}
export function groupPick(app: App, id: string, scope?: PolicyScope, includeUnavailable = false, accepts?: (profile: AgentProfile) => boolean): PickAI | undefined {
  const group = app.config.agents.groups.find(g => g.name === id || g.id === id);
  const found = profilesFor(app, groupItems(app, group?.id ?? id), allProfiles(app.config)).find(x => (x.available || includeUnavailable) && !policyReason(scope, x.p) && (!accepts || accepts(x.p)));
  return found && pickOf(found.p);
}
export type PolicyScope = {
  classId: RunClass; use: string[]; strict: boolean; order: "fixed" | "choose"; deny: { selector: string; rule: string }[];
  groups: AiGroup[]; said: string[]; members: PickAI[];
};
export function policyScope(app: Pick<App, "config">, kind?: string, role?: string, spec?: Pick<AgentSpec, "ai" | "agent" | "model" | "effort" | "class">): PolicyScope | undefined {
  const classId = runClass(kind, role, spec?.class);
  if (!classId) return;
  const config = app.config.agents;
  const rule = config.policy.classes[classId];
  const name = runClasses[classId].name;
  // Legacy agent/model/effort is a preference resolved by resolveRunProfile; it never widens the category.
  const use = spec?.ai?.use ?? rule?.use ?? [];
  const groups = use.map(ref => {
    if (ref.startsWith("ai:")) return { id: ref, name: ref.slice(3), items: [parseAI(ref.slice(3))] };
    const g = config.groups.find(g => g.id === ref);
    return { id: ref, name: g?.name ?? ref, items: groupItems(app, ref) };
  });
  const catalog = groups.length ? allProfiles(app.config) : [];
  const members = groups.flatMap(g => g.items.map(item => {
    const base = catalog.find(p => p.id === item.profile);
    return effectivePick(item, base);
  }));
  return {
    classId, use, groups, members,
    order: rule?.order ?? (classId === "coding" || classId === "review" ? "fixed" : "choose"),
    strict: spec?.ai?.strict ?? rule?.strict ?? false,
    said: rule?.said.map(s => s.text) ?? [],
    deny: [
      ...config.policy.deny.map(selector => ({ selector, rule: "全局规则" })),
      ...(rule?.deny ?? []).map(selector => ({ selector, rule: name })),
      ...(spec?.ai?.deny ?? []).map(selector => ({ selector, rule: "Agent 档案" })),
    ],
  };
}
export function policyReason(scope: PolicyScope | undefined, p: PolicyAI): string | undefined {
  if (!scope) return;
  const served = p.keyRef && p.model ? modelDisplayName(p.model) : p.model;
  const blocked = scope.deny.find(d => matchesSelector(d.selector, p) || (served !== p.model && d.selector.startsWith("model:") && matchesSelector(d.selector, { ...p, model: served })));
  if (blocked) return blocked.rule + " 不用 " + blocked.selector;
  if (scope.use.length && !scope.members.some(m => sameAI(m, p))) return runClasses[scope.classId].name + " 只用 " + scope.use.join("、");
}
export function scopedProfiles(app: App, scope: PolicyScope | undefined, options: AgentProfile[], includeOther = false) {
  if (!scope || (!scope.use.length && !scope.deny.length)) return options;
  const catalog = allProfiles(app.config);
  const ordered = scope.groups.flatMap(g => profilesFor(app, g.items, catalog).filter(x => x.available).map(x => x.p));
  const available = (p: AgentProfile) => backendAvailable(p, app.home) && !excluded(app, p);
  const needAlternative = includeOther && !scope.use.length && !options.some(p => !policyReason(scope, p) && available(p));
  const rest = needAlternative ? catalog.filter(available) : [];
  const seen = new Set<string>();
  return [...ordered, ...options, ...rest].filter(p => {
    if (policyReason(scope, p)) return false;
    const key = JSON.stringify(pickOf(p));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function validatePolicy(app: Pick<App, "config">, policy: Policy, groups = app.config.agents.groups) {
  const ids = new Set(groups.map(g => g.id));
  const profiles = allProfiles(app.config);
  if (ids.size !== groups.length || Object.keys(builtinGroups).some(k => !ids.has(k))) throw new HttpError(400, "AI 组编号要唯一，并保留强、标准、省三组");
  const checkAI = (p: PickAI) => { if (!profiles.some(x => x.id === p.profile)) throw new HttpError(400, "不认识的后端：" + p.profile); };
  for (const g of groups) for (const p of g.items) checkAI(p);
  for (const r of Object.values(policy.classes)) for (const ref of r!.use) {
    if (ref.startsWith("ai:")) checkAI(parseAI(ref.slice(3)));
    else if (!ids.has(ref)) throw new HttpError(400, "不认识的 AI 组：" + ref);
  }
  for (const sel of [...policy.deny, ...Object.values(policy.classes).flatMap(r => r!.deny)]) {
    const [type, ...parts] = sel.split(":");
    const val = parts.join(":").trim();
    if (type === "ai" && val) { checkAI(parseAI(val)); continue; }
    if (type === "model" && (modelFamily({ model: val }) || ["anthropic", "openai", "google", "zhipu", "moonshot", "xai", "meta"].includes(val))) continue;
    if (["key", "backend"].includes(type) && profiles.some(p => matchesSelector(sel, p))) continue;
    throw new HttpError(400, "不认识的排除规则：" + sel);
  }
}
export function policyUsage(app: App) {
  const rows = all<{ kind: string; classId: string | null; pick: string | null; label: string; count: number }>(app.db, `select r.kind,
    json_extract(e.data,'$.choice.class') classId,
    json_extract(e.data,'$.choice.ai') pick,
    coalesce(json_extract(e.data,'$.choice.picked'),json_extract(e.data,'$.choice.current')) label,count(*) count
    from run_events e join runs r on r.id=e.run_id
    where e.type='status' and json_type(e.data,'$.choice')='object' and e.at>=?
    group by 1,2,3,4`, new Date(Date.now() - 7 * 86400000).toISOString());
  const totals = new Map<string, { class: string; profile: string; model?: string; effort?: string; count: number }>();
  for (const row of rows) {
    const cls = row.classId ?? runClass(row.kind);
    if (!cls || (!row.pick && !row.label)) continue;
    const ai: PickAI = row.pick ? JSON.parse(row.pick) : parseAI(row.label);
    const key = JSON.stringify([cls, ai.profile, ai.model, ai.effort]);
    const total = totals.get(key) ?? { class: cls, ...ai, count: 0 };
    total.count += row.count;
    totals.set(key, total);
  }
  return [...totals.values()];
}

/** A durable wait frees the worker slot. Re-entry checks availability and the same deadline. */
export async function waitForPolicy(app: App, scope: PolicyScope, runId: string | null): Promise<never> {
  const { getRun, setRunOutput, addRunEvent, ResumeRunAt } = await import("./runs.ts");
  const text = runClasses[scope.classId].name + " 的 AI 范围内没有可用后端：" + scope.use.join("、");
  if (!runId) throw new Error(text);
  const saved = getRun(app, runId).output.aiPolicyWaitUntil;
  const deadline = typeof saved === "number" ? saved : Date.now() + app.config.agents.queueTimeoutMinutes * 60_000;
  if (Date.now() >= deadline) {
    const { notify } = await import("../core/notify.ts");
    notify(app, { title: "等待 AI 超时", body: text, runId });
    throw new Error("等待 AI 超时：" + text);
  }
  if (saved === undefined) {
    setRunOutput(app, runId, { aiPolicyWaitUntil: deadline });
    addRunEvent(app, runId, "status", { text: text + "，排队等待" });
  }
  throw new ResumeRunAt(Math.min(Date.now() + 30_000, deadline));
}
