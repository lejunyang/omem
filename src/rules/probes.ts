import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { addRunEvent, createRun, getRun, setRunOutput, trackAbort, type Run } from "../agents/runs.ts";
import { execScript, runtimeCommand } from "./script.ts";
import { PROBE_KEY } from "./probe-key.ts";

/**
 * 预查库 (docs/v2/first-look.md): short read-only scripts the owner keeps by name — “查这个 UID 的账号状态”,
 * “看这个接口最近的报错数” — that run before an agent looks at a message, so the fast first look (and the
 * deeper run after it) starts with the facts in hand. Each probe has a name, one line on what it finds,
 * an optional regular expression (no match on the message: the probe is skipped; its groups go to the
 * script with the event), a runtime, its code, a timeout and `direct` (what it prints may be sent as is,
 * without a model).
 *
 * The safety line is the one rules with a script have (rules/script.ts): only the owner saves or changes
 * one, since it runs on this machine. It runs the same way — execScript: a directory of its own, a small
 * environment, the command rules in front of PATH, the event as JSON on stdin and in OMEM_EVENT (never
 * pasted into the code), output capped, killed at its timeout — and every run of one is a run of kind
 * `probe` (the first look's, or the rule's, as its parent). A probe failing or timing out never stops
 * what comes after: its result says so.
 *
 * Kept in `kv` under `rule-probe:<name>` (no table of its own: a few dozen at most).
 */

const KEY = PROBE_KEY;
/** What a probe's output may bring into a model's material or a message. */
export const PROBE_TEXT_LIMIT = 4000;
export const PROBE_TIMEOUT_MAX = 120;
/** The code a proposal may carry: the card shows all of it. */
export const PROPOSAL_CODE_MAX = 12_000;

const name = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}_.-]+$/u, "名字只用文字、数字、下划线、点和短横线");
const regex = z.string().trim().max(500).refine((s) => {
  try {
    new RegExp(s, "iu");
    return true;
  } catch {
    return false;
  }
}, "匹配条件不是合法的正则表达式");

export const probeInputSchema = z.object({
  name,
  description: z.string().trim().min(1).max(200),
  match: regex.optional().transform((v) => v || undefined),
  runtime: z.enum(["node", "python", "bash"]),
  code: z.string().min(1).max(50_000),
  timeoutSec: z.number().int().min(1).max(PROBE_TIMEOUT_MAX).default(20),
  direct: z.boolean().default(false),
});
export type ProbeInput = z.input<typeof probeInputSchema>;
export type Probe = z.infer<typeof probeInputSchema> & { createdBy: string; createdAt: string; updatedAt: string; via?: string };

export function listProbes(app: App): Probe[] {
  return all<{ value: string }>(app.db, "select value from kv where key like ? order by key", `${KEY}%`).flatMap((r) => {
    try {
      return [JSON.parse(r.value) as Probe];
    } catch {
      return [];
    }
  });
}

export function getProbe(app: App, probeName: string): Probe | null {
  const row = one<{ value: string }>(app.db, "select value from kv where key = ?", KEY + probeName);
  try {
    return row ? (JSON.parse(row.value) as Probe) : null;
  } catch {
    return null;
  }
}

export function requireProbe(app: App, probeName: string) {
  const p = getProbe(app, probeName);
  if (!p) throw new HttpError(404, `没有叫「${probeName}」的预查`);
  return p;
}

/** Only the owner saves or changes a probe: its code runs on this machine. `via`: how it came (an accepted proposal). */
export function saveProbe(app: App, input: ProbeInput, actor: string, via?: string): Probe {
  if (actor !== OWNER) throw new HttpError(403, "预查只能由本人保存或修改：它的代码在这台机器上执行");
  const p = probeInputSchema.parse(input);
  runtimeCommand(p.runtime);
  const before = getProbe(app, p.name);
  const saved: Probe = { ...p, createdBy: before?.createdBy ?? actor, createdAt: before?.createdAt ?? now(), updatedAt: now(), ...(via ?? before?.via ? { via: via ?? before?.via } : {}) };
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KEY + p.name, JSON.stringify(saved));
  return saved;
}

export function deleteProbe(app: App, probeName: string, actor: string) {
  if (actor !== OWNER) throw new HttpError(403, "预查只能由本人删除");
  if (!run(app.db, "delete from kv where key = ?", KEY + probeName).changes) throw new HttpError(404, `没有叫「${probeName}」的预查`);
}

