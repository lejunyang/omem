import { findSpace } from "../core/spaces.ts";
import type { App } from "../core/app.ts";
import { all, withinTx } from "../core/db.ts";
import { OWNER, canWrite } from "../core/users.ts";
import { HttpError, newId, now, sha256 } from "../core/util.ts";
import { cancelAsk, createAsk, registerAskAction } from "../agents/asks.ts";
import { getContext, removeContext, saveContext, type ContextInput, type ListenContext } from "../channels/listen.ts";
import { deleteRule, findRule, saveRule } from "../rules/store.ts";
import { currentChatIn } from "../rules/conditions.ts";
import { ruleInputSchema, type Rule } from "../rules/types.ts";

const REPLY_LABEL = { none: "不发", draft: "先给你看", auto: "直接发" } as const;
/** What a 持续跟进 rule does, in one sentence for the owner (cards, the rules page). */
export const FOLLOW_WHAT = "命中后开一次跟进：建一件事项，处理者在一段时间内自己复查，结束时写小结。";

export const situationRuleId = (id: string) => `situation:${id}`;
/** The trigger, conditions and judging of a 持续跟进 rule: what the owner may set directly on the rules page. */
export type StartRule = Pick<Rule, "trigger" | "conditions" | "judge" | "judgeWith">;
export type SituationInput = Pick<ContextInput, "id" | "name" | "note" | "recognize" | "spec" | "spaceId" | "knobs" | "status" | "expiresAt"> & {
  /** Set the start rule directly (the rules page). Marked as set by hand unless `fromSentence`. */
  rule?: Partial<StartRule>;
  /** `rule` is what “生成条件” gave for `recognize`, unchanged: it keeps following the sentence. */
  fromSentence?: boolean;
  /** Compile `recognize` again even though the owner set the conditions by hand. */
  regenerate?: boolean;
};
type SituationOrigin = { kind: "situation"; contextId: string; name: string; manual?: boolean };
const originOf = (r: Rule | null) => (r?.origin && "kind" in r.origin ? r.origin as SituationOrigin : null);
const startOf = (r: StartRule): StartRule => ({ trigger: r.trigger, conditions: r.conditions ?? null, judge: r.judge, judgeWith: r.judgeWith });
const sameStart = (a: StartRule, b: StartRule) => JSON.stringify(startOf(a)) === JSON.stringify(startOf(b));
const START_EVENTS = ["message", "doc", "object", "omem"];
/** A start rule as the rule schema reads it, fixed to fire on each event without waiting or skipping. */
function parseStart(rule: Partial<StartRule>): StartRule {
  const r = ruleInputSchema.safeParse({ name: "持续跟进", description: "持续跟进", actions: [{ type: "notify", urgent: false }], ...rule });
  if (!r.success) throw new HttpError(400, `条件不完整：${r.error.issues.map(i => `${i.path.join(".")}：${i.message}`).join("；")}`);
  return startOf({ ...r.data, trigger: { ...r.data.trigger, once: "event", waitMinutes: 0, unless: [] } });
}

export function requireSituation(app: App, userId: string, id: string) {
  const c = getContext(app, id);
  if (!c || c.kind !== "situation" || c.userId !== userId || userId !== OWNER) throw new HttpError(404, "没有这条持续跟进的规则");
  return c;
}

function validate(app: App, userId: string, proposed: SituationInput) {
  if (userId !== OWNER) throw new HttpError(403, "只有本人可以设置持续跟进的规则");
  const before = proposed.id ? requireSituation(app, userId, proposed.id) : null;
  const name = (proposed.name ?? before?.name ?? "").trim();
  const note = (proposed.note ?? before?.note ?? "").trim();
  const recognize = (proposed.recognize ?? before?.recognize ?? "").trim();
  const spaceId = (proposed.spaceId === undefined ? before?.spaceId : proposed.spaceId) ?? "personal";
  const space = findSpace(app, spaceId);
  if (!space || space.kind === "worktree") throw new HttpError(400, "持续跟进需要一个可写的空间");
  if (!canWrite(app, userId, spaceId)) throw new HttpError(403, "不能在这个空间里设置持续跟进");
  if (!name || name.length > 80 || !note || note.length > 2000 || recognize.length > 1000) throw new HttpError(400, "请填写名字（80 字以内）和说明（2000 字以内）；一句话描述不超过 1000 字");
  if (proposed.expiresAt && !Number.isFinite(Date.parse(proposed.expiresAt))) throw new HttpError(400, "停用时间不正确");
  return { before, name, note, recognize, spaceId };
}

