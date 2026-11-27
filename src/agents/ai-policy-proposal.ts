import { z } from "zod";
import type { App } from "../core/app.ts";
import { allProfiles, prepareConfigSave, saveConfig, type AgentProfile, type Config } from "../core/config.ts";
import { classPolicySchema, classSchema, policySchema } from "../core/ai-policy-schema.ts";
import { HttpError, now, sha256 } from "../core/util.ts";
import { withinTx } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { audit } from "../auth/permissions.ts";
import type { ViewComponent } from "./ui-blocks.ts";
import { createAsk, registerAskAction } from "./asks.ts";
import { createRun, getRun, runUser, setRunOutput, type RunContext } from "./runs.ts";
import { groupPick, matchesSelector, policyReason, policyScope, policyUsage, validatePolicy, type PolicyAI } from "./ai-policy.ts";
import { runClasses } from "./run-classes.ts";
import { modelFamily } from "./families.ts";
import { cachedProbe, effortsFor } from "./probe.ts";
import { backendAvailable } from "./availability.ts";

export const policyText = z.string().trim().min(1).max(8000);
const refs = z.array(z.string().trim().min(1).max(300)).max(100);
const changeSchema = z.object({
  class: classSchema, addUse: refs.optional(), removeUse: refs.optional(),
  addDeny: refs.optional(), removeDeny: refs.optional(),
  order: z.enum(["fixed", "choose"]).optional(), strict: z.boolean().optional(),
}).strict();
const draftSchema = z.object({
  changes: z.array(changeSchema).max(Object.keys(runClasses).length),
  unmatched: z.array(z.string().trim().min(1).max(8000)).max(20).default([]),
}).strict();
export const proposalArgs = z.object({
  text: policyText.optional().describe("主助手原样转交本人的一句话"),
  draft: draftSchema.optional().describe("只给规则起草运行，按类别增减 use 和 deny。unmatched 放没有对应设置的原话"),
}).strict();
type Draft = z.infer<typeof draftSchema>;

// A preview is tied to the rules and group definitions it described.
const revision = (config: Config) => sha256(JSON.stringify([config.agents.policy, config.agents.groups]));
function checkRevision(config: Config, expected: unknown) {
  if (revision(config) !== expected) throw new HttpError(409, "AI 规则或分组已经改过，请重新生成预览");
}

export function startPolicyDraft(app: App, text: string, parentId: string | null = null) {
  return createRun(app, { kind: "ai-policy-draft", title: "起草 AI 规则", userId: OWNER, parentId,
    input: { text: policyText.parse(text) } });
}

function backendModels(app: App, p: AgentProfile) {
  const items = app.config.agents.groups.flatMap(g => g.items).filter(i => i.profile === p.id);
  const probe = cachedProbe(app, p.id);
  return [...new Set([p.model, ...(p.keyModels ?? []), ...(probe?.models ?? []), ...items.map(i => i.model)].filter((m): m is string => !!m))];
}

export async function runPolicyDraft(ctx: RunContext) {
  const { app, run } = ctx;
  if (run.output.askId) return;
  const strong = groupPick(app, "strong", policyScope(app, run.kind));
  if (!strong) throw new HttpError(409, "强组在当前范围内没有可用的 AI，请在设置里检查强组");
  const backends = allProfiles(app.config).filter(p => backendAvailable(p, app.home)).map(p => ({
    id: p.id, name: p.name, models: backendModels(app, p), modelNames: cachedProbe(app, p.id)?.modelNames,
  }));
  ctx.output({ revision: revision(app.config) });
  const { runRole } = await import("./runner.ts");
  await runRole(app, {
    role: "ai-policy-writer", spaceId: "personal", spaces: ["personal"], runId: run.id,
    requiredTools: ["propose_ai_policy"], execution: { ...strong, source: "flow", reason: "强组起草 AI 规则" },
    signal: ctx.signal, onEvent: e => ctx.event(e.type, e),
    task: [`本人原话：\n${run.input.text}`, `类别：${JSON.stringify(runClasses)}`,
      `组：${JSON.stringify(app.config.agents.groups)}`, `可用的 AI：${JSON.stringify(backends)}`,
      `当前规则：${JSON.stringify(app.config.agents.policy)}`].join("\n\n"),
  });
  if (!getRun(app, run.id).output.askId) throw new Error("强组没有提交规则草稿，请换个说法重试");
}

const editRefs = (old: string[], add: string[] = [], remove: string[] = []) =>
  [...new Set([...old.filter(s => !remove.includes(s)), ...add])];

