import { groupItems, policyScope, policyReason, scopedProfiles, pickOf, type PolicyScope } from "./ai-policy.ts";
import { runClasses, type RunClass } from "./run-classes.ts";
import { modelDisplayName } from "../core/ai-keys.ts";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { decide, decisionReady, describeDecision } from "../core/decision.ts";
import { truncate } from "../core/util.ts";
import { choosableProfiles, downReason, excluded, excludedReason, limitOf, perDayOf, usedOf, usedToday } from "./capacity.ts";
import { probeFor } from "./probe.ts";
import { isAiMember, memberAccountPlan, selectedMemberAccount } from "./accounts.ts";
import { memberAi } from "./member-ai.ts";
import { jsonIn } from "./oneshot.ts";
import { quotaAvoid, quotaView } from "./quota.ts";

/**
 * Choosing the AI for a run before it starts, the same way for every kind of run: the owner's
 * candidates (settings → AI → 任务选型, each with what it suits) plus the run's own AI, judged
 * against the task, the time, each model's load and each account's plan quota.
 *
 * Who chooses, per kind of run (`routing.choose`): the decision model when one is configured (a
 * second or so, docs/v2/ai-models.md); with `always`, the general model when there is none. With no
 * candidates, or choice off, the run keeps its own AI. Whatever is chosen goes first and the run's
 * own AI and fallbacks follow it (runner.ts failoverProfiles), so a wrong pick costs no more than
 * the run would have anyway.
 */
export type ChooseScene = "conversation" | "rules" | "tasks";
export type AiPick = { profile: string; model?: string; effort?: string };
export type AiChoice = AiPick & { reason: string };
/**
 * Where an order of AIs came from: the decision model or the general model weighing the owner's
 * routing notes (总体偏好, each candidate's 适用说明), or the static order of the settings (the
 * role's other backends, the fallbacks, the candidates as listed) when there is no model to ask.
 */
export type OrderSource = "decision" | "general" | "static";
export const ORDER_LABEL: Record<OrderSource, string> = { decision: "决策模型按选型说明排的顺序", general: "通用模型按选型说明排的顺序", static: "设置里的静态顺序（没有决策模型时）" };
/**
 * The chooser's answer: the AI to start on (null: the run's own) and the order to go on in when it
 * cannot finish — every option ranked, so moving on follows the owner's notes too, without asking again.
 */
export type ChooseResult = { pick: AiChoice | null; order: AgentProfile[]; by: OrderSource; reason: string };
/**
 * What the choice was, for the run's record (a status event with `choice`): whether choosing ran,
 * what it was offered, who chose and why, the order it ranked them in — or why it did not run at
 * all — so the owner can see whether the setting does anything.
 */
export type ChoiceRecord = {
  class?: RunClass;
  ai?: AiPick;
  scope?: string[];
  excluded?: string[];
  deny?: string[];
  said?: string[];
  scene: ChooseScene;
  /** chosen: another AI; kept: the chooser kept the run's own; skipped: choosing did not run; failed: the chooser failed. */
  outcome: "chosen" | "kept" | "skipped" | "failed";
  current: string;
  picked?: string;
  by?: string;
  reason: string;
  options?: string[];
  /** The options as ranked: the first is used, the others in turn when it cannot finish. */
  order?: string[];
  left?: string[];
};

// An endpoint ID is shown as the model behind it (core/ai-keys.ts modelDisplayName).
const label = (c: AiPick) => [c.profile, c.model && modelDisplayName(c.model), c.effort].filter(Boolean).join(" · ");

type Candidate = { profile: string; model?: string; effort?: string; when: string };
/**
 * What the owner wrote for a candidate: settings → AI keeps one line for the backend (no model) and
 * optional lines for its models. A model's line is read together with its backend's.
 */
export function candidateWhen(list: Candidate[], c: Candidate) {
  if (!c.model) return c.when;
  const backend = list.find((x) => x.profile === c.profile && !x.model)?.when.trim();
  return backend ? `${backend}；${c.model}：${c.when}` : c.when;
}

export function routingCandidates(app: App): Candidate[] {
  return groupItems(app, "candidates").map(({ note, ...p }) => ({ ...p, when: note ?? "" }));
}