/**
 * Save a 持续跟进 rule: the follow-up's settings (a `listen_contexts` row, kind situation) and the rule
 * that starts one (`situation:<id>`). The start rule is set directly (the rules page) or compiled from
 * the one-sentence description; once the owner set it by hand, a new sentence leaves it alone unless
 * `regenerate`. The host, not the compiler, picks the action. Everything is staged before either row is written.
 */
export async function saveSituation(app: App, userId: string, input: SituationInput, opts: { currentChat?: string | null; confirmation?: { runId: string; conversationId: string } } = {}) {
  const { before, name, note, recognize, spaceId } = validate(app, userId, input);
  const id = before?.id ?? newId("ctx");
  const ruleId = situationRuleId(id);
  const oldRule = findRule(app, ruleId);
  const wasManual = !!originOf(oldRule)?.manual;
  const given = input.rule ? parseStart(input.rule) : null;
  let compiled: StartRule;
  let manual = wasManual;
  /** A new sentence that did not change the conditions because the owner set them by hand. */
  let kept = false;
  if (given && !(oldRule && sameStart(given, oldRule) && !input.fromSentence)) {
    compiled = given;
    manual = !input.fromSentence;
  } else if (oldRule && !input.regenerate && (before?.recognize === recognize || wasManual || given || !recognize)) {
    compiled = startOf(oldRule);
    kept = wasManual && before?.recognize !== recognize;
  } else {
    if (!recognize) throw new HttpError(400, "写一句话描述什么时候开始跟进，或直接设好触发和条件");
    const { draftRule } = await import("../rules/compile.ts");
    const r = await draftRule(app, recognize, undefined, id);
    if (!r.rule) throw new HttpError(422, r.error ?? "没能从这句话生成开始跟进的条件");
    const parsed = ruleInputSchema.parse(r.rule);
    compiled = startOf({ ...parsed, conditions: currentChatIn(parsed.conditions, opts.currentChat ?? null) });
    manual = false;
  }
  if (!START_EVENTS.includes(compiled.trigger.event)) throw new HttpError(422, "持续跟进要由新消息、文档变化、对象变化或 omem 里的事开始");
  if (compiled.judge !== "code" && !recognize) throw new HttpError(400, "交给 AI 判断时，先写一句话描述什么时候开始跟进：模型按这句话判断");
  const { rule: _rule, fromSentence: _from, regenerate: _regen, ...fields } = input;
  const desired: ContextInput = { ...fields, id, kind: "situation", name, note, recognize, spaceId,
    status: input.status ?? before?.status ?? "active", ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}) };
  const reply = desired.knobs?.reply;
  const previousReply = before?.knobs.reply ?? "none";
  const replyLine = `在这一次的群里：${reply !== undefined && reply !== previousReply ? `${REPLY_LABEL[previousReply]} → ` : ""}${REPLY_LABEL[reply ?? previousReply]}`;
  const c = withinTx(app.db, () => {
    if (before && revision(requireSituation(app, userId, id)) !== revision(before)) throw new HttpError(409, "这条规则刚被改过，请重读再保存");
    if (before && opts.confirmation) return before;
    return persist(app, userId, opts.confirmation ? { ...desired, status: "paused", knobs: { ...desired.knobs, reply: "none" } } : desired, compiled, manual);
  });
  for (const { id: askId } of all<{ id: string }>(app.db, `select id from asks where status='pending' and json_extract(context,'$.handler')='situation-enable' and json_extract(context,'$.contextId')=?`, id)) cancelAsk(app, askId);
  const confirmation = opts.confirmation ? createAsk(app, {
    ...opts.confirmation, userId, question: [before ? `应用持续跟进「${name}」的改动吗？` : `启用持续跟进「${name}」吗？`, FOLLOW_WHAT, replyLine, `说明：${note}`, ...(recognize ? [`什么时候开始：${recognize}`] : []), ...(before ? [`原说明：${before.note}`] : [])].join("\n\n"),
    options: before ? [{ label: "应用改动" }, { label: "保留原版" }] : [{ label: "启用" }, { label: "先不启用" }], allowText: false,
    context: { handler: "situation-enable", contextId: id, revision: revision(c), ...(before ? { change: desired, compiled: startOf(compiled), manual } : { reply }), afterReply: true, spaceId },
  }) : null;
  return { context: c, proposed: { name, note, recognize }, previousNote: before?.note ?? null, replyLine, confirmation, conditionsKept: kept };
}

