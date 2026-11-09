import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { decide, decisionReady, describeDecision } from "../core/decision.ts";
import { truncate } from "../core/util.ts";
import { choosableProfiles, downReason, excluded, limitOf, usedOf } from "./capacity.ts";
import { jsonIn } from "./oneshot.ts";
import { quotaView } from "./quota.ts";

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

const label = (c: AiPick) => [c.profile, c.model, c.effort].filter(Boolean).join(" · ");

/** The owner's candidates as profiles, installed and not left out (limit 0, quota spent). */
export function candidateProfiles(app: App): (AgentProfile & { when: string })[] {
  const r = app.config.agents.routing;
  if (!r.automatic) return [];
  const usable = new Set(choosableProfiles(app).map((p) => p.id));
  const specs = allProfiles(app.config);
  return r.candidates.flatMap((c) => {
    const p = specs.find((x) => x.id === c.profile);
    if (!p || !usable.has(p.id)) return [];
    const out = { ...p, model: c.model ?? p.model, effort: c.effort ?? (c.model && c.model !== p.model ? undefined : p.effort), when: c.when };
    return excluded(app, out) ? [] : [out];
  });
}

/** What the chooser knows about one option right now: load, plan quota, a recent breakdown. */
function state(app: App, p: AgentProfile) {
  const parts = [`正在用 ${usedOf(app, p)}/${limitOf(app, p)}`];
  const q = quotaView(app, p);
  if (q?.windows.length) parts.push(`额度 ${q.windows.map((w) => `${w.name}${w.model ? `(${w.model})` : ""} 已用 ${w.used}%${w.perDayLeft !== undefined ? `、每天约 ${w.perDayLeft}%` : ""}`).join("；")}`);
  if (q?.avoid) parts.push(`快用完了：${q.avoid}`);
  const down = downReason(app, p);
  if (down) parts.push(`刚出过故障：${truncate(down, 80)}`);
  return parts.join("，");
}

/**
 * The AI this run should use, or null to keep its own. `current` is what the run would use
 * otherwise (its profile, role or Agent 档案 setting). Never throws: a chooser that fails leaves the
 * run on its own AI, and the reason goes to `onStatus`.
 */
export async function chooseAI(
  app: App,
  o: { scene: ChooseScene; task: string; who: string; current: AgentProfile; signal?: AbortSignal; onStatus?: (text: string) => void },
): Promise<AiChoice | null> {
  const r = app.config.agents.routing;
  const mode = r.automatic ? r.choose[o.scene] : "off";
  if (mode === "off") return null;
  if (!r.candidates.length) return null;
  const useDecision = decisionReady(app);
  if (!useDecision && mode !== "always") return null;
  const same = (p: AiPick) => p.profile === o.current.id && (p.model ?? "") === (o.current.model ?? "") && (p.effort ?? "") === (o.current.effort ?? "");
  const others = candidateProfiles(app).filter((c) => !same({ profile: c.id, model: c.model, effort: c.effort }));
  if (!others.length) return null;
  const opts: Record<string, { pick: AiPick | null; text: string }> = {
    keep: { pick: null, text: `按原来的设置用 ${label({ profile: o.current.id, model: o.current.model, effort: o.current.effort })}（${state(app, o.current)}）` },
  };
  others.forEach((c, i) => {
    opts[`c${i + 1}`] = { pick: { profile: c.id, model: c.model, effort: c.effort }, text: `${label({ profile: c.id, model: c.model, effort: c.effort })}：${c.when}（${state(app, c)}）` };
  });
  const now = new Date().toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const material = {
    任务: truncate(o.task, 4000),
    由谁做: o.who,
    现在: now,
    ...(r.guidance.trim() ? { 本人的总体偏好: r.guidance.trim() } : {}),
  };
  const instructions = "为这个任务选用哪个 AI。按本人的偏好和每个候选写的适用场景对照任务和现在的时间；同样合适时选空闲的、额度宽裕的，不选快用完和刚出过故障的；拿不准就按原来的设置。";
  const done = (key: string, reason: string): AiChoice | null => {
    const pick = opts[key]?.pick;
    return pick ? { ...pick, reason } : null;
  };
  if (useDecision) {
    try {
      const d = await decide(app, material, { type: "choice", instructions, options: Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v.text])) }, { signal: o.signal, timeoutMs: 20_000 });
      if (d) return done(d.choice, describeDecision(d, Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v.pick ? label(v.pick) : "按原来的设置"]))));
    } catch (e) {
      const why = (e as Error).message.slice(0, 160);
      if (mode !== "always") {
        o.onStatus?.(`决策模型选 AI 出错（${why}），按原来的设置`);
        return null;
      }
      o.onStatus?.(`决策模型选 AI 出错（${why}），改由通用模型选`);
    }
  }
  const { askModel } = await import("./oneshot.ts");
  const prompt = [
    `${instructions}只输出 JSON：{"choice": "选项的键", "reason": "一句中文理由"}。`,
    "",
    ...Object.entries(material).map(([k, v]) => `${k}：${v}`),
    "",
    "选项：",
    ...Object.entries(opts).map(([k, v]) => `- ${k}：${v.text}`),
  ].join("\n");
  const v = jsonIn<{ choice?: string; reason?: string }>(await askModel(app, prompt, { timeoutMs: 60_000, signal: o.signal }).catch(() => null));
  if (!v?.choice || !opts[v.choice]) {
    o.onStatus?.("通用模型没有给出可用的选择，按原来的设置");
    return null;
  }
  return done(v.choice, `通用模型：${truncate(String(v.reason ?? ""), 120)}`);
}

export const aiLabel = label;
