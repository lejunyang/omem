import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, now } from "../core/util.ts";
import { larkCli } from "./lark-cli.ts";

/**
 * People seen in Feishu, across the two apps omem talks to Feishu through.
 *
 * open_ids are per app: lark-cli (personal capture) and the bot see different open_ids for the same
 * person, so an id from a captured message cannot be used by the bot. What both sides can agree on:
 * - lark-cli resolves its own open_ids to name and enterprise email (`contact +search-user --user-ids`,
 *   up to 100 at a time, with the permissions capture already has);
 * - the bot resolves an email to the tenant-wide user_id (`contact.user.batchGetId`, permission
 *   `contact:user.id:readonly`) and its own open_ids to user_id and email (`contact.user.get`).
 * So a person is keyed by email; the user_id is what the bot @-mentions with. Ids are stored, not shown:
 * chat text drops them, the web shows the email next to the name.
 */
export type Person = { email: string | null; name: string; cliOpenId: string | null; botOpenId: string | null; userId: string | null };

type Row = { email: string | null; name: string; cli_open_id: string | null; bot_open_id: string | null; user_id: string | null };
const toPerson = (r: Row): Person => ({ email: r.email, name: r.name, cliOpenId: r.cli_open_id, botOpenId: r.bot_open_id, userId: r.user_id });

/** Merge what is known about one person into the row that already matches any of its ids. */
export function rememberPerson(app: App, p: Partial<Person> & { name?: string }) {
  const keys: [string, string | null | undefined][] = [
    ["email", p.email],
    ["cli_open_id", p.cliOpenId],
    ["bot_open_id", p.botOpenId],
    ["user_id", p.userId],
  ];
  const found = keys.map(([k, v]) => (v ? one<Row & { id: number }>(app.db, `select rowid as id, * from lark_people where ${k} = ?`, v) : undefined)).find(Boolean);
  if (found)
    run(
      app.db,
      `update lark_people set name = coalesce(nullif(?, ''), name), email = coalesce(?, email), cli_open_id = coalesce(?, cli_open_id),
         bot_open_id = coalesce(?, bot_open_id), user_id = coalesce(?, user_id), updated_at = ? where rowid = ?`,
      p.name ?? "",
      p.email || null,
      p.cliOpenId || null,
      p.botOpenId || null,
      p.userId || null,
      now(),
      found.id,
    );
  else
    run(
      app.db,
      "insert into lark_people(email, name, cli_open_id, bot_open_id, user_id, updated_at) values(?,?,?,?,?,?)",
      p.email || null,
      p.name ?? "",
      p.cliOpenId || null,
      p.botOpenId || null,
      p.userId || null,
      now(),
    );
}

export function peopleByCliIds(app: App, ids: string[]): Map<string, Person> {
  if (!ids.length) return new Map();
  const rows = all<Row>(app.db, `select * from lark_people where cli_open_id in (${ids.map(() => "?").join(",")})`, ...ids);
  return new Map(rows.map((r) => [r.cli_open_id!, toPerson(r)]));
}

/** lark-cli open_ids in a captured message: sender, mentions, and `@name(ou_…)` inside rendered cards. */
export function cliIdsIn(text: string, extra: (string | undefined)[] = []) {
  const ids = new Set(extra.filter((x): x is string => !!x && x.startsWith("ou_")));
  for (const m of text.matchAll(/@[^@\n]{1,60}?\((ou_[0-9a-f]{32})\)/g)) ids.add(m[1]);
  return [...ids];
}

/** Names and emails for lark-cli open_ids not seen before (100 per call). Failures are not fatal: names stay as they are. */
export async function learnCliPeople(app: App, ids: string[]) {
  const known = peopleByCliIds(app, ids);
  const unknown = [...new Set(ids)].filter((id) => !known.get(id)?.email);
  for (let i = 0; i < unknown.length; i += 100) {
    try {
      const v = await larkCli(["contact", "+search-user", "--user-ids", unknown.slice(i, i + 100).join(","), "--as", "user"], 60_000);
      for (const u of (v.data?.users ?? []) as { open_id?: string; localized_name?: string; enterprise_email?: string; email?: string }[])
        if (u.open_id) rememberPerson(app, { cliOpenId: u.open_id, name: u.localized_name ?? "", email: u.enterprise_email || u.email || null });
    } catch (e) {
      console.warn(`[omem] 查飞书联系人失败：${(e as Error).message}`);
      return;
    }
  }
}

