import type { App } from "../core/app.ts";
import { learnBotPerson } from "./lark-people.ts";
import { notify } from "../core/notify.ts";
import { OWNER, larkOpenIdOf, userName } from "../core/users.ts";
import { audit } from "../auth/permissions.ts";
import { getAsk, type Ask } from "../agents/asks.ts";
import { addRunEvent } from "../agents/runs.ts";
import type { Thread } from "../agents/threads.ts";
import { botOfChannel } from "../core/bot-context.ts";
import { larkClientFor, larkOwnerOpenId } from "./lark-send.ts";
import { addChatMembers } from "./lark-invite.ts";
import { postEphemeralAsk } from "./lark-asks.ts";

async function inChat(bot: string, chatId: string, person: string, type: string) {
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await larkClientFor(bot).im.chatMembers.get({ path: { chat_id: chatId },
      params: { member_id_type: type, page_size: 100, page_token: token } });
    if (r.code || !Array.isArray(r.data?.items) || r.data.trigger_security_conf_limit) break;
    if (r.data.items.some((m: {member_id: string}) => m.member_id === person)) return true;
    if (r.data.has_more === false) return false;
    if (!r.data.page_token || r.data.page_token === token) break;
    token = r.data.page_token;
  }
  throw new Error("无法确认群成员名单");
}

/** Only the authenticated command's source thread and the selected credential holder reach this path. */
export async function remindHolderInGroup(app: App, ask: Ask, thread: Thread, runId: string) {
  if (!thread.settings.group || !(thread.channel === "lark" || thread.channel.startsWith("lark:"))) return;
  const chatId = thread.key?.split("#")[0];
  if (!chatId) return;
  const bot = botOfChannel(thread.channel), holder = ask.userId;
  const mainId = holder === OWNER ? larkOwnerOpenId(app, "main") : larkOpenIdOf(app, holder);
  const mainPerson = () => mainId ? learnBotPerson(app, larkClientFor("main"), mainId) : null;
  const target = bot === "main" ? mainId : holder === OWNER ? larkOwnerOpenId(app, bot) : (await mainPerson())?.userId;
  if (!target) return;
  const type = target.startsWith("ou_") ? "open_id" : "user_id";
  const pending = () => getAsk(app, ask.id).status === "pending";
  if (!await inChat(bot, chatId, target, type)) {
    if (!pending()) return;
    try {
      const r = await larkClientFor(bot).im.chatMembers.create({ path: { chat_id: chatId },
        params: { member_id_type: type, succeed_type: 1 }, data: { id_list: [target] } });
      if (r.data?.pending_approval_id_list?.includes(target)) throw new Error("等待群管理员批准");
      if (r.code || !r.data || r.data.invalid_id_list?.length || r.data.not_existed_id_list?.length)
        throw new Error(`群拒绝加入（${r.code || "成员不可用"}）`);
    } catch (error) {
      addRunEvent(app, runId, "status", { text: `机器人拉持有人进群失败：${(error as Error).message}`, askId: ask.id });
      if (!app.config.credentials.confirm.inviteAsOwner || !pending()) return;
      const person = await mainPerson();
      const id = person?.cliOpenId || person?.userId;
      if (!id) throw new Error("缺少本人身份可用的持有人飞书标识");
      if (!app.config.credentials.confirm.inviteAsOwner || !pending()) return;
      let result = "加入失败";
      try {
        const added = await addChatMembers(chatId, person.cliOpenId ? "open_id" : "user_id", [id]);
        if (added.pending.length) result = "等待群管理员批准";
        else if (!added.invalid.length && !added.notExisted.length) result = "已加入";
      } finally {
        audit(app, OWNER, "credentials.confirm.invite", chatId, { askId: ask.id, runId, holder, result });
        notify(app, { userId: OWNER, title: "凭据确认使用了你的身份邀请持有人",
          body: `${userName(app, holder)} · ${thread.title || "来源群"}（${chatId}） · ${result}。确认编号 ${ask.id}。`, link: `#/runs/${runId}` });
      }
      if (result !== "已加入") return;
    }
  }
  if (pending()) await postEphemeralAsk(app, ask, chatId, bot, target);
}
