import * as lark from "@larksuiteoapi/node-sdk";
import { ask, scheduleIngest } from "../agents/jobs.ts";
import { getRun, waitForRun } from "../agents/runs.ts";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { addNotificationSink } from "../core/notify.ts";
import { findSpace } from "../core/spaces.ts";
import { appendToSource, findSourceByUri } from "../sources/store.ts";

/**
 * Feishu/Lark bot channel. Private chat with the owner is a command channel to
 * the assistant; group chats the bot is in are captured as chat sources (per
 * group → space mapping) and handed to the ingest role in batches.
 */
type Inbound = {
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  mentionsBot: boolean;
  createTime: string;
};

function messageText(raw: string | undefined, type: string | undefined): string {
  if (!raw) return "";
  try {
    const c = JSON.parse(raw);
    if (type === "text") return String(c.text ?? "");
    if (type === "post") {
      const body = c.content ?? c.zh_cn?.content ?? c.en_us?.content ?? [];
      return [c.title, ...body.map((line: { tag: string; text?: string; href?: string }[]) => line.map((n) => n.text ?? n.href ?? "").join(""))].filter(Boolean).join("\n");
    }
    if (type === "image") return "[图片]";
    if (type === "file") return `[文件] ${c.file_name ?? ""}`;
    return `[${type}]`;
  } catch {
    return raw;
  }
}

function kv(app: App, key: string, value?: string) {
  if (value === undefined) return one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value;
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, value);
  return value;
}

export async function startLarkBot(app: App) {
  const cfg = app.config.lark;
  const appSecret = process.env[cfg.appSecretEnv];
  if (!cfg.appId || !appSecret) throw new Error(`需要配置 lark.appId 和环境变量 ${cfg.appSecretEnv}`);
  const client = new lark.Client({ appId: cfg.appId, appSecret, domain: lark.Domain.Feishu });

  const send = async (chatId: string, markdown: string, replyTo?: string) => {
    const card = { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: markdown.slice(0, 28000) }] };
    if (replyTo) await client.im.message.reply({ path: { message_id: replyTo }, data: { msg_type: "interactive", content: JSON.stringify(card) } });
    else await client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) } });
  };

  addNotificationSink(async (n) => {
    const chat = kv(app, "lark_owner_chat");
    if (chat) await send(chat, `**${n.title}**\n${n.body}`);
  });

  const pending = new Map<string, { spaceId: string; sourceId: string; timer: NodeJS.Timeout }>();
  const captureGroup = (m: Inbound) => {
    const map = (findSpace(app, "personal")?.settings.larkGroups ?? {}) as Record<string, string>;
    const spaceId = map[m.chatId] ?? cfg.defaultSpace;
    const uri = `lark:${m.chatId}`;
    const before = findSourceByUri(app, spaceId, uri);
    const at = new Date(Number(m.createTime)).toISOString().slice(0, 16).replace("T", " ");
    const r = appendToSource(app, {
      spaceId,
      kind: "chat",
      uri,
      title: (before?.title as string) ?? `飞书群 ${m.chatId.slice(-6)}`,
      lines: [`[${at}] ${m.senderName || m.senderId}: ${m.text.replace(/\n/g, " ⏎ ")}`],
      meta: { chatId: m.chatId },
    });
    // Debounce: hand a burst of messages to the ingest role once.
    const key = `${spaceId}:${r.id}`;
    const p = pending.get(key);
    if (p) clearTimeout(p.timer);
    pending.set(key, {
      spaceId,
      sourceId: r.id,
      timer: setTimeout(() => {
        pending.delete(key);
        scheduleIngest(app, spaceId, [r.id], "飞书群新消息");
      }, 5 * 60_000),
    });
  };

  const handle = async (m: Inbound) => {
    if (m.chatType === "group") {
      captureGroup(m);
      if (!m.mentionsBot) return;
    }
    if (!cfg.ownerOpenId) {
      await send(m.chatId, `还没有绑定本人。请在 omem 配置中设置 \`lark.ownerOpenId\` 为：\`${m.senderId}\`，然后重启服务。`, m.messageId);
      return;
    }
    if (m.senderId !== cfg.ownerOpenId) return;
    if (m.chatType === "p2p") kv(app, "lark_owner_chat", m.chatId);
    const text = m.text.replace(/@_user_\d+/g, "").trim();
    if (!text) return;
    const { runId } = ask(app, { text, spaceId: cfg.defaultSpace, channel: "lark", externalId: m.chatId });
    const r = await waitForRun(app, runId);
    const answer = r.status === "done" ? String((getRun(app, runId).output as { answer?: string }).answer ?? "") : `处理失败：${r.error ?? r.status}`;
    await send(m.chatId, answer.replace(/\]\(src:[^)]+\)/g, "]").replace(/\]\(mem:[^)]+\)/g, "]"), m.messageId);
  };

  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
    "im.message.receive_v1": async (data: any) => {
      const msg = data.message;
      const m: Inbound = {
        chatId: msg.chat_id,
        chatType: msg.chat_type === "p2p" ? "p2p" : "group",
        messageId: msg.message_id,
        senderId: data.sender?.sender_id?.open_id ?? "",
        senderName: data.sender?.sender_id?.open_id ?? "",
        text: messageText(msg.content, msg.message_type),
        mentionsBot: (msg.mentions ?? []).some((x: { id?: { open_id?: string }; name?: string }) => !x.id?.open_id || x.name === kv(app, "lark_bot_name")),
        createTime: msg.create_time,
      };
      handle(m).catch((e) => console.warn("[omem] 飞书消息处理失败", e));
      return {};
    },
  });
  const ws = new lark.WSClient({ appId: cfg.appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.warn });
  await ws.start({ eventDispatcher: dispatcher });
  console.log("[omem] 飞书机器人已连接");
}
