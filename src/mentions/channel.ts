import type { App } from "../core/app.ts";

/**
 * What a chat channel tells 有人找你 (docs/v2/mentions.md “渠道”). The flow itself — the free
 * checks, the wait for rules and the ingest run, the daily limits, the triage, the handling and its
 * fallbacks — is the same for every channel (mentions.ts, triage.ts); a channel only knows its own
 * messages, who read them, what took them, and how an answer to the asker goes out. Feishu is the
 * one channel (src/channels/lark-mentions.ts).
 */

/** A message looking for the owner, as stored (its chat line is its citation). */
export type MentionMessage = {
  id: string;
  sender: string;
  senderId: string | null;
  atMs: number;
  text: string;
  topicId: string | null;
  /** The message it quoted (who: what), when it quoted one. */
  quoted: string | null;
  /** The chat source the message's line is in, and the line (`src:<id>#L<n>`). */
  sourceId: string | null;
  ref: string | null;
};

export type MentionChat = { id: string; name: string; kind: "p2p" | "group" };

/** What a handling may do with an answer to the asker: from the settings and the triage. */
export type ReplyMode = "off" | "draft" | "auto";

/** A reply sent to the asker (run output `mentionReply`). */
export type Replied = {
  via: string; by: "auto" | "owner"; at: string; messageId: string | null; chatId: string; where: string;
  /** A send whose result is checked afterwards (Feishu through Doubao): false when it did not go out as written. */
  ok?: boolean; problem?: string;
};

/** A handling's view of what it handles (run input `mention`). */
export type MentionInfo = {
  /** The channel (MentionChannel.id); runs queued before the channels were split have none and are Feishu's. */
  channel?: string;
  /** The mention run that triaged it. */
  from: string;
  chatId: string;
  chatName: string;
  chatKind: "p2p" | "group";
  topicId: string | null;
  messageIds: string[];
  /** The message a group reply goes under (the newest one). */
  lastMessageId: string;
  senderId: string | null;
  senderName: string;
  /** Citations of the messages (chat lines). */
  refs: string[];
  reply: ReplyMode;
  urgency: "normal" | "urgent";
  what: string;
};

export type MentionChannel = {
  /** Short id ("lark"): runs carry it, and `${id}-mention` is its key in handled_messages. */
  id: string;
  /** How the owner calls it in text (“飞书”). */
  label: string;
  /** The stored messages with their citations, oldest first; ids not stored are left out. */
  messages(app: App, ids: string[]): MentionMessage[];
  /** The space the chat's messages are kept in. */
  spaceOf(app: App, chatId: string, messageId: string): string;
  /** The owner read the message, reacted to it or answered after it (only the signals `skipWhen` counts). */
  ownerSeen(app: App, m: MentionMessage, skipWhen?: { read?: boolean; reacted?: boolean; replied?: boolean }): Promise<boolean>;
  /** Something of the channel's own took the message (a watched chat, the bot answering it directly). */
  takenElsewhere(app: App, chatId: string, m: MentionMessage): boolean;
  /** The key rules know the message by (rule_firings.event_key, rule_handled.key). */
  ruleKey(messageId: string): string;
  /** For the triage: the talk around the messages (same topic, or the chat), a few lines, oldest first. */
  talkAround(app: App, chatId: string, topicId: string | null, messages: MentionMessage[]): string;
  /** For the triage: who sent it, as far as the channel knows (how often they write, whether one-to-one). */
  senderLine(app: App, m: MentionMessage): string;
  /** Lines of these sources handed to 有人找你 since `since` (the ingest run leaves telling the owner about them to it). */
  handedLines(app: App, sourceIds: string[], since: string): string[];
  /** The owner's own conversation with omem on this channel: a handling's home, so a reply to its reminder carries on there. */
  ownerConversation(app: App): string | null;
  /** How to read more, for the handler's task (documents the messages link to, say). */
  readHint: string;
  /** Answering the asker. A channel without it: the reply is only ever suggested in the reminder. */
  reply?: {
    /** The owner's setting for this kind of chat. */
    mode(app: App, kind: "p2p" | "group"): ReplyMode;
    /** How a reply goes out there, in a sentence (for the handler's task and the draft). */
    how(app: App, m: Pick<MentionInfo, "chatKind" | "senderName">): string;
    /** Send it now: the handler under the owner's standing permission (auto), or the owner from a draft. */
    send(app: App, runId: string, text: string, by: "auto" | "owner"): Promise<Replied & { note: string }>;
    /** Put it before the owner to send (or not); returns the draft's id. */
    draft(app: App, runId: string, m: MentionInfo, text: string): Promise<string>;
  };
};

const channels = new Map<string, MentionChannel>();

/** A channel registers itself when its module loads. */
export function registerMentionChannel(c: MentionChannel) {
  channels.set(c.id, c);
}

export function mentionChannel(id: string | undefined): MentionChannel {
  // Runs and handlings from before the channels were split carry no channel: they are Feishu's.
  const c = channels.get(id ?? "lark");
  if (!c) throw new Error(`“有人找你”没有渠道 ${id}`);
  return c;
}

export function mentionChannels() {
  return [...channels.values()];
}

/** The channel's key in handled_messages. */
export const handledKey = (c: Pick<MentionChannel, "id">) => `${c.id}-mention`;
