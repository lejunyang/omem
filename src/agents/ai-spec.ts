import type { App } from "../core/app.ts";
import { allProfiles, listedModelsOf, type AgentProfile } from "../core/config.ts";
import { pairedIn } from "../core/peers.ts";
import { HttpError } from "../core/util.ts";
import { automaticNames, backendProgram, commonBackendAliases } from "./backend-names.ts";
import { cachedMachineLoginState } from "./machine-login.ts";
import { OWNER } from "../core/users.ts";
import { isAiMember, memberAccountPlan } from "./accounts.ts";
import { groupPick } from "./ai-policy.ts";
import { backendAvailable } from "./availability.ts";
import { acpCatalog, installHint } from "./catalog.ts";
import { userProbe } from "./probe.ts";

export type AiPick = { profile: string; model?: string; effort?: string };
export type AiSpec = {
  ai?: AiPick;
  group?: string;
  rest: string;
  notes: string[];
  ambiguous?: (AiPick & { model: string })[];
  unknown?: string;
};

const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const effortValues: Record<string, string> = { 低: "low", 中: "medium", 高: "high", 极高: "xhigh", 最高: "max" };
const effortEnd = /(minimal|medium|xhigh|high|low|max|极高|最高|低|中|高)$/i;

// Only correct a complete command word. A short prefix or an arbitrary sentence is not a typo.
function oneLetterAway(a: string, b: string) {
  if (!/^[a-z]{5,}$/.test(a) || !/^[a-z]{5,}$/.test(b) || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + Number(a.length >= b.length)) === b.slice(i + Number(b.length >= a.length));
}

function argumentsOf(text: string) {
  const [line, ...lines] = text.replace(/^[^\S\n]+/, "").split(/\r?\n/);
  // A Chinese effort is still an AI argument. A following Chinese sentence starts the task.
  const han = line.search(/\p{Script=Han}/u);
  let end = han < 0 ? line.length : han;
  const levelInChinese = /^(极高|最高|低|中|高)(?=\s|$)/.exec(line.slice(end));
  if (levelInChinese) end += levelInChinese[0].length;
  const args = line.slice(0, end).trim();
  const level = effortEnd.exec(args);
  const word = level?.[1].toLowerCase();
  return { model: (level ? args.slice(0, level.index) : args).trim(), effort: word && (effortValues[word] ?? word),
    rest: [line.slice(end).trimStart(), ...lines].join("\n").trim() };
}

function modelsFor(app: App, profile: AgentProfile, userId?: string) {
  const probe = userProbe(app, userId, profile.id);
  const models = profile.keyModels ?? (probe?.models.length ? probe.models : profile.model ? [profile.model] : []);
  const names = profile.keyRef ? listedModelsOf(profile.keyRef)?.endpoints : undefined;
  return models.map(id => ({ id, name: probe?.modelNames?.[id] ?? names?.[id] ?? id }));
}

function resolveModel(models: ReturnType<typeof modelsFor>, query: string) {
  const q = compact(query);
  const exact = models.filter(m => m.id.toLowerCase() === query.toLowerCase());
  if (exact.length) return exact;
  const normalized = models.filter(m => compact(m.name) === q);
  if (normalized.length) return normalized;
  return q ? models.filter(m => compact(m.name).includes(q) || compact(m.id).includes(q)) : [];
}

export function validateCommandNames(config: App["config"], home: string, commands: string[]) {
  const devices = new Map(pairedIn(home).map(p => [p.id, p.back?.name]));
  const occupied = new Map<string, Set<string>>();
  const register = (name: string, owner: string, unique: boolean) => {
    const key = name.toLowerCase();
    const owners = occupied.get(key) ?? new Set<string>();
    const other = [...owners].find(value => value !== owner);
    if (unique && other) throw new HttpError(400, `${owner} 的命令词「${name}」与${other}重名`);
    owners.add(owner);
    occupied.set(key, owners);
  };
  for (const c of commands) register(c, "命令 /" + c, false);
  const profiles = allProfiles(config);
  for (const p of profiles) for (const name of automaticNames(p, p.peer && devices.get(p.peer.id))) register(name, "后端 " + p.id, false);
  for (const g of config.agents.groups) for (const name of [g.id, g.name]) register(name, "组 " + g.id, true);
  for (const p of profiles) for (const name of p.aliases ?? []) register(name, "后端 " + p.id, true);
}

