import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { OWNER } from "../core/users.ts";
import { audit } from "../auth/permissions.ts";
import { larkCli } from "./lark-cli.ts";
import { rememberPerson } from "./lark-people.ts";

/**
 * Adding people and bots to the owner's groups, as the owner (lark-cli, user identity). The one
 * general way to do it (`lark_invite`): people always wait for the owner's OK on a card that lists
 * every group and every person; bots omem can name join directly unless `lark.invite.botApproval`.
 * Rules bring omem's own bot in through `inviteOwnBot`, which uses the same call.
 *
 * Ids are lark-cli's own (user identity): open_ids of people (`ou_…`, the ones capture sees, not the
 * bot app's) and app_ids of bots (`cli_…`).
 */

export type Invitee = { openId: string; name: string; email: string | null };
export type BotInvitee = { appId: string; name: string };
export type ResolvedInvite = { chatId: string; chatName: string; people: Invitee[]; bots: BotInvitee[] };
export type InviteSpec = { chat_id: string; people?: string[]; bots?: string[] };

/** One request takes at most this many people, or this many bots (Feishu's limits). */
const PEOPLE_PER_CALL = 50;
const BOTS_PER_CALL = 5;

// ---- bots seen in the owner's groups ------------------------------------------------------

const KNOWN_BOTS = "lark_known_bots";