/** The owner's candidates as profiles, installed and not left out (limit 0, quota spent, daily cap); why the others were left out goes to `left`. */
export function candidateProfiles(app: App, left?: string[], userId?: string): (AgentProfile & { when: string })[] {
  const r = app.config.agents.routing;
  if (!r.automatic) return [];
  const usable = new Set(choosableProfiles(app).map((p) => p.id));
  const specs = allProfiles(app.config);
  const candidates = routingCandidates(app);
  return candidates.flatMap((c) => {
    const p = specs.find((x) => x.id === c.profile);
    if (!p || !usable.has(p.id)) return [];
    // An empty model or effort in the settings means the backend's own (not a model named "").
    const model = c.model || undefined;
    const out = { ...p, model: model ?? p.model, effort: c.effort || (model && model !== p.model ? undefined : p.effort), when: candidateWhen(candidates, c) };
    const plan = userId ? memberAccountPlan(app, userId, out) : null;
    const reason = plan && plan.kind !== "ready" ? plan.reason : excludedReason(app, plan?.profile ?? out);
    if (!reason) return [out];
    left?.push(`${label({ profile: out.id, model: out.model, effort: out.effort })}：${reason}`);
    return [];
  });
}

/** What the chooser knows about one option right now: load, plan quota, a recent breakdown. */
function state(app: App, p: AgentProfile) {
  const parts = [`正在用 ${usedOf(app, p)}/${limitOf(app, p)}`];
  const q = quotaView(app, p);
  if (q?.windows.length) parts.push(`额度 ${q.windows.map((w) => `${w.name}${w.model ? `(${w.model})` : ""} 已用 ${w.used}%${w.perDayLeft !== undefined ? `、每天约 ${w.perDayLeft}%` : ""}`).join("；")}`);
  if (q?.avoid) parts.push(`快用完了：${q.avoid}`);
  const cap = perDayOf(app, p);
  if (cap !== undefined) parts.push(`今天已用 ${usedToday(app, p)}/${cap} 次`);
  const note = p.model ? probeFor(app, p)?.modelNotes?.[p.model] : undefined;
  if (note) parts.push(`后端对这个模型的说明：${truncate(note, 120)}`);
  const down = downReason(app, p);
  if (down) parts.push(`刚出过故障：${truncate(down, 80)}`);
  return parts.join("，");
}

/** Keys of the options, the most likely first (ties keep their place). */
function ranked(keys: string[], probabilities: Record<string, number>, first?: string) {
  const p = (k: string) => (k === first ? Infinity : probabilities[k] ?? -1);
  return keys.map((k, i) => ({ k, i })).sort((a, b) => p(b.k) - p(a.k) || a.i - b.i).map((x) => x.k);
}

/**
 * The AI this run should use and the order to go on in, or null when choosing did not run or
 * failed (the run keeps its own AI and the static order). `current` is what the run would use
 * otherwise (its profile, role or Agent 档案 setting). Never throws. Every outcome — chosen, kept,
 * not run and why — goes to `onRecord` for the run.
 */
