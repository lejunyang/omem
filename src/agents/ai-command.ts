import type { App } from "../core/app.ts";
import { listedModelsOf, saveConfig } from "../core/config.ts";
import { OWNER } from "../core/users.ts";
import { isAiMember, memberAccountPlan } from "./accounts.ts";
import { parseAiSpec, type AiPick, type AiSpec } from "./ai-spec.ts";
import { policyReason } from "./ai-policy.ts";
import { createAsk, registerAskHandler } from "./asks.ts";
import { memberThreadAi, setMemberAi, setMemberThreadAi } from "./member-ai.ts";
import { backendAvailable } from "./availability.ts";
import { userProbe } from "./probe.ts";
import { actorScope, resolveRunProfile } from "./runner.ts";
import { releaseThreadSession, threadActor } from "./sessions.ts";
import { saveAgentSpec } from "./specs.ts";
import { getThread, updateThread, type Thread } from "./threads.ts";
import type { Inbound } from "./inbox.ts";

export type CommandTask = { thread: Thread; task: string; reply?: string; turnAi?: AiPick; notes?: string[] };
type Mode = "chat" | "topic" | "save";

export function checkCommandPick(app: App, thread: Thread, userId: string, pick: AiPick, save: boolean) {
  const { actor } = threadActor(app, thread);
  const p = resolveRunProfile(app, { actor, profileId: pick.profile, model: pick.model, effort: pick.effort });
  if (!backendAvailable(p, app.home)) throw new Error(p.id + " 现在不可用。");
  if (userId !== OWNER) {
    if (!isAiMember(app, userId)) throw new Error("这个账号不能选择 AI。");
    const plan = memberAccountPlan(app, userId, p);
    if (plan.kind === "blocked") throw new Error(plan.reason);
  }
  if (userId !== OWNER || save) {
    const conflict = policyReason(actorScope(app, actor, "ask"), p);
    if (conflict) throw new Error(conflict);
  }
  return p;
}

function applyPick(app: App, thread: Thread, userId: string, pick: AiPick, mode: Mode, rest: string, notes: string[]): string | CommandTask {
  if (!pick.effort && mode !== "save") {
    const effort = userId === OWNER ? thread.settings.effort : memberThreadAi(app, thread, userId).effort;
    if (effort) pick = { ...pick, effort };
  }
  const effective = checkCommandPick(app, thread, userId, pick, mode === "save");
  const named = [pick.profile, pick.model, pick.effort].filter(Boolean).join(" · ");
  if (mode === "chat" && rest) return { thread, task: rest, turnAi: pick, notes };
  if (mode === "save") {
    if (userId !== OWNER) setMemberAi(app, userId, { ...pick, model: pick.model ?? "", effort: pick.effort ?? "" });
    else {
      const { actor } = threadActor(app, thread);
      if ("spec" in actor) saveAgentSpec(app, { name: actor.spec.name, agent: pick.profile, model: effective.model ?? "", effort: effective.effort ?? "" }, "user");
      else {
        const next = structuredClone(app.config);
        next.agents.roles[actor.role] = pick.profile;
        next.agents.roleModels[actor.role] = { ...next.agents.roleModels[actor.role], [pick.profile]: { model: effective.model, effort: effective.effort } };
        saveConfig(next, app.home);
        Object.assign(app.config, next);
      }
    }
    return [...notes, "已保存默认 AI：" + named + "。"].join("\n");
  }
  if (userId === OWNER) {
    thread = updateThread(app, thread.id, { settings: { profile: pick.profile, model: pick.model ?? null, effort: pick.effort ?? null, ownerNamedAi: true } });
    releaseThreadSession(thread.id);
  } else {
    setMemberThreadAi(app, thread.id, userId, { profile: pick.profile, model: pick.model, effort: pick.effort });
    thread = getThread(app, thread.id);
  }
  if (mode === "topic") return { thread, task: rest, notes };
  return [...notes, "你在本会话将使用 " + named + "。"].join("\n");
}

export function applyAiSpec(app: App, thread: Thread, userId: string, spec: AiSpec, mode: Mode): string | CommandTask {
  if (spec.unknown) return spec.unknown;
  if (mode === "save" && spec.rest) return "保存默认 AI 时请只写后端、模型和强度。";
  if (spec.ambiguous) {
    const options = spec.ambiguous;
    const profileId = options[0].profile;
    const names = userProbe(app, userId, profileId)?.modelNames ?? (profileId.includes("@") ? listedModelsOf(profileId.split("@")[1])?.endpoints : undefined);

    createAsk(app, { runId: null, userId, conversationId: thread.id, question: "有几个模型符合，请选择要用的模型。", allowText: false,
      options: options.length <= 6 ? options.map(p => ({ label: names?.[p.model] ?? p.model }))
        : [...options.slice(0, 5).map(p => ({ label: names?.[p.model] ?? p.model })), { label: "更多型号" }], context: { handler: "ai-command", picks: options, mode, rest: spec.rest, notes: spec.notes } });
    return "请选择要用的模型。";
  }
  return applyPick(app, thread, userId, spec.ai!, mode, spec.rest, spec.notes);
}

registerAskHandler("ai-command", async (app, ask, args) => {
  const { deliverToThread, receive } = await import("./inbox.ts");
  const thread = getThread(app, ask.conversationId!);
  const picks = args.picks as NonNullable<AiSpec["ambiguous"]>;
  const mode = args.mode as Mode, rest = String(args.rest), notes = args.notes as string[];
  if (picks.length > 6 && ask.choice === 5) {
    applyAiSpec(app, thread, ask.userId, { ambiguous: picks.slice(5), rest, notes }, mode);
    return;
  }
  const pick = picks[ask.choice!];
  try {
    const r = applyPick(app, thread, ask.userId, pick, mode, rest, notes);
    if (typeof r === "string") await deliverToThread(app, thread.id, r);
    else await receive(app, { conversationId: thread.id, text: r.task, userId: ask.userId, fromAsk: true }, r);
  } catch (e) { await deliverToThread(app, thread.id, "选择 AI 失败：" + (e as Error).message); }
}, (_app, ask, _context, by, answer) => {
  if (by !== ask.userId || answer.choice === null) throw new Error("请由发起人选择一个模型。");
});

export function parseAiCommand(app: App, text: string, userId?: string) {
  const wrapper = /^\/ai(?:\s+|$)/i.test(text);
  let specText = wrapper ? text.replace(/^\/ai\s*/i, "") : text.slice(1);
  const save = wrapper ? /^save\s+/i.test(specText) : /^(\S+)\s+save(?:\s|$)/i.test(specText);
  if (save) specText = wrapper ? specText.replace(/^save\s+/i, "") : specText.replace(/^(\S+)\s+save\b/i, "$1");
  const spec = parseAiSpec(app, specText, { userId });
  if (!spec.ai && !spec.group && !spec.ambiguous && !spec.unknown) return null;
  return { spec, save };
}

export function aiCommand(app: App, thread: Thread, text: string, inb: Inbound) {
  const parsed = parseAiCommand(app, text, inb.userId);
  if (!parsed) return /^\/ai(?:\s+|$)/i.test(text) ? "用法：/ai save 后端 模型 强度，或 /ai off。" : null;
  const { spec, save } = parsed;
  return applyAiSpec(app, thread, inb.userId ?? OWNER, spec, save ? "save" : "chat");
}
