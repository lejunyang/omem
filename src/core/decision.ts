import type { App } from "./app.ts";
import { baseOf, categoryStatus, clefModel, decisionStatus, decisionStatuses, type CategoryStatus, type DecisionChoice, type DecisionMedia, keyOf } from "./ai-keys.ts";

/**
 * The decision model (docs/v2/ai-models.md): bounded judgments — one of a few options, or yes/no —
 * with a probability for each, from whichever API settings → AI → 决策 names. The three APIs differ
 * in shape; this turns one question into each and reads the answer back:
 *
 * - OpenAI Decisions (`POST {base}/decisions`): `input` + `questions: [{type, name, instructions,
 *   choices: [{value, description}]}]`, yes/no as `predicate`; answers is an array.
 * - Jev (TypeSafe and OpenRouter, `POST …/v1/systemone`): `state` + `questions: {id: {type,
 *   instructions, criteria: {option: description}}}`, yes/no as `noul`; answers keyed by id.
 * - Clef (Cloudflare Workers AI, `POST …/accounts/<账号>/ai/run/@cf/cloudflare/<模型>`): Jev's shape,
 *   `model` is the short selector (clef-flash / clef / clef-omni), the answer may come wrapped in
 *   Cloudflare's `{result, success}`. Clef and Clef-flash also read `images`; Clef-omni `audio` and
 *   `videos` too (data URLs, `DecisionInput.media`).
 * - StartLux-Decision (the local judge, same shape as Jev): yes/no asked as a two-way choice, which
 *   the evaluation found more reliable for it (docs/v2/judge-models.md).
 *
 * Decision models give no reasons: the "reason" a caller records is the choice and its probability.
 */
export type DecisionQuestion =
  | { type: "choice"; instructions: string; options: Record<string, string> }
  | { type: "yesno"; instructions: string; yes?: string; no?: string };
export type DecisionResult = { choice: string; probabilities: Record<string, number>; confidence: number | null; by: string };
export class DecisionRefused extends Error {}
/** Pictures, sound or video to judge along with the material: data URLs (`data:image/png;base64,…`). */
export type DecisionMediaInput = Partial<Record<DecisionMedia, string[]>>;

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
/** Tests replace the network. */
export function setDecisionFetchForTests(f: Fetch | null) {
  fetcher = f ?? ((...a) => fetch(...a));
}

/** Whether a decision model is configured and usable now. */
export function decisionReady(app: App) {
  return categoryStatus(app.config, "decision", app.home).ready;
}

const MEDIA_LABEL: Record<DecisionMedia, string> = { images: "图片", audio: "音频", videos: "视频" };
const yesNoOptions = (q: Extract<DecisionQuestion, { type: "yesno" }>) => ({ yes: q.yes || "是", no: q.no || "否" });

type Usable = CategoryStatus & DecisionChoice;
/** A decision model that just failed is asked after the others for this long, not first on every call. */
const COOL_MS = 5 * 60_000;
const down = new Map<string, number>();
const choiceKey = (c: DecisionChoice) => `${c.provider}\n${c.model}`;
/** Tests start from a clean slate. */
export function resetDecisionCooldownForTests() {
  down.clear();
}

/**
 * The usable decision models in the order a call asks them. Settings name one or several
 * (`ai.decision`): `fixed` keeps their order, `random` puts any one of them first. One that failed
 * in the last few minutes goes to the back whichever way.
 */
export function decisionOrder(app: App, rand: () => number = Math.random): Usable[] {
  const ready = decisionStatuses(app.config, app.home).filter((s) => s.ready);
  let order = ready;
  if (app.config.ai.decision.pick === "random" && ready.length > 1) {
    const first = ready[Math.min(ready.length - 1, Math.floor(rand() * ready.length))];
    order = [first, ...ready.filter((s) => s !== first)];
  }
  const t = Date.now();
  const isDown = (s: Usable) => (down.get(choiceKey(s)) ?? 0) > t;
  return [...order.filter((s) => !isDown(s)), ...order.filter(isDown)];
}

/**
 * Ask the decision model. `material` is what to judge (text, or an object of named parts); null when
 * no decision model is configured. With several configured, one that fails or refuses is passed over
 * and the next is asked; throws when none of them answers. `only`: ask this one and no other (trying
 * one out from settings, whether or not it is among the configured ones).
 */