export function parseAiSpec(app: App, text: string, { userId = OWNER }: { userId?: string } = {}): AiSpec {
  const body = text.trim().replace(/^\//, "");
  const lower = body.toLowerCase();
  const result: AiSpec = { rest: text.trim(), notes: [] };
  const profiles = allProfiles(app.config);
  const names = new Map<string, AgentProfile[]>();
  const devices = new Map(pairedIn(app.home).map(p => [p.id, p.back?.name]));
  for (const p of profiles) {
    const aliases = [...automaticNames(p, p.peer && devices.get(p.peer.id)), ...(p.aliases ?? [])];
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      const list = names.get(key) ?? [];
      if (!list.includes(p)) list.push(p);
      names.set(key, list);
    }
  }
  const groups = app.config.agents.groups;
  const groupNames = groups.flatMap(g => [g.id, g.name].map(n => n.toLowerCase()));
  let name = [...names.keys(), ...groupNames].filter(k => lower.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  let length = name?.length ?? 0;
  const word = lower.split(/\s/, 1)[0];
  if (!name || (word !== name && word.length === name.length + 1)) {
    const close = [...names.keys()].filter(k => oneLetterAway(word, k));
    if (close.length === 1) {
      name = close[0];
      length = word.length;
      result.notes.push("按 /" + name + " 理解");
    }
  }
  if (!name) return result;
  let tail = body.slice(length);
  const group = groups.find(g => [g.name, g.id].some(n => n.toLowerCase() === name));
  if (userId !== OWNER && !isAiMember(app, userId)) return { ...result, unknown: "这个账号不能选择 AI。" };
  if (group) {
    result.group = group.id;
    result.rest = tail.trim();
    const usable = userId === OWNER ? undefined : (p: AgentProfile) => memberAccountPlan(app, userId, p).kind !== "blocked";
    const pick = groupPick(app, group.id, undefined, false, usable);
    if (!pick) return { ...result, unknown: "AI 组「" + group.name + "」当前没有可用后端。" };
    result.ai = pick;
    return result;
  }

  let candidates = names.get(name)!;
  if (candidates.some(p => p.id.toLowerCase() === name) && (name.includes("@") || name.endsWith("-cli"))) candidates = candidates.filter(p => p.id.toLowerCase() === name);
  // Key names may contain Chinese. Consume the key before finding the beginning of the task.
  const selectors = app.config.ai.providers.flatMap(k => [k.name, k.id].filter(Boolean).map(label => ({ id: k.id, label: label.toLowerCase() })));
  for (const token of tail.split("\n", 1)[0].matchAll(/\S+/g)) {
    const label = token[0].replace(/^@/, "").toLowerCase();
    const key = selectors.find(k => k.label === label && candidates.some(p => p.keyRef === k.id));
    const qualified = key ? candidates.filter(p => p.keyRef === key.id)
      : candidates.filter(p => p.peer && [p.peer.id, devices.get(p.peer.id)].some(n => n?.toLowerCase() === label));
    if (qualified.length) {
      candidates = qualified;
      tail = tail.slice(0, token.index) + tail.slice(token.index + token[0].length);
      break;
    }
    if (/\p{Script=Han}/u.test(token[0]) && !Object.hasOwn(effortValues, token[0])) break;
  }
  const { model, effort, rest } = argumentsOf(tail);
  result.rest = rest;
  const login = (p: AgentProfile) => cachedMachineLoginState(app, p.loginDir ? p.id : backendProgram(p));
  const available = candidates.filter(p => backendAvailable(p, app.home)
    && (userId !== OWNER || p.peer || p.keyRef || login(p) !== "none"));
  if (!available.length) {
    const entry = acpCatalog.find(e => e.id === (commonBackendAliases[name] ?? backendProgram(candidates[0])));
    return { ...result, unknown: [name + " 没装或现在不可用。", entry && installHint(entry)].filter(Boolean).join(" ") };
  }
  const accessible = available.filter(p => userId === OWNER || memberAccountPlan(app, userId, p).kind !== "blocked");
  if (!accessible.length) return { ...result, unknown: "你的账号不能使用 " + name + "。" };
  const configured = new Set(app.config.agents.profiles.map(p => p.id));
  const accountRank = (p: AgentProfile) => p.keyRef || p.peer ? 2 : login(p) === "logged-in" ? 0 : 1;
  const matchesAlias = (p: AgentProfile) => commonBackendAliases[name] === backendProgram(p);
  accessible.sort((a, b) => accountRank(a) - accountRank(b)
    || Number(matchesAlias(b)) - Number(matchesAlias(a))
    || Number(a.id.endsWith("-cli")) - Number(b.id.endsWith("-cli"))
    || Number(configured.has(b.id)) - Number(configured.has(a.id))
    || Number(b.id.toLowerCase() === name) - Number(a.id.toLowerCase() === name));
  let p = accessible[0];
  let models = modelsFor(app, p, userId);
  let hits = model ? resolveModel(models, model) : [];
  if (model && !hits.length) {
    const keys = accessible.filter(q => q.keyRef);
    if (keys.length === 1 && p !== keys[0]) {
      const alternatives = modelsFor(app, keys[0], userId);
      const found = resolveModel(alternatives, model);
      if (found.length) { p = keys[0]; models = alternatives; hits = found; }
    }
  }
  if (accessible.length > 1) result.notes.push("还有 " + accessible.filter(q => q !== p).map(q => q.peer ? `/${backendProgram(q)} ${devices.get(q.peer.id) || q.peer.id}` : "/" + q.id).join("、") + "，可用对应命令或设备名选");
  const base: AiPick = { profile: p.id, ...(effort ? { effort } : {}) };
  if (!model) return { ...result, ai: base };
  if (!hits.length) return { ...result, unknown: "找不到模型 " + model + "。可选：" + (models.map(m => m.name).join("、") || "还没有检测到模型") };
  if (hits.length > 1 && !/\d/.test(model) && new Set(hits.map(m => compact(m.name.replace(/\d+(?:[.-]\d+)*/g, "")))).size === 1) {
    hits.sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }));
    if (hits[0].name !== hits[1].name) {
      result.notes.push(model + " → " + hits[0].name + "（最新的）");
      hits = hits.slice(0, 1);
    }
  }
  if (hits.length > 1) return { ...result, ambiguous: hits.map(m => ({ ...base, model: m.id })) };
  return { ...result, ai: { ...base, model: hits[0].id } };
}
