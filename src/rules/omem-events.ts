import type { App, AppEvent } from "../core/app.ts";
import { one } from "../core/db.ts";
import { json, truncate } from "../core/util.ts";
import type { OmemFacts, RuleEvent } from "./types.ts";

/**
 * omem's own events as rule triggers (docs/v2/rules.md, “omem 里发生的事”): a run ended, a review
 * ended, a delegation was applied or discarded, a question was answered or lapsed, an item was made
 * or changed state, a flow stage moved, a plugin recorded a signal. They come from the process's event
 * bus (`app.events`: `run`, `ask`, and `omem` for the rest, sent where each happens) and go to
 * `dispatchRuleEvent` like any other event.
 *
 * No loops: a run a rule started never wakes that rule again, and the runs of rules about omem's own
 * events wake none at all (two such rules could otherwise wake each other forever). The same event
 * about the same thing in the same state is passed on once in ten minutes.
 */
const THROTTLE_MS = 10 * 60_000;
const recent = new WeakMap<App, Map<string, number>>();
const attached = new WeakSet<App>();

/** Whether any enabled rule listens for omem's events (most events go nowhere: checked first). */
function listening(app: App) {
  try {
    return !!one(app.db, "select 1 from rules where enabled = 1 and json_extract(trigger, '$.event') = 'omem' limit 1");
  } catch {
    return false;
  }
}

/** Hand one of omem's events to the rules (awaited in tests; callers elsewhere let it go). */
export async function dispatchOmemEvent(app: App, facts: OmemFacts, at = new Date()) {
  if (!listening(app)) return false;
  // Whatever a run did (an item it made, a stage it finished), the rule behind that run is behind it too.
  if (facts.runId && !facts.ruleId) {
    const r = runRow(app, facts.runId);
    const rule = r ? ruleBehind(app, json(r.input, {}), json(r.trigger, null)) : null;
    if (rule?.omem) return false;
    if (rule) facts = { ...facts, ruleId: rule.id };
  }
  let map = recent.get(app); if (!map) recent.set(app, map = new Map());
  const dedupe = `${facts.type}:${facts.id}:${facts.status ?? ""}`;
  const last = map.get(dedupe);
  if (last !== undefined && at.getTime() - last < THROTTLE_MS) return false;
  map.set(dedupe, at.getTime());
  if (map.size > 2000) for (const [k, t] of map) if (at.getTime() - t >= THROTTLE_MS) map.delete(k);
  const event: RuleEvent = { key: `omem:${dedupe}:${at.toISOString()}`, kind: "omem", at: at.toISOString(), omem: facts, via: "omem" };
  const { dispatchRuleEvent } = await import("./engine.ts");
  await dispatchRuleEvent(app, event);
  return true;
}

/** Send one from where it happens (items, flows, plugin signals): through the bus, so nothing waits on the rules. */
export function emitOmem(app: App, facts: OmemFacts) {
  app.emit({ type: "omem", event: facts });
}

/**
 * A branch review ended (review-chain): the conclusion and how the earlier findings fared. Its run's
 * `reviewStage: done` already sends a plain `review.done`; this one, with the counts, is for a re-review
 * that knows them (the run id is the same, so only the first of the two in ten minutes goes out).
 */
export function reviewFinished(app: App, input: { runId: string; verdict: string; newFindings?: number; fixed?: number; still?: number; repo?: string; branch?: string; itemId?: string; summary?: string }) {
  const r = runRow(app, input.runId);
  emitOmem(app, {
    type: "review.done", id: input.runId, runId: input.runId, title: r?.title ?? "评审", status: input.verdict, space: r?.space_id ?? undefined,
    ...(input.newFindings !== undefined ? { newFindings: input.newFindings } : {}), ...(input.fixed !== undefined ? { fixed: input.fixed } : {}), ...(input.still !== undefined ? { still: input.still } : {}),
    ...(input.repo ? { repo: input.repo } : {}), ...(input.branch ? { branch: input.branch } : {}), ...itemOf(app, input.itemId), ...(input.summary ? { text: truncate(input.summary, 2000) } : {}),
  });
}

type RunRow = { id: string; kind: string; space_id: string | null; status: string; title: string; input: string; output: string; profile_id: string | null; error: string | null; trigger: string | null; quiet: number | null };
const runRow = (app: App, id: string) => one<RunRow>(app.db, "select id,kind,space_id,status,title,input,output,profile_id,error,trigger,quiet from runs where id = ?", id);
function itemOf(app: App, id: unknown): { item?: { id: string; title: string } } {
  if (typeof id !== "string" || !id) return {};
  const i = one<{ title: string }>(app.db, "select title from items where id = ?", id);
  return i ? { item: { id, title: i.title } } : {};
}
/** The rule a run came from, and whether that rule is itself about omem's events. */
function ruleBehind(app: App, input: Record<string, unknown>, trigger: { source?: { kind: string; id: string } } | null) {
  const id = trigger?.source?.kind === "rule" ? trigger.source.id : typeof (input.rule as { id?: unknown } | undefined)?.id === "string" ? String((input.rule as { id: string }).id) : null;
  if (!id) return null;
  const t = one<{ trigger: string }>(app.db, "select trigger from rules where id = ?", id);
  return { id, omem: !!t && json<{ event?: string }>(t.trigger, {}).event === "omem" };
}

