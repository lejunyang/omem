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

export const situationRuleId = (id: string) => `situation:${id}`;
export type SituationInput = Pick<ContextInput, "id" | "name" | "note" | "recognize" | "spec" | "spaceId" | "knobs" | "status" | "expiresAt">;

export function requireSituation(app: App, userId: string, id: string) {
  const c = getContext(app, id);
  if (!c || c.kind !== "situation" || c.userId !== userId || userId !== OWNER) throw new HttpError(404, "没有这个情境");
  return c;
}

function validate(app: App, userId: string, proposed: SituationInput) {
  if (userId !== OWNER) throw new HttpError(403, "只有本人可以设置情境");
  const before = proposed.id ? requireSituation(app, userId, proposed.id) : null;
  const name = (proposed.name ?? before?.name ?? "").trim();
  const note = (proposed.note ?? before?.note ?? "").trim();
  const recognize = (proposed.recognize ?? before?.recognize ?? "").trim();
  const spaceId = (proposed.spaceId === undefined ? before?.spaceId : proposed.spaceId) ?? "personal";
  const space = findSpace(app, spaceId);
  if (!space || space.kind === "worktree") throw new HttpError(400, "情境需要一个可写的空间");
  if (!canWrite(app, userId, spaceId)) throw new HttpError(403, "不能修改这个空间的情境");
  if (!name || name.length > 80 || !note || note.length > 2000 || !recognize || recognize.length > 1000) throw new HttpError(400, "请填写情境名（80 字以内）、说明（2000 字以内）和怎么认出来（1000 字以内）");
  if (proposed.expiresAt && !Number.isFinite(Date.parse(proposed.expiresAt))) throw new HttpError(400, "停用时间不正确");
  return { before, name, note, recognize, spaceId };
}

/** Stage the compiled trigger before touching either row. The host, not the compiler, picks the action. */
export async function saveSituation(app: App, userId: string, input: SituationInput, opts: { currentChat?: string | null; confirmation?: { runId: string; conversationId: string } } = {}) {
  const { before, name, note, recognize, spaceId } = validate(app, userId, input);
  const id = before?.id ?? newId("ctx");
  const ruleId = situationRuleId(id);
  const oldRule = findRule(app, ruleId);
  let compiled: Pick<Rule, "trigger" | "conditions" | "judge" | "judgeWith">;
  if (oldRule && before?.recognize === recognize) compiled = oldRule;
  else {
    const { draftRule } = await import("../rules/compile.ts");
    const r = await draftRule(app, recognize, undefined, id);
    if (!r.rule) throw new HttpError(422, r.error ?? "没有认出开始信号的规则");
    const parsed = ruleInputSchema.parse(r.rule);
    compiled = { ...parsed, conditions: currentChatIn(parsed.conditions, opts.currentChat ?? null) };
  }
  if (!["message", "doc", "object", "omem"].includes(compiled.trigger.event)) throw new HttpError(422, "开始信号要来自新消息、文档变化、对象变化或 omem 里的事件");
  const desired: ContextInput = { ...input, id, kind: "situation", name, note, recognize, spaceId,
    status: input.status ?? before?.status ?? "active", ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}) };
  const reply = desired.knobs?.reply;
  const previousReply = before?.knobs.reply ?? "none";
  const replyLine = `在这一回的群里：${reply !== undefined && reply !== previousReply ? `${REPLY_LABEL[previousReply]} → ` : ""}${REPLY_LABEL[reply ?? previousReply]}`;
  const c = withinTx(app.db, () => {
    if (before && revision(requireSituation(app, userId, id)) !== revision(before)) throw new HttpError(409, "情境已改，请重读再保存");
    if (before && opts.confirmation) return before;
    return persist(app, userId, opts.confirmation ? { ...desired, status: "paused", knobs: { ...desired.knobs, reply: "none" } } : desired, compiled);
  });
  for (const { id: askId } of all<{ id: string }>(app.db, `select id from asks where status='pending' and json_extract(context,'$.handler')='situation-enable' and json_extract(context,'$.contextId')=?`, id)) cancelAsk(app, askId);
  const confirmation = opts.confirmation ? createAsk(app, {
    ...opts.confirmation, userId, question: [before ? `应用情境「${name}」的改动吗？` : `启用情境「${name}」吗？`, replyLine, `说明：${note}`, `怎么认出来：${recognize}`, ...(before ? [`原说明：${before.note}`] : [])].join("\n\n"),
    options: before ? [{ label: "应用改动" }, { label: "保留原版" }] : [{ label: "启用情境" }, { label: "先不启用" }], allowText: false,
    context: { handler: "situation-enable", contextId: id, revision: revision(c), ...(before ? { change: desired, compiled: { trigger: compiled.trigger, conditions: compiled.conditions, judge: compiled.judge, judgeWith: compiled.judgeWith } } : { reply }), afterReply: true, spaceId },
  }) : null;
  return { context: c, proposed: { name, note, recognize }, previousNote: before?.note ?? null, replyLine, confirmation };
}

function persist(app: App, userId: string, desired: ContextInput, compiled: Pick<Rule, "trigger" | "conditions" | "judge" | "judgeWith">) {
  const c = saveContext(app, desired);
  saveRule(app, { ...compiled, id: situationRuleId(c.id), temporary: undefined, name: `情境：${c.name}`.slice(0, 60), description: c.recognize!,
    // Ownership and execution space belong to the situation, not the event's group.
    spaceId: undefined, conversationId: undefined, enabled: activeSituation(c), actions: [{ type: "context", context: c.id }],
    trigger: { ...compiled.trigger, once: "event", waitMinutes: 0, unless: [] },
  }, "user", userId, { origin: { kind: "situation", contextId: c.id, name: c.name } });
  return c;
}

const revision = (c: ListenContext) => sha256(JSON.stringify([c.name, c.note, c.recognize, c.spaceId, c.spec, c.status, c.knobs, c.expiresAt]));
export const activeSituation = (c: ListenContext) => c.status === "active" && (!c.expiresAt || c.expiresAt > now());

registerAskAction("situation-enable", (app, ask, ctx) => {
  if (ask.userId !== OWNER || ask.answeredBy !== OWNER) throw new HttpError(403, "只有本人可以启用情境");
  const c = requireSituation(app, OWNER, String(ctx.contextId));
  if (revision(c) !== ctx.revision) throw new HttpError(409, "情境已经修改，请核对后再启用");
  if (ask.choice === 1) return ctx.change ? "情境保留原版。" : "情境保持停用。";
  if (ask.choice !== 0) throw new HttpError(400, "请选择是否启用");
  if (ctx.change) {
    const desired = ctx.change as ContextInput;
    validate(app, OWNER, desired);
    persist(app, OWNER, desired, ctx.compiled as Pick<Rule, "trigger" | "conditions" | "judge" | "judgeWith">);
    return `情境「${desired.name}」已更新。`;
  }
  const rule = findRule(app, situationRuleId(c.id));
  if (!rule?.origin) throw new HttpError(409, "情境的规则不见了，请重新保存");
  const reply = ctx.reply === "draft" || ctx.reply === "auto" ? ctx.reply : undefined;
  withinTx(app.db, () => {
    saveContext(app, { id: c.id, kind: "situation", status: "active", ...(reply && { knobs: { reply } }), ...(c.expiresAt && c.expiresAt <= now() ? { expiresAt: null } : {}) });
    saveRule(app, { ...rule, temporary: undefined, enabled: true }, "user", OWNER, { origin: rule.origin });
  });
  return `情境「${c.name}」已启用。`;
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
