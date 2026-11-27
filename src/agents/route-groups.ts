import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { decide, decisionOrder, type DecisionQuestion, type DecisionResult } from "../core/decision.ts";
import { capMaterial, sceneThreshold } from "../core/decision-log.ts";
import { newId, now, untilAbort } from "../core/util.ts";
import { runClasses, type RunClass } from "./run-classes.ts";

type Group = { id: string; name: string; items: { note?: string }[] };
type Routing = { order: string[]; reason: string; by: "decision" | "static" };

/** Apply the same confidence and lead to live choices and to offline replays. */
export function rankRoute(ids: string[], answer: Pick<DecisionResult, "choice" | "probabilities">, threshold: number) {
  const p = answer.probabilities;
  if (!ids.every(id => Number.isFinite(p[id]) && p[id] >= 0 && p[id] <= 1)) return null;
  const sorted = ids.toSorted((a, b) => p[b] - p[a]);
  const [first, second] = sorted;
  if (!second || first !== answer.choice || p[first] < threshold || p[first] - p[second] + Number.EPSILON < 0.15) return null;
  return sorted;
}

/** The caller supplies the eligible groups in policy order for an order: choose rule. */
export async function routeGroups(app: App, o: {
  classId: RunClass; task: string; groups: Group[]; conversation: boolean; runId?: string; signal?: AbortSignal;
}): Promise<Routing> {
  const groups = [...new Map(o.groups.map(g => [g.id, g])).values()];
  const ids = groups.map(g => g.id);
  if (ids.length < 2) return { order: ids, by: "static", reason: ids.length ? "只有一个允许的组" : "没有允许的组" };

  const category = runClasses[o.classId];
  const guidance = app.config.agents.routing.guidance.trim();
  const material = { 类别: `${category.name}：${category.description}`, 任务: o.task.slice(0, 1500), ...(guidance && { 本人的总体偏好: guidance }) };
  const options = Object.fromEntries(groups.map(g => {
    const notes = [...new Set(g.items.map(item => item.note?.trim()).filter(Boolean))].join("；");
    return [g.id, notes ? `${g.name}：${notes.slice(0, 500)}` : g.name];
  }));
  const question: DecisionQuestion = { type: "choice", instructions: "按任务类别、任务内容、各组的用途和本人的偏好，选择最适合的一组。", options };
  const threshold = sceneThreshold(app, "route");
  const deadline = AbortSignal.timeout(o.conversation ? 8000 : 20000);
  const signal = o.signal ? AbortSignal.any([deadline, o.signal]) : deadline;
  let answer: DecisionResult | null = null;
  let why = "没有配置可用的决策模型";
  let model = "";
  try {
    const [first] = decisionOrder(app);
    if (first) {
      model = first.detail;
      answer = await untilAbort(signal, () => decide(app, material, question, { only: first, signal }));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    why = deadline.aborted ? "决策模型超时" : o.signal?.aborted ? "选型已取消" : `决策模型出错（${message.slice(0, 120)}）`;
  }
  const ranked = answer && rankRoute(ids, answer, threshold);
  if (answer) {
    const p = answer.probabilities;
    const scores = groups.filter(g => Number.isFinite(p[g.id]))
      .sort((a, b) => p[b.id] - p[a.id])
      .slice(0, 2).map(g => `${g.name} ${p[g.id].toFixed(2)}`).join(" / ");
    why = (ranked ? "决策模型选择" : "决策模型拿不准") + (scores ? `（${scores}）` : "");
  }
  const result: Routing = ranked ? { by: "decision", order: ranked, reason: why } : { by: "static", order: ids, reason: why + "，按默认先后" };
  run(app.db, `insert into decisions(id,at,scene,"by",question,material,probabilities,choice,taken,threshold,ref,route)
    values(?,?,'route',?,?,?,?,?,?,?,?,?)`, newId("d"), now(), answer?.by ?? model, JSON.stringify(question), capMaterial(material),
    JSON.stringify(answer?.probabilities ?? {}), answer?.choice ?? "", result.order[0], threshold, o.runId ?? null,
    JSON.stringify({ classId: o.classId, defaultOrder: ids, ...result }));
  return result;
}