/** What a probe's regex took from the first message it matched: the whole match ("0"), numbered and named groups. */
export type Captures = Record<string, string>;
export function matchProbe(p: Pick<Probe, "match">, texts: string[]): { matched: boolean; captures: Captures; text: string | null } {
  if (!p.match) return { matched: true, captures: {}, text: texts[0] ?? null };
  const re = new RegExp(p.match, "iu");
  for (const t of texts) {
    const m = re.exec(t);
    if (!m) continue;
    const captures: Captures = {};
    m.forEach((v, i) => {
      if (v !== undefined) captures[String(i)] = v;
    });
    for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) captures[k] = v;
    return { matched: true, captures, text: t };
  }
  return { matched: false, captures: {}, text: null };
}

/** One probe's result, as later steps (the first look, the deep run, a rule's next actions) read it. */
export type ProbeResult = {
  name: string;
  description: string;
  /** Not run: no match, or the probe is gone. */
  skipped?: string;
  ok: boolean;
  output: string;
  ms: number;
  timedOut?: boolean;
  exitCode?: number | null;
  direct: boolean;
  runId?: string;
};

/**
 * Run probes by name for one event: each that matches gets a run of its own (kind probe) and runs now,
 * all of them side by side; none blocks the others or what comes after. `texts`: the message texts the
 * regex is tried on (the triggering message, or a 关注's merged ones).
 */
export async function runProbes(app: App, o: { names: string[]; event: Record<string, unknown>; texts: string[]; parentId?: string | null; spaceId: string; userId?: string; signal?: AbortSignal; title?: string }): Promise<ProbeResult[]> {
  return Promise.all([...new Set(o.names)].map((n) => runOne(app, n, o)));
}

async function runOne(app: App, probeName: string, o: Parameters<typeof runProbes>[1]): Promise<ProbeResult> {
  const p = getProbe(app, probeName);
  if (!p) return { name: probeName, description: "", skipped: "预查库里没有这个名字（可能被删了）", ok: false, output: "", ms: 0, direct: false };
  const m = matchProbe(p, o.texts);
  if (!m.matched) return { name: p.name, description: p.description, skipped: "消息不匹配它的条件，没有执行", ok: false, output: "", ms: 0, direct: p.direct };
  const event = { ...o.event, captures: m.captures };
  const r = createRun(app, {
    kind: "probe",
    spaceId: o.spaceId,
    title: truncate(`预查「${p.name}」${o.title ? `：${o.title}` : ""}`, 80),
    input: { probe: p.name, runtime: p.runtime, timeoutSec: p.timeoutSec, captures: m.captures, matched: m.text ? truncate(m.text, 300) : null },
    parentId: o.parentId ?? null,
    userId: o.userId ?? OWNER,
  });
  return execute(app, r, p, event, o.signal);
}

/** A probe run created just now: marked running before the worker can pick it, run here, closed here. */
async function execute(app: App, r: Run, p: Probe, event: Record<string, unknown>, signal?: AbortSignal): Promise<ProbeResult> {
  run(app.db, "update runs set status = 'running', started_at = ? where id = ? and status = 'queued'", now(), r.id);
  app.emit({ type: "run", runId: r.id, status: "running" });
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const untrack = trackAbort(r.id, controller);
  const stdin = JSON.stringify(event);
  let result: ProbeResult;
  try {
    const out = await execScript(app, {
      runId: r.id, spaceId: r.spaceId ?? "personal", runtime: p.runtime, code: p.code, timeoutSec: p.timeoutSec, stdin,
      env: { OMEM_EVENT: stdin, OMEM_CAPTURES: JSON.stringify(event.captures ?? {}), OMEM_PROBE: p.name },
      signal: controller.signal,
    });
    const ok = out.code === 0 && !out.timedOut && !controller.signal.aborted;
    const text = (ok ? out.stdout : out.stderr || out.stdout).trim();
    result = { name: p.name, description: p.description, ok, output: truncate(text, PROBE_TEXT_LIMIT), ms: out.ms, timedOut: out.timedOut, exitCode: out.code, direct: p.direct, runId: r.id };
    setRunOutput(app, r.id, { exitCode: out.code, timedOut: out.timedOut, ms: out.ms, stdout: out.stdout, stderr: out.stderr });
    const status = controller.signal.aborted ? "cancelled" : ok ? "done" : "failed";
    const error = ok ? null : out.timedOut ? `超过 ${p.timeoutSec} 秒没结束，已停止` : controller.signal.aborted ? "已取消" : `退出码 ${out.code}：${truncate(out.stderr.trim() || out.stdout.trim(), 300)}`;
    addRunEvent(app, r.id, ok ? "status" : "error", ok ? { text: `预查完成（${out.ms} 毫秒）` } : { message: error });
    run(app.db, "update runs set status = ?, error = ?, finished_at = ? where id = ?", status, error, now(), r.id);
    app.emit({ type: "run", runId: r.id, status });
  } catch (e) {
    const message = (e as Error).message;
    result = { name: p.name, description: p.description, ok: false, output: truncate(message, 500), ms: 0, direct: p.direct, runId: r.id };
    addRunEvent(app, r.id, "error", { message });
    run(app.db, "update runs set status = 'failed', error = ?, finished_at = ? where id = ?", message, now(), r.id);
    app.emit({ type: "run", runId: r.id, status: "failed" });
  } finally {
    signal?.removeEventListener("abort", stop);
    untrack();
  }
  return result;
}