export async function decide(app: App, material: string | Record<string, unknown>, q: DecisionQuestion, opts: { timeoutMs?: number; signal?: AbortSignal; media?: DecisionMediaInput; only?: DecisionChoice } = {}): Promise<DecisionResult | null> {
  const order = opts.only ? [decisionStatus(app.config, opts.only, app.home)].filter((s) => s.ready) : decisionOrder(app);
  if (!order.length) return null;
  const media = Object.fromEntries(Object.entries(opts.media ?? {}).filter(([, v]) => v?.length)) as DecisionMediaInput;
  // Judging without the picture would answer a different question: only the ones that read it are asked.
  const wanted = Object.keys(media) as DecisionMedia[];
  const able = order.filter((s) => wanted.every((k) => s.media?.includes(k)));
  if (!able.length) throw new Error(`决策模型（${order.map((s) => s.detail).join("、")}）不读${wanted.filter((k) => !order.some((s) => s.media?.includes(k))).map((k) => MEDIA_LABEL[k]).join("、") || wanted.map((k) => MEDIA_LABEL[k]).join("、")}`);
  // With others to fall back on, a hung one is not waited out in full.
  const each = able.length > 1 ? Math.min(opts.timeoutMs ?? 30_000, 15_000) : (opts.timeoutMs ?? 30_000);
  const passed: string[] = [];
  let last: unknown;
  for (const s of able) {
    try {
      const r = await ask(app, s, material, q, AbortSignal.any([AbortSignal.timeout(each), ...(opts.signal ? [opts.signal] : [])]), media);
      down.delete(choiceKey(s));
      return passed.length ? { ...r, by: `${r.by}；${passed.join("、")}没答上，换了一个` } : r;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      last = e;
      passed.push(s.detail);
      // A refusal is about this question; anything else about the model: keep it out of the way for a while.
      if (!(e instanceof DecisionRefused)) down.set(choiceKey(s), Date.now() + COOL_MS);
    }
  }
  throw last;
}

