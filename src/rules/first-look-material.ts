import type { Run } from "../agents/runs.ts";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import type { FirstLookInput, LookMessage, Outcome } from "./first-look.ts";
import { probesText, type ProbeResult } from "./probes.ts";

export function splitFirstLookText(text: string): { lead: string; more?: string } {
  if (text.length <= 120 || /[\r\n]/.test(text) || /^\s*[-*+]\s/.test(text)) return { lead: text };
  const end = text.search(/[。；]/) + 1;
  const more = end ? text.slice(end).trimStart() : "";
  return more ? { lead: text.slice(0, end), more } : { lead: text };
}

/** Grounds written as one long paragraph: one sentence per line on the card, so it reads as a list. */
export function evidenceLines(text: string) {
  const t = text.trim();
  if (t.length <= 80 || /[\r\n]/.test(t)) return t;
  const parts = t.split(/(?<=[。；])/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts.map((part) => `- ${part}`).join("\n") : t;
}

export const OWNER_CONTINUED = "本人要求接着查";

type ProbeSummary = Pick<ProbeResult, "name" | "ok" | "skipped" | "ms" | "timedOut" | "runId">;

export function continuedMaterial(app: App, look: Run, input: FirstLookInput, messages: LookMessage[]): string {
  const outcome = (look.output.firstLookResult ?? look.output.firstLook) as Partial<Outcome> | undefined;
  const text = outcome?.text ?? look.output.answer;
  const saved = (look.output.stages as { probes?: { results?: ProbeSummary[] } } | undefined)?.probes?.results ?? [];
  const results: ProbeResult[] = [];
  let missing = input.probes.some((name) => !saved.some((result) => result.name === name));
  for (const result of saved) {
    const raw = result.runId ? one<{ output: string | null }>(app.db, "select output from runs where kind = 'probe' and parent_id = ? and id = ?", look.id, result.runId) : undefined;
    const output = JSON.parse(raw?.output ?? "{}") as { stdout?: string; stderr?: string };
    const probeText = result.ok ? output.stdout : output.stderr || output.stdout;
    if (result.skipped || typeof probeText === "string") results.push({ ...result, description: "", direct: false, output: probeText?.trim() ?? "" });
    else missing = true;
  }
  return [
    `${OWNER_CONTINUED}：本人看了先看一眼的结论，请继续核对和补查。`,
    input.listen ? `要接着查的原消息：\n${messages.map((message) => `- ${message.sender}（飞书消息 ${message.id}）：${truncate(message.text, 1500)}`).join("\n")}` : "",
    typeof text === "string" && text ? `先看一眼的结论：\n${text}` : `先看一眼的结论见运行 ${look.id}`,
    outcome?.evidence ? `依据：\n${outcome.evidence}` : "",
    outcome?.next ? `还要查：${outcome.next}` : "",
    outcome?.reason ? `先看一眼的说明：${outcome.reason}` : "",
    results.length ? `预查结果：\n${probesText(results, 2500)}` : "",
    missing ? `预查结果见先看一眼运行 ${look.id}` : "",
  ].filter(Boolean).join("\n\n");
}