/** A probe run the worker found queued (a restart cut it off): its caller starts it again, this one ends. */
export function orphanProbe(r: Run) {
  return { skipped: `预查「${String(r.input.probe ?? "")}」在服务重启时中断；用到它的那一步会重新跑` };
}

/** Try a probe (saved or not yet) on a sample event: what it prints and how long it took. Owner only, checked by the caller. */
export async function tryProbe(app: App, input: ProbeInput, event: Record<string, unknown>, texts: string[]) {
  const p = { ...probeInputSchema.parse(input), createdBy: OWNER, createdAt: now(), updatedAt: now() } satisfies Probe;
  const m = matchProbe(p, texts);
  if (!m.matched) return { matched: false, captures: {}, ok: false, output: "", stderr: "", exitCode: null, timedOut: false, ms: 0, runId: null };
  const r = createRun(app, { kind: "probe", spaceId: "personal", title: truncate(`试跑预查「${p.name}」`, 80), input: { probe: p.name, runtime: p.runtime, timeoutSec: p.timeoutSec, captures: m.captures, trial: true }, userId: OWNER });
  const res = await execute(app, r, p, { ...event, captures: m.captures });
  const out = getRun(app, r.id).output as { stdout?: string; stderr?: string };
  return { matched: true, captures: m.captures, ok: res.ok, output: out.stdout ?? "", stderr: out.stderr ?? "", exitCode: res.exitCode ?? null, timedOut: !!res.timedOut, ms: res.ms, runId: r.id };
}

