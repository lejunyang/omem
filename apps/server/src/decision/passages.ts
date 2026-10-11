import type { RetrievalHit } from "../retrieval/port.js";
import { passageQuestions } from "./questions.js";
import type { DecisionResult, DecisionService } from "./service.js";
import { getLogger } from "../logging/logger.js";
import { stableDigest } from "../storage/digest.js";
import { promotedOrder } from "../retrieval/evaluated-order.js";

export function passagePolicy(result: DecisionResult) {
  const p = (key: string, option: string) =>
    result.answers[key]?.probabilities[option] ?? 0;
  // Separate dimensions: contradictions are useful evidence, not noise. Unknown
  // conditions or a missing parent must survive initial selection for ACP to read.
  const protectedContext =
    p("premise", "contradicts") >= 0.2 ||
    p("parent_context", "needed") >= 0.2 ||
    p("relevance", "uncertain") >= 0.2;
  const omit =
    result.model.size !== "0.8b" &&
    !protectedContext &&
    p("relevance", "unrelated") >= 0.98 &&
    p("answer_coverage", "none") >= 0.95 &&
    p("evidence", "none") >= 0.95;
  const strongAnswer =
    p("relevance", "answer") >= 0.9 &&
    p("evidence", "statement") + p("evidence", "conditional") >= 0.9;
  const needsContext = p("parent_context", "needed") >= 0.5;
  return {
    omit,
    // High positive evidence deserves attention. A low answer option alone is
    // not a negative verdict: partial answers, contradictions and context count.
    judgment: needsContext
      ? ("needs_context" as const)
      : omit
        ? ("strong_unrelated" as const)
        : strongAnswer
          ? ("strong_answer" as const)
          : ("uncertain" as const),
    priority:
      Math.max(p("relevance", "answer"), p("premise", "contradicts")) +
      0.35 * p("relevance", "background"),
    possibleInjection: p("injection", "attempt") >= 0.8,
  };
}

/** The same input contract is used by search and offline model comparisons. */
export function passageState(question: string, hit: RetrievalHit) {
  return {
    user_question: question,
    material: hit.text,
    title: hit.title,
    headings: hit.headingPath,
    surrounding_context: hit.context,
    source_kind: hit.kind,
    matched_ranges: hit.matchedRanges,
    original_locator: hit.target,
    material_description: hit.materialDescription
      ? {
          role: hit.materialDescription.description.role,
          status: hit.materialDescription.description.status,
        }
      : undefined,
    instruction:
      "标题、概念及用途是检索元数据，不是论断证据。根据 material 中实际原文判断能回答的步骤或条件；只提到问题词语的注释、文案和目录是 topic_only。原文摘录未覆盖完整实现时按缺背景处理，不把缺失当成无关。",
  };
}

