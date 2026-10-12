import type { App } from "../core/app.ts";
import { addNotificationSink } from "../core/notify.ts";
import { answerFromChannel, chunkMessage } from "./common.ts";

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
  const send = async (chatId: string | number, text: string) => {
    for (const part of chunkMessage(text, 3900)) await api("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true });
  };
  addNotificationSink(async (n) => {
    if (cfg.ownerChatId) await send(cfg.ownerChatId, `${n.title}\n${n.body}`);
  });
  let offset = 0;
  const loop = async () => {
    for (;;) {
      try {
        const updates = (await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] })) as { update_id: number; message?: { chat: { id: number }; text?: string } }[];
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text) continue;
          const chatId = String(m.chat.id);
          if (!cfg.ownerChatId) {
            await send(chatId, `还没有绑定本人。请在 omem 配置中设置 telegram.ownerChatId 为 ${chatId}，然后重启服务。`);
            continue;
          }
          if (chatId !== String(cfg.ownerChatId)) continue;
          void api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
          answerFromChannel(app, { channel: "telegram", chatId, text: m.text, spaceId: cfg.defaultSpace })
            .then((answer) => send(chatId, answer || "（没有回答）"))
            .catch((e) => send(chatId, `处理失败：${(e as Error).message}`));
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