/** Text in a fenced block: never read as Markdown or HTML wherever it lands (a model's material, a card, a notification). */
export function fenced(text: string, limit = PROBE_TEXT_LIMIT) {
  return "```text\n" + truncate(text, limit).replace(/```/g, "ʼʼʼ") + "\n```";
}

/** Probe results as material: each with what it is for, its output, or why there is none. */
export function probesText(results: ProbeResult[], limit = PROBE_TEXT_LIMIT) {
  return results
    .map((r) => `- 预查「${r.name}」（${r.description || "没有说明"}）：${r.skipped ? r.skipped : r.ok ? `${r.ms} 毫秒\n${fenced(r.output || "（没有输出）", limit)}` : `${r.timedOut ? "超时" : "失败"}${r.output ? `\n${fenced(r.output, 600)}` : ""}`}`)
    .join("\n");
}

// ------------------------------------------------------------------ proposals

export const proposalSchema = z.object({
  name,
  description: z.string().trim().min(1).max(200),
  match: regex.optional(),
  runtime: z.enum(["node", "python", "bash"]),
  code: z.string().min(1).max(PROPOSAL_CODE_MAX),
  why: z.string().trim().min(1).max(600),
  timeout_sec: z.number().int().min(1).max(PROBE_TIMEOUT_MAX).optional(),
  direct: z.boolean().optional(),
});
export type Proposal = z.infer<typeof proposalSchema>;

const lang = (r: string) => (r === "node" ? "js" : r === "python" ? "python" : "bash");

export function proposalCard(p: Proposal, state?: { saved: boolean; by: string; at: string; note?: string }, timeZone?: string) {
  const blocks: Record<string, unknown>[] = [
    { fields: [{ label: "名字", value: p.name }, { label: "运行", value: `${p.runtime} · 最长 ${p.timeout_sec ?? 20} 秒${p.direct ? " · 结果可直接发" : ""}` }] },
    { markdown: `**查什么**：${p.description}\n\n**为什么提**：${p.why}${p.match ? `\n\n**匹配**：\`${p.match.replace(/`/g, "ʼ")}\`（消息不匹配就跳过）` : "\n\n**匹配**：每条都跑"}` },
    { markdown: "```" + lang(p.runtime) + "\n" + p.code.replace(/```/g, "ʼʼʼ") + "\n```" },
  ];
  if (!state) {
    blocks.push({ note: "保存后以你的名义放进预查库，规则和关注才能用它；代码在这台机器上执行，读到的事件是 JSON（标准输入和 OMEM_EVENT）。" });
    blocks.push({ buttons: [{ text: "保存", value: "save", style: "primary" }, { text: "不要", value: "drop" }] });
  } else {
    const time = new Date(state.at).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
    blocks.push({ note: `${state.by} ${time} ${state.saved ? "保存了" : "不要"}${state.note ? `：${state.note}` : ""}` });
  }
  return { title: state ? `预查「${p.name}」${state.saved ? "已保存" : "没有保存"}` : `要保存预查「${p.name}」吗？`, color: state ? (state.saved ? "green" : "grey") : "blue", blocks };
}

/** `propose_probe`: the assistant suggests a probe; the owner gets a card with all its code. */
export async function proposeProbe(app: App, from: { runId: string | null; conversationId?: string | null }, raw: unknown) {
  const p = proposalSchema.parse(raw);
  if (getProbe(app, p.name)) throw new HttpError(409, `预查库里已经有「${p.name}」：换个名字，或让本人在预查页改它`);
  const { fingerprint, mayPropose } = await import("../items/choices.ts");
  const may = mayPropose(app, OWNER, "probe", fingerprint(p.name));
  if (!may.ok) throw new HttpError(409, `不再提这个预查：${may.why}`);
  // Checked before it reaches the owner: a proposal that cannot be saved is no proposal.
  probeInputSchema.parse({ ...p, timeoutSec: p.timeout_sec });
  runtimeCommand(p.runtime);
  const { buildCard } = await import("../channels/lark-send.ts");
  const { ownerCard } = await import("../channels/watch-trial.ts");
  const sent = await ownerCard(app, null, buildCard(proposalCard(p) as never), "probe-proposal", { proposal: p, at: now() }, from.conversationId ?? null, from.runId);
  if (from.runId) addRunEvent(app, from.runId, "status", { text: `提议了预查「${p.name}」，等本人在卡片上决定` });
  return `已把预查「${p.name}」连同完整代码发给本人（${sent.inGroup ? "群里只有本人看得到的卡片" : "私聊卡片"}）。本人点“保存”后它才进预查库；点“不要”以后不再提同名的。`;
}

/** The owner pressed 保存 or 不要 on a proposal card (lark-actions.ts). Returns the card to show instead. */
export async function decideProposal(app: App, payload: { proposal: Proposal }, act: string, by: string) {
  const p = proposalSchema.parse(payload.proposal);
  const at = now();
  if (act === "save") {
    saveProbe(app, { name: p.name, description: p.description, match: p.match, runtime: p.runtime, code: p.code, timeoutSec: p.timeout_sec, direct: p.direct }, OWNER, "proposal");
    return proposalCard(p, { saved: true, by, at, note: "已进预查库" }, app.config.timezone);
  }
  const { recordChoice, fingerprint } = await import("../items/choices.ts");
  recordChoice(app, { userId: OWNER, kind: "probe", target: fingerprint(p.name), choice: "drop", via: "lark-card", reason: truncate(p.description, 200) });
  return proposalCard(p, { saved: false, by, at, note: "以后不再提同名的预查" }, app.config.timezone);
}

// ------------------------------------------------------------------ a rule's step outputs

/** What a probe or a script step of a rule printed, for the actions after it (rules/actions.ts). */
export type StepOutput = { from: "probe" | "script"; name: string; ok: boolean; text: string; skipped?: string; ms?: number; runId?: string };

/** Step outputs as material or a message body: fenced, cut to `limit` each, never raw HTML or Markdown. */
export function stepOutputsText(outs: StepOutput[], limit = PROBE_TEXT_LIMIT) {
  return outs
    .map((o) => `- ${o.from === "probe" ? "预查" : "脚本"}「${o.name}」：${o.skipped ? o.skipped : `${o.ok ? "完成" : "失败"}${o.ms !== undefined ? `（${o.ms} 毫秒）` : ""}\n${fenced(o.text || "（没有输出）", limit)}`}`)
    .join("\n");
}
