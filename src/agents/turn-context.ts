import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import type { RunContext } from "./runs.ts";
import { contextOfConversation, itemContext } from "../channels/listen.ts";
import { itemFlow, itemStages } from "../flows/store.ts";
import { candidatesAt, itemsAt, placesOfRun } from "../items/places.ts";
import { canReadItem, findItem, getItem, isClosed, type Item } from "../items/store.ts";
import { lineLike, rootOf } from "../items/tree.ts";
import { addScope, scopeOf } from "./run-scope.ts";
import type { Thread, ThreadMessage } from "./threads.ts";
import { handlingText } from "../core/handling.ts";
import { lineChoices } from "../items/choices.ts";
import { truncate } from "../core/util.ts";

export type TurnContext = {
  conversationId: string | null;
  chat?: { chatId: string; threadId?: string };
  item?: { id: string; title: string; via: "explicit" | "linked" };
  line?: { id: string; title: string; phase?: string };
  listen?: { id: string; name: string };
  stage?: { id: string; name: string; state: string };
  candidates: { itemId: string; title: string; reason: string }[];
  /** What other paths already made of the message this turn answers (core/handling.ts), in a line; only when there is any. */
  handled?: string;
  /** The owner's latest choices on this line's proposals (items/choices.ts), a few short lines; only when there are any. */
  choices?: string[];
};

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
export function itemFocus(app: App, item: Item, via: "explicit" | "linked", flow = itemFlow(app, item.id)) {
  const root = item.parentId ? getItem(app, rootOf(app, item.id)) : item;
  const line = canReadItem(app, root, item.userId) && lineLike(app, root) ? root : undefined;
  const listen = line && itemContext(app, line.id);
  const stages = flow && !flow.endedAt ? itemStages(app, item.id) : [];
  const active = flow?.definition.stages.find(d => stages.some(s => s.id === d.id && ["doing", "blocked", "gated"].includes(s.state)));
  const stage = stages.find(s => s.id === active?.id);
  const context: TurnContext = {
    conversationId: null, candidates: [],
    item: { id: item.id, title: item.title, via },
    line: line && { id: line.id, title: line.title, phase: isClosed(line.status) ? "ended" : line.phase ?? "active" },
    listen: listen ? { id: listen.id, name: listen.name } : undefined,
    stage: active && stage && { id: active.id, name: active.name, state: stage.state },
  };
  // The person's latest choices on this line's proposals (items/choices.ts): what not to propose again.
  const top = line ?? item;
  const choices = lineChoices(app, item.userId, top.id, [...new Set([item.id, top.id])], [top.title, item.title]);
  if (choices.length) context.choices = choices;
  return { context, item, line, listen, stage, flow, stages };
}

export function explicitItemFocus(app: App, id: string | null | undefined, userId: string) {
  const item = id ? findItem(app, id) : undefined;
  return item && canReadItem(app, item, userId) ? itemFocus(app, item, "explicit") : undefined;
}

function cardItem(app: App, messageId: string, userId: string) {
  const card = one<{ id: string }>(app.db, `select json_extract(payload,'$.itemId') id from card_interactions where message_id=?
    and purpose='agent' and json_extract(payload,'$.itemId') is not null order by created_at desc limit 1`, messageId);
  return card?.id ?? one<{ id: string }>(app.db, `select json_extract(context,'$.entityId') id from notifications
    where (json_extract(context,'$.pushed.messageId')=? or json_extract(context,'$.larkMessageId')=?)
      and user_id=? and json_extract(context,'$.entity')='item' order by at desc limit 1`, messageId, messageId, userId)?.id;
}

export function resolveTurn(app: App, runId: string, thread: Thread, messages: ThreadMessage[], userId: string) {
  const keys = scopeOf(app, runId);
  const here = placesOfRun(app, runId, keys, userId);
  const chat = keys.find(k => k.kind === "chat");
  const linked = itemsAt(app, here, userId, 4, true);
  const listening = thread.channel === "listen" ? contextOfConversation(app, thread.id) : null;
  let explicit: string | undefined;
  for (const m of [...messages].reverse()) {
    if (m.meta.asker || m.meta.speaker) continue;
    const quote = m.meta.quote as { messageId?: string } | undefined;
    explicit = typeof m.meta.itemId === "string" ? m.meta.itemId : quote?.messageId ? cardItem(app, quote.messageId, userId) : undefined;
    if (!explicit && typeof m.meta.topicRootId === "string") explicit = cardItem(app, m.meta.topicRootId, userId);
    if (explicit) break;
  }
  explicit ??= thread.settings.itemId ?? listening?.itemId ?? (chat?.topic ? cardItem(app, chat.topic, userId) : undefined);
  if (!explicit && thread.parentId) {
    // Older work conversations kept the assignment on the run or its item material.
    explicit = one<{ id: string }>(app.db, `select coalesce(json_extract(r.input,'$.itemId'), m.item_id) id
      from runs r left join item_materials m on m.kind='run' and m.ref=r.id
      where json_extract(r.output,'$.agentWork.workConversationId')=?
        and (json_extract(r.input,'$.itemId') is not null or m.item_id is not null)
      order by r.created_at desc, r.id, m.id limit 1`, thread.id)?.id;
  }
  const linkedItem = linked.at(0);
  const focus = explicitItemFocus(app, explicit, userId) ?? (linkedItem && itemFocus(app, linkedItem, "linked"));
  const item = focus?.item;
  const context: TurnContext = {
    ...focus?.context,
    conversationId: thread.id,
    ...(chat && { chat: { chatId: chat.key, threadId: chat.topic || undefined } }),
    candidates: item ? linked.filter(i => i.id !== item.id).slice(0, 3).map(i => ({ itemId: i.id, title: i.title, reason: "这个会话也挂在它上面" }))
      : candidatesAt(app, here, userId).map(c => ({ itemId: c.item.id, title: c.item.title, reason: c.reasons.join("，") })),
  };
  // The message this turn answers, when other paths saw it too: who took it, what it became (short).
  const trigger = [...messages].reverse().find(m => typeof m.meta.externalId === "string")?.meta.externalId as string | undefined;
  const handled = trigger ? handlingText(app, trigger, 4, ["direct"]) : "";
  if (handled) context.handled = truncate(handled, 300);
  if (context.item) addScope(app, runId, "item", context.item.id, "", "input");
  if (context.line) addScope(app, runId, "item", context.line.id, "", "input");
  return { context, here, linked, listening, focus };
}
export type ResolvedTurn = ReturnType<typeof resolveTurn>;
