import type { App } from "../core/app.ts";
import { addNotificationSink } from "../core/notify.ts";
import { answerFromChannel, chunkMessage } from "./common.ts";
import { registerThreadSender } from "../agents/inbox.ts";

/**
 * Telegram bot channel (Bot API long polling — no public URL needed). Only the
 * owner's chat may command the assistant; notifications go to that chat.
 */
export async function startTelegram(app: App) {
  const cfg = app.config.telegram;
  const token = process.env[cfg.tokenEnv];
  if (!token) throw new Error(`需要环境变量 ${cfg.tokenEnv}`);
  const api = async (method: string, body: Record<string, unknown> = {}) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json()) as { ok: boolean; result: any; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  };
  const send = async (chatId: string | number, text: string, topic?: number | string) => {
    for (const part of chunkMessage(text, 3900)) await api("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true, ...(topic ? { message_thread_id: Number(topic) } : {}) });
  };
  registerThreadSender("telegram", async (thread, text) => {
    const [chatId, topic] = (thread.key ?? "").split("#");
    if (chatId) await send(chatId, text, topic);
  });
  addNotificationSink(async (n) => {
    if (cfg.ownerChatId) await send(cfg.ownerChatId, `${n.title}\n${n.body}`);
  });
  let botName = "";
  let offset = 0;
  type Msg = {
    message_id: number;
    chat: { id: number; type: string; is_forum?: boolean };
    from?: { id: number };
    text?: string;
    message_thread_id?: number;
    is_topic_message?: boolean;
    reply_to_message?: { from?: { username?: string } };
  };
  const loop = async () => {
    try {
      botName = ((await api("getMe")) as { username: string }).username;
    } catch {}
    for (;;) {
      try {
        const updates = (await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] })) as { update_id: number; message?: Msg }[];
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text) continue;
          const chatId = String(m.chat.id);
          const isGroup = m.chat.type !== "private";
          if (!cfg.ownerChatId) {
            if (!isGroup) await send(chatId, `还没有绑定本人。请在 omem 配置中设置 telegram.ownerChatId 为 ${chatId}，然后重启服务。`);
            continue;
          }
          // The owner's user id equals their private chat id; in groups only their messages that address the bot count.
          if (String(m.from?.id) !== String(cfg.ownerChatId)) continue;
          const addressed = !isGroup || (botName && m.text.includes(`@${botName}`)) || m.reply_to_message?.from?.username === botName || m.text.startsWith("/");
          if (!addressed) continue;
          const topic = m.is_topic_message ? m.message_thread_id : undefined;
          void api("sendChatAction", { chat_id: chatId, action: "typing", ...(topic ? { message_thread_id: topic } : {}) }).catch(() => {});
          answerFromChannel(app, {
            channel: "telegram",
            chatId,
            topicId: topic ? String(topic) : undefined,
            isGroup,
            text: botName ? m.text.replace(`@${botName}`, "").trim() : m.text,
            spaceId: cfg.defaultSpace,
            externalMessageId: String(m.message_id),
          })
            .then((answer) => (answer === null ? undefined : send(chatId, answer || "（没有回答）", topic)))
            .catch((e) => send(chatId, `处理失败：${(e as Error).message}`, topic));
        }
      } catch (e) {
        console.warn("[omem] Telegram 轮询失败：", (e as Error).message);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  void loop();
  console.log("[omem] Telegram 机器人已启动");
}