export async function chooseAI(
  app: App,
  o: { scope?: PolicyScope; runId?: string; scene: ChooseScene; task: string; who: string; current: AgentProfile; accepts?: (profile: AgentProfile) => boolean; userId?: string; signal?: AbortSignal; onStatus?: (text: string) => void; onRecord?: (r: ChoiceRecord) => void },
): Promise<ChooseResult | null> {
  const r = app.config.agents.routing;
  const current = label({ profile: o.current.id, model: o.current.model, effort: o.current.effort });
  const scope = "scope" in o ? o.scope : policyScope(app, o.scene === "conversation" ? "ask" : undefined, o.who);
  const rejected: string[] = [];
  const accept = (p: AgentProfile) => {
    const why = policyReason(scope, p);
    if (why) rejected.push(label(pickOf(p)) + "（" + why + "）");
    return !why && (!o.accepts || o.accepts(p));
  };
  const record = (x: Omit<ChoiceRecord, "scene" | "current">) => o.onRecord?.({ scene: o.scene, current, ai: pickOf(o.current), ...(scope && { class: scope.classId, scope: scope.groups.map(g => g.name), deny: scope.deny.map(d => d.selector), said: scope.said, excluded: [...new Set(rejected)] }), ...x });
  const skip = (reason: string) => {
    record({ outcome: "skipped", reason });
    return null;
  };
  if (scope && (scope.use.length || scope.deny.length || scope.order === "fixed" || ["coding", "review"].includes(scope.classId))) {
    const candidates = [o.current, ...candidateProfiles(app, undefined, o.userId)];
    candidates.forEach(accept);
    const order = scopedProfiles(app, scope, candidates, true).filter(accept);
    if (!order.length) return skip("没有符合范围的 AI");
    const reason = scope.use.length ? "按组的先后" : "按范围内的默认先后";
    const pick = pickOf(order[0]);
    record({ outcome: "chosen", ai: pick, picked: label(pick), by: "设置", reason, order: order.map(p => label(pickOf(p))) });
    return { pick: { ...pick, reason }, order, reason, by: "static" };
  }
  if (!r.automatic) return skip("设置里关了“允许按任务自动选择 AI”");
  const mode = r.choose[o.scene];
  if (mode === "off") return skip(`这类运行（${SCENE[o.scene]}）设成了“不选”`);
  if (!routingCandidates(app).length) return skip("任务选型里没有候选");
  const useDecision = decisionReady(app);
  if (!useDecision && mode !== "always") return skip("没有配置决策模型（设置 → 后端与模型 → 决策），这类运行只在有决策模型时选");
  const same = (p: AiPick) => p.profile === o.current.id && (p.model ?? "") === (o.current.model ?? "") && (p.effort ?? "") === (o.current.effort ?? "");
  // Options the run would not get anyway are not offered: left out (limit 0, quota spent, daily cap)
  // or set aside when a slot is taken (nearly spent, just broke down), so a pick is not overruled after
  // the fact. The run's own AI is always an option; when it is nearly spent its line says so.
  const left: string[] = [];
  // A member's run: their own account where they are logged in (its quota, its models), and no
  // backend the owner keeps to own accounts that they have not logged in to (agents/accounts.ts).
  const member = o.userId && isAiMember(app, o.userId) ? o.userId : undefined;
  const guidance = memberAi(app, member).guidance;
  const status = (p: AgentProfile) => {
    const plan = member ? memberAccountPlan(app, member, p) : null;
    if (plan && plan.kind !== "ready") return plan.reason;
    const effective = plan?.profile ?? p;
    return [selectedMemberAccount(effective)?.reason, state(app, effective)].filter(Boolean).join("，");
  };
  const others = candidateProfiles(app, left, member).filter((c) => {
    if (same({ profile: c.id, model: c.model, effort: c.effort })) return false;
    if (o.accepts && !o.accepts(c)) {
      left.push(`${c.id}：本次任务需要 omem 工具`);
      return false;
    }
    const plan = member ? memberAccountPlan(app, member, c) : null;
    if (plan && plan.kind !== "ready") return false;
    const effective = plan?.profile ?? c;
    const down = downReason(app, effective);
    const why = quotaAvoid(app, effective) ?? (down ? `刚出过故障：${truncate(down, 60)}` : null);
    if (why) left.push(`${label({ profile: c.id, model: c.model, effort: c.effort })}：${why}`);
    return !why;
  });
  if (!others.length) {
    record({ outcome: "skipped", reason: `除了原来的 ${current}，没有现在能用的候选`, ...(left.length ? { left } : {}) });
    return null;
  }
  const strip = ({ when: _, ...p }: AgentProfile & { when: string }) => p as AgentProfile;
  const opts: Record<string, { pick: AiPick | null; profile: AgentProfile; text: string }> = {
    keep: { pick: null, profile: o.current, text: `按原来的设置用 ${current}（${status(o.current)}）` },
  };
  if (o.accepts && !o.accepts(o.current)) {
    delete opts.keep;
    left.push(`${current}：本次任务需要 omem 工具`);
  }
  others.forEach((c, i) => {
    opts[`c${i + 1}`] = { pick: { profile: c.id, model: c.model, effort: c.effort }, profile: strip(c), text: `${label({ profile: c.id, model: c.model, effort: c.effort })}：${c.when}（${status(c)}）` };
  });
  const keys = Object.keys(opts);
  const options = Object.values(opts).map((v) => truncate(v.text, 200));
  const now = new Date().toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const material = {
    任务: truncate(o.task, 4000),
    由谁做: o.who,
    现在: now,
    ...(r.guidance.trim() ? { 本人的总体偏好: r.guidance.trim() } : {}),
    ...(guidance ? { 成员的选型偏好: guidance } : {}),
  };
  const instructions = "为这个任务选用哪个 AI，并排出先后（选中的用不了时按这个顺序换）。按本人的偏好" +
    (guidance ? "、成员写的选型偏好" : "") +
    "和每个候选的适用场景对照任务和时间。同样合适时选空闲、额度宽裕、已能运行的，快用完和刚出过故障的排到后面。拿不准就按原来的设置。";
  const nameOf = (k: string) => (opts[k].pick ? label(opts[k].pick!) : `原来的 ${current}`);
  const done = (order: string[], reason: string, by: OrderSource): ChooseResult => {
    const pick = opts[order[0]].pick;
    record({ outcome: pick ? "chosen" : "kept", ...(pick ? { ai: pick, picked: label(pick) } : {}), by: by === "decision" ? "决策模型" : "通用模型", reason, options, order: order.map(nameOf), ...(left.length ? { left } : {}) });
    return { pick: pick ? { ...pick, reason } : null, order: order.map((k) => opts[k].profile), by, reason };
  };
  if (useDecision) {
    try {
      const d = await decide(app, material, { type: "choice", instructions, options: Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v.text])) }, { signal: o.signal, timeoutMs: 20_000 });
      if (d && opts[d.choice]) return done(ranked(keys, d.probabilities, d.choice), describeDecision(d, Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v.pick ? label(v.pick) : "按原来的设置"]))), "decision");
      if (mode !== "always") {
        record({ outcome: "failed", by: "决策模型", reason: "决策模型没有给出选择，按原来的设置", options });
        return null;
      }
    } catch (e) {
      const why = (e as Error).message.slice(0, 160);
      if (mode !== "always") {
        record({ outcome: "failed", by: "决策模型", reason: `出错：${why}`, options });
        return null;
      }
      o.onStatus?.(`决策模型选 AI 出错（${why}），改由通用模型选`);
    }
  }
  const { askModel } = await import("./oneshot.ts");
  const prompt = [
    `${instructions}只输出 JSON：{"order": ["最先用的选项键", "其次", "…"], "reason": "一句中文理由"}，每个选项键都排进去。`,
    "",
    ...Object.entries(material).map(([k, v]) => `${k}：${v}`),
    "",
    "选项：",
    ...Object.entries(opts).map(([k, v]) => `- ${k}：${v.text}`),
  ].join("\n");
  const v = jsonIn<{ order?: unknown; choice?: string; reason?: string }>(await askModel(app, prompt, { timeoutMs: 60_000, signal: o.signal, userId: o.userId, memberRouting: !!member }).catch(() => null));
  const given = [...(Array.isArray(v?.order) ? v!.order : []), v?.choice].filter((k): k is string => typeof k === "string" && !!opts[k]);
  if (!given.length) {
    record({ outcome: "failed", by: "通用模型", reason: "没有给出可用的选择，按原来的设置", options });
    return null;
  }
  const order = [...new Set([...given, ...keys])];
  return done(order, `通用模型：${truncate(String(v?.reason ?? ""), 120)}`, "general");
}

