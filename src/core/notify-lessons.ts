import type { App } from "./app.ts";
import { one, run } from "./db.ts";

/**
 * Notification "ignore" lessons — semantic, not keyword matching.
 *
 * When the owner ignores a notification (or manually cites a message with a
 * reason), the *model* writes one short rule in the owner's own words: what
 * class of things should no longer ping. Before pushing, the rules are given
 * back to the model with the new notification, and it decides whether it is
 * the same kind of thing. Rules stay in kv, count their hits, and can be seen
 * and deleted.
 */
export type IgnoreRule = {
  id: string;
  /** What the owner does not want to be paged for, as a concise rule in their words. */
  rule: string;
  /** The notification title the rule was learned from (audit). */
  example: string;
  createdAt: string;
  hits: number;
};

const KEY = "notify_ignore_rules";

export function listIgnoreRules(app: App): IgnoreRule[] {
  const raw = one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value;
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as IgnoreRule[]) : [];
  } catch {
    return [];
  }
}

function saveRules(app: App, rules: IgnoreRule[]) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KEY, JSON.stringify(rules.slice(0, 100)));
}

/** Persist a rule the model summarized from an ignore action; duplicates (same rule) are skipped. */
export function addIgnoreRule(app: App, rule: string, example: string): IgnoreRule {
  const rules = listIgnoreRules(app);
  const trimmed = rule.trim().slice(0, 300);
  const existing = rules.find((r) => r.rule === trimmed);
  if (existing) return existing;
  const saved: IgnoreRule = { id: `ir_${Date.now().toString(36)}`, rule: trimmed, example, createdAt: new Date().toISOString(), hits: 0 };
  rules.unshift(saved);
  saveRules(app, rules);
  return saved;
}

export function recordIgnoreHit(app: App, id: string) {
  const rules = listIgnoreRules(app);
  const r = rules.find((x) => x.id === id);
  if (!r) return;
  r.hits++;
  saveRules(app, rules);
}

export function deleteIgnoreRule(app: App, id: string) {
  saveRules(app, listIgnoreRules(app).filter((r) => r.id !== id));
}

/** System prompt fragment for the model that decides whether a notification may push. */
export const IGNORE_GATE_PROMPT = `你在替本人做通知打扰判断。下面是本人明确说过“以后不用提醒我”的规则：

<ignore-rules>
{rules}
</ignore-rules>

现在有一条准备推送的通知：
标题：{title}
内容：{body}

判断它是否属于上述“不提醒”的同类。注意规则里限定的对象、群和场景；宁可放行不确定的（真紧急的事不能漏），只在确实属于同类时静默。只输出 JSON：{"mute": true/false, "ruleId": "命中的规则 id，未命中为 null", "reason": "一句中文理由"}`;
