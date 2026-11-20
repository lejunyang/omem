import type { Condition, Rule } from "./types.ts";

/** A rule may also select a space inside a nested condition, without setting the rule's home space. */
function visibleCondition(condition: Condition | null, spaces: Set<string>): boolean {
  if (!condition) return true;
  if ("all" in condition) return condition.all.every(child => visibleCondition(child, spaces));
  if ("any" in condition) return condition.any.every(child => visibleCondition(child, spaces));
  if ("not" in condition) return visibleCondition(condition.not, spaces);
  if (!["omem.space", "doc.space"].includes(condition.field)) return true;
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  return values.every(value => typeof value === "string" && spaces.has(value));
}

export function ruleVisible(rule: Rule, spaces: Set<string> | null) {
  return !spaces || ((!rule.spaceId || spaces.has(rule.spaceId)) && visibleCondition(rule.conditions, spaces));
}

/** Read-only consumers receive descriptive fields. Actions can carry executable code or credentials. */
export function ruleSummary(rule: Rule) {
  return { id: rule.id, name: rule.name, description: rule.description, enabled: rule.enabled,
    spaceId: rule.spaceId, event: rule.trigger.event, actions: rule.actions.map(action => ({ type: action.type })) };
}
