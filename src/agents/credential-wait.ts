import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { activeUser, findUser, userName } from "../core/users.ts";
import { json, now } from "../core/util.ts";

/**
 * A conversation stopped because a command's login was missing or expired (credential-outcome.ts):
 * remembered per holder and credential, and once that login works again (credentials.ts, a finished
 * login or a check that finds it valid) the conversation goes on by itself with an `[授权]` turn, as
 * a Feishu authorization does (auth/connect-wait.ts). The agent does not poll or set wake-ups for it.
 */
type Waiting = { conversationId: string; runId: string; requester: string; at: string };
/** A request older than this is not picked up again: the person has moved on. */
const KEEP_MS = 6 * 3600_000;
const key = (holder: string, kind: string) => `credential_wait:${holder}:${kind}`;

function waiting(app: App, holder: string, kind: string): Waiting[] {
  const list = json<Waiting[]>(one<{ value: string }>(app.db, "select value from kv where key = ?", key(holder, kind))?.value, []);
  return list.filter((w) => Date.now() - Date.parse(w.at) < KEEP_MS);
}
function save(app: App, holder: string, kind: string, list: Waiting[]) {
  if (!list.length) run(app.db, "delete from kv where key = ?", key(holder, kind));
  else run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key(holder, kind), JSON.stringify(list.slice(-10)));
}

/** Remember the run's conversation; false when the run has none (a rule or a schedule: nothing to go on with). */
export function waitForCredential(app: App, holder: string, kind: string, runId: string, requester: string) {
  const conversationId = one<{ c: string | null }>(app.db, "select json_extract(input, '$.conversationId') c from runs where id = ?", runId)?.c;
  if (!conversationId) return false;
  const list = waiting(app, holder, kind).filter((w) => w.conversationId !== conversationId);
  save(app, holder, kind, [...list, { conversationId, runId, requester, at: now() }]);
  return true;
}

export function credentialWaits(app: App, holder: string, kind: string) {
  return waiting(app, holder, kind);
}

/** The login works again: every conversation waiting on it goes on. */
export function credentialReady(app: App, holder: string, kind: string, name: string) {
  const list = waiting(app, holder, kind);
  if (!list.length) return 0;
  save(app, holder, kind, []);
  for (const w of list) {
    if (!activeUser(findUser(app, w.requester))) continue;
    void import("./inbox.ts")
      .then(({ receive }) => receive(app, { conversationId: w.conversationId, text: `[授权] ${userName(app, holder)}已完成${name}登录。接着做刚才因为没登录没做成的事，做完照常回复。`, userId: w.requester, fromAsk: true }))
      .catch((e) => console.warn(`[omem] ${name}登录后接着做没有开始：${(e as Error).message}`));
  }
  return list.length;
}
