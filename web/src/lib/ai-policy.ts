import { reactive, ref } from "vue";
import { ApiError, get } from "../api";
import { modelFamily } from "../../../src/agents/families";

/**
 * AI rules and groups (docs/v2/ai-policy.md, `GET /api/ai/policy`): what the settings page, the
 * backend blocks and the profile form share. Rules are written with selectors (`backend:claude`,
 * `model:gemini`, `ai:codex · gpt-6.2-sol · high`, `key:<id>`) and group ids; nobody reads those here:
 * every one is said in words (`selectorText`, `refText`) and picked from choices.
 */
export type AiPick = { profile: string; model?: string; effort?: string };
export type GroupItem = AiPick & { hours?: string; note?: string };
export type AiGroup = { id: string; name: string; items: GroupItem[] };
export type ClassOrder = "choose" | "fixed";
export type ClassRule = { use: string[]; deny: string[]; order: ClassOrder; strict: boolean; said: { text: string; at: string }[] };
export type Policy = { deny: string[]; classes: Partial<Record<string, ClassRule>> };
export type RunClassInfo = { name: string; description: string; kinds: string[]; roles: string[]; order: ClassOrder };
/** `program`: what a `backend:` rule matches; `names`: the command words it answers to by itself. */
export type PolicyBackend = { id: string; name: string; program: string; installed: boolean; key?: { id: string; name: string }; models: string[]; modelNames?: Record<string, string>; names: string[] };
export type PolicyUsage = { class: string; profile: string; model?: string; effort?: string; count: number };
export type PolicyView = { classes: Record<string, RunClassInfo>; groups: AiGroup[]; policy: Policy; usage: PolicyUsage[]; backends: PolicyBackend[] };

export const BUILTIN_GROUPS: Record<string, string> = { strong: "强", standard: "标准", cheap: "省" };
export const defaultOrder = (classId: string): ClassOrder => (classId === "coding" || classId === "review" ? "fixed" : "choose");

/**
 * One copy for the tab. `missing`: the server is older than the rules (no such route). Loaded again
 * after a save here, a confirmed proposal, or a change to the backends.
 */
export const aiPolicy = reactive<{ data: PolicyView | null; error: string; missing: boolean; loading: boolean }>({ data: null, error: "", missing: false, loading: false });
let seq = 0;
let pending: Promise<void> | null = null;
export function loadAiPolicy(force = false): Promise<void> {
  if (!force && (aiPolicy.data || aiPolicy.missing)) return Promise.resolve();
  if (!force && pending) return pending;
  const mine = ++seq;
  aiPolicy.loading = true;
  pending = get<PolicyView>("/api/ai/policy").then((v) => {
    if (mine !== seq) return;
    aiPolicy.data = v;
    aiPolicy.error = "";
    aiPolicy.missing = false;
  }).catch((e) => {
    if (mine !== seq) return;
    if (e instanceof ApiError && e.status === 404) aiPolicy.missing = true;
    else aiPolicy.error = (e as Error).message;
  }).finally(() => {
    if (mine === seq) {
      aiPolicy.loading = false;
      pending = null;
    }
  });
  return pending;
}

/**
 * Outside the settings page (the Agent page): the old tiers and candidates the groups still stand for
 * until they are saved (`GET /api/settings?section=ai`); someone who may not read them gets none.
 */
type OldAi = { tiers?: Partial<Record<string, Tier>>; candidates?: Candidate[] };
export const aiOld = reactive<{ data: OldAi | null }>({ data: null });
let oldPending: Promise<void> | null = null;
export function loadAiOld() {
  oldPending ??= get<{ config: { agents?: { tiers?: OldAi["tiers"]; routing?: { candidates?: Candidate[] } } } }>("/api/settings?section=ai")
    .then((s) => { aiOld.data = { tiers: s.config.agents?.tiers, candidates: s.config.agents?.routing?.candidates }; })
    .catch(() => { aiOld.data = {}; });
  return oldPending;
}

/** A sentence handed from elsewhere (总体偏好 → 转成规则) to the “用一句话改” box. */
export const proposalText = ref("");