export async function assessPassages(
  service: DecisionService,
  question: string,
  hits: RetrievalHit[],
  options: {
    sourceIdFor?: (hit: RetrievalHit) => string | undefined;
    onInput?: (hit: RetrievalHit) => void;
    readContext?: (hit: RetrievalHit) => RetrievalHit | undefined;
    budgetMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  const logger = getLogger({ component: "retrieval" });
  const queryDigest = stableDigest(question);
  const assessed: {
    hit: RetrievalHit;
    result: DecisionResult | null;
    index: number;
    contextRead?: "expanded" | "unavailable" | "budget";
  }[] = [];
  const stateFor = (hit: RetrievalHit) => passageState(question, hit);
  const budgetMs = options.budgetMs ?? 8_000;
  const unlimited = budgetMs === 0;
  options.signal?.throwIfAborted();
  // Cold loading must not add tens of seconds before the regular Agent can work.
  // Warm one real request in the background; the next turn can reuse residency.
  if (!unlimited && service.status().status !== "ready") {
    if (hits[0] && service.status().status === "idle")
      void service.decide(stateFor(hits[0]), passageQuestions);
    logger.info(
      {
        event: "retrieval.decision_skipped",
        queryDigest,
        reason: "model_not_ready",
        modelStatus: service.status().status,
        candidates: hits.length,
      },
      "retrieval.decision_skipped",
    );
    return { hits, decisions: [], status: service.status() };
  }
  const started = performance.now();
  // Bound added interactive latency; untouched candidates retain their ranking.
  // The full corpus remains available to the Agent's autonomous search tools.
  const decide = async (hit: RetrievalHit) => {
    // A load-driven model switch may be cold even though the previous model was
    // ready. Let it finish in the background without stalling this user turn.
    let timer: ReturnType<typeof setTimeout> | undefined;
    options.signal?.throwIfAborted();
    options.onInput?.(hit);
    const request = service.decide(stateFor(hit), passageQuestions, {
      ...(unlimited ? { timeoutMs: 0 } : {}), signal: options.signal,
    });
    if (unlimited) return request;
    try { return await Promise.race([
      request,
      new Promise<null>((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          Math.max(1, budgetMs - (performance.now() - started)),
        );
      }),
    ]); } finally { clearTimeout(timer); }
  };
  for (const [index, original] of hits.entries()) {
    options.signal?.throwIfAborted();
    if (!unlimited && performance.now() - started > budgetMs) break;
    let hit = original,
      result = await decide(hit);
    let contextRead: "expanded" | "unavailable" | "budget" | undefined;
    if (
      result &&
      passagePolicy(result).judgment === "needs_context" &&
      options.readContext
    ) {
      if (!unlimited && performance.now() - started >= budgetMs) contextRead = "budget";
      else {
        const expanded = options.readContext(hit);
        if (!expanded || expanded.text === hit.text)
          contextRead = "unavailable";
        else {
          const next = await decide(expanded);
          if (next) {
            hit = expanded;
            result = next;
            contextRead = "expanded";
          } else contextRead = "budget";
        }
      }
    }
    if (!result && !assessed.length) {
      logger.info(
        {
          event: "retrieval.decision_skipped",
          queryDigest,
          reason: "decision_unavailable_or_latency_budget",
          candidates: hits.length,
        },
        "retrieval.decision_skipped",
      );
      return { hits, decisions: [], status: service.status() };
    }
    assessed.push({ hit, result, index, contextRead });
  }
  // Small-model advice has not earned authority to reorder retrieved evidence.
  // A batch that switches model revisions also cannot compare uncalibrated scores.
  const modelIdentities = new Set(
    assessed.flatMap(({ result }) =>
      result ? [`${result.model.alias}:${result.model.revision}`] : [],
    ),
  );
  const advisoryOnly =
    assessed.some(({ result }) => result?.model.size === "0.8b") ||
    modelIdentities.size > 1;
  const decisions = assessed.map(({ hit, result }) => ({
    id: hit.id,
    result,
    policy: result
      ? {
          ...passagePolicy(result),
          advisoryOnly,
          omit: !advisoryOnly && passagePolicy(result).omit,
        }
      : null,
  }));
  const kept = assessed.filter(
    ({ result }) => advisoryOnly || !result || !passagePolicy(result).omit,
  );
  const abstained = kept.length === 0;
  for (const { hit, result } of assessed) {
    const policy = result ? passagePolicy(result) : null;
    const dimensions = result
      ? Object.fromEntries(
          Object.entries(passageQuestions).map(([key, question]) => [
            key,
            {
              choice: result.answers[key]?.choice,
              confidence: result.answers[key]?.confidence,
              scores: Object.keys(question.criteria).map((option) => ({
                label: option,
                probability: result.answers[key]?.probabilities[option],
              })),
            },
          ]),
        )
      : undefined;
    logger.debug(
      {
        event: "retrieval.passage_decision",
        queryDigest,
        hitId: hit.id,
        sourceId: options.sourceIdFor?.(hit),
        revisionId:
          hit.target.kind === "source" ? hit.target.revisionId : undefined,
        kind: hit.kind,
        outcome:
          policy?.omit && !abstained && !advisoryOnly ? "omitted" : "kept",
        reason: !result
          ? "decision_unavailable"
          : advisoryOnly
            ? "advisory_only"
            : abstained
              ? "all_omitted_abstention"
              : policy?.omit
                ? "unrelated_without_answer_or_evidence"
                : "relevant_or_protected_context",
        dimensions,
        policy,
        model: result?.model.alias,
      },
      "retrieval.passage_decision",
    );
  }
  const ordered = advisoryOnly
    ? kept
    : promotedOrder(
        kept,
        (a) => (a.result ? passagePolicy(a.result).priority : undefined),
        (a) =>
          !!a.result && passagePolicy(a.result).judgment === "strong_answer",
      );
  // If every assessed item would disappear, abstain rather than asserting that
  // the library has no answer. The writer still sees ordinary untrusted sources.
  logger.info(
    {
      event: "retrieval.selection",
      queryDigest,
      candidates: hits.length,
      assessed: assessed.length,
      omitted: abstained ? 0 : assessed.length - kept.length,
      retainedWithoutAssessment: hits.length - assessed.length,
      abstained,
      advisoryOnly,
    },
    "retrieval.selection",
  );
  return {
    hits: kept.length
      ? [
          ...ordered.map((a) =>
            a.result
              ? {
                  ...a.hit,
                  routes: [...a.hit.routes, "decision"],
                  assessment: {
                    model: a.result.model.alias,
                    priority: passagePolicy(a.result).priority,
                    judgment: passagePolicy(a.result).judgment,
                    input: {
                      digest: stableDigest(a.hit.text),
                      characters: a.hit.text.length,
                      target: a.hit.target,
                    },
                    ...(a.contextRead ? { contextRead: a.contextRead } : {}),
                    advisoryOnly,
                    answers: a.result.answers,
                  },
                }
              : a.hit,
          ),
          ...hits.slice(assessed.length),
        ]
      : hits,
    decisions,
    status: service.status(),
  };
}
