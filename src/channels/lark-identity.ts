import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { emailHolder, linkIdentity, normalEmail, resolveIdentity, updateUser, userName } from "../core/users.ts";
import { audit } from "../auth/permissions.ts";
import { learnBotPerson, rememberPerson } from "./lark-people.ts";

/**
 * The owner adds colleagues by email or by name (settings → members, or `add_users` from an @);
 * the open_id the bot sees them under comes later, when they first talk to it. That first message
 * ties the two together: the bot reads who the open_id is (its own directory access), and an account
 * waiting for exactly this person takes the identity. Without it a person the owner already added
 * would still be answered as a guest until they logged in.
 *
 * Matched, in order: the directory email equals the account's; the tenant-wide user_id the bot gets
 * for the account's email equals the sender's (works without email permission); the name, for an
 * account added without an email, when exactly one such account has it. Only accounts with no
 * Feishu identity of this bot yet take part. Two candidates: none is taken and the owner is told.
 */
export async function claimLarkSender(app: App, client: any, sender: { openId: string; userId?: string | null; name?: string }): Promise<string | null> {
  const known = resolveIdentity(app, "lark", sender.openId);
  if (known) return known;
  // A real guest writes again and again: look again only when the accounts have changed.
  const accounts = one<{ v: string }>(app.db, "select count(*) || ':' || coalesce(max(created_at), '') || ':' || coalesce(max(email), '') as v from users")!.v;
  const missKey = `lark_claim_miss:${sender.openId}`;
  if (one<{ value: string }>(app.db, "select value from kv where key = ?", missKey)?.value === accounts) return null;
  const miss = () => { run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", missKey, accounts); return null; };

  if (sender.userId || sender.name) rememberPerson(app, { botOpenId: sender.openId, userId: sender.userId || null, name: sender.name ?? "" });
  const person = await learnBotPerson(app, client, sender.openId);
  const email = normalEmail(person?.email);
  const userId = person?.userId ?? sender.userId ?? null;
  const name = person?.name || sender.name || "";

  const appId = app.config.lark.appId ?? null;
  const open = all<{ id: string; name: string; email: string | null }>(
    app.db,
    `select id, name, email from users u where kind = 'person' and status = 'active' and disabled_at is null and id != 'owner'
       and not exists (select 1 from identities i where i.user_id = u.id and i.channel = 'lark' and i.kind = 'alias' and (i.app_id is null or i.app_id = ?))`,
    appId,
  );
  let by: "email" | "user_id" | "name" | null = null;
  let hits = email ? open.filter((u) => u.email === email) : [];
  if (hits.length) by = "email";
  if (!hits.length && userId) {
    const withEmail = open.filter((u) => u.email);
    const ids = await userIdsOf(app, client, withEmail.map((u) => u.email!));
    hits = withEmail.filter((u) => ids.get(u.email!) === userId);
    if (hits.length) by = "user_id";
  }
  if (!hits.length && name) {
    hits = open.filter((u) => !u.email && u.name === name);
    if (hits.length) by = "name";
  }
  if (!hits.length) return miss();
  if (hits.length > 1) {
    notify(app, { title: "飞书上的人对应了多个账号", body: `${name || sender.openId} 找机器人了，${hits.map((u) => `${u.name}（${u.id}）`).join("、")} 都可能是他，没有自动对应：设置 → 成员 里改掉重复的名字或邮箱。`, link: "#/settings?tab=members", urgency: "normal" });
    return miss();
  }
  const u = hits[0];
  linkIdentity(app, u.id, "lark", sender.openId, { kind: "alias", appId, display: name, verified: by !== "name" });
  if (!u.email && email && !emailHolder(app, email, u.id)) updateUser(app, u.id, { email });
  audit(app, "system", "lark.identity.claim", u.id, { openId: sender.openId, by, email, name });
  const how = by === "email" ? `飞书通讯录的邮箱 ${email}` : by === "user_id" ? `账号邮箱 ${u.email} 在飞书上就是他` : `名字「${name}」（账号没有邮箱，按名字对应的）`;
  notify(app, { title: "预建的账号已对应到飞书", body: `${name || u.name} 第一次找机器人，按${how}对应到账号 ${userName(app, u.id)}（${u.id}），之后按他的空间权限回答，不再当访客。不对的话在 设置 → 成员 解除。`, link: "#/settings?tab=members", urgency: "normal" });
  return u.id;
}

/** The tenant-wide user_id for each email, by the bot (`contact:user.id:readonly`); what it cannot read is left out. */
async function userIdsOf(app: App, client: any, emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo: string[] = [];
  for (const e of emails) {
    const id = one<{ user_id: string | null }>(app.db, "select user_id from lark_people where lower(email) = ? and user_id is not null", e)?.user_id;
    if (id) out.set(e, id);
    else todo.push(e);
  }
  for (let i = 0; i < todo.length; i += 50) {
    try {
      const r = await client.contact.user.batchGetId({ data: { emails: todo.slice(i, i + 50), include_resigned: false }, params: { user_id_type: "user_id" } });
      if (r?.code) break;
      for (const x of (r?.data?.user_list ?? []) as { email?: string; user_id?: string }[]) {
        const e = normalEmail(x.email);
        if (!e || !x.user_id) continue;
        out.set(e, x.user_id);
        rememberPerson(app, { email: e, userId: x.user_id });
      }
    } catch {
      break;
    }
  }
  return out;
}
