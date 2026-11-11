import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import { checkSlug, pageExists, readPage } from "../wiki/store.ts";

/**
 * The owner's work state (docs/v2/work-state.md). Work goes on for days or weeks; the runs that
 * decide what to tell the owner need more than “this hour”. The host gathers facts only — the chats
 * the owner spoke in, documents opened, coding, open items, meetings, what the owner asked omem —
 * and the role work-state writes them up each night as a Wiki page the owner can read and edit
 * (personal/state/work), plus a card for each person the owner deals with (personal/people/<name>).
 * A section headed “本人补充” on any page is the owner's: an agent's rewrite keeps it as it was
 * (keepOwnerSection, applied by write_page).
 */

export const WORK_STATE_SPACE = "personal";
export const WORK_STATE_PAGE = "state/work";
export const PEOPLE_DIR = "people";
export const OWNER_SECTION = "本人补充";
export const SUMMARY_SECTION = "摘要";

const DAY = 86400_000;
const SLUG_BAD = /[^\p{L}\p{N}._-]+/gu;

/** Where a person's card is: people/<name>, with the email's local part when two people share the name. */
export function personSlug(app: App, p: { id?: string | null; name: string; email?: string | null }): string {
  const name = p.name.trim().replace(SLUG_BAD, "-").replace(/^-+|-+$/g, "") || "未命名";
  const same = p.id ? (one<{ n: number }>(app.db, "select count(*) n from lark_people where name = ? and coalesce(cli_open_id, '') != ?", p.name.trim(), p.id)?.n ?? 0) : 0;
  const tag = same ? (p.email?.split("@")[0] ?? p.id?.slice(-6) ?? "").replace(SLUG_BAD, "-") : "";
  return checkSlug(`${PEOPLE_DIR}/${name}${tag ? `-${tag}` : ""}`);
}

// ------------------------------------------------------------------ the owner's section

const HEADING = /^##\s+(.+?)\s*$/gm;

/** A level-2 section of a Markdown body (heading line included), or null. */
export function sectionOf(body: string, title: string): { start: number; end: number; text: string } | null {
  const heads = [...body.matchAll(HEADING)].map((m) => ({ at: m.index!, title: m[1] }));
  const i = heads.findIndex((h) => h.title === title);
  if (i < 0) return null;
  const start = heads[i].at;
  const end = i + 1 < heads.length ? heads[i + 1].at : body.length;
  return { start, end, text: body.slice(start, end).trimEnd() };
}

/**
 * An agent's new body for a page that had the owner's section: that section as it was, where the
 * new body has it (or at the end). Without one before, the new body stands (an agent may open an
 * empty one for the owner).
 */
export function keepOwnerSection(before: string, after: string): string {
  const mine = sectionOf(before, OWNER_SECTION);
  if (!mine) return after;
  const theirs = sectionOf(after, OWNER_SECTION);
  if (theirs) return `${after.slice(0, theirs.start)}${mine.text}\n\n${after.slice(theirs.end).replace(/^\n+/, "")}`.trimEnd();
  return `${after.trimEnd()}\n\n${mine.text}`;
}

// ------------------------------------------------------------------ reading it back

/** The page, or null when there is none yet. */
function pageOrNull(app: App, slug: string) {
  try {
    return pageExists(app, WORK_STATE_SPACE, slug) ? readPage(app, WORK_STATE_SPACE, slug) : null;
  } catch {
    return null;
  }
}

/** The work state in a few hundred characters: the page's 摘要 section (else its summary line), capped. */
export function workStateBrief(app: App, chars = app.config.workState.briefChars): string {
  const p = pageOrNull(app, WORK_STATE_PAGE);
  if (!p) return "";
  const s = sectionOf(p.body, SUMMARY_SECTION);
  const text = (s ? s.text.replace(/^##[^\n]*\n/, "") : String(p.meta.summary ?? "")).trim();
  return text ? `${truncate(text, chars)}\n（整理于 ${String(p.meta.updated ?? p.updatedAt.slice(0, 10))}；全文 read_page(space="personal", page="${WORK_STATE_PAGE}")）` : "";
}

/** When the page last changed (its file time), to tell whether a running conversation saw this version. */
export function workStateStamp(app: App): string | null {
  return pageOrNull(app, WORK_STATE_PAGE)?.updatedAt ?? null;
}

/** A person's card: by their captured id (lark-cli open_id), else by name. */
export function personCard(app: App, who: { id?: string | null; name?: string | null }): { slug: string; title: string; summary: string } | null {
  const known = who.id ? one<{ name: string; email: string | null }>(app.db, "select name, email from lark_people where cli_open_id = ?", who.id) : undefined;
  const name = known?.name || who.name?.trim();
  if (!name) return null;
  for (const slug of [personSlug(app, { id: who.id, name, email: known?.email }), personSlug(app, { name })]) {
    const p = pageOrNull(app, slug);
    if (p) return { slug: p.slug, title: p.meta.title, summary: String(p.meta.summary ?? "") };
  }
  return null;
}

/** One line for where a person is named: their card's summary and where to read it. */
export function personLine(app: App, who: { id?: string | null; name?: string | null }): string {
  const c = personCard(app, who);
  return c ? `${c.summary ? truncate(c.summary, 120) : c.title}（人物卡 personal:${c.slug}）` : "";
}

/** People with cards who wrote in a chat lately, one line each (for a conversation in that chat). */
export function peopleInChat(app: App, chatId: string, limit = 5): string[] {
  const rows = all<{ sender_id: string; sender_name: string }>(
    app.db,
    "select sender_id, max(sender_name) sender_name from lark_messages where chat_id = ? and sender_kind = 'user' and sender_id is not null and create_ms > ? group by sender_id order by count(*) desc limit 30",
    chatId, Date.now() - 14 * DAY,
  );
  const out: string[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const line = personLine(app, { id: r.sender_id, name: r.sender_name });
    if (line) out.push(`- ${r.sender_name}：${line}`);
  }
  return out;
}

