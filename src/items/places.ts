import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json, truncate } from "../core/util.ts";
import { accessibleSpaces } from "../core/users.ts";
import { chatName, conclusionOf, scopeOf } from "../agents/run-scope.ts";
import { addMaterials } from "./materials.ts";
import { getItem, type Item } from "./store.ts";

/**
 * One piece of work in several places (docs/v2/awareness.md §3): an item is linked to the
 * conversations and group chats it goes on in. The link is an item material — `conversation` for an
 * omem conversation, `source` for a captured chat no conversation stands for — so the item page, the
 * reviews and delegations of the item and `materials_remove` all see the same thing. A run that
 * writes an item links it to the places of its scope by itself; an agent links or unlinks one with
 * upsert_item's materials_add / materials_remove. Runs in a linked place are told where else the
 * work goes on; runs in a place with no linked item get candidates to judge.
 */
export type Place = { kind: "conversation" | "source"; ref: string };
export type PlaceView = Place & { title: string; spaceId: string | null; lastAt: string | null; summary: string; link: string };

const OPEN = ["open", "waiting", "snoozed"];

/** The places of a run's scope: its conversations, and the chats it works in (their conversation when omem has one, else the captured chat). */
export function placesOfRun(app: App, runId: string): Place[] {
  const out: Place[] = [];
  const add = (p: Place) => { if (!out.some((x) => x.kind === p.kind && x.ref === p.ref)) out.push(p); };
  const keys = scopeOf(app, runId);
  for (const k of keys) if (k.kind === "conversation") add({ kind: "conversation", ref: k.key });
  for (const k of keys) {
    if (k.kind !== "chat") continue;
    const conv = one<{ id: string }>(app.db, "select id from conversations where channel like 'lark%' and status = 'active' and external_id in (?, ?) order by external_id = ? desc, updated_at desc limit 1", k.topic ? `${k.key}#${k.topic}` : k.key, k.key, k.topic ? `${k.key}#${k.topic}` : k.key);
    if (conv) { add({ kind: "conversation", ref: conv.id }); continue; }
    const src = one<{ id: string }>(app.db, "select id from sources where uri = ? and kind = 'chat' and deleted_at is null order by updated_at desc limit 1", `lark:${k.key}`);
    if (src) add({ kind: "source", ref: src.id });
  }
  return out;
}

const isChatSource = (app: App, id: string) => !!one(app.db, "select 1 from sources where id = ? and kind = 'chat'", id);

/** A run wrote the item: link it to the run's places it is not linked to yet. Places the item's owner cannot see are left out. */
export function linkRunPlaces(app: App, runId: string, itemId: string, userId: string): Place[] {
  let item: Item;
  try { item = getItem(app, itemId); } catch { return []; }
  if (item.userId !== userId) return [];
  const linked: Place[] = [];
  for (const p of placesOfRun(app, runId)) {
    if (one(app.db, "select 1 from item_materials where item_id = ? and kind = ? and ref = ?", itemId, p.kind, p.ref)) continue;
    try {
      addMaterials(app, itemId, [{ kind: p.kind, ref: p.ref, note: `运行 ${runId} 在这里处理过这件事（自动关联）` }], userId, "agent");
      linked.push(p);
    } catch {
      // Not the item owner's conversation, or a space they cannot read: no link.
    }
  }
  return linked;
}

