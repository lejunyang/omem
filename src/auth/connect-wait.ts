import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { json, now, webLink } from "../core/util.ts";
import { findUser, OWNER, userName } from "../core/users.ts";
import { featuresOf, grantedFeatures, LARK_DOC_READ_SCOPE, LARK_LEGACY_DOC_SCOPE, LARK_LEGACY_WIKI_SCOPE, LARK_WIKI_COPY_SCOPE, scopesFor } from "./features.ts";
import { findConnection } from "./vault.ts";

/**
 * A member's run needed Feishu as them and could not (not connected, the connection expired, a
 * feature or scope not granted). Instead of “去账号页连接”, they get a link that opens the login page
 * with what is missing already ticked; the request is remembered, and once their authorization comes
 * back with it, the conversation it came from goes on by itself (an `[授权]` turn, like an answer).
 */
type Waiting = { conversationId: string; features: string[]; scopes: string[]; reason: string; at: string; runId?: string; offeredFeatures?: string[]; offeredScopes?: string[]; noticeId?: string };
/** A request older than this is not picked up again: the person has moved on. */
const KEEP_MS = 6 * 3600_000;
const key = (userId: string) => `connect_wait:${userId}`;
const legacyRead = `读取飞书文档缺少飞书权限 ${LARK_LEGACY_DOC_SCOPE}`;
const legacyCopy = `以本人身份复制飞书文档缺少飞书权限 ${LARK_LEGACY_WIKI_SCOPE}`;

function waiting(app: App, userId: string): Waiting[] {
  const list = json<Waiting[]>(one<{ value: string }>(app.db, "select value from kv where key = ?", key(userId))?.value, []);
  return list.filter((w) => Date.now() - Date.parse(w.at) < KEEP_MS);
}
function save(app: App, userId: string, list: Waiting[]) {
  if (!list.length) run(app.db, "delete from kv where key = ?", key(userId));
  else run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key(userId), JSON.stringify(list.slice(-10)));
}

const knownFeatures = (features: string[]) => [...new Set(features)].filter((f) => featuresOf("lark").some((x) => x.id === f));

/** The page that asks for exactly this: the login page, which also turns features on for someone already logged in. */
export function connectLink(app: App, features: string[], scopes: string[] = []) {
  const q = new URLSearchParams({ provider: "lark" });
  if (features.length) q.set("features", features.join(","));
  if (scopes.length) q.set("scopes", scopes.join(","));
  return webLink(app, `#/login?${q}`);
}

/**
 * Record what the run was refused for and tell the person (a card in their private chat with the link);
 * returns the message for the agent: the link to pass on, and that the work resumes by itself.
 */
export function needConnection(app: App, userId: string, runId: string | null | undefined, what: { features?: string[]; scopes?: string[]; requiredScopes?: string[]; reason: string }) {
  const conversationId = runId ? one<{ c: string | null }>(app.db, "select json_extract(input, '$.conversationId') c from runs where id = ?", runId)?.c : null;
  const list = conversationId ? waiting(app, userId) : [];
  const pending = list.find((w) => w.conversationId === conversationId);
  // Calls in one turn can add requirements. A new turn can be about a different task.
  const previous = pending?.runId === runId ? pending : undefined;
  const alreadyOffered = previous?.offeredFeatures ?? [];
  const coveredScopes = new Set([...scopesFor("lark", alreadyOffered), ...(previous?.offeredScopes ?? [])]);
  const covered = what.requiredScopes?.length && what.requiredScopes.every((s) => coveredScopes.has(s));
  const features = knownFeatures([...alreadyOffered, ...(covered ? [] : what.features ?? [])]);
  const scopes = [...new Set([...(previous?.offeredScopes ?? []), ...(what.scopes ?? [])])];
  const link = connectLink(app, features, scopes);
  const labels = features.map((f) => featuresOf("lark").find((x) => x.id === f)?.label ?? f);
  const asked = [...labels.map((label) => `「${label}」`), ...scopes].join("、") || "飞书";
  const name = userName(app, userId);
  let noticeId = pending?.noticeId;
  if (!noticeId || link !== connectLink(app, pending?.offeredFeatures ?? [], pending?.offeredScopes ?? [])) {
    try {
      noticeId = notify(app, { userId, tone: "warning", title: "飞书授权：助手需要你确认", body: `${what.reason}，需要你给 omem 授权${asked}。打开链接用飞书确认就行${conversationId ? "，授权完成后助手会接着做刚才的事" : ""}。`, link, urgency: "normal", replaces: noticeId }).id;
    } catch { /* A person without a channel still gets the link through the agent's reply. */ }
  }
  if (conversationId) {
    const requiredFeatures = knownFeatures([...(previous?.features ?? []), ...(what.requiredScopes ? [] : what.features ?? [])]);
    const requiredScopes = [...new Set([...(previous?.scopes ?? []), ...(what.requiredScopes ?? what.scopes ?? [])])];
    save(app, userId, [...list.filter((w) => w !== pending), { conversationId, runId: runId ?? undefined, features: requiredFeatures, scopes: requiredScopes, offeredFeatures: features, offeredScopes: scopes, noticeId, reason: what.reason, at: now() }]);
  }
  const linkPart = /^https?:/.test(link) ? `授权链接：${link}` : `授权页面在 omem 网页的 ${link}（omem 没有配置对外网址，链接只能写成这样）`;
  return `${name}${what.reason}，需要授权${asked}。已私聊发给对方；你在回复里也把这个链接给他：${linkPart}。告诉他打开后用飞书确认${conversationId ? "，授权完成后你会自动接着做，不用再说一遍" : "，授权后再让你试一次"}。不要换别的方式绕过。`;
}

/** Their authorization came back: conversations that waited for what it now carries go on. */
export function connectionGranted(app: App, userId: string, provider: string) {
  if (provider !== "lark" || userId === OWNER || findUser(app, userId)?.status !== "active") return;
  const list = waiting(app, userId);
  if (!list.length) return;
  const c = findConnection(app, userId, provider);
  if (!c || c.status !== "active") return;
  const have = new Set(grantedFeatures(provider, c.scopes)), scopes = new Set(c.scopes);
  const ready = list.filter((w) => w.features.every((f) => have.has(f)) && w.scopes.every((s) => {
    if (s === LARK_LEGACY_DOC_SCOPE && w.reason === legacyRead) return scopes.has(LARK_DOC_READ_SCOPE) || scopes.has(s);
    if (s === LARK_LEGACY_WIKI_SCOPE && w.reason === legacyCopy) return scopes.has(LARK_WIKI_COPY_SCOPE) || scopes.has(s);
    return scopes.has(s);
  }));
  save(app, userId, list.filter((w) => !ready.includes(w)));
  for (const w of ready) {
    void import("../agents/inbox.ts")
      .then(({ receive }) => receive(app, { conversationId: w.conversationId, text: `[授权] ${userName(app, userId)}已在飞书完成授权。接着做刚才因为没有授权没做成的事（${w.reason}），做完照常回复。`, userId, fromAsk: true }))
      .catch((e) => console.warn(`[omem] 授权后接着做没有开始：${(e as Error).message}`));
  }
}
