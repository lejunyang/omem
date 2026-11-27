import type { App } from "../core/app.ts";
import { allProfiles, listedModelsOf, type AgentProfile } from "../core/config.ts";
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

const commonNames: Record<string, string> = { cc: "claude", gemini: "antigravity", agy: "antigravity" };
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

export function parseAiSpec(app: App, text: string, { userId = OWNER }: { userId?: string } = {}): AiSpec {
  const body = text.trim().replace(/^\//, "");
  const lower = body.toLowerCase();
  const result: AiSpec = { rest: text.trim(), notes: [] };
  const profiles = allProfiles(app.config);
  const names = new Map<string, AgentProfile[]>();
  for (const p of profiles) {
    const program = (p.peer?.agent ?? (p.keyRef ? p.id.split("@")[0] : p.source ?? p.id)).replace(/-(?:acp|cli)$/, "");
    const command = p.command.split(/[/\\]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, "");
    const aliases = [p.id, p.name, program, command, p.peer?.id, ...Object.keys(commonNames).filter(k => commonNames[k] === program)];
    for (const alias of new Set(aliases)) {
      if (!alias) continue;
      const key = alias.toLowerCase();
      // The short command /gemini names Antigravity; Gemini CLI still has its display name.
      if (key === "gemini" && program !== "antigravity") continue;
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
    const pick = groupPick(app, group.id);
    if (!pick) return { ...result, unknown: "AI 组「" + group.name + "」当前没有可用后端。" };
    if (userId !== OWNER) {
      const p = profiles.find(p => p.id === pick.profile)!;
      const plan = memberAccountPlan(app, userId, { ...p, model: pick.model, effort: pick.effort });
      if (plan.kind === "blocked") return { ...result, unknown: plan.reason };
    }
    result.ai = pick;
    return result;
  }

  let candidates = names.get(name)!;
  if (name.includes("@") || name.endsWith("-cli")) candidates = candidates.filter(p => p.id.toLowerCase() === name);
  // Key names may contain Chinese. Consume the key before finding the beginning of the task.
  const selectors = app.config.ai.providers.flatMap(k => [k.name, k.id].filter(Boolean).map(label => ({ id: k.id, label: label.toLowerCase() })));
  for (const token of tail.split("\n", 1)[0].matchAll(/\S+/g)) {
    const key = selectors.find(k => k.label === token[0].toLowerCase() && candidates.some(p => p.keyRef === k.id));
    if (key) {
      candidates = candidates.filter(p => p.keyRef === key.id);
      tail = tail.slice(0, token.index) + tail.slice(token.index + token[0].length);
      break;
    }
    if (/\p{Script=Han}/u.test(token[0]) && !Object.hasOwn(effortValues, token[0])) break;
  }
  const { model, effort, rest } = argumentsOf(tail);
  result.rest = rest;
  const available = candidates.filter(p => backendAvailable(p, app.home));
  if (!available.length) {
    const entry = acpCatalog.find(e => e.id === (commonNames[name] ?? name) || e.id === candidates[0]?.id);
    return { ...result, unknown: [name + " 没装或现在不可用。", entry && installHint(entry)].filter(Boolean).join(" ") };
  }
  const accessible = available.filter(p => userId === OWNER || memberAccountPlan(app, userId, p).kind !== "blocked");
  if (!accessible.length) return { ...result, unknown: "你的账号不能使用 " + name + "。" };
  const rank = (p: AgentProfile) => Number(!!(p.keyRef || p.peer)) * 4 + Number(p.id !== name) + Number(p.id.endsWith("-cli")) * 2;
  accessible.sort((a, b) => rank(a) - rank(b));
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
  if (accessible.length > 1) result.notes.push("还有 " + accessible.filter(q => q !== p).map(q => "/" + q.id).join("、") + " 可选");
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