/** A run that ended, as `run.done` / `run.failed` (not quiet ones, not cancelled ones). */
function runFacts(app: App, runId: string, status: string): OmemFacts | null {
  if (status !== "done" && status !== "failed") return null;
  const r = runRow(app, runId);
  if (!r || r.quiet) return null;
  const input = json<Record<string, unknown>>(r.input, {}), output = json<Record<string, unknown>>(r.output, {});
  const trigger = json<{ via?: string; source?: { kind: string; id: string } } | null>(r.trigger, null);
  const rule = ruleBehind(app, input, trigger);
  // The runs of a rule about omem's own events wake no rule about them.
  if (rule?.omem) return null;
  const text = status === "failed" ? r.error ?? "" : typeof output.text === "string" ? output.text : typeof output.summary === "string" ? output.summary : "";
  return {
    type: status === "done" ? "run.done" : "run.failed", id: r.id, runId: r.id, title: r.title, kind: r.kind, status,
    ...(typeof input.spec === "string" ? { profile: input.spec } : r.profile_id ? { profile: r.profile_id } : {}),
    ...(r.space_id ? { space: r.space_id } : {}), via: trigger?.via ?? "system", ...itemOf(app, input.itemId), ...(text ? { text: truncate(text, 2000) } : {}),
    ...(rule ? { ruleId: rule.id } : {}),
  };
}

/** An answered or lapsed question (asks.ts `closed`), with the item it is about when its context names one. */
function askFacts(app: App, id: string, status: string): OmemFacts | null {
  if (status !== "answered" && status !== "cancelled") return null;
  const a = one<{ id: string; question: string; answer: string | null; choice: number | null; options: string; run_id: string | null; context: string; kind: string }>(app.db, "select id,question,answer,choice,options,run_id,context,kind from asks where id = ?", id);
  if (!a) return null;
  const context = json<Record<string, unknown>>(a.context, {});
  const options = json<{ label: string }[]>(a.options, []);
  const answer = a.answer ?? (a.choice !== null ? options[a.choice]?.label ?? "" : "");
  const run = a.run_id ? runRow(app, a.run_id) : undefined;
  const input = run ? json<Record<string, unknown>>(run.input, {}) : {};
  const rule = run ? ruleBehind(app, input, json(run.trigger, null)) : null;
  return {
    type: status === "answered" ? "ask.answered" : "ask.expired", id: a.id, title: truncate(a.question.split("\n")[0] ?? "", 200), kind: a.kind, status,
    text: truncate(`${a.question}${answer ? `\n回答：${answer}` : ""}`, 2000), ...(run?.space_id ? { space: run.space_id } : {}),
    ...itemOf(app, context.itemId ?? input.itemId), ...(a.run_id ? { runId: a.run_id } : {}), ...(rule ? { ruleId: rule.id } : {}),
  };
}

/** Listen on the bus for the rest of the process (once per app). */
export function attachOmemEvents(app: App) {
  if (attached.has(app)) return;
  attached.add(app);
  const listener = (e: AppEvent) => {
    let facts: OmemFacts | null = null;
    try {
      if (e.type === "run") facts = runFacts(app, e.runId, e.status);
      else if (e.type === "ask") facts = askFacts(app, e.id, e.status);
      else if (e.type === "omem") facts = e.event;
    } catch (err) {
      console.warn(`[omem] 内部事件没有交给规则：${(err as Error).message}`);
    }
    if (facts) void dispatchOmemEvent(app, facts).catch((err) => console.warn(`[omem] 内部事件没有交给规则：${(err as Error).message}`));
  };
  app.events.on("event", listener);
  app.events.once("close", () => { app.events.off("event", listener); attached.delete(app); });
}

// ---- the places that send their own -------------------------------------------------------

/** A run's output got `appliedAt` / `discardedAt` (a delegation), or `reviewStage: done` (its review ended): agents/runs.ts setRunOutput. */
export function runOutputFacts(app: App, runId: string, prev: Record<string, unknown>, next: Record<string, unknown>): OmemFacts | null {
  const applied = next.appliedAt && !prev.appliedAt, discarded = next.discardedAt && !prev.discardedAt, reviewed = next.reviewStage === "done" && prev.reviewStage !== "done";
  if (!applied && !discarded && !reviewed) return null;
  const r = runRow(app, runId);
  if (!r) return null;
  const input = json<Record<string, unknown>>(r.input, {});
  const worktrees = Array.isArray(next.worktrees) ? next.worktrees as { space?: string; branch?: string }[] : Array.isArray(prev.worktrees) ? prev.worktrees as { space?: string; branch?: string }[] : [];
  const repo = typeof input.repo === "string" ? input.repo : worktrees[0]?.space ?? r.space_id ?? undefined;
  const branch = typeof input.branch === "string" ? input.branch : worktrees[0]?.branch;
  const rule = ruleBehind(app, input, json(r.trigger, null));
  const base = { id: r.id, runId: r.id, title: r.title, ...(r.space_id ? { space: r.space_id } : {}), ...(repo ? { repo } : {}), ...(branch ? { branch } : {}), ...itemOf(app, input.itemId), ...(rule ? { ruleId: rule.id } : {}) };
  if (reviewed) {
    const lead = next.reviewLead as { round?: number; summary?: string } | undefined;
    // This round's findings the lead kept (not rejected, not merged into another).
    const found = typeof lead?.round === "number" ? one<{ n: number }>(app.db, "select count(*) n from review_findings f join reviews v on v.id = f.review_id where v.code_run_id = ? and v.round = ? and f.merged_into is null and f.state != 'rejected'", r.id, lead.round)?.n : undefined;
    return { ...base, type: "review.done", status: String(next.verdict ?? ""), ...(found !== undefined ? { newFindings: found } : {}), ...(typeof lead?.summary === "string" ? { text: truncate(lead.summary, 2000) } : {}) };
  }
  return { ...base, type: applied ? "code.applied" : "code.discarded", status: applied ? "applied" : "discarded" };
}