/**
 * The order to go on in for a run that did not go through the chooser (its AI was named, choosing
 * is off, no decision model for it) once its AI cannot take it: the decision model ranks what is left
 * by the owner's routing notes, once per kind of run and set of options for a while (not once per
 * failure), else the static order as it is. Never throws.
 */
const ORDER_TTL = 10 * 60_000;
const orders = new WeakMap<App, Map<string, { at: number; keys: string[]; reason: string }>>();
export async function fallbackOrder(
  app: App,
  o: { scope?: PolicyScope; scene: ChooseScene; who: string; from: AgentProfile; why: string; options: AgentProfile[]; userId?: string; signal?: AbortSignal; now?: number },
): Promise<{ order: AgentProfile[]; by: OrderSource; reason: string }> {
  const r = app.config.agents.routing;
  const scope = "scope" in o ? o.scope : policyScope(app, o.scene === "conversation" ? "ask" : undefined, o.who);
  o = { ...o, options: o.options.filter(p => !policyReason(scope, p)) };
  const keep = (reason: string) => ({ order: o.options, by: "static" as const, reason });
  if (scope?.order === "fixed" || scope?.use.length) return keep("按组的先后");
  if (o.options.length < 2) return keep("只剩一个可换的");
  const guidance = memberAi(app, o.userId).guidance;
  const candidates = routingCandidates(app);
  if (!r.automatic || (!guidance && !r.guidance.trim() && !candidates.some((c) => c.when.trim()))) return keep("没有选型说明");
  if (!decisionReady(app)) return keep("没有配置决策模型");
  const names = o.options.map((p) => label({ profile: p.id, model: p.model, effort: p.effort }));
  const key = JSON.stringify([o.scene, o.who, names, o.userId, guidance]);
  const now = o.now ?? Date.now();
  let cache = orders.get(app);
  if (!cache) { cache = new Map(); orders.set(app, cache); }
  const hit = cache.get(key);
  const byKeys = (ks: string[]) => ks.map((k) => o.options[Number(k.slice(1))]);
  if (hit && now - hit.at < ORDER_TTL) return { order: byKeys(hit.keys), by: "decision", reason: hit.reason };
  const when = (p: AgentProfile) => {
    const fits = (c: Candidate) => c.profile === p.id && (!c.effort || c.effort === p.effort);
    // The model's own line before the backend's.
    const c = candidates.find((c) => fits(c) && c.model === p.model) ?? candidates.find((c) => fits(c) && !c.model);
    return c ? candidateWhen(candidates, c) : "（不在候选里：档案的其他后端或兜底）";
  };
  const opts = Object.fromEntries(o.options.map((p, i) => [`o${i}`, `${names[i]}：${when(p)}（${state(app, p)}）`]));
  const material = {
    由谁做: o.who,
    原来的: label({ profile: o.from.id, model: o.from.model, effort: o.from.effort }),
    为什么换: truncate(o.why, 300),
    现在: new Date(now).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, weekday: "short", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    ...(r.guidance.trim() ? { 本人的总体偏好: r.guidance.trim() } : {}),
    ...(guidance ? { 成员的选型偏好: guidance } : {}),
  };
  try {
    const d = await decide(app, material, { type: "choice", instructions: "原来的 AI 现在用不了，要换一个接手。按本人的偏好、成员的选型偏好和每项适用场景排序；同样合适时选空闲的、额度宽裕的，不选快用完和刚出过故障的。", options: opts }, { signal: o.signal, timeoutMs: 20_000 });
    if (!d || !opts[d.choice]) return keep("决策模型没有给出顺序");
    const keys = ranked(Object.keys(opts), d.probabilities, d.choice);
    const reason = describeDecision(d, Object.fromEntries(Object.keys(opts).map((k, i) => [k, names[i]])));
    cache.set(key, { at: now, keys, reason });
    return { order: byKeys(keys), by: "decision", reason };
  } catch (e) {
    return keep(`决策模型出错：${(e as Error).message.slice(0, 120)}`);
  }
}

