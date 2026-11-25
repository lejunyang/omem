import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { OWNER, canWrite } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { updateThread } from "../agents/threads.ts";
import { getContext, larkScopeOf } from "../channels/listen.ts";
import { addMaterials } from "../items/materials.ts";
import { addItemEvent } from "../items/store.ts";
import { instanceOfThread, requireInstance, type SituationInstance } from "./instances.ts";
import { requireSituation } from "./settings.ts";

export function situationOfRun(app: App, runId: string | null, userId: string) {
  if (!runId || userId !== OWNER) return null;
  const row = one<{ lane: string }>(app.db, `select lane from runs where id=? and user_id=? and kind='ask'
    and lane=json_extract(input,'$.conversationId')`, runId, OWNER);
  return row ? instanceOfThread(app, row.lane) : null;
}

export function situationChatScope(app: App, instance: SituationInstance, allowEnded = false) {
  const context = getContext(app, instance.contextId);
  if (context?.kind === "situation" && context.userId === instance.userId && (instance.status === "active" || allowEnded))
    return larkScopeOf(context, instance.chatId);
  return { chats: [], draft: true };
}

export function allowSituationInvite(app: App, runId: string | null, userId: string, input: { invites: { chat_id: string; people?: string[]; bots?: string[] }[]; bots_seen_in?: string[] }) {
  const instance = situationOfRun(app, runId, userId);
  if (!instance) return;
  const [invite] = input.invites;
  if (input.invites.length !== 1 || !situationChatScope(app, instance).chats.includes(invite.chat_id) || invite.people?.length ||
      invite.bots?.length !== 1 || (invite.bots[0] !== "self" && invite.bots[0] !== app.config.lark.appId) || input.bots_seen_in?.length)
    throw new HttpError(403, "持续跟进的处理只能用 lark_invite 把 omem 自己的机器人拉进这一次绑定的群");
}

export function situationSendError(error: unknown, canInvite = true) {
  const detail = error as { code?: number; response?: { data?: { code?: number } }; message?: string };
  if ((detail?.response?.data?.code ?? detail?.code) !== 230002 && !/230002|(?:bot|user).{0,25}(?:not in|out of) (?:the )?chat/i.test(detail?.message ?? "")) return error;
  return new HttpError(400, canInvite ? "机器人不在这一次的群里；用 lark_invite（bots: [\"self\"]）拉 omem 机器人进群再发。" : "机器人不在这一次的群里；本次运行没有 lark_invite，请本人拉 omem 机器人进群后再发。");
}

export function contextForBinding(app: App, instance: SituationInstance) {
  if (instance.status !== "active") throw new HttpError(409, "这一次跟进已经结束");
  if (!canWrite(app, instance.userId, instance.spaceId)) throw new HttpError(403, "不能写这个空间的持续跟进");
  const context = requireSituation(app, instance.userId, instance.contextId);
  if (context.knobs.reply === "none") throw new HttpError(403, "本人没有允许这条持续跟进在群里发，只能私下告诉本人");
  return context;
}

export function bindSituationChat(app: App, instance: SituationInstance, chatId: string, name: string, runId: string) {
  const fresh = requireInstance(app, instance.userId, instance.id);
  const context = contextForBinding(app, fresh);
  run(app.db, "update situation_instances set chat_id=? where id=?", chatId, fresh.id);
  updateThread(app, fresh.conversationId, { settings: { lark: larkScopeOf(context, chatId) } });
  if (fresh.chatId !== chatId) {
    const action = fresh.chatId ? `把这一次的群从 ${fresh.chatId} 换成` : "绑定这一次的群";
    addItemEvent(app, fresh.itemId, "situation-chat", `${action}「${name}」（${chatId}） · [处理运行](#/runs/${runId})`, "agent", [], runId);
  }
}

export async function attachSituationChat(app: App, instance: SituationInstance, chatId: string, runId: string) {
  const uri = `lark:${chatId}`;
  const source = one<{ id: string }>(app.db, `select id from sources where kind='chat' and deleted_at is null
    and (uri=? or uri glob ?) order by (uri=?) desc, uri desc, captured_at limit 1`, uri, `${uri}@*`, uri);
  if (source) await addMaterials(app, instance.itemId, [{ kind: "source", ref: source.id }], instance.userId, "agent", runId);
}
