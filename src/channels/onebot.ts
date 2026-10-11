import { scheduleIngest } from "../agents/jobs.ts";
import type { App } from "../core/app.ts";
import { addNotificationSink } from "../core/notify.ts";
import { appendToSource } from "../sources/store.ts";
import { answerFromChannel, chunkMessage } from "./common.ts";

/**
 * OneBot v11 channel over a forward WebSocket. QQ (NapCat, LLOneBot, Lagrange)
 * and several WeChat bridges speak this protocol, so one adapter covers them.
 *
 * - Private messages from the owner → assistant; replies go back privately.
 * - Group messages → captured as chat sources (per group) and handed to the
 *   ingest role in batches; an @ of the bot by the owner also gets an answer.
 * - Notifications → the owner's private chat.
 */
type Segment = { type: string; data: Record<string, string> };
type MessageEvent = {
  post_type: string;
  message_type?: "private" | "group";
  self_id?: number;
  user_id?: number;
  group_id?: number;
  message_id?: number;
  raw_message?: string;
  message?: Segment[] | string;
  sender?: { nickname?: string; card?: string };
  time?: number;
};

function plain(e: MessageEvent) {
  if (typeof e.message === "string") return e.message;
  if (!Array.isArray(e.message)) return e.raw_message ?? "";
  return e.message
    .map((s) => (s.type === "text" ? s.data.text : s.type === "at" ? `@${s.data.qq}` : s.type === "image" ? "[图片]" : s.type === "face" ? "" : `[${s.type}]`))
    .join("")
    .trim();
}

export async function startOneBot(app: App) {
  const cfg = app.config.onebot;
  if (!cfg.url) throw new Error("需要配置 onebot.url（例如 ws://127.0.0.1:3001）");
  const token = cfg.tokenEnv ? process.env[cfg.tokenEnv] : undefined;
  let ws: WebSocket | null = null;
  let seq = 0;
  const call = (action: string, params: Record<string, unknown>) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ action, params, echo: String(++seq) }));
  const sendPrivate = (userId: string | number, text: string) => chunkMessage(text, 3000).forEach((part) => call("send_private_msg", { user_id: Number(userId), message: part }));
  const sendGroup = (groupId: number, text: string) => chunkMessage(text, 3000).forEach((part) => call("send_group_msg", { group_id: groupId, message: part }));

  addNotificationSink((n) => {
    if (cfg.ownerUserId) sendPrivate(cfg.ownerUserId, `${n.title}\n${n.body}`);
  });

  const pending = new Map<string, NodeJS.Timeout>();
  const handle = async (e: MessageEvent) => {
    if (e.post_type !== "message") return;
    const text = plain(e);
    if (!text) return;
    const fromOwner = cfg.ownerUserId && String(e.user_id) === String(cfg.ownerUserId);
    if (e.message_type === "group" && e.group_id) {
      const spaceId = cfg.groupSpaces[String(e.group_id)] ?? cfg.defaultSpace;
      const at = new Date((e.time ?? Date.now() / 1000) * 1000).toISOString().slice(0, 16).replace("T", " ");
      const r = appendToSource(app, {
        spaceId,
        kind: "chat",
        uri: `onebot:group:${e.group_id}`,
        title: `${cfg.name} 群 ${e.group_id}`,
        lines: [`[${at}] ${e.sender?.card || e.sender?.nickname || e.user_id}: ${text.replace(/\n/g, " ⏎ ")}`],
      });
      const key = `${spaceId}:${r.id}`;
      clearTimeout(pending.get(key));
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          scheduleIngest(app, spaceId, [r.id], `${cfg.name} 群新消息`);
        }, 5 * 60_000),
      );
      const mentionsBot = Array.isArray(e.message) && e.message.some((s) => s.type === "at" && String(s.data.qq) === String(e.self_id));
      if (fromOwner && mentionsBot) sendGroup(e.group_id, await answerFromChannel(app, { channel: "onebot", chatId: `group:${e.group_id}`, text: text.replace(/@\d+/g, "").trim(), spaceId }));
      return;
    }
    if (e.message_type === "private") {
      if (!cfg.ownerUserId) return sendPrivate(e.user_id!, `还没有绑定本人。请在 omem 配置中设置 onebot.ownerUserId 为 ${e.user_id}，然后重启服务。`);
      if (!fromOwner) return;
      sendPrivate(e.user_id!, await answerFromChannel(app, { channel: "onebot", chatId: `private:${e.user_id}`, text, spaceId: cfg.defaultSpace }));
    }
  };

  const connect = () => {
    ws = new WebSocket(cfg.url!, token ? { headers: { authorization: `Bearer ${token}` } } as never : undefined);
    ws.onopen = () => console.log(`[omem] ${cfg.name}（OneBot）已连接`);
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(String(m.data)) as MessageEvent;
        handle(e).catch((err) => console.warn("[omem] OneBot 消息处理失败", err));
      } catch {}
    };
    ws.onclose = () => setTimeout(connect, 10_000);
    ws.onerror = () => ws?.close();
  };
  connect();
}
