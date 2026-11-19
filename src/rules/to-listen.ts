import type { App } from "../core/app.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import type { ListenContext, ListenKnobs } from "../channels/listen.ts";
import { getRule, saveRule } from "./store.ts";
import type { Condition, Rule, RuleAction } from "./types.ts";

/** The chats a condition pins a message to (chat.id equals or in, alone or any of several); null when it does not. */
function chatsOf(c: Condition): string[] | null {
  if ("field" in c) {
    if (c.field !== "chat.id") return null;
    if (c.op === "equals" && typeof c.value === "string" && c.value.trim()) return [c.value.trim()];
    if (c.op === "in" && Array.isArray(c.value) && c.value.length) return c.value.map((v) => v.trim()).filter(Boolean);
    return null;
  }
  if ("any" in c) {
    const parts = c.any.map(chatsOf);
    return parts.length && parts.every((p) => p?.length) ? parts.flatMap((p) => p!) : null;
  }
  return null;
}

/** A rule's conditions as the chats it is about and whatever else it asks of a message. */
function splitConditions(c: Condition | null): { chats: string[]; rest: Condition[] } | null {
  if (!c) return null;
  const whole = chatsOf(c);
  if (whole) return { chats: whole, rest: [] };
  if (!("all" in c)) return null;
  const pinned = c.all.map(chatsOf);
  const at = pinned.findIndex((p) => p?.length);
  if (at < 0 || pinned.filter((p) => p?.length).length > 1) return null;
  return { chats: pinned[at]!, rest: c.all.filter((_, i) => i !== at) };
}

export type RuleToContext = {
  context: ListenContext;
  rule: Rule;
  /** disabled: the 关注 does all the rule did, so the rule is off (its action points at the 关注 should it be turned on again); switched: the rule goes on, handing what it picks to the 关注. */
  outcome: "disabled" | "switched";
  /** An existing place 关注 on the same groups with the same handler took it. */
  reused: boolean;
};

/**
 * A rule that hands messages of certain groups to an agent (or watches them) becomes a place 「关注」 on
 * those groups: its description is the 关注's note, its agent the handler, its reply mode the 关注's. The
 * rule's action then hands its events to that 关注 (`context`); when the rule asks nothing more of a
 * message than its group (no other condition, no wait, no other action), the 关注 does all of it and the
 * rule is turned off.
 */
export async function ruleToContext(app: App, ruleId: string): Promise<RuleToContext> {
  const rule = getRule(app, ruleId);
  if (rule.temporary) throw new HttpError(400, "Agent 设的临时规则不转成关注");
  if (rule.trigger.event !== "message") throw new HttpError(400, "只有“新消息”触发的规则能转成关注");
  const split = splitConditions(rule.conditions);
  if (!split) throw new HttpError(400, "这条规则的条件没有写具体是哪些群（chat.id 等于某个群），转不成关注");
  const chats = [...new Set(split.chats)];
  const at = rule.actions.findIndex((a) => a.type === "agent" || a.type === "watch");
  if (at < 0) throw new HttpError(400, "这条规则不是交给 Agent 或持续监听的，转不成关注");
  const action = rule.actions[at] as Extract<RuleAction, { type: "agent" } | { type: "watch" }>;
  const spec = action.spec || "assistant";
  const knobs: Partial<ListenKnobs> = {
    // Silent investigation is how a 关注's handler works anyway: it posts only what is worth it.
    reply: action.reply === "silent" ? "auto" : action.reply,
    // A watch on @ messages or a keyword keeps listening for those.
    ...(action.type === "watch" ? { listen: action.on === "mention" ? "addressed" as const : "relevant" as const, ...(action.on === "keyword" && action.pattern ? { pattern: action.pattern } : {}) } : {}),
    // The rule already handled what came before.
    backlog: "off",
  };
  const L = await import("../channels/listen.ts");
  const { groupName, seedContext } = await import("../channels/lark-watch.ts");
  const existing = L.listContexts(app, { kind: "place" }).find((c) => c.spec === spec && c.chats.length === chats.length && chats.every((x) => c.chats.includes(x)));
  const task = action.type === "agent" && action.task.trim() ? `\n要做的：${action.task.trim()}` : "";
  const ctx = L.saveContext(app, {
    id: existing?.id,
    kind: "place",
    ...(existing ? {} : { name: rule.name, chats, spec, note: `${rule.description}${task}`, spaceId: (action.type === "agent" ? action.space : undefined) ?? rule.spaceId ?? null, expiresAt: null, knobs }),
    status: "active",
  }, (id) => groupName(app, id));
  if (!existing) await seedContext(app, ctx).catch(() => 0);
  const redundant = !split.rest.length && rule.actions.length === 1 && !rule.trigger.waitMinutes && !rule.trigger.unless.length;
  const actions = rule.actions.map((a, i) => (i === at ? { type: "context" as const, context: ctx.id } : a));
  const saved = saveRule(app, { ...rule, temporary: undefined, actions, ...(redundant ? { enabled: false } : {}) }, "user", OWNER);
  return { context: ctx, rule: saved, outcome: redundant ? "disabled" : "switched", reused: !!existing };
}