function persist(app: App, userId: string, desired: ContextInput, compiled: StartRule, manual: boolean) {
  const c = saveContext(app, desired);
  saveRule(app, { ...compiled, id: situationRuleId(c.id), temporary: undefined, name: c.name.slice(0, 60), description: c.recognize || c.name,
    // Ownership and execution space belong to the follow-up, not the event's group.
    spaceId: undefined, conversationId: undefined, enabled: activeSituation(c), actions: [{ type: "context", context: c.id }],
    trigger: { ...compiled.trigger, once: "event", waitMinutes: 0, unless: [] },
  }, "user", userId, { origin: { kind: "situation", contextId: c.id, name: c.name, ...(manual ? { manual: true } : {}) } });
  return c;
}

/**
 * The rules page saving a 持续跟进 rule as a rule (PUT /api/rules/situation:<id>, the list's switch):
 * the name is its name, on / off is its status, the description is its one sentence, and the trigger,
 * conditions and judging are its start rule. Actions, space and destination stay the host's.
 */
export async function saveSituationAsRule(app: App, userId: string, contextId: string, body: Record<string, unknown>) {
  const c = requireSituation(app, userId, contextId);
  const rule = findRule(app, situationRuleId(c.id));
  const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : undefined);
  const description = text("description");
  const start = body.trigger !== undefined || body.conditions !== undefined || body.judge !== undefined || body.judgeWith !== undefined;
  await saveSituation(app, userId, {
    id: c.id, ...(text("name") ? { name: text("name") } : {}),
    ...(typeof body.enabled === "boolean" ? { status: body.enabled ? "active" : "paused", ...(body.enabled && c.expiresAt && c.expiresAt <= now() ? { expiresAt: null } : {}) } : {}),
    // The list sends the description back as it got it: only a changed one is a new sentence.
    ...(description !== undefined && description !== rule?.description ? { recognize: description } : {}),
    ...(start ? { rule: { trigger: body.trigger ?? rule?.trigger, conditions: body.conditions === undefined ? rule?.conditions ?? null : body.conditions, judge: body.judge ?? rule?.judge, judgeWith: body.judgeWith ?? rule?.judgeWith } as Partial<StartRule> } : {}),
  });
  return findRule(app, situationRuleId(c.id))!;
}

const revision = (c: ListenContext) => sha256(JSON.stringify([c.name, c.note, c.recognize, c.spaceId, c.spec, c.status, c.knobs, c.expiresAt]));
export const activeSituation = (c: ListenContext) => c.status === "active" && (!c.expiresAt || c.expiresAt > now());

registerAskAction("situation-enable", (app, ask, ctx) => {
  if (ask.userId !== OWNER || ask.answeredBy !== OWNER) throw new HttpError(403, "只有本人可以启用持续跟进的规则");
  const c = requireSituation(app, OWNER, String(ctx.contextId));
  if (revision(c) !== ctx.revision) throw new HttpError(409, "这条规则已经修改，请核对后再启用");
  if (ask.choice === 1) return ctx.change ? "持续跟进保留原版。" : "持续跟进保持停用。";
  if (ask.choice !== 0) throw new HttpError(400, "请选择是否启用");
  if (ctx.change) {
    const desired = ctx.change as ContextInput;
    validate(app, OWNER, desired);
    persist(app, OWNER, desired, ctx.compiled as StartRule, !!ctx.manual);
    return `持续跟进「${desired.name}」已更新。`;
  }
  const rule = findRule(app, situationRuleId(c.id));
  if (!rule?.origin) throw new HttpError(409, "这条持续跟进的规则不见了，请重新保存");
  const reply = ctx.reply === "draft" || ctx.reply === "auto" ? ctx.reply : undefined;
  withinTx(app.db, () => {
    saveContext(app, { id: c.id, kind: "situation", status: "active", ...(reply && { knobs: { reply } }), ...(c.expiresAt && c.expiresAt <= now() ? { expiresAt: null } : {}) });
    saveRule(app, { ...rule, temporary: undefined, enabled: true }, "user", OWNER, { origin: rule.origin });
  });
  return `持续跟进「${c.name}」已启用。`;
});

export async function deleteSituation(app: App, userId: string, id: string) {
  const c = requireSituation(app, userId, id);
  const { finishSituation, listSituations } = await import("./instances.ts");
  withinTx(app.db, () => {
    for (const i of listSituations(app, userId, { contextId: c.id, status: "active" })) finishSituation(app, userId, i.id);
    const rule = findRule(app, situationRuleId(id));
    if (rule) deleteRule(app, rule.id, id);
    removeContext(app, id);
  });
  for (const { id: askId } of all<{ id: string }>(app.db, `select id from asks where status='pending' and json_extract(context,'$.handler')='situation-enable' and json_extract(context,'$.contextId')=?`, id)) cancelAsk(app, askId);
}