async function ask(app: App, s: Usable, material: string | Record<string, unknown>, q: DecisionQuestion, signal: AbortSignal, media: DecisionMediaInput): Promise<DecisionResult> {
  if (s.provider === "startlux") return startlux(app, material, q, signal);
  const p = app.config.ai.providers.find((x) => x.id === s.provider)!;
  const key = keyOf(p.id, app.home);
  const by = `${p.name || p.id} · ${s.model}`;
  if (p.kind === "openai") return { ...(await openaiDecide(baseOf(p), key, s.model, material, q, signal)), by };
  if (p.kind === "cloudflare") {
    const model = clefModel(s.model);
    return { ...(await systemOne(`${baseOf(p)}/run/@cf/cloudflare/${model}`, { authorization: `Bearer ${key}` }, model, material, q, signal, false, media)), by };
  }
  return { ...(await systemOne(`${baseOf(p)}/v1/systemone`, { authorization: `Bearer ${key}` }, s.model, material, q, signal)), by };
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const r = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  const text = await r.text();
  if (!r.ok) throw new Error(`决策模型返回 ${r.status}：${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`决策模型返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

const best = (probs: Record<string, number>) => Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

async function openaiDecide(base: string, key: string, model: string, material: string | Record<string, unknown>, q: DecisionQuestion, signal: AbortSignal): Promise<Omit<DecisionResult, "by">> {
  const input = typeof material === "string" ? material : [{ role: "user", content: [{ type: "input_json", data: material }] }];
  const question =
    q.type === "yesno"
      ? { type: "predicate", name: "q", instructions: q.instructions }
      : { type: "choice", name: "q", instructions: q.instructions, choices: Object.entries(q.options).map(([value, description]) => ({ value, description })) };
  const body = await post(`${base}/decisions`, { authorization: `Bearer ${key}` }, { model, input, questions: [question] }, signal);
  const a = (body.answers ?? []).find((x: { name?: string }) => x.name === "q") ?? body.answers?.[0];
  if (!a || a.type === "refusal") throw new DecisionRefused("决策模型拒绝回答这个问题");
  if (q.type === "yesno") {
    const y = Number(a.probability);
    if (!Number.isFinite(y)) throw new Error("决策模型的回答里没有概率");
    return { choice: y >= 0.5 ? "yes" : "no", probabilities: { yes: y, no: 1 - y }, confidence: null };
  }
  const probabilities = Object.fromEntries(((a.probabilities ?? []) as { value: string; probability: number }[]).map((x) => [String(x.value), Number(x.probability)]));
  return { choice: String(a.choice ?? best(probabilities)), probabilities, confidence: typeof a.confidence === "number" ? a.confidence : null };
}

/** Jev's System One shape (TypeSafe, OpenRouter, Clef, StartLux). `model` empty for StartLux. */
async function systemOne(url: string, headers: Record<string, string>, model: string, material: string | Record<string, unknown>, q: DecisionQuestion, signal: AbortSignal, yesNoAsChoice = false, media: DecisionMediaInput = {}): Promise<Omit<DecisionResult, "by">> {
  let question: Record<string, unknown>;
  if (q.type === "yesno" && !yesNoAsChoice) {
    const o = yesNoOptions(q);
    question = { type: "noul", instructions: q.instructions, criteria: { true: o.yes, false: o.no } };
  } else if (q.type === "yesno") {
    const o = yesNoOptions(q);
    question = { type: "choice", instructions: q.instructions, criteria: { yes: o.yes, no: o.no } };
  } else {
    question = { type: "choice", instructions: q.instructions, criteria: q.options };
  }
  const raw = await post(url, headers, { ...(model ? { model } : {}), state: material, ...media, questions: { q: question } }, signal);
  // Cloudflare's REST API wraps the body in {result, success, errors}.
  const body = raw?.answers ? raw : (raw?.result ?? raw);
  const a = body?.answers?.q;
  if (!a || a.type === "refusal") throw new DecisionRefused("决策模型拒绝回答这个问题");
  if (a.type === "noul") {
    const y = Number(a.noul);
    if (!Number.isFinite(y)) throw new Error("决策模型的回答里没有概率");
    return { choice: y >= 0.5 ? "yes" : "no", probabilities: { yes: y, no: 1 - y }, confidence: null };
  }
  const probabilities = Object.fromEntries(Object.entries((a.probabilities ?? {}) as Record<string, number>).map(([k, v]) => [k, Number(v)]));
  return { choice: String(a.choice ?? best(probabilities)), probabilities, confidence: typeof a.confidence === "number" ? a.confidence : null };
}

async function startlux(app: App, material: string | Record<string, unknown>, q: DecisionQuestion, signal: AbortSignal): Promise<DecisionResult> {
  const { judgeDone, judgeUrl } = await import("../sources/judge.ts");
  try {
    const url = await judgeUrl(app);
    // The local server reads `state` as an object of named parts.
    const state = typeof material === "string" ? { material } : material;
    const r = await systemOne(`${url.replace(/\/$/, "")}/v1/systemone`, {}, "", state, q, signal, true);
    return { ...r, by: "StartLux-Decision（本机）" };
  } finally {
    judgeDone(app);
  }
}

/** One line for a run or a rule firing: "决策模型（Jev · jev-latest）：是 0.91". */
export function describeDecision(r: DecisionResult, labels: Record<string, string> = { yes: "是", no: "否" }) {
  const p = r.probabilities[r.choice];
  return `决策模型（${r.by}）：${labels[r.choice] ?? r.choice}${Number.isFinite(p) ? ` ${p.toFixed(2)}` : ""}`;
}

export type YesNo = { yes: boolean; reason: string; by: "decision" | "general" };

/**
 * A yes/no judgment that prefers the decision model: used when `preferDecision` and one is
 * configured; otherwise, or when it fails and settings say to fall back, the general model
 * (`general`, the caller's own prompt). With fallback "none" a failure counts as no.
 */
export async function judgeYesNo(
  app: App,
  o: { preferDecision: boolean; instructions: string; material: string | Record<string, unknown>; yes?: string; no?: string; general: () => Promise<{ yes: boolean; reason: string } | null>; signal?: AbortSignal },
): Promise<YesNo | null> {
  const viaGeneral = async (prefix = "") => {
    const v = await o.general();
    return v ? { ...v, reason: prefix + v.reason, by: "general" as const } : null;
  };
  if (!o.preferDecision || !decisionReady(app)) return viaGeneral();
  try {
    const r = await decide(app, o.material, { type: "yesno", instructions: o.instructions, yes: o.yes, no: o.no }, { signal: o.signal });
    if (r) return { yes: r.choice === "yes", reason: describeDecision(r), by: "decision" };
  } catch (e) {
    const why = (e as Error).message.slice(0, 200);
    if (app.config.ai.decision.fallback === "general") return viaGeneral(`决策模型出错（${why}），改用通用模型：`);
    return { yes: false, reason: `决策模型出错（${why}），按否处理`, by: "decision" };
  }
  return viaGeneral();
}
