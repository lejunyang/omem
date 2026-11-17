import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { persistChatMessages, type LarkMessage } from "./lark-messages.ts";
import { chatSpace } from "./lark-personal.ts";

/**
 * Earlier messages of a chat, read by the bot itself (im.message.list): what was said before the bot
 * was asked — before it joined, or while the owner's capture was not in the chat. A bot reads the
 * chats it is a member of; whether history from before it joined is visible is the chat's own
 * setting (“新成员可查看历史消息”). What it reads goes into the chat's source like any capture, so the
 * lines can be cited (`src:…#L…`) and are found by search afterwards.
 */
export type HistoryPage = { sourceId: string | null; lines: { line: number | null; text: string }[]; cursor: string | null; note?: string };

type ApiMessage = {
  message_id?: string; msg_type?: string; create_time?: string; deleted?: boolean; thread_id?: string; parent_id?: string; root_id?: string; chat_id?: string;
  sender?: { id?: string; id_type?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: { key?: string; id?: string; id_type?: string; name?: string }[];
};

/** The space the chat's record lives in: where it already is, else where its messages go. */
export function chatRecordSpace(app: App, chatId: string) {
  return one<{ space_id: string }>(app.db, "select space_id from sources where uri = ? and deleted_at is null order by captured_at limit 1", `lark:${chatId}`)?.space_id ?? chatSpace(app, chatId);
}

function toMessage(app: App, chatId: string, m: ApiMessage): LarkMessage | null {
  if (!m.message_id || m.deleted) return null;
  const senderId = m.sender?.id ?? "";
  const app_ = m.sender?.sender_type === "app" || m.sender?.id_type === "app_id";
  const name = app_ ? undefined : one<{ name: string }>(app.db, "select name from lark_people where bot_open_id = ? and name != ''", senderId)?.name;
  let content: unknown = m.body?.content ?? "";
  // `@_user_1` placeholders read as the names they stand for, as in what the bot captures live.
  if (typeof content === "string" && m.mentions?.length)
    for (const x of m.mentions) if (x.key && x.name) content = (content as string).split(x.key).join(`@${x.name}`);
  return {
    message_id: m.message_id, chat_id: chatId, msg_type: m.msg_type ?? "text", content, create_time: m.create_time ?? String(Date.now()),
    thread_id: m.thread_id || undefined, parent_id: m.parent_id || undefined, root_id: m.root_id || undefined,
    sender: { id: senderId, name, sender_type: app_ ? "app" : "user" },
    mentions: (m.mentions ?? []).map((x) => ({ id: x.id, name: x.name })),
  };
}

/**
 * One page (newest first from `cursor`, shown oldest first) of the chat, or of one topic in it.
 * `client` is the bot's (lark-send.ts larkClient / larkClientFor).
 */
export async function readChatHistory(app: App, client: any, opts: { chatId: string; topicId?: string | null; cursor?: string | null; limit?: number; chatName?: string }): Promise<HistoryPage> {
  if (!client?.im?.message?.list) throw new HttpError(400, "机器人没有连上，读不了群消息");
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 50));
  const r = await client.im.message.list({
    params: {
      container_id_type: opts.topicId ? "thread" : "chat", container_id: opts.topicId ?? opts.chatId,
      sort_type: "ByCreateTimeDesc", page_size: limit, ...(opts.cursor ? { page_token: opts.cursor } : {}),
    },
  });
  if (r?.code) {
    const msg = `${r.code} ${r.msg ?? ""}`.trim();
    throw new HttpError(400, /230027|230002|not in chat|permission/i.test(msg)
      ? `机器人读不了这个群的消息（${msg}）：机器人要在群里，并有读取群消息的权限（im:message.group_msg）`
      : `读取群消息失败：${msg}`);
  }
  const items = ((r?.data?.items ?? []) as ApiMessage[]).filter((m) => !m.chat_id || m.chat_id === opts.chatId || opts.topicId);
  const messages = items.map((m) => toMessage(app, opts.chatId, m)).filter((m): m is LarkMessage => !!m).reverse();
  const cursor = r?.data?.has_more && r?.data?.page_token ? String(r.data.page_token) : null;
  if (!messages.length) return { sourceId: null, lines: [], cursor, note: items.length ? undefined : "没有读到更早的消息：可能是群设置不让新成员看进群前的历史" };
  const spaceId = chatRecordSpace(app, opts.chatId);
  const name = one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null order by captured_at limit 1", `lark:${opts.chatId}`)?.title ?? opts.chatName ?? opts.chatId;
  const saved = persistChatMessages(app, { chatId: opts.chatId, spaceId, name, messages, owner: app.config.lark.ownerOpenId || undefined });
  const ids = messages.map((m) => m.message_id);
  const at = new Map(all<{ message_id: string; line: number; source_id: string }>(app.db, `select message_id, line, source_id from lark_message_lines where message_id in (${ids.map(() => "?").join(",")})`, ...ids)
    .filter((x) => x.source_id === saved.id).map((x) => [x.message_id, x.line]));
  const text = saved.id ? (one<{ text: string }>(app.db, "select text from sources where id = ?", saved.id)?.text ?? "").split("\n") : [];
  return { sourceId: saved.id ?? null, lines: ids.map((id) => { const line = at.get(id) ?? null; return { line, text: line ? text[line - 1] ?? "" : "" }; }).filter((x) => x.text), cursor };
}
