import { currentBot } from "../core/bot-context.ts";
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

/** A complete group member list has no match; ordinary mentions may omit this recipient. */
export class ChatMemberAbsentError extends HttpError {
  readonly who: string;
  constructor(who: string) {
    super(400, `目标群成员列表已完整读取，没有“${who}”；普通 @ 可跳过此人并继续发送。`);
    this.who = who;
  }
}

/**
 * Who the bot should @: a name, email, known bot-side id or "all". Capture-side open_ids
 * must never be passed through. Group membership can resolve a name without directory access.
 */
export async function resolveMention(app: App, who: string, chatId?: string | null): Promise<{ name: string; userId: string; email: string | null } | { all: true }> {
  const w = who.trim().replace(/^@/, "");
  if (w === "all" || w === "所有人") return { all: true };
  if (w.startsWith("cli_")) throw new HttpError(400, "app_id 不能用于 @ 机器人；请用机器人在本应用收到的 @ 消息里的名字或 open_id。");
  let rows: Row[];
  if (w.includes("@")) rows = all<Row>(app.db, "select * from lark_people where lower(email) = lower(?)", w);
  else rows = all<Row>(app.db, "select * from lark_people where user_id = ? or bot_open_id = ? or name = ?", w, w, w);
  const byEmail = new Map<string, Row>();
  for (const r of rows) byEmail.set(r.email ?? r.user_id ?? r.bot_open_id ?? r.cli_open_id ?? r.name, r);
  const list = [...byEmail.values()];
  // A bot-side open_id alone can belong to another bot, which the human member list omits.
  // Preserve known explicit IDs and these open-id-only identities; all other names are local to the chat.
  const r = list[0];
  // bot_open_id is the main bot's id for a person; the other bots (lark.bots) can only use user_id.
  const main = currentBot() === "main";
  const knownId = list.length === 1 && (r.user_id === w || (main && r.bot_open_id === w));
  const openIdOnly = main && list.length === 1 && r.bot_open_id && !r.user_id && !r.email;
  if (chatId && !w.includes("@") && !knownId && !openIdOnly) {
    const member = await mentionInChat(app, chatId, w);
    if (member) return member;
    if (w.startsWith("ou_")) throw new HttpError(400, "无法在目标群核实这个 open_id；不能用采集应用的 open_id 代替机器人应用的身份。");
    throw new ChatMemberAbsentError(w);
  }
  if (list.length > 1) throw new HttpError(400, `“${w}”有 ${list.length} 条同名联系人记录，尚未核实是否同一人：${list.map((r) => `${r.name}（${r.email ?? "无邮箱"}）`).join("、")}。用邮箱指定是哪一位。`);
  if (r?.user_id) return { name: r.name, userId: r.user_id, email: r.email };
  if (main && r?.bot_open_id?.startsWith("ou_")) return { name: r.name, userId: r.bot_open_id, email: r.email };
  const email = r?.email ?? (w.includes("@") ? w : null);
  if (!email) throw new HttpError(400, `不认识“${w}”：没有在飞书消息里见过这个人，给出邮箱才能 @ 他`);
  const { larkClient } = await import("./lark-send.ts");
  let userId: string | undefined;
  try {
    const res = await larkClient().contact.user.batchGetId({ data: { emails: [email], include_resigned: false }, params: { user_id_type: "user_id" } });
    if (res.code) throw Object.assign(new Error(res.msg ?? "查询失败"), { response: { data: res } });
    userId = res.data?.user_list?.[0]?.user_id;
  } catch (e) {
    const x = e as { response?: { data?: { code?: number; msg?: string } }; message: string };
    const msg = `${x.response?.data?.code ?? ""} ${x.response?.data?.msg ?? x.message}`;
    throw new HttpError(400, /99991672|contact:user\.id/.test(msg) ? "机器人缺少按邮箱查人的权限（contact:user.id:readonly）：运行 omem lark bot-permissions 补齐" : `按邮箱查人失败：${msg}`);
  }
  // Email lookups only see people inside the bot app's availability scope.
  if (!userId)
    throw new HttpError(
      400,
      `机器人按邮箱查不到 ${email} 的 user_id。若对方在目标群，可改用明确的群成员姓名（工具会核对群成员，重名时拒绝）；邮箱查询需要机器人通讯录权限及应用可用范围。不要拿采集应用的 open_id 代替。`,
    );
  rememberPerson(app, { email, userId, name: r?.name ?? "" });
  return { name: r?.name || email.split("@")[0], userId, email };
}

async function mentionInChat(app: App, chatId: string, who: string) {
  const { larkClient } = await import("./lark-send.ts");
  const client = larkClient();
  // open_ids are per app: the other bots list members by the tenant-wide user_id.
  const main = currentBot() === "main";
  const matches = new Map<string, string>();
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await client.im.chatMembers.get({ path: { chat_id: chatId }, params: { member_id_type: main ? "open_id" : "user_id", page_size: 100, ...(token ? { page_token: token } : {}) } });
    if (r.code) throw new HttpError(400, `读取目标群成员失败（${r.code}）：需要机器人有查看群成员权限并在群内。`);
    if (!r.data || r.data.trigger_security_conf_limit) throw new HttpError(400, "目标群成员列表不完整，无法确认 @ 对象。请用已核实的邮箱或机器人侧 ID。");
    for (const m of r.data.items ?? []) {
      if (typeof m.member_id !== "string" || (main && !m.member_id.startsWith("ou_"))) continue;
      if (m.name === who || m.member_id === who) matches.set(m.member_id, m.name ?? who);
    }
    if (r.data.has_more === false) {
      if (matches.size > 1) throw new HttpError(400, `目标群有 ${matches.size} 位“${who}”，请用邮箱或已核实的机器人侧 ID 指定，不能按名字猜。`);
      const match = [...matches][0];
      if (!match) return null;
      const [id, name] = match;
      rememberPerson(app, main ? { botOpenId: id, name } : { userId: id, name });
      return { name, userId: id, email: null };
    }
    if (!r.data.has_more || !r.data.page_token || seen.has(r.data.page_token)) break;
    token = r.data.page_token;
    seen.add(token!);
  }
  throw new HttpError(400, "目标群成员分页未完成，无法确认 @ 对象。请稍后重试或用已核实的邮箱或机器人侧 ID。");
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