// ---- words for what rules name ----------------------------------------------------------------
const plainName = (name: string) => name.replace(/\s*[(（](ACP|CLI|命令行)[)）]\s*$/i, "");
export const FAMILY_LABEL: Record<string, string> = {
  anthropic: "Claude", openai: "GPT", google: "Gemini", deepseek: "DeepSeek", doubao: "豆包", qwen: "通义千问",
  zhipu: "GLM", moonshot: "Kimi", xai: "Grok", meta: "Llama", mistral: "Mistral", minimax: "MiniMax",
};
/** The word a family is written with in a rule (`model:gemini`): any name of the family matches it. */
export const FAMILY_WORD: Record<string, string> = {
  anthropic: "claude", openai: "gpt", google: "gemini", deepseek: "deepseek", doubao: "doubao", qwen: "qwen",
  zhipu: "glm", moonshot: "kimi", xai: "grok", meta: "llama", mistral: "mistral", minimax: "minimax",
};
const PROGRAM_FAMILY: Record<string, string> = { antigravity: "google", gemini: "google", claude: "anthropic", codex: "openai" };
const COMMON_ALIASES: Record<string, string> = { cc: "claude", gemini: "antigravity", agy: "antigravity" };
export const familyOf = (word: string) => modelFamily({ model: word }) ?? word.toLowerCase();
/** “Gemini 系列”, “豆包系列”: a space only after a Latin name. */
export const familyName = (family: string, fallback = family) => {
  const name = FAMILY_LABEL[family] ?? fallback;
  return /[A-Za-z0-9]$/.test(name) ? `${name} 系列` : `${name}系列`;
};
const normalizeProgram = (name: string) => name.toLowerCase().split("@")[0].replace(/-(?:cli|acp)$/, "");