/** What a place is now: its name, latest activity and the last thing said or summarized there. */
export function placeView(app: App, p: Place): PlaceView | null {
  if (p.kind === "conversation") {
    const c = one<{ title: string; summary: string; space_id: string; updated_at: string; external_id: string | null; channel: string }>(app.db, "select title, summary, space_id, updated_at, external_id, channel from conversations where id = ?", p.ref);
    if (!c) return null;
    const last = one<{ text: string; created_at: string }>(app.db, "select text, created_at from messages where conversation_id = ? and json_extract(meta, '$.command') is null order by created_at desc limit 1", p.ref);
    const lastAnswer = one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'assistant' order by created_at desc limit 1", p.ref);
    const summary = c.summary.trim() ? c.summary.trim().split("\n").filter((l) => l.trim()).slice(0, 2).join(" ") : (lastAnswer?.text ?? last?.text ?? "");
    const chat = c.channel.startsWith("lark") && c.external_id?.startsWith("oc_") ? c.external_id.split("#") : null;
    const title = c.title || (chat ? `飞书「${chatName(app, chat[0])}」${chat[1] ? "的话题" : ""}` : p.ref);
    return { ...p, title, spaceId: c.space_id, lastAt: last?.created_at ?? c.updated_at, summary: truncate(summary.replace(/\s+/g, " "), 160), link: `#/ask/${p.ref}` };
  }
  const s = one<{ title: string; space_id: string; updated_at: string; text: string }>(app.db, "select title, space_id, updated_at, text from sources where id = ? and deleted_at is null", p.ref);
  if (!s) return null;
  const lastLine = s.text.split("\n").reverse().find((l) => l.trim()) ?? "";
  return { ...p, title: s.title, spaceId: s.space_id, lastAt: s.updated_at, summary: truncate(lastLine.replace(/\s*\(om_[\w-]+\)\s*$/, "").replace(/\s+/g, " "), 160), link: `#/sources/${p.ref}` };
}

