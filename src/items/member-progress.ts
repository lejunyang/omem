import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { audit } from "../auth/permissions.ts";
import { createAsk, registerAskHandler, reviseAsk } from "../agents/asks.ts";
import { notify } from "../core/notify.ts";
import { findUser, listUsers, OWNER, userName, type User } from "../core/users.ts";
import { HttpError, now, truncate, webLink } from "../core/util.ts";
import { itemAccess } from "./access.ts";
import { recordChange } from "./changes.ts";
import { changeFilter, viewerOf } from "./member-work.ts";
import { addItemEvent, getItem, isClosed, type Item } from "./store.ts";

/**
 * The assistant asks a member, for the owner, how one of the owner's lines or items is going
 * (`ask_member_progress`, docs/v2/multi-user.md “成员的线”). The host checks who may be asked, makes one
 * question that belongs to the member (their 等我的 on the web; their private chat with omem's bot when
 * they have a Feishu identity: the bot's identity, never the owner's), and keeps one open question per
 * item and person: asking again revises it. The answer, word for word, becomes a change of the item
 * (`origin: member`, keyed by the question, so a replay adds nothing) and the owner is told in the
 * not-urgent notifications. “现在说不了” is kept too: the same item is not asked of them again for a while.
 */
export const PROGRESS_HANDLER = "member-progress";
export const UNABLE_OPTION = "现在说不了";
/** After “现在说不了”, the same item is not asked of the same person again for this long. */
export const PROGRESS_COOLDOWN_MS = 3 * 86_400_000;

const COOL = (itemId: string, userId: string) => `member_progress_unable:${itemId}:${userId}`;

/** The person, by omem id or exact name. */
function memberOf(app: App, who: string): User | null {
  return findUser(app, who) ?? listUsers(app).find((u) => u.name === who.trim()) ?? null;
}

/** Whether this person may be asked about this item, and where they open it; throws why not. */
export function checkProgressAsk(app: App, itemId: string, who: string): { item: Item; member: User; link: string } {
  const item = one(app.db, "select 1 from items where id = ?", itemId) ? getItem(app, itemId) : null;
  if (!item) throw new HttpError(404, `没有这件事项：${itemId}`);
  if (item.userId !== OWNER) throw new HttpError(403, "只能问本人自己的线或事项的进展");
  if (isClosed(item.status) || item.status === "candidate") throw new HttpError(409, "这件事已经结束了（或还只是候选），不用再问进展");
  const member = memberOf(app, who);
  if (!member || member.id === OWNER) throw new HttpError(400, `没有这个成员：${who}（写 omem 用户的 id 或名字）`);
  if (member.disabledAt || member.status !== "active" || member.kind !== "person") throw new HttpError(400, `${member.name} 现在不能用 omem`);
  if (member.role === "observer") throw new HttpError(403, `${member.name} 是只读的观察者，不能回答进展`);
  // They read it on the work page (the line, item by item), or as an item they may read.
  const onLine = changeFilter(app, viewerOf(app, member.id))(item.id);
  if (!onLine && !itemAccess(app, member.id, item, "read")) throw new HttpError(403, `${member.name} 读不到「${item.title}」：先让 ta 能读这件事所在的空间`);
  return { item, member, link: webLink(app, onLine ? `#/work/${encodeURIComponent(item.id)}` : `#/items/${encodeURIComponent(item.id)}`) };
}

/** When they last said they cannot say now, if within the cooldown. */
export function unableSince(app: App, itemId: string, userId: string, at = Date.now()) {
  const v = one<{ value: string }>(app.db, "select value from kv where key = ?", COOL(itemId, userId))?.value;
  return v && at - Date.parse(v) < PROGRESS_COOLDOWN_MS ? v : null;
}

const questionText = (app: App, item: Item, question: string, link: string, by: string) =>
  `「${item.title}」的进展：${question.trim()}\n\n[打开这件事](${link})\n\n你的回答会原样记到这件事上，并告诉${userName(app, by)}。`;

/** Ask (or ask again, revising the open question). Checked first; the caller decided it may be sent now. */
export async function askMemberProgress(app: App, input: { itemId: string; member: string; question: string; runId?: string | null; by?: string }) {
  const { item, member, link } = checkProgressAsk(app, input.itemId, input.member);
  const since = unableSince(app, item.id, member.id);
  if (since) throw new HttpError(409, `${member.name} 在 ${since.slice(0, 10)} 说了现在说不了，${PROGRESS_COOLDOWN_MS / 86_400_000} 天内不再问同一件事`);
  const text = questionText(app, item, input.question, link, input.by ?? OWNER);
  const open = one<{ id: string }>(app.db, `select id from asks where status = 'pending' and user_id = ? and json_extract(context, '$.handler') = ?
    and json_extract(context, '$.progressItem') = ? order by created_at desc limit 1`, member.id, PROGRESS_HANDLER, item.id);
  let askId: string, updated = false;
  if (open) {
    await reviseAsk(app, open.id, text);
    askId = open.id;
    updated = true;
  } else {
    // No run on the question: it is the member's, and the owner's run need not be one they may read.
    askId = createAsk(app, {
      runId: null, conversationId: null, userId: member.id, question: text, options: [{ label: UNABLE_OPTION }], allowText: true,
      context: { handler: PROGRESS_HANDLER, progressItem: item.id, askedBy: input.by ?? OWNER, toName: member.name, fromRun: input.runId ?? null },
    }).id;
  }
  audit(app, input.by ?? OWNER, "member-progress.ask", member.id, { itemId: item.id, askId, updated, runId: input.runId ?? null, question: truncate(input.question, 300) });
  return { askId, updated, member: { id: member.id, name: member.name }, item: { id: item.id, title: item.title } };
}

registerAskHandler(PROGRESS_HANDLER, async (app, ask, ctx) => {
  const itemId = String(ctx.progressItem ?? "");
  if (!one(app.db, "select 1 from items where id = ?", itemId)) return;
  const item = getItem(app, itemId);
  const who = userName(app, ask.userId);
  const said = ask.answer?.replace(new RegExp(`^${UNABLE_OPTION}：?`), "").trim() ?? "";
  const asker = typeof ctx.askedBy === "string" ? ctx.askedBy : OWNER;
  if (ask.choice === 0 && !said) {
    run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", COOL(item.id, ask.userId), now());
    addItemEvent(app, item.id, "note", `问了${who}进展，${who}说现在说不了`, "user");
    notify(app, { userId: asker, title: `${who}现在说不了「${truncate(item.title, 30)}」的进展`, body: `${PROGRESS_COOLDOWN_MS / 86_400_000} 天内不再问 ta 这件事。`, urgency: "later", link: `#/work/${item.id}` });
    return;
  }
  run(app.db, "delete from kv where key = ?", COOL(item.id, ask.userId));
  // The answer word for word, once: keyed by this question.
  recordChange(app, { itemId: item.id, type: "info", origin: "member", source: `ask:${ask.id}`, summary: `${who}：${said}`, detail: said, runId: null });
  notify(app, { userId: asker, title: `${who}回了「${truncate(item.title, 30)}」的进展`, body: truncate(said, 1500), urgency: "later", link: `#/work/${item.id}` });
}, (_app, ask, _ctx, by) => {
  if (by !== ask.userId) throw new HttpError(403, "只有被问的人能回答");
});
