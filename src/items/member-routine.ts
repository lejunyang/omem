import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { findUser, OWNER, updateUser } from "../core/users.ts";
import { now } from "../core/util.ts";
import { accountEntries, loggedIn } from "../agents/accounts.ts";
import { sandboxSupport } from "../agents/sandbox.ts";

/**
 * The routine work on a member's own lines (docs/v2/multi-user.md “成员的线”): the daily look at where a
 * line stands and its next steps, following what its groups said, the wrap-up after it ended. These
 * start models, so whose quota pays is the question. The owner's lines run as they always did; a
 * member's run only when
 *
 * - the member (or the owner for them) turned it on (`users.settings.lineRoutine`, off by default), and
 * - the member is logged in to an AI account of their own here, on a machine that can keep their runs
 *   apart (agents/accounts.ts): those runs carry `ownAccountOnly`, and the runner refuses every backend
 *   that would borrow the owner's login (agents/runner.ts).
 *
 * Without either, nothing is queued; the reason is kept per person and shown on their work page. Runs
 * the member starts by hand (更新, 就这么做) need the own account too, not the switch.
 */
export type Routine = { on: boolean; ready: boolean; reason: string | null; skippedAt: string | null };

const SKIP = (userId: string) => `line_routine_skip:${userId}`;

/** Logged in to an account of their own here, on a machine that keeps member runs apart; or why not. */
export function ownAccountProblem(app: App, userId: string): string | null {
  if (userId === OWNER) return null;
  const support = sandboxSupport();
  if (!support.ok) return `这台机器不能把成员的运行和本人的隔开（${support.reason ?? "没有沙箱"}），成员的线不用本人的额度跑`;
  const mine = accountEntries(app).filter((e) => loggedIn(app, userId, e.id));
  if (!mine.length) return "还没有登录自己的 AI 账号：在 账号 → 我的 AI 账号 里登录一个";
  return null;
}

export function lineRoutine(app: App, userId: string): Routine {
  if (userId === OWNER) return { on: true, ready: true, reason: null, skippedAt: null };
  const u = findUser(app, userId);
  const on = !!u?.settings.lineRoutine;
  const skipped = one<{ value: string }>(app.db, "select value from kv where key = ?", SKIP(userId))?.value ?? null;
  const skippedAt = skipped ? (JSON.parse(skipped) as { at?: string }).at ?? null : null;
  if (!u || u.disabledAt || u.status !== "active") return { on, ready: false, reason: "这个账号不能用", skippedAt };
  if (!on) return { on, ready: false, reason: "线的例行整理没打开", skippedAt };
  const problem = ownAccountProblem(app, userId);
  return { on, ready: !problem, reason: problem, skippedAt };
}

/**
 * Whether the host may start routine work on this person's line now. When not, the reason is kept for
 * their work page (once per reason a day is enough: the row is overwritten).
 */
export function mayRunRoutine(app: App, userId: string): boolean {
  const r = lineRoutine(app, userId);
  if (r.ready) return true;
  if (r.on) run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", SKIP(userId), JSON.stringify({ at: now(), reason: r.reason }));
  return false;
}

export function setLineRoutine(app: App, userId: string, on: boolean) {
  if (userId === OWNER) return lineRoutine(app, userId);
  updateUser(app, userId, { settings: { lineRoutine: on } });
  if (!on) run(app.db, "delete from kv where key = ?", SKIP(userId));
  return lineRoutine(app, userId);
}