/** Bots seen in some group of the owner's: app_id → name. */
export function knownBots(app: App): Record<string, string> {
  const v = one<{ value: string }>(app.db, "select value from kv where key = ?", KNOWN_BOTS)?.value;
  try {
    return v ? (JSON.parse(v) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Remember the names of bots in a group's member list (rules/engine.ts `chatBots`). */
export function rememberBots(app: App, bots: { appId?: string; name: string }[]) {
  const seen = bots.filter((b): b is BotInvitee => !!b.appId?.startsWith("cli_") && !!b.name.trim());
  if (!seen.length) return;
  const known = knownBots(app);
  let changed = false;
  for (const b of seen)
    if (known[b.appId] !== b.name) {
      known[b.appId] = b.name;
      changed = true;
    }
  if (changed) run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KNOWN_BOTS, JSON.stringify(known));
}

/** omem's own bots: the main one (`self`) and `lark.bots`, with the names they told us. */
function ownBots(app: App): (BotInvitee & { ref: string })[] {
  const name = (key: string, dflt: string) => one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value ?? dflt;
  const out: (BotInvitee & { ref: string })[] = [];
  if (app.config.lark.appId) out.push({ ref: "self", appId: app.config.lark.appId, name: name("lark_bot_name", "omem 的机器人") });
  for (const b of app.config.lark.bots) out.push({ ref: b.id, appId: b.appId, name: name(`lark_bot_name:${b.id}`, b.id) });
  return out;
}

// ---- resolving --------------------------------------------------------------------------

type CliUser = { open_id?: string; localized_name?: string; name?: string; enterprise_email?: string; email?: string; department?: unknown; is_cross_tenant?: boolean };

const nameOf = (u: CliUser) => {
  const n = String(u.localized_name ?? u.name ?? "").trim();
  return n && n !== u.open_id ? n : "";
};
const emailOf = (u: CliUser) => u.enterprise_email || u.email || null;
const deptOf = (u: CliUser) => (typeof u.department === "string" ? u.department : u.department && typeof u.department === "object" ? String((u.department as { name?: unknown }).name ?? "") : "");

async function searchUsers(args: string[]): Promise<CliUser[]> {
  const v = await larkCli(["contact", "+search-user", ...args, "--as", "user", "--format", "json"], 60_000);
  return ((v?.data?.users ?? v?.users ?? []) as CliUser[]).filter((u) => typeof u.open_id === "string" && u.open_id.startsWith("ou_"));
}

function candidates(users: CliUser[]) {
  return users.map((u) => `${nameOf(u) || "（无名字）"}（${emailOf(u) ?? "无邮箱"}${deptOf(u) ? `，${deptOf(u)}` : ""}${u.is_cross_tenant ? "，外部" : ""}，${u.open_id}）`).join("；");
}

/** A person by open_id, email or name; throws a message for the agent when not exactly one. */
async function resolvePerson(app: App, who: string): Promise<Invitee> {
  const w = who.trim();
  if (!w) throw new Error("空的成员");
  type Row = { name: string; email: string | null; cli_open_id: string };
  if (w.startsWith("ou_")) {
    const local = one<Row>(app.db, "select name, email, cli_open_id from lark_people where cli_open_id = ? and name != ''", w);
    if (local) return { openId: w, name: local.name, email: local.email };
    let users: CliUser[] = [];
    try {
      users = await searchUsers(["--user-ids", w]);
    } catch (e) {
      throw new Error(`“${w}”查不到名字（${(e as Error).message}）`);
    }
    const u = users.find((x) => x.open_id === w);
    if (!u || !nameOf(u)) throw new Error(`“${w}”取不到名字：卡片上要让本人认出是谁。确认这是本人身份（lark-cli）下的 open_id，或改用邮箱`);
    rememberPerson(app, { cliOpenId: w, name: nameOf(u), email: emailOf(u) });
    return { openId: w, name: nameOf(u), email: emailOf(u) };
  }
  const email = w.includes("@");
  const rows = email
    ? all<Row>(app.db, "select name, email, cli_open_id from lark_people where lower(email) = lower(?) and cli_open_id is not null and name != ''", w)
    : all<Row>(app.db, "select name, email, cli_open_id from lark_people where name = ? and cli_open_id is not null", w);
  const ids = [...new Set(rows.map((r) => r.cli_open_id))];
  if (ids.length === 1) return { openId: rows[0].cli_open_id, name: rows[0].name, email: rows[0].email };
  let users: CliUser[];
  try {
    users = await searchUsers(["--query", w, "--page-size", "30"]);
  } catch (e) {
    throw new Error(`“${w}”查通讯录失败（${(e as Error).message}）`);
  }
  const hits = users.filter((u) => (email ? [u.enterprise_email, u.email].some((x) => x && x.toLowerCase() === w.toLowerCase()) : nameOf(u) === w));
  const unique = [...new Map(hits.map((u) => [u.open_id!, u])).values()];
  if (unique.length === 1) {
    const u = unique[0];
    rememberPerson(app, { cliOpenId: u.open_id, name: nameOf(u) || w, email: emailOf(u) });
    return { openId: u.open_id!, name: nameOf(u) || w, email: emailOf(u) };
  }
  if (unique.length > 1) throw new Error(`“${w}”有 ${unique.length} 个人：${candidates(unique)}。用 open_id 或邮箱指明是哪一位，不要猜`);
  throw new Error(`通讯录里没有${email ? "邮箱是" : "叫"}“${w}”的人${users.length ? `（相近的：${candidates(users.slice(0, 5))}）` : ""}`);
}

/** A bot by `self`, an id in `lark.bots`, an app_id or a name. */
function resolveBot(app: App, ref: string, seen: Record<string, string>): BotInvitee {
  const w = ref.trim();
  const own = ownBots(app);
  const mine = own.find((b) => b.ref === w || b.appId === w);
  if (mine) return { appId: mine.appId, name: mine.name };
  if (w === "self") throw new Error("没有配置 omem 的飞书机器人（lark.appId）");
  if (w.startsWith("cli_")) {
    if (seen[w]) return { appId: w, name: seen[w] };
    throw new Error(`不知道 ${w} 是哪个机器人：传 bots_seen_in（它已经在的群），读到它的名字后才能拉`);
  }
  const all = new Map<string, string>();
  for (const b of own) if (b.name === w) all.set(b.appId, b.name);
  for (const [appId, name] of Object.entries(seen)) if (name === w) all.set(appId, name);
  if (all.size === 1) {
    const [appId, name] = [...all][0];
    return { appId, name };
  }
  if (all.size > 1) throw new Error(`有 ${all.size} 个机器人叫“${w}”：${[...all.keys()].join("、")}。用 app_id 指明`);
  throw new Error(`不认识机器人“${w}”：传 bots_seen_in（它已经在的群）让我读到它，或用 self 指 omem 自己的机器人`);
}

/** A group the owner is in, with its name. */
async function readChat(chatId: string): Promise<string> {
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error(`${chatId} 不是群的 chat_id（oc_…）：用 lark_read 的 im +chat-search 查`);
  let v: any;
  try {
    v = await larkCli(["im", "chats", "get", "--chat-id", chatId, "--as", "user", "--format", "json"], 60_000);
  } catch (e) {
    throw new Error(`读不到群 ${chatId}（${(e as Error).message}）：本人要在群里`);
  }
  const d = v?.data ?? v;
  if (d?.chat_mode === "p2p") throw new Error(`${chatId} 是单聊，不能拉人`);
  if (d?.chat_status && d.chat_status !== "normal") throw new Error(`群 ${chatId} 已解散`);
  const name = String(d?.name ?? "").trim();
  if (!name && !d?.chat_mode) throw new Error(`读不到群 ${chatId} 的信息：本人要在群里`);
  return name || chatId;
}

/**
 * Tool arguments → groups with names, people with names and emails, bots with names. Every problem
 * is collected and thrown at once (400), so the agent fixes them in one go.
 */
export async function resolveInvites(app: App, invites: InviteSpec[], botsSeenIn: string[] = []): Promise<ResolvedInvite[]> {
  const problems: string[] = [];
  if (botsSeenIn.length) {
    const { chatBots } = await import("../rules/engine.ts");
    for (const id of botsSeenIn) {
      const bots = await chatBots(app, id);
      if (!bots) problems.push(`bots_seen_in：读不到群 ${id} 的机器人列表（本人要在群里）`);
    }
  }
  const seen = knownBots(app);
  const people = new Map<string, Promise<Invitee | Error>>();
  const person = (w: string) => {
    if (!people.has(w)) people.set(w, resolvePerson(app, w).catch((e: Error) => e));
    return people.get(w)!;
  };
  const out: ResolvedInvite[] = [];
  for (const inv of invites) {
    let chatName = inv.chat_id;
    try {
      chatName = await readChat(inv.chat_id);
    } catch (e) {
      problems.push((e as Error).message);
    }
    const ps: Invitee[] = [];
    for (const w of inv.people ?? []) {
      const r = await person(w);
      if (r instanceof Error) problems.push(`群「${chatName}」：${r.message}`);
      else if (!ps.some((p) => p.openId === r.openId)) ps.push(r);
    }
    const bs: BotInvitee[] = [];
    for (const w of inv.bots ?? []) {
      try {
        const b = resolveBot(app, w, seen);
        if (!bs.some((x) => x.appId === b.appId)) bs.push(b);
      } catch (e) {
        problems.push(`群「${chatName}」：${(e as Error).message}`);
      }
    }
    if (!ps.length && !bs.length && !(inv.people?.length || inv.bots?.length)) problems.push(`群「${chatName}」：没有要拉的人或机器人`);
    out.push({ chatId: inv.chat_id, chatName, people: ps, bots: bs });
  }
  if (problems.length) throw new HttpError(400, `有 ${problems.length} 处要改，改好后整个重新调用：\n${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
  return out;
}

// ---- adding -----------------------------------------------------------------------------

type AddResult = { invalid: string[]; notExisted: string[]; pending: string[] };

/** Add members to a chat as the owner: one call, at most 50 people or 5 bots. The one lark-cli call for it. */
export async function addChatMembers(chatId: string, kind: "open_id" | "app_id", ids: string[]): Promise<AddResult> {
  const v = await larkCli(["im", "chat.members", "create", "--chat-id", chatId, "--member-id-type", kind, "--succeed-type", "1", "--data", JSON.stringify({ id_list: ids }), "--as", "user"], 60_000);
  const d = v?.data ?? v ?? {};
  const list = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  return { invalid: list(d.invalid_id_list), notExisted: list(d.not_existed_id_list), pending: list(d.pending_approval_id_list) };
}

export type InviteOutcome = { chatId: string; chatName: string; added: string[]; invalid: string[]; notExisted: string[]; pending: string[]; error?: string };

/** Run resolved invites group by group; one group failing leaves the others alone. */
export async function runInvites(app: App, resolved: ResolvedInvite[], opts: { runId?: string | null; approved?: boolean } = {}): Promise<InviteOutcome[]> {
  const { asOwner } = await import("./lark-auth.ts");
  const outcomes: InviteOutcome[] = [];
  for (const r of resolved) {
    const label = new Map<string, string>([...r.people.map((p) => [p.openId, p.email ? `${p.name}（${p.email}）` : p.name] as const), ...r.bots.map((b) => [b.appId, `机器人 ${b.name}`] as const)]);
    const o: InviteOutcome = { chatId: r.chatId, chatName: r.chatName, added: [], invalid: [], notExisted: [], pending: [] };
    const batches: ["open_id" | "app_id", string[]][] = [];
    for (let i = 0; i < r.people.length; i += PEOPLE_PER_CALL) batches.push(["open_id", r.people.slice(i, i + PEOPLE_PER_CALL).map((p) => p.openId)]);
    for (let i = 0; i < r.bots.length; i += BOTS_PER_CALL) batches.push(["app_id", r.bots.slice(i, i + BOTS_PER_CALL).map((b) => b.appId)]);
    const errors: string[] = [];
    for (const [kind, ids] of batches) {
      try {
        const res = await asOwner(app, "把人拉进群", () => addChatMembers(r.chatId, kind, ids));
        const failed = new Set([...res.invalid, ...res.notExisted, ...res.pending]);
        o.added.push(...ids.filter((id) => !failed.has(id)));
        o.invalid.push(...res.invalid);
        o.notExisted.push(...res.notExisted);
        o.pending.push(...res.pending);
      } catch (e) {
        errors.push(`${ids.map((id) => label.get(id) ?? id).join("、")}：${(e as Error).message}`);
      }
    }
    if (errors.length) o.error = errors.join("；");
    if (r.bots.length) (await import("../rules/engine.ts")).forgetChatBots(r.chatId);
    const named = (ids: string[]) => ids.map((id) => label.get(id) ?? id);
    audit(app, OWNER, "lark.invite", r.chatId, {
      runId: opts.runId ?? null,
      approved: !!opts.approved,
      chat: r.chatName,
      people: r.people,
      bots: r.bots,
      result: { added: named(o.added), invalid: named(o.invalid), notExisted: named(o.notExisted), pending: named(o.pending), error: o.error ?? null },
    });
    o.added = named(o.added);
    o.invalid = named(o.invalid);
    o.notExisted = named(o.notExisted);
    o.pending = named(o.pending);
    outcomes.push(o);
  }
  return outcomes;
}

/** The outcomes, a few lines per group, for the agent to tell the owner. */
export function describeOutcomes(outcomes: InviteOutcome[]) {
  return outcomes
    .map((o) => {
      const lines = [o.added.length ? `已用本人身份把 ${o.added.join("、")} 拉进「${o.chatName}」（${o.chatId}）` : `「${o.chatName}」（${o.chatId}）：没有拉进任何人`];
      if (o.pending.length) lines.push(`  等群主或管理员审批：${o.pending.join("、")}`);
      if (o.invalid.length) lines.push(`  无效（离职、不可见或应用未启用）：${o.invalid.join("、")}`);
      if (o.notExisted.length) lines.push(`  不存在：${o.notExisted.join("、")}`);
      if (o.error) lines.push(`  失败：${o.error}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** What the owner approves: every group, every person and bot, and why. */
export function inviteQuestion(resolved: ResolvedInvite[], reason: string) {
  const groups = resolved.map((r) => {
    const who = [...r.people.map((p) => `- ${p.name}${p.email ? `（${p.email}）` : ""}`), ...r.bots.map((b) => `- 机器人 ${b.name}`)];
    return `**「${r.chatName}」**\n${who.join("\n")}`;
  });
  const n = resolved.reduce((s, r) => s + r.people.length + r.bots.length, 0);
  return `以你的身份把下面 ${n} 个成员拉进 ${resolved.length} 个群？\n\n原因：${reason}\n\n${groups.join("\n\n")}\n\n批准后一次全部执行；只想拉其中一部分就拒绝并说明。`;
}

/**
 * Add omem's own bot to a chat the owner is in, as the owner. Only for what the owner set up
 * themself: a rule's action (rules/actions.ts, rules/forward.ts).
 */
export async function inviteOwnBot(app: App, chatId: string) {
  const appId = app.config.lark.appId;
  if (!appId) throw new HttpError(400, "没有配置飞书机器人（lark.appId）");
  await addChatMembers(chatId, "app_id", [appId]);
  (await import("../rules/engine.ts")).forgetChatBots(chatId);
}
