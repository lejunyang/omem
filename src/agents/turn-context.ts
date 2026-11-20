import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { accessibleSpaces } from "../core/users.ts";
import type { RunContext } from "./runs.ts";
import { contextOfConversation, itemContext } from "../channels/listen.ts";
import { itemFlow, itemStages } from "../flows/store.ts";
import { candidatesAt, itemsAt, placesOfRun } from "../items/places.ts";
import { getItem, type Item } from "../items/store.ts";
import { rootOf } from "../items/tree.ts";
import { addScope, chatOfConversation } from "./run-scope.ts";
import type { Thread, ThreadMessage } from "./threads.ts";

export type TurnContext = {
  conversationId: string | null;
  chat?: { chatId: string; threadId?: string };
  item?: { id: string; title: string; via: "explicit" | "linked" };
  line?: { id: string; title: string; phase?: string };
  listen?: { id: string; name: string };
  stage?: { id: string; name: string; state: string };
  candidates: { itemId: string; title: string; reason: string }[];
};

function readable(app: App, item: Item, userId: string) {
  const spaces = accessibleSpaces(app, userId);
  return item.userId === userId && (!spaces || spaces.includes(item.spaceId));
}

const turns = new WeakMap<RunContext, ResolvedTurn>();
export function contextForTurn(ctx: RunContext, thread: Thread, messages: ThreadMessage[], userId: string) {
  let turn = turns.get(ctx);
  if (!turn) {
    turn = resolveTurn(ctx.app, ctx.run.id, thread, messages, userId);
    turns.set(ctx, turn);
    ctx.output({ turnContext: turn.context });
  }
  return turn;
}

/** Shared by a conversation and by the specialist jobs already bound to an item. */
export function itemFocus(app: App, item: Item, via: "explicit" | "linked") {
  const root = getItem(app, rootOf(app, item.id));
  const line = readable(app, root, item.userId) ? root : undefined;
  const listen = line && itemContext(app, line.id);
  const flow = itemFlow(app, item.id);
  const stages = flow && !flow.endedAt ? itemStages(app, item.id) : [];
  const active = flow?.definition.stages.find(d => stages.some(s => s.id === d.id && ["doing", "blocked", "gated"].includes(s.state)));
  const stage = stages.find(s => s.id === active?.id);
  return {
    item: { id: item.id, title: item.title, via },
    line: line && { id: line.id, title: line.title, phase: line.phase ?? "active" },
    listen: listen ? { id: listen.id, name: listen.name } : undefined,
    stage: active && stage && { id: active.id, name: active.name, state: stage.state },
  };
}

function cardItem(app: App, messageId: string, userId: string) {
  return one<{ id: string }>(app.db, `select json_extract(context,'$.entityId') id from notifications
    where (json_extract(context,'$.pushed.messageId')=? or json_extract(context,'$.larkMessageId')=?)
      and user_id=? and json_extract(context,'$.entity')='item' order by at desc limit 1`, messageId, messageId, userId)?.id;
}

export function resolveTurn(app: App, runId: string, thread: Thread, messages: ThreadMessage[], userId: string) {
  const here = placesOfRun(app, runId);
  const chat = chatOfConversation(app, thread.id);
  if (chat) {
    const source = one<{ id: string }>(app.db, "select id from sources where uri=? and kind='chat' and deleted_at is null order by updated_at desc limit 1", `lark:${chat.chatId}`);
    if (source && !here.some(p => p.ref === source.id)) here.push({ kind: "source", ref: source.id });
  }
  const linked = itemsAt(app, here, userId, 4, true);
  const listening = thread.channel === "listen" ? contextOfConversation(app, thread.id) : null;
  let explicit: string | undefined;
  for (const m of [...messages].reverse()) {
    if (m.meta.asker || m.meta.speaker) continue;
    const quote = m.meta.quote as { messageId?: string } | undefined;
    explicit = typeof m.meta.itemId === "string" ? m.meta.itemId : quote?.messageId ? cardItem(app, quote.messageId, userId) : undefined;
    if (explicit) break;
  }
  explicit ??= thread.settings.itemId ?? listening?.itemId ?? (chat?.topic ? cardItem(app, chat.topic, userId) : undefined);
  const explicitItem = explicit && one(app.db, "select 1 from items where id=?", explicit) ? getItem(app, explicit) : undefined;
  const item = explicitItem && readable(app, explicitItem, userId) ? explicitItem : linked[0];
  const context: TurnContext = {
    conversationId: thread.id,
    ...(chat && { chat: { chatId: chat.chatId, threadId: chat.topic || undefined } }),
    ...(item && itemFocus(app, item, item === explicitItem ? "explicit" : "linked")),
    candidates: item ? linked.filter(i => i.id !== item.id).slice(0, 3).map(i => ({ itemId: i.id, title: i.title, reason: "这个会话也挂在它上面" }))
      : candidatesAt(app, here, userId).map(c => ({ itemId: c.item.id, title: c.item.title, reason: c.reasons.join("，") })),
  };
  if (context.item) addScope(app, runId, "item", context.item.id, "", "input");
  if (context.line) addScope(app, runId, "item", context.line.id, "", "input");
  return { context, here, linked, listening };
}
export type ResolvedTurn = ReturnType<typeof resolveTurn>;