export function parseAi(text: string): AiPick {
  const [profile, model, effort] = text.split("·").map((x) => x.trim());
  return { profile, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
/** `ai:codex · gpt-6.2-sol · high`; an effort is only written with its model (the pickers ask in that order). */
export const aiRef = (p: AiPick) => "ai:" + [p.profile, p.model, p.model ? p.effort : undefined].filter(Boolean).join(" · ");

/** The backends of one program: the one that names it best is a local ACP one, not a key's or a device's. */
export function programName(program: string, backends: PolicyBackend[]) {
  const same = backends.filter((b) => b.program === program);
  const best = same.find((b) => !b.key && !b.id.includes("@") && !/-cli$/.test(b.id)) ?? same[0];
  return best ? plainName(best.name) : program;
}
export function backendName(id: string, backends: PolicyBackend[]) {
  const b = backends.find((x) => x.id === id);
  return b ? plainName(b.name) : id;
}
export function modelLabel(id: string, model: string, backends: PolicyBackend[]) {
  return backends.find((b) => b.id === id)?.modelNames?.[model] ?? model;
}
/** “Codex · gpt-6.2-sol · high”; `all` says what a missing model or effort stands for. */
export function aiText(p: AiPick, backends: PolicyBackend[], all?: { model: string; effort: string }) {
  const parts = [backendName(p.profile, backends)];
  if (p.model) parts.push(modelLabel(p.profile, p.model, backends));
  else if (all) parts.push(all.model);
  if (p.effort) parts.push(p.effort);
  else if (all && p.model) parts.push(all.effort);
  return parts.join(" · ");
}
export type SelectorType = "backend" | "model" | "ai" | "key";
export function splitSelector(sel: string): { type: SelectorType | ""; value: string } {
  const at = sel.indexOf(":");
  const type = sel.slice(0, at);
  return { type: (["backend", "model", "ai", "key"].includes(type) ? type : "") as SelectorType | "", value: sel.slice(at + 1).trim() };
}
/** What a deny selector leaves out, said as a person would: “Claude Code（全部模型）”, “Gemini 系列模型”. */
export function selectorText(sel: string, backends: PolicyBackend[]) {
  const { type, value } = splitSelector(sel);
  switch (type) {
    case "backend": {
      const program = normalizeProgram(value);
      return `${programName(COMMON_ALIASES[program] && !backends.some((b) => b.program === program) ? COMMON_ALIASES[program] : program, backends)}（全部模型）`;
    }
    case "model": {
      return `${familyName(familyOf(value), value)}模型`;
    }
    case "ai": return aiText(parseAi(value), backends, { model: "全部模型", effort: "全部强度" });
    case "key": {
      const key = backends.find((b) => b.key?.id === value)?.key;
      return `API key「${key?.name ?? value}」生成的后端`;
    }
    default: return sel;
  }
}
/** A `use` entry: a group by its name, or one AI. */
export function refText(ref: string, groups: AiGroup[], backends: PolicyBackend[]) {
  if (ref.startsWith("ai:")) return aiText(parseAi(ref.slice(3)), backends);
  return groups.find((g) => g.id === ref)?.name ?? BUILTIN_GROUPS[ref] ?? ref;
}

// ---- the groups as they act now ----------------------------------------------------------------
type Tier = { profile: string; model?: string; effort?: string };
type Candidate = Tier & { when: string };
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
/**
 * The groups the way runs see them: an empty built-in group stands for its old tier (强 / 标准 / 省),
 * a missing `candidates` group for the old routing candidates (ai-policy.ts groupItems). Saving the
 * groups moves those two into the groups for good, so the editor starts from this.
 */
export function effectiveGroups(groups: AiGroup[] | undefined, tiers: Partial<Record<string, Tier>> | undefined, candidates: Candidate[] | undefined): AiGroup[] {
  const list: AiGroup[] = (groups ?? []).map((g) => ({ ...g, items: g.items.map((i) => clean({ ...i })) }));
  for (const [id, name] of Object.entries(BUILTIN_GROUPS)) if (!list.some((g) => g.id === id)) list.splice(Object.keys(BUILTIN_GROUPS).indexOf(id), 0, { id, name, items: [] });
  for (const g of list) {
    const tier = BUILTIN_GROUPS[g.id] && !g.items.length ? tiers?.[g.id] : undefined;
    if (tier?.profile) g.items = [clean({ profile: tier.profile, model: tier.model, effort: tier.effort })];
  }
  if (!list.some((g) => g.id === "candidates") && candidates?.length)
    list.push({ id: "candidates", name: "候选", items: candidates.map(({ when, ...p }) => clean({ profile: p.profile, model: p.model, effort: p.effort, note: when?.trim() || undefined })) });
  return list;
}
/** The old tiers or candidates are still kept apart: the first save of the groups takes them in. */
export const hasOldSettings = (tiers: Record<string, unknown> | undefined, candidates: unknown[] | undefined) => !!(tiers && Object.keys(tiers).length) || !!candidates?.length;

// ---- who a rule leaves out (the same reading as src/agents/ai-policy.ts, for marking conflicts) -
export type ScopeRule = { use: string[]; deny: { selector: string; rule: string }[]; name: string };
type BackendDefaults = { id: string; model?: string; effort?: string };
function filled(p: AiPick, defaults: BackendDefaults[]): AiPick {
  const base = defaults.find((d) => d.id === p.profile);
  const model = p.model || base?.model;
  return { profile: p.profile, model, effort: p.effort || (!p.model || p.model === base?.model ? base?.effort : undefined) };
}
const same = (rule: AiPick, p: AiPick) => rule.profile === p.profile && (!rule.model || rule.model === p.model) && (!rule.effort || rule.effort === p.effort);
export function selectorMatches(sel: string, p: AiPick, backends: PolicyBackend[]) {
  const { type, value } = splitSelector(sel);
  const b = backends.find((x) => x.id === p.profile);
  switch (type) {
    case "backend": {
      const wanted = normalizeProgram(value);
      return !!b && (b.program === wanted || b.program === COMMON_ALIASES[wanted]);
    }
    case "model": {
      const family = p.model ? modelFamily({ model: p.model }) : b ? PROGRAM_FAMILY[b.program] : undefined;
      return !!family && family === familyOf(value);
    }
    case "key": return b?.key?.id === value;
    case "ai": return same(parseAi(value), p);
    default: return false;
  }
}
/** The groups and AIs a `use` list stands for, filled in with each backend's own model. */
export function useMembers(use: string[], groups: AiGroup[], defaults: BackendDefaults[]) {
  return use.flatMap((ref) => (ref.startsWith("ai:") ? [parseAi(ref.slice(3))] : groups.find((g) => g.id === ref)?.items ?? [])).map((i) => filled(i, defaults));
}
/** Why a rule leaves this AI out, in words, or undefined when it may run. */
export function scopeReason(p: AiPick, rule: ScopeRule, groups: AiGroup[], backends: PolicyBackend[], defaults: BackendDefaults[]) {
  const ai = filled(p, defaults);
  const blocked = rule.deny.find((d) => selectorMatches(d.selector, ai, backends));
  if (blocked) return `${blocked.rule}不用 ${selectorText(blocked.selector, backends)}`;
  if (rule.use.length && !useMembers(rule.use, groups, defaults).some((m) => same(m, ai))) return `${rule.name}只用 ${rule.use.map((r) => refText(r, groups, backends)).join("、")}`;
}
