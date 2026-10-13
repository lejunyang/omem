import * as lark from "@larksuiteoapi/node-sdk";
import { scheduleIngest } from "../agents/jobs.ts";
import { answerFromChannel } from "./common.ts";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { addNotificationSink } from "../core/notify.ts";
import { findSpace } from "../core/spaces.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFile } from "../sources/import.ts";
import { appendToSource, findSourceByUri, sourceText } from "../sources/store.ts";
import { registerThreadSender } from "../agents/inbox.ts";

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
  /** Topic (话题) the message belongs to: thread_id in topic groups and threaded replies. */
  topicId?: string;
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

  const send = async (chatId: string, markdown: string, replyTo?: string, inThread = false) => {
    const card = { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: markdown.slice(0, 28000) }] };
    if (replyTo) await client.im.message.reply({ path: { message_id: replyTo }, data: { msg_type: "interactive", content: JSON.stringify(card), reply_in_thread: inThread } });
    else await client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) } });
  };

  // Later results for a thread (delegated agents…) go back to the same chat, inside the topic when there is one.
  registerThreadSender("lark", async (thread, markdown) => {
    const [chatId, topic] = (thread.key ?? "").split("#");
    if (!chatId) return;
    await send(chatId, markdown, thread.settings.lastMessageId, !!topic);
  });

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
      lines: [`[${at}${m.topicId ? ` · 话题 ${m.topicId}` : ""}] ${m.senderName || m.senderId}: ${m.text.replace(/\n/g, " ⏎ ")}`],
      meta: { chatId: m.chatId },
    });
    lastCapture.set(m.messageId, { spaceId, sourceId: r.id });
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

  const lastCapture = new Map<string, { spaceId: string; sourceId: string }>();
  /** What was said just before an @mention, in the same topic when there is one. */
  const groupContext = (m: Inbound) => {
    const cap = lastCapture.get(m.messageId);
    lastCapture.delete(m.messageId);
    if (!cap) return "";
    const lines = sourceText(app, cap.sourceId).split("\n").filter(Boolean);
    lines.pop(); // the mention itself
    const pick = m.topicId ? lines.filter((l) => l.includes(`话题 ${m.topicId}]`)) : lines;
    return pick.slice(-15).join("\n");
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
    const context = m.chatType === "group" ? groupContext(m) : "";
    if (!text) return;
    const map = (findSpace(app, "personal")?.settings.larkGroups ?? {}) as Record<string, string>;
    const answer = await answerFromChannel(app, {
      channel: "lark",
      chatId: m.chatId,
      topicId: m.topicId,
      isGroup: m.chatType === "group",
      text,
      spaceId: m.chatType === "group" ? (map[m.chatId] ?? cfg.defaultSpace) : cfg.defaultSpace,
      context,
      contextLabel: m.topicId ? "话题里" : "群里",
      externalMessageId: m.messageId,
    });
    if (answer !== null) await send(m.chatId, answer, m.messageId, !!m.topicId);
  };

  /** Images and files sent to the bot (or in its groups) become sources; the ingest role reads them. */
  const saveResource = async (msg: { message_id: string; message_type: string; content: string }, m: Inbound) => {
    const c = JSON.parse(msg.content || "{}") as { image_key?: string; file_key?: string; file_name?: string };
    const key = c.image_key ?? c.file_key;
    if (!key) return;
    const dir = await mkdtemp(join(tmpdir(), "omem-lark-"));
    try {
      const name = c.file_name ?? `${msg.message_id}.png`;
      const file = join(dir, name.replace(/[\\/]/g, "_"));
      const res = await client.im.messageResource.get({ path: { message_id: msg.message_id, file_key: key }, params: { type: msg.message_type === "image" ? "image" : "file" } });
      await res.writeFile(file);
      const map = (findSpace(app, "personal")?.settings.larkGroups ?? {}) as Record<string, string>;
      const spaceId = m.chatType === "group" ? (map[m.chatId] ?? cfg.defaultSpace) : cfg.defaultSpace;
      const r = importFile(app, spaceId, file, `lark:${m.chatId}/${name}`);
      if (r && r.status !== "unchanged") scheduleIngest(app, spaceId, [r.id], `飞书${m.chatType === "group" ? "群" : "私聊"}附件`);
      if (m.chatType === "p2p") await send(m.chatId, r ? `已保存「${name}」，助理会读取并整理。` : `「${name}」的格式暂不支持。`, m.messageId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
        topicId: msg.thread_id || undefined,
      };
      if ((msg.message_type === "image" || msg.message_type === "file") && (m.chatType === "group" || m.senderId === cfg.ownerOpenId))
        saveResource(msg, m).catch((e) => console.warn("[omem] 飞书附件保存失败", e));
      else handle(m).catch((e) => console.warn("[omem] 飞书消息处理失败", e));
      return {};
    },
  });
  const ws = new lark.WSClient({ appId: cfg.appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.warn });
  await ws.start({ eventDispatcher: dispatcher });
  console.log("[omem] 飞书机器人已连接");
}