/** For the bot's own open_ids (sender or mentions of a message it received). */
export async function learnBotPerson(app: App, client: any, openId: string) {
  const known = one<Row>(app.db, "select * from lark_people where bot_open_id = ?", openId);
  if (known?.user_id && known.email) return toPerson(known);
  try {
    const r = await client.contact.user.get({ path: { user_id: openId }, params: { user_id_type: "open_id" } });
    const u = r.data?.user;
    if (!u) return known ? toPerson(known) : null;
    rememberPerson(app, { botOpenId: openId, name: u.name, email: u.enterprise_email || u.email || null, userId: u.user_id || null });
    return toPerson(one<Row>(app.db, "select * from lark_people where bot_open_id = ?", openId)!);
  } catch {
    return known ? toPerson(known) : null;
  }
}

/**
 * Who the bot should @: a name, an email, a user_id or "all". Names must be unambiguous among the
 * people seen; an email is enough even for someone never seen (the bot looks the user_id up).
 */
export async function resolveMention(app: App, who: string): Promise<{ name: string; userId: string; email: string | null } | { all: true }> {
  const w = who.trim().replace(/^@/, "");
  if (w === "all" || w === "所有人") return { all: true };
  let rows: Row[];
  if (w.includes("@")) rows = all<Row>(app.db, "select * from lark_people where lower(email) = lower(?)", w);
  else rows = all<Row>(app.db, "select * from lark_people where user_id = ? or name = ?", w, w);
  const byEmail = new Map<string, Row>();
  for (const r of rows) byEmail.set(r.email ?? r.user_id ?? r.cli_open_id ?? r.name, r);
  const list = [...byEmail.values()];
  if (list.length > 1) throw new HttpError(400, `“${w}”有 ${list.length} 个人：${list.map((r) => `${r.name}（${r.email ?? "无邮箱"}）`).join("、")}。用邮箱指定是哪一位。`);
  const r = list[0];
  if (r?.user_id) return { name: r.name, userId: r.user_id, email: r.email };
  const email = r?.email ?? (w.includes("@") ? w : null);
  if (!email) throw new HttpError(400, `不认识“${w}”：没有在飞书消息里见过这个人，给出邮箱才能 @ 他`);
  const { larkClient } = await import("./lark-send.ts");
  let userId: string | undefined;
  try {
    const res = await larkClient().contact.user.batchGetId({ data: { emails: [email], include_resigned: false }, params: { user_id_type: "user_id" } });
    userId = res.data?.user_list?.[0]?.user_id;
  } catch (e) {
    const x = e as { response?: { data?: { code?: number; msg?: string } }; message: string };
    const msg = x.response?.data?.msg ?? x.message;
    throw new HttpError(400, /99991672|contact:user\.id/.test(msg) ? "机器人缺少按邮箱查人的权限（contact:user.id:readonly）：运行 omem lark bot-permissions 补齐" : `按邮箱查人失败：${msg}`);
  }
  // Email lookups only see people inside the bot app's availability scope.
  if (!userId)
    throw new HttpError(
      400,
      `机器人查不到 ${email} 的 user_id：飞书只返回在机器人应用“可用范围”内的人。可以在开发者后台把可用范围扩大到相关同事（可能要管理员审批）；或者等这个人在机器人所在的群里发言，机器人会从消息里记下他的 id。`,
    );
  rememberPerson(app, { email, userId, name: r?.name ?? "" });
  return { name: r?.name || email.split("@")[0], userId, email };
}

type Resolved = Awaited<ReturnType<typeof resolveMention>>;

/**
 * Put real @-mentions into text: `@名字` written in the text becomes the mention tag; people not written
 * get one at the start. Text messages use `<at user_id>`, cards (Markdown) `<at id>`; both take user_id.
 */
export function applyMentions(text: string, people: Resolved[], kind: "text" | "card") {
  let out = text;
  const lead: string[] = [];
  for (const p of people) {
    const tag = "all" in p ? (kind === "text" ? '<at user_id="all"></at>' : "<at id=all></at>") : kind === "text" ? `<at user_id="${p.userId}">${p.name}</at>` : `<at id=${p.userId}></at>`;
    const names = "all" in p ? ["all", "所有人"] : [p.name, p.email].filter((x): x is string => !!x);
    const at = names.map((n) => `@${n}`).find((n) => out.includes(n));
    if (at) out = out.replace(at, tag);
    else lead.push(tag);
  }
  return lead.length ? `${lead.join(" ")} ${out}` : out;
}