function applyDraft(config: Config, draft: Draft) {
  const policy = structuredClone(config.agents.policy);
  const changed = new Set<keyof typeof runClasses>();
  if (new Set(draft.changes.map(c => c.class)).size !== draft.changes.length) throw new HttpError(400, "同一类别的改动请合成一条");
  for (const c of draft.changes) {
    const old = policy.classes[c.class] ?? classPolicySchema.parse({ order: policyScope({ config }, undefined, undefined, { class: c.class })!.order });
    const next = { ...old, use: editRefs(old.use, c.addUse, c.removeUse), deny: editRefs(old.deny, c.addDeny, c.removeDeny),
      order: c.order ?? old.order, strict: c.strict ?? old.strict };
    if (JSON.stringify(next) === JSON.stringify(old)) continue;
    changed.add(c.class);
    policy.classes[c.class] = next;
  }
  policySchema.parse(policy);
  validatePolicy({ config }, policy);
  return { policy, changed };
}

function preview(app: App, draft: Draft) {
  const { policy, changed } = applyDraft(app.config, draft);
  const proposed = { config: { ...app.config, agents: { ...app.config.agents, policy } } };
  const usage = policyUsage(app);
  const profiles = new Map(allProfiles(app.config).map(p => [p.id, p]));
  const history = usage.map(u => ({
    class: u.class, count: u.count, ai: { ...profiles.get(u.profile), id: u.profile, model: u.model, effort: u.effort },
  }));
  const groups = app.config.agents.groups.flatMap(g => g.items);
  const catalog: PolicyAI[] = [...profiles.values()];
  for (const p of profiles.values()) {
    const probe = cachedProbe(app, p.id);
    for (const model of backendModels(app, p)) {
      catalog.push({ ...p, model, effort: model === p.model ? p.effort : undefined });
      for (const effort of effortsFor(probe, model)) catalog.push({ ...p, model, effort });
    }
  }
  for (const i of groups) {
    const base = profiles.get(i.profile);
    if (base) catalog.push({ ...base, model: i.model ?? base.model, effort: i.effort ?? (i.model && i.model !== base.model ? undefined : base.effort) });
  }
  catalog.push(...history.map(h => h.ai));
  for (const change of draft.changes) {
    for (const ref of [...(change.addUse ?? []), ...(change.addDeny ?? [])]) {
      if (ref.startsWith("ai:") && !catalog.some(p => matchesSelector(ref, p))) throw new HttpError(400, "没有这个后端、模型和强度的组合：" + ref);
    }
  }
  const view: ViewComponent[] = [];
  const groupName = (id: string) => app.config.agents.groups.find(g => g.id === id)?.name ?? id;
  for (const id of changed) {
    const before = policyScope(app, undefined, undefined, { class: id })!;
    const after = policyScope(proposed, undefined, undefined, { class: id })!;
    const rule = policy.classes[id]!;
    const affected = history.filter(h => h.class === id && !policyReason(before, h.ai) && policyReason(after, h.ai))
      .reduce((total, h) => total + h.count, 0);
    view.push({ type: "callout", tone: "info", title: runClasses[id].name, text: `近 7 天有 ${affected} 次选择的 AI 将被移出范围。` });
    const settings = [];
    if (JSON.stringify(before.use) !== JSON.stringify(after.use)) settings.push({ label: "可选范围", value: rule.use.map(groupName).join(" → ") || "不限组" });
    if (before.order !== after.order) settings.push({ label: "顺序", value: rule.order === "fixed" ? "按组的先后" : "由决策模型选择" });
    if (before.strict !== after.strict) settings.push({ label: "范围内均不可用时", value: rule.strict ? "排队等待" : "沿用普通兜底设置" });
    if (settings.length) view.push({ type: "fields", items: settings });
    for (const selector of rule.deny) {
      const single = { ...after, use: [], deny: [{ selector, rule: "" }] };
      const matches = catalog.filter(ai => policyReason(single, ai))
        .map(ai => [ai.id, ai.model, selector.startsWith("ai:") ? ai.effort : undefined].filter(Boolean).join(" · "));
      const labels = [...new Set(matches)];
      view.push({ type: "fold", title: `不用 ${selectorText(app, selector, catalog)}（${labels.length} 项）`, text: labels.map(label => "- " + label).join("\n") || "当前没有匹配的 AI", open: labels.length <= 3 });
    }
    const removed = (app.config.agents.policy.classes[id]?.deny ?? []).filter(s => !rule.deny.includes(s));
    if (removed.length) view.push({ type: "markdown", text: "取消排除：" + removed.map(s => selectorText(app, s, catalog)).join("、") });
  }
  if (!changed.size) view.push({ type: "markdown", text: "没有可保存的规则变更。" });
  if (draft.unmatched.length) view.push({ type: "callout", tone: "warning", title: "这些要求没有对应的设置", text: draft.unmatched.map(s => "- " + s).join("\n") });
  return { view, changed };
}