/** The places an item goes on in that this reader may see, newest activity first. */
export function itemPlaces(app: App, itemId: string, userId: string): PlaceView[] {
  const allowed = accessibleSpaces(app, userId);
  const rows = all<{ kind: string; ref: string }>(app.db, "select kind, ref from item_materials where item_id = ? and kind in ('conversation','source') order by id", itemId);
  return rows
    .filter((r) => r.kind === "conversation" || isChatSource(app, r.ref))
    .flatMap((r) => placeView(app, { kind: r.kind as Place["kind"], ref: r.ref }) ?? [])
    .filter((v) => !allowed || !v.spaceId || allowed.includes(v.spaceId))
    .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

/** Open items of this person linked to any of these places. */
export function itemsAt(app: App, places: Place[], userId: string, limit = 3): Item[] {
  const convs = places.filter((p) => p.kind === "conversation").map((p) => p.ref);
  const srcs = places.filter((p) => p.kind === "source").map((p) => p.ref);
  if (!convs.length && !srcs.length) return [];
  const ids = all<{ id: string }>(app.db,
    `select distinct i.id from item_materials m join items i on i.id = m.item_id
      where i.user_id = ? and i.status in (${OPEN.map(() => "?").join(",")})
        and ((m.kind = 'conversation' and m.ref in (${convs.map(() => "?").join(",") || "''"})) or (m.kind = 'source' and m.ref in (${srcs.map(() => "?").join(",") || "''"})))
      order by i.updated_at desc limit ?`,
    userId, ...OPEN, ...convs, ...srcs, limit);
  return ids.map((r) => getItem(app, r.id));
}

const placeLine = (v: PlaceView, tz: string) =>
  `  - ${v.kind === "conversation" ? "会话" : "群聊原件"}「${truncate(v.title, 40)}」（${v.kind === "conversation" ? v.ref : `src:${v.ref}`}${v.lastAt ? `，最近 ${new Date(v.lastAt).toLocaleString("zh-CN", { hour12: false, timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}）${v.summary ? `：${v.summary}` : ""}`;

/** “这件事还在这些会话里进行”: for the items linked to this run's places, the other places they go on in; "" when none. */
export function itemPlacesNote(app: App, runId: string, userId: string): string {
  const here = placesOfRun(app, runId);
  const items = itemsAt(app, here, userId);
  const parts: string[] = [];
  for (const item of items) {
    const others = itemPlaces(app, item.id, userId).filter((v) => !here.some((p) => p.kind === v.kind && p.ref === v.ref)).slice(0, 5);
    if (!others.length) continue;
    parts.push([`- 事项 ${item.id}「${truncate(item.title, 60)}」[${item.kind}/${item.status}]`, ...others.map((v) => placeLine(v, app.config.timezone))].join("\n"));
  }
  if (!parts.length) return "";
  return ["# 这件事还在这些会话里进行", "", "这个会话关联的事项，也在下面这些地方进行（最近的一句话或摘要）：", ...parts, "", "read_item 看一件事的全貌（时间线、各会话、工作文件、正在跑的运行）。"].join("\n");
}

// ---- candidates ------------------------------------------------------------------------------

/** Pairs of characters (CJK) and words (latin) of a text, for a cheap “shares words with” score (like the mention triage). */
function grams(text: string) {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) out.add(w);
  const cjk = text.replace(/[^一-鿿]/g, "");
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2));
  return out;
}
const LINK_RE = /https?:\/\/[^\s)）\]"'>]+|\b[A-Z][A-Z0-9]{1,9}-\d{2,}\b|#\d{3,}\b/g;

/** What a place says lately and who says it, for matching items against. */
function placeMaterial(app: App, p: Place): { text: string; people: string[]; lastAt: string | null; source: string | null } {
  if (p.kind === "conversation") {
    const msgs = all<{ text: string; meta: string; created_at: string }>(app.db, "select text, meta, created_at from messages where conversation_id = ? order by created_at desc limit 8", p.ref);
    const people = [...new Set(msgs.flatMap((m) => { const meta = json<Record<string, unknown>>(m.meta, {}); return [meta.speaker, meta.asker].filter((x): x is string => typeof x === "string"); }))];
    const chat = one<{ external_id: string | null }>(app.db, "select external_id from conversations where id = ?", p.ref)?.external_id;
    const source = chat?.startsWith("oc_") ? one<{ id: string }>(app.db, "select id from sources where uri = ? and deleted_at is null", `lark:${chat.split("#")[0]}`)?.id ?? null : null;
    return { text: msgs.map((m) => m.text).join("\n").slice(0, 6000), people, lastAt: msgs[0]?.created_at ?? null, source };
  }
  const s = one<{ text: string; updated_at: string }>(app.db, "select text, updated_at from sources where id = ?", p.ref);
  const lines = (s?.text ?? "").split("\n").filter((l) => l.trim()).slice(-20);
  const people = [...new Set(lines.flatMap((l) => /^\[[^\]]*\]\s*([^:：]{1,20})[:：]/.exec(l)?.[1]?.replace(/（本人）/, "") ?? []))];
  return { text: lines.join("\n").slice(0, 6000), people, lastAt: s?.updated_at ?? null, source: p.ref };
}

export type Candidate = { item: Item; score: number; reasons: string[] };

/**
 * Open items that may be what this run's place is about, for a place no open item is linked to yet:
 * citing the chat, sharing a link or ticket number, naming the same people, sharing words, active at
 * the same time. A guess for the agent to judge, never linked by the host.
 */
export function placeCandidates(app: App, runId: string, userId: string, limit = 3): Candidate[] {
  const here = placesOfRun(app, runId);
  if (!here.length || itemsAt(app, here, userId, 1).length) return [];
  const mats = here.map((p) => placeMaterial(app, p));
  const text = mats.map((m) => m.text).join("\n");
  if (!text.trim()) return [];
  const want = grams(text);
  const links = new Set(text.match(LINK_RE) ?? []);
  const people = [...new Set(mats.flatMap((m) => m.people))].filter((n) => n.length >= 2 && n !== "本人");
  const sources = mats.map((m) => m.source).filter((s): s is string => !!s);
  const lastAt = mats.map((m) => m.lastAt).filter((x): x is string => !!x).sort().at(-1);
  const allowed = accessibleSpaces(app, userId);
  type Row = { id: string; title: string; detail: string; waiting_on: string | null; source_refs: string; space_id: string; updated_at: string };
  const rows = all<Row>(app.db, `select id, title, detail, waiting_on, source_refs, space_id, updated_at from items where user_id = ? and status in (${OPEN.map(() => "?").join(",")}) order by updated_at desc limit 300`, userId, ...OPEN);
  const scored = rows.filter((r) => !allowed || allowed.includes(r.space_id)).map((r) => {
    const body = `${r.title} ${r.detail} ${r.waiting_on ?? ""}`;
    const reasons: string[] = [];
    let score = 0;
    if (sources.some((s) => r.source_refs.includes(`src:${s}`))) { score += 6; reasons.push("引用了这个群的消息"); }
    const sharedLinks = [...links].filter((l) => body.includes(l) || r.source_refs.includes(l));
    if (sharedLinks.length) { score += 5 * sharedLinks.length; reasons.push(`同一个链接或单号（${truncate(sharedLinks[0], 40)}）`); }
    const who = people.filter((n) => body.includes(n));
    if (who.length) { score += 3; reasons.push(`提到同一个人（${who.slice(0, 2).join("、")}）`); }
    const g = grams(body);
    let shared = 0;
    for (const x of want) if (g.has(x)) shared++;
    if (shared >= 3) { score += Math.min(shared, 10); reasons.push(`有 ${shared} 处共同的词`); }
    if (lastAt && Math.abs(Date.parse(r.updated_at) - Date.parse(lastAt)) < 48 * 3600_000 && score > 0) { score += 2; reasons.push("时间相近"); }
    return { id: r.id, score, reasons };
  }).filter((x) => x.score >= 6).sort((a, b) => b.score - a.score).slice(0, limit);
  return scored.map((x) => ({ item: getItem(app, x.id), score: x.score, reasons: x.reasons }));
}

/** “可能是同一件事的事项”, or "". */
export function candidatesNote(app: App, runId: string, userId: string): string {
  const list = placeCandidates(app, runId, userId);
  if (!list.length) return "";
  const conv = placesOfRun(app, runId)[0];
  const ref = conv.kind === "conversation" ? `{kind:"conversation", ref:"${conv.ref}"}` : `{kind:"source", ref:"${conv.ref}"}`;
  return [
    "# 可能是同一件事的在办事项（还没有关联到这里）",
    "",
    "宿主按引用、链接或单号、人、共同的词和时间猜的，不一定对：",
    ...list.map((c) => `- ${c.item.id}「${truncate(c.item.title, 60)}」[${c.item.kind}/${c.item.status}]：${c.reasons.join("，")}`),
    "",
    `读过确认是同一件事，用 upsert_item(id, materials_add=[${ref}]) 关联到这里；不是就不用管。`,
  ].join("\n");
}

// ---- the whole picture -------------------------------------------------------------------------

export type ItemRun = { id: string; kind: string; title: string; status: string; startedAt: string | null; conclusion: string; via: "item" | "place" };

/** Runs under way on the item: those that touched it, and those working in one of its places. */
export function itemRuns(app: App, itemId: string, userId: string): ItemRun[] {
  const places = all<{ kind: string; ref: string }>(app.db, "select kind, ref from item_materials where item_id = ? and kind in ('conversation','source')", itemId);
  // A conversation's runs carry its chat too (run-scope.ts), so the conversation key covers them.
  const chatIds = places.flatMap((p) => {
    if (p.kind === "conversation") return [];
    const uri = one<{ uri: string }>(app.db, "select uri from sources where id = ? and kind = 'chat'", p.ref)?.uri;
    return uri?.startsWith("lark:oc_") ? [uri.slice(5)] : [];
  });
  const convs = places.filter((p) => p.kind === "conversation").map((p) => p.ref);
  const rows = all<{ id: string; kind: string; title: string; status: string; started_at: string | null; output: string; via: string }>(app.db,
    `select r.id, r.kind, r.title, r.status, r.started_at, r.output, case when s.kind = 'item' then 'item' else 'place' end via
       from run_scope s join runs r on r.id = s.run_id
      where r.status in ('queued','running') and coalesce(r.user_id, 'owner') = ?
        and ((s.kind = 'item' and s.key = ?) or (s.kind = 'conversation' and s.key in (${convs.map(() => "?").join(",") || "''"})) or (s.kind = 'chat' and s.key in (${chatIds.map(() => "?").join(",") || "''"})))
      group by r.id order by r.created_at desc limit 10`,
    userId, itemId, ...convs, ...chatIds);
  return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, startedAt: r.started_at, conclusion: conclusionOf(json(r.output, {}), null), via: r.via as ItemRun["via"] }));
}
