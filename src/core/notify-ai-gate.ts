import type { App } from "./app.ts";
import { askModel, jsonIn } from "../agents/oneshot.ts";
import { addIgnoreRule, IGNORE_GATE_PROMPT, listIgnoreRules, recordIgnoreHit, type IgnoreRule } from "./notify-lessons.ts";

/**
 * Ask the model whether this notification falls under one of the owner's
 * "don't ping me for this" rules. Returns the matched rule, or null to allow
 * the push. No rules → no call, allow. Any uncertainty → allow.
 */
export async function aiIgnoreMatch(
  app: App,
  n: { title: string; body?: string; urgency?: string },
): Promise<{ rule: IgnoreRule; reason: string } | null> {
  if (n.urgency === "urgent") return null; // never let a learned rule silence something marked urgent
  const rules = listIgnoreRules(app);
  if (!rules.length) return null;
  const prompt = IGNORE_GATE_PROMPT
    .replace("{rules}", rules.map((r) => `- id=${r.id}：${r.rule}`).join("\n"))
    .replace("{title}", n.title)
    .replace("{body}", (n.body ?? "").slice(0, 1000));
  const verdict = jsonIn<{ mute?: boolean; ruleId?: string | null; reason?: string }>(await askModel(app, prompt));
  if (!verdict || verdict.mute !== true || !verdict.ruleId) return null;
  const rule = rules.find((r) => r.id === verdict.ruleId);
  if (!rule) return null;
  recordIgnoreHit(app, rule.id);
  return { rule, reason: verdict.reason ?? "" };
}

const LEARN_PROMPT = `本人点了一条通知的“忽略”。请总结成一条可复用的提醒过滤规则，说明以后哪一类事情不要再主动推送（仍然保留在应用内通知里）。
要求：一句中文、30–60 字、写清对象和场景边界（哪个群、哪类信号），不要带具体人名流水；如果这只是一次性事件、不足以成为通用规则，输出空字符串。

通知标题：{title}
通知内容：{body}

只输出 JSON：{"rule": "规则文字，或空字符串"}`;

/** Summarize an ignored notification into a reusable rule (best-effort). */
export async function learnIgnoreFromNotification(app: App, n: { title: string; body?: string }): Promise<IgnoreRule | null> {
  const prompt = LEARN_PROMPT.replace("{title}", n.title).replace("{body}", (n.body ?? "").slice(0, 1000));
  const rule = (jsonIn<{ rule?: string }>(await askModel(app, prompt))?.rule ?? "").trim();
  if (rule.length < 6) return null;
  return addIgnoreRule(app, rule, n.title);
}
