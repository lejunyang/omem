import type { App } from "../core/app.ts";
import { botOfChannel } from "../core/bot-context.ts";
import { identitiesOf, larkOpenIdOf } from "../core/users.ts";
import type { AccountLoginReply } from "../agents/accounts.ts";
import type { Thread } from "../agents/threads.ts";
import { buildCard, larkClientFor, sendEphemeral, sendLark, type CardBlock } from "./lark-send.ts";

export type LoginDestination = { thread?: Thread; replyTo?: string; inThread?: boolean; userId: string; senderId?: string };

const isLark = (thread?: Thread) => thread?.channel === "lark" || thread?.channel.startsWith("lark:");

export function loginDestination(app: App, where: LoginDestination) {
  const thread = isLark(where.thread) ? where.thread : undefined;
  const [chatId] = (thread?.key ?? "").split("#");
  const bot = botOfChannel(thread?.channel);
  const recipient = (thread ? where.senderId : undefined) ?? (bot === "main" ? larkOpenIdOf(app, where.userId)
    : identitiesOf(app, where.userId).find(i => i.channel === thread?.channel && i.kind === "alias")?.external_id);
  return { chatId, bot, recipient, group: !!chatId && (thread?.settings.group === true || !!where.inThread) };
}

export async function sendAiLoginStatus(app: App, where: LoginDestination, text: string) {
  const { chatId, bot, recipient } = loginDestination(app, where);
  if (chatId) {
    await sendLark({ chatId, bot, replyTo: where.replyTo, inThread: where.inThread }, { text });
    return true;
  } else if (recipient) {
    await sendLark({ userId: recipient, bot }, { text });
    return true;
  }
  return false;
}

export async function sendAiLoginCard(app: App, where: LoginDestination, name: string, text: string, reply: AccountLoginReply) {
  const { chatId, bot, recipient, group } = loginDestination(app, where);
  const blocks: CardBlock[] = [{ markdown: text }];
  if (reply.code) blocks.push({ fields: [{ label: "设备码", value: reply.code }] });
  if (reply.url?.startsWith("https://")) blocks.push({ buttons: [{ text: "打开官方授权页", url: reply.url, style: "primary" }] });
  else if (reply.qr) {
    const image = Buffer.from(reply.qr.slice("data:image/png;base64,".length), "base64");
    const uploaded = await larkClientFor(bot).im.image.create({ data: { image_type: "message", image } });
    if (!uploaded?.image_key) throw new Error("飞书二维码上传失败");
    blocks.push({ image: uploaded.image_key, alt: name + " 授权二维码" });
  } else throw new Error("登录没有返回 HTTPS 链接或二维码");
  const card = buildCard({ title: "登录 " + name, blocks });
  if (group) {
    if (!recipient) throw new Error("找不到你在当前飞书机器人的身份");
    // Login challenges are usable by whoever sees them. Feishu's member-only cards are group-level.
    await sendEphemeral(chatId, recipient, card, bot);
    if (where.inThread) await sendAiLoginStatus(app, where, "需要发起人登录 " + name + "。授权卡片已在本群单独发给你，完成后这次运行会继续。").catch(() => {});
  } else if (chatId) {
    await sendLark({ chatId, replyTo: where.replyTo, inThread: where.inThread, bot }, { card });
  } else if (recipient) {
    await sendLark({ userId: recipient, bot }, { card });
  } else throw new Error("没有可发送授权卡片的飞书会话");
}