const FAMILY_NAMES: Record<string, string> = {
  google: "Gemini", anthropic: "Claude", openai: "GPT", deepseek: "DeepSeek", doubao: "豆包", qwen: "通义千问",
  zhipu: "GLM", moonshot: "Kimi", xai: "Grok", meta: "Llama", mistral: "Mistral", minimax: "MiniMax",
};
/** A deny selector the way the settings page says it (web/src/lib/ai-policy.ts selectorText): the owner reads the card, not the rule syntax. */
export function selectorText(app: App, selector: string, catalog: PolicyAI[]) {
  const at = selector.indexOf(":");
  const type = selector.slice(0, at);
  const value = selector.slice(at + 1).trim();
  if (type === "backend") {
    const same = catalog.filter(p => matchesSelector(selector, p));
    const best = same.find(p => !p.keyRef && !p.peer && !/-cli$/.test(p.id)) ?? same[0];
    const name = best && allProfiles(app.config).find(p => p.id === best.id)?.name;
    return `${name || best?.id || value}（全部模型）`;
  }
  if (type === "model") {
    const family = modelFamily({ model: value }) ?? value;
    return `${FAMILY_NAMES[family] ?? value} 系列模型`;
  }
  if (type === "ai") return value;
  if (type === "key") return `API key「${app.config.ai.providers.find(k => k.id === value)?.name || value}」生成的后端`;
  return selector;
}

export function submitPolicyDraft(app: App, runId: string, draft: Draft) {
  const r = getRun(app, runId);
  if (r.kind !== "ai-policy-draft" || runUser(app, r.id) !== OWNER) throw new HttpError(403, "只有本人的规则起草运行可以提交草稿");
  if (r.output.askId) return String(r.output.askId);
  checkRevision(app.config, r.output.revision);
  const { view, changed } = preview(app, draft);
  const text = String(r.input.text);
  const labels = [...(changed.size ? ["确认"] : []), "改一下", "不改"];
  return withinTx(app.db, () => {
    const ask = createAsk(app, { runId, conversationId: null, userId: OWNER,
      question: text,
      options: labels.map(label => ({ label })), allowText: false,
      ui: { view, head: { title: "AI 规则预览", tag: { text: "待确认", tone: "warning" } } },
      context: { handler: "ai-policy-proposal", text, draft, revision: r.output.revision },
    });
    setRunOutput(app, runId, { askId: ask.id });
    return ask.id;
  });
}

registerAskAction("ai-policy-proposal", (app, ask, ctx) => {
  if (ask.userId !== OWNER || ask.answeredBy !== OWNER) throw new HttpError(403, "只有本人可以处理 AI 规则提案");
  const choice = ask.options[ask.choice ?? -1]?.label;
  if (choice === "不改") return "已保留原规则。";
  const text = policyText.parse(ctx.text);
  if (choice === "改一下") {
    createAsk(app, { runId: ask.runId, conversationId: null, userId: OWNER, allowText: false, question: "把希望采用的完整规则再写一遍。\n\n原话：" + text,
      ui: { fields: [{ id: "text", type: "textarea", label: "修改后的规则", required: true, ...(text.length <= 4000 ? { default: text } : {}) }], submitLabel: "重新预览" },
      context: { handler: "ai-policy-revise" } });
    return "已打开修改卡，提交后会生成新预览。";
  }
  if (choice !== "确认") throw new HttpError(400, "请选择如何处理这份提案");
  // Include another process's settings changes before checking the preview and applying its delta.
  const current = prepareConfigSave(app.config, app.home).candidate;
  checkRevision(current, ctx.revision);
  const { policy, changed } = applyDraft(current, draftSchema.parse(ctx.draft));
  const at = now();
  for (const id of changed) policy.classes[id]!.said.push({ text, at });
  const next = { ...current, agents: { ...current.agents, policy } };
  saveConfig(next, app.home, candidate => validatePolicy({ config: candidate }, candidate.agents.policy));
  Object.assign(app.config, next);
  audit(app, OWNER, "settings.update", "settings", { changes: { ai: ["agents.policy"] }, askId: ask.id });
  return "已保存 AI 规则和你的原话。";
});

registerAskAction("ai-policy-revise", (app, ask) => {
  if (ask.userId !== OWNER || ask.answeredBy !== OWNER) throw new HttpError(403, "只有本人可以修改这份提案");
  startPolicyDraft(app, policyText.parse(ask.value?.text ?? ask.answer), ask.runId);
  return "已提交修改后的原话，等强组生成新预览。";
});
