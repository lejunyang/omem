import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import { checkSlug, deletePage, movePages, pageExists, readPage, writePage } from "../wiki/store.ts";

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

const nameSlug = (name: string) => name.trim().replace(SLUG_BAD, "-").replace(/^-+|-+$/g, "") || "未命名";

/**
 * A person's email: the one recorded for their id, else the one email everybody of that name in the
 * address book shares (the same person is often several rows: seen by lark-cli, seen by the bot).
 * `namesakes`: more than one email under the name, so the name alone does not tell who it is.
 */
function personEmail(app: App, p: { id?: string | null; name: string; email?: string | null }): { email: string | null; namesakes: boolean } {
  const emails = all<{ email: string }>(app.db, "select distinct email from lark_people where name = ? and email is not null", p.name.trim()).map((r) => r.email);
  if (p.email) return { email: p.email, namesakes: emails.length > 1 };
  const own = p.id ? one<{ email: string | null }>(app.db, "select email from lark_people where (cli_open_id = ? or bot_open_id = ? or user_id = ?) and email is not null", p.id, p.id, p.id)?.email : null;
  if (own) return { email: own, namesakes: emails.length > 1 };
  return emails.length === 1 ? { email: emails[0], namesakes: false } : { email: null, namesakes: emails.length > 1 };
}

/**
 * Where a person's card is: people/<name>-<the email's local part> (a Feishu email is the one stable
 * name for a person), people/<name> when no email is known; with namesakes and no email, the id's tail.
 */
export function personSlug(app: App, p: { id?: string | null; name: string; email?: string | null }): string {
  const { email, namesakes } = personEmail(app, p);
  const tag = (email ? email.split("@")[0] : namesakes && p.id ? p.id.slice(-6) : "").replace(SLUG_BAD, "-");
  return checkSlug(`${PEOPLE_DIR}/${nameSlug(p.name)}${tag ? `-${tag}` : ""}`);
}

/** The heading the cards folded into one go under, for work-state to fold in (roles/work-state.md). */
export const MERGED_SECTION = "合并进来的旧卡";

/**
 * Cards of one person under different paths (written before personSlug settled on the email) made
 * one: each card goes to the path personSlug gives now; where several land on one path, the longest
 * is kept and the others' bodies are appended under MERGED_SECTION (headings one level down), their
 * paths kept as aliases so links still open. The people involved are marked due for the next night,
 * so work-state folds the old text in. Cards whose path tells nobody (an unknown tail) stay as they are.
 */
export function mergePersonCards(app: App, opts: { dryRun?: boolean } = {}) {
  const rows = all<{ slug: string; title: string }>(app.db, "select slug, title from pages where space_id = ? and slug like ?", WORK_STATE_SPACE, `${PEOPLE_DIR}/%`);
  const groups = new Map<string, { slug: string; ids: string[] }[]>();
  for (const r of rows) {
    const rest = r.slug.slice(PEOPLE_DIR.length + 1);
    if (rest.includes("/")) continue;
    const name = (r.title || rest).trim();
    const tag = rest.startsWith(`${nameSlug(name)}-`) ? rest.slice(nameSlug(name).length + 1) : rest === nameSlug(name) ? "" : null;
    if (tag === null) continue;
    let who: { id?: string | null; name: string; email?: string | null } = { name };
    if (tag) {
      const byEmail = one<{ email: string; cli_open_id: string | null }>(app.db, "select email, cli_open_id from lark_people where email like ? escape '\\' and name = ?", `${tag.replace(/[%_\\]/g, "\\$&")}@%`, name);
      const byId = byEmail ? undefined : one<{ email: string | null; cli_open_id: string }>(app.db, "select email, cli_open_id from lark_people where cli_open_id like ? and name = ?", `%${tag}`, name);
      if (!byEmail && !byId) continue;
      who = { name, id: (byEmail ?? byId)!.cli_open_id, email: (byEmail ?? byId)!.email };
    }
    const target = personSlug(app, who);
    const ids = all<{ cli_open_id: string }>(app.db, "select cli_open_id from lark_people where name = ? and cli_open_id is not null" + (who.email ? " and (email = ? or email is null)" : ""), ...(who.email ? [name, who.email] : [name])).map((x) => x.cli_open_id);
    (groups.get(target) ?? groups.set(target, []).get(target)!).push({ slug: r.slug, ids });
  }
  const done: { to: string; from: string[] }[] = [];
  for (const [to, cards] of groups) {
    if (cards.length === 1 && cards[0].slug === to) continue;
    done.push({ to, from: cards.map((c) => c.slug).filter((s) => s !== to) });
    if (opts.dryRun) continue;
    if (cards.length === 1) {
      movePages(app, WORK_STATE_SPACE, [{ from: cards[0].slug, to }], { message: `work-state: move ${cards[0].slug} to ${to}` });
      continue;
    }
    const pages = cards.map((c) => ({ ...c, page: readPage(app, WORK_STATE_SPACE, c.slug) }));
    const keep = pages.find((p) => p.slug === to) ?? [...pages].sort((a, b) => b.page.body.length - a.page.body.length)[0];
    const others = pages.filter((p) => p !== keep);
    // The owner's sections are put together here (an agent's rewrite keeps that section as it is, so it could not).
    const cut = (body: string) => {
      const s = sectionOf(body, OWNER_SECTION);
      return s ? { rest: `${body.slice(0, s.start)}${body.slice(s.end)}`.trim(), mine: s.text.replace(/^##[^\n]*\n/, "").trim() } : { rest: body.trim(), mine: "" };
    };
    const mine = [...new Set(pages.flatMap((p) => cut(p.page.body).mine.split("\n").map((l) => l.trimEnd()).filter(Boolean)))].join("\n");
    const old = others.map((p) => `### ${p.slug}\n\n${cut(p.page.body).rest.replace(/^(#{2,5}) /gm, "#$1 ")}`).join("\n\n");
    const body = `${cut(keep.page.body).rest}\n\n## ${MERGED_SECTION}\n\n${old}${mine ? `\n\n## ${OWNER_SECTION}\n\n${mine}` : ""}\n`;
    const aliases = [...new Set([...pages.flatMap((p) => [p.slug, ...((p.page.meta.aliases as string[] | undefined) ?? [])])])].filter((a) => a !== to);
    for (const p of pages) if (p.slug !== to) deletePage(app, WORK_STATE_SPACE, p.slug, "work-state");
    writePage(app, WORK_STATE_SPACE, to, { meta: { ...keep.page.meta, aliases }, body }, { actor: "agent", message: `work-state: merge ${others.map((p) => p.slug).join(", ")} into ${to}` });
    for (const id of new Set(cards.flatMap((c) => c.ids))) run(app.db, "delete from kv where key = ?", `work_state_person:${id}`);
  }
  return done;
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
  for (const slug of new Set([personSlug(app, { id: who.id, name, email: known?.email }), personSlug(app, { name }), checkSlug(`${PEOPLE_DIR}/${nameSlug(name)}`)])) {
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