const SCENE: Record<ChooseScene, string> = { conversation: "和助手的对话", rules: "规则交给的 Agent", tasks: "交办和后台任务" };

/** One line for the run page: what the choice was, or why there was none. */
export function choiceText(r: ChoiceRecord): string {
  if (r.class) {
    const range = r.scope?.length ? r.scope.join("、") : "全部 AI";
    const scope = range + (r.deny?.length ? "（不用 " + r.deny.join("、") + "）" : "") + (r.said?.length ? "，依据「" + r.said.at(-1) + "」" : "");
    const next = r.order?.slice(1) ?? [];
    const detail = !r.scope?.length && !r.excluded?.length ? choiceText({ ...r, class: undefined }) :
      "用 " + (r.picked ?? r.current) + "（" + r.reason + "）" + (next.length ? "；用不了依次换 " + next.join("、") : "");
    return [runClasses[r.class].name + " · 范围：" + scope, detail,
    r.excluded?.length && "没进范围的：" + r.excluded.join("、")].filter(Boolean).join("\n");
  }
  const then = r.order && r.order.length > 1 ? `；用不了时依次换 ${r.order.slice(1).join("、")}` : "";
  if (r.outcome === "chosen") return `自动选 AI：${r.picked}（${r.reason}）${then}`;
  if (r.outcome === "kept") return `自动选 AI：按原来的设置用 ${r.current}（${r.reason}）${then}`;
  if (r.outcome === "failed") return `自动选 AI 没有选成，用原来的 ${r.current}（${r.by ? `${r.by}：` : ""}${r.reason}）`;
  return `没有自动选 AI，用 ${r.current}：${r.reason}`;
}

/** The record as a run event: a status line (shown like any other) carrying the details. */
export const choiceEvent = (r: ChoiceRecord) => ({ type: "status" as const, text: choiceText(r), choice: r });

export const aiLabel = label;
