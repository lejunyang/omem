import type { RetrievalHit } from "../retrieval/port.js";
import { passageQuestions } from "./questions.js";
import type { DecisionResult, DecisionService } from "./service.js";

export function passagePolicy(result: DecisionResult) {
  const p = (key: string, option: string) => result.answers[key]?.probabilities[option] ?? 0;
  // Separate dimensions: contradictions are useful evidence, not noise. Unknown
  // conditions or a missing parent must survive initial selection for ACP to read.
  const protectedContext = p("premise", "contradicts") >= .2 || p("parent_context", "needed") >= .2 || p("relevance", "uncertain") >= .2;
  const omit = !protectedContext && p("relevance", "unrelated") >= .98 && p("answer_coverage", "none") >= .95 && p("evidence", "none") >= .95;
  return { omit, priority: Math.max(p("relevance", "answer"), p("premise", "contradicts")) + .35 * p("relevance", "background"), possibleInjection: p("injection", "attempt") >= .8 };
}

export async function assessPassages(service: DecisionService, question: string, hits: RetrievalHit[]) {
  const assessed: { hit: RetrievalHit; result: DecisionResult | null; index: number }[] = [];
  const stateFor = (hit: RetrievalHit) => ({ user_question: question, material: hit.text,
    title: hit.title, headings: hit.headingPath, surrounding_context: hit.context, source_kind: hit.kind });
  // Cold loading must not add tens of seconds before the regular Agent can work.
  // Warm one real request in the background; the next turn can reuse residency.
  if (service.status().status !== "ready") {
    if (hits[0] && service.status().status === "idle") void service.decide(stateFor(hits[0]), passageQuestions);
    return { hits, decisions: [], status: service.status() };
  }
  const started = performance.now();
  // Bound added interactive latency; untouched candidates retain their ranking.
  // The full corpus remains available to the Agent's autonomous search tools.
  for (const [index, hit] of hits.slice(0, 12).entries()) {
    if (performance.now() - started > 8_000) break;
    // A load-driven model switch may be cold even though the previous model was
    // ready. Let it finish in the background without stalling this user turn.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      service.decide(stateFor(hit), passageQuestions),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(1, 8_000 - (performance.now() - started))); }),
    ]);
    clearTimeout(timer);
    if (!result && !assessed.length) return { hits, decisions: [], status: service.status() };
    assessed.push({ hit, result, index });
  }
  const decisions = assessed.map(({ hit, result }) => ({ id: hit.id, result, policy: result ? passagePolicy(result) : null }));
  const kept = assessed.filter(({ result }) => !result || !passagePolicy(result).omit);
  kept.sort((a, b) => {
    const priority = (r: DecisionResult | null) => r ? passagePolicy(r).priority : .5;
    return priority(b.result) - priority(a.result) || a.index - b.index;
  });
  // If every assessed item would disappear, abstain rather than asserting that
  // the library has no answer. The writer still sees ordinary untrusted sources.
  return { hits: kept.length ? [...kept.map(a => a.hit), ...hits.slice(assessed.length)] : hits, decisions, status: service.status() };
}
