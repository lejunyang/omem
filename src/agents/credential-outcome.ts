import { z } from "zod";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { COMMAND_OUTPUT_LIMIT, now } from "../core/util.ts";
import { applicationUrl, recordAccess } from "./credential-access.ts";
import { credentialMethods, type CredentialCommand } from "./credential-registry.ts";
import { canStartLogin, credentialHold, expireCommandCredential, renewableLogin, startCredentialLogin } from "./credentials.ts";
import { waitForCredential } from "./credential-wait.ts";
import { executableName, field } from "./operation-policy.ts";

import type { ToolContext } from "./tools.ts";
import { OWNER, userName } from "../core/users.ts";

export function reportable(ctx: ToolContext) {
  return ctx.actor === "agent" && !!ctx.runId && !ctx.shadow && !ctx.boardAccess && !ctx.view && ctx.role !== "guest" && ctx.commandHomeUser !== null &&
    (ctx.commandHomeUser ?? OWNER) === (ctx.userId ?? OWNER);
}

export const outcomeSchema = z.object({
  command: z.string().min(1).max(100), args: z.array(z.string().max(100_000)).max(10_000),
  code: z.number().int(), output: z.string().max(COMMAND_OUTPUT_LIMIT),
}).strict();

/**
 * The declaration this invocation belongs to: same executable, and of those that name a subcommand
 * prefix the longest one the arguments start with; one without a prefix takes the rest.
 */
export function credentialCommand(name: string, args: string[] = []) {
  let best: { method: ReturnType<typeof credentialMethods>[number]; command: CredentialCommand } | undefined;
  let depth = -1;
  const parsed = credentialArgs(args);
  for (const method of credentialMethods()) {
    for (const command of method.provides.commands) {
      if (executableName(command.name) !== executableName(name)) continue;
      const d = command.subcommand?.length ?? 0;
      if (d <= depth || (command.subcommand && !parsed.matches({ subcommand: command.subcommand }))) continue;
      best = { method, command };
      depth = d;
    }
  }
  return best;
}

export function credentialArgs(args: string[]) {
  const options = new Map<string, string | true>();
  for (const [i, arg] of args.entries()) {
    if (arg === "--") break;
    const flag = /^--?([\w-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (flag) {
      const next = args[i + 1];
      options.set(flag[1]!, flag[2] ?? (next !== undefined && !next.startsWith("-") ? next : true));
    }
  }
  // Words that are not options; `value` when the word may be the value of the option right before it.
  const words = args.flatMap((a, i) => a.startsWith("-") ? [] : [{ word: a, value: i > 0 && /^--?[\w-]+$/.test(args[i - 1]!) }]);
  /** The subcommand starts at the first word, or after global options and their values (`--site cn log …`). */
  function subcommandAt(sub: string[]) {
    for (let k = 0; k + sub.length <= words.length; k++) {
      if (sub.every((w, j) => words[k + j]!.word === w)) return true;
      if (!words[k]!.value) return false;
    }
    return false;
  }
  function matches(match: NonNullable<CredentialCommand["readOnly"]>[number]) {
    if (match.subcommand && !subcommandAt(match.subcommand)) return false;
    if (match.args && (match.args.length !== args.length || match.args.some((w,i) => w !== args[i]))) return false;
    return Object.entries(match.options ?? {}).every(([k,v]) => typeof v === "boolean" ? v === options.has(k) : v === options.get(k));
  }
  return { matches, options };
}

export function commandResource(command: CredentialCommand, args: string[], { matches, options } = credentialArgs(args)) {
  for (const { match, key } of command.resource ?? []) {
    if (!matches(match)) continue;
    let complete = true;
    const resource = key.replace(/\{option\.([\w-]+)\}/g, (_, opt: string) => {
      const value = options.get(opt);
      if (typeof value === "string" && value) return value;
      complete = false;
      return "";
    });
    if (complete && resource.length <= 1024) return resource;
  }
}

function parseObject(s: string): object | undefined {
  try {
    const data: unknown = JSON.parse(s);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch { /* The command may also print human-readable diagnostics. */ }
}
export function classifyFailure(command: CredentialCommand, output: string) {
  let json = parseObject(output);
  if (!json) {
    for (const line of output.split("\n").reverse()) if ((json = parseObject(line))) break;
  }
  if (json && command.outcomes) {
    for (const reason of Object.keys(command.outcomes) as (keyof typeof command.outcomes)[]) {
      if (reason === "applyUrl" || !command.outcomes[reason]?.some(p => field(json,p.json) === p.equals)) continue;
      const path = command.outcomes.applyUrl;
      return { reason, applyUrl: path ? applicationUrl(field(json,path)) : null };
    }
  }
  return { reason: "failed" as const, applyUrl: null };
}

/** onBehalf: the run works as this person with their consent (rules/run-as.ts): their login is waited for like one's own. */
export async function credentialOutcome(app: App, user: string, runId: string, req: z.infer<typeof outcomeSchema>, remind = true, onBehalf = false) {
  const entry = credentialCommand(req.command, req.args);
  if (!entry) return {};
  const { method, command } = entry;
  const resource = commandResource(command, req.args);
  if (req.code === 0) {
    if (resource) recordAccess(app, method.kind, resource, user, true, runId);
    run(app.db, "update credential_holds set last_used_at=? where user_id=? and kind=?", now(), user, method.kind);
    return {};
  }
  const result = classifyFailure(command, req.output);
  let notice: string | undefined;
  if (result.reason === "expired" || result.reason === "unauthenticated") {
    // A conversation is stuck on it: omem starts the login now (the card carries the official link)
    // and the conversation goes on once it works (credential-wait.ts). Otherwise only a reminder.
    const requester = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", runId)?.user_id ?? user;
    const renews = renewableLogin(user, method, credentialHold(app, user, method.kind));
    // Only one's own login (or the owner's): a lender is not asked to log in because a borrower's command failed.
    const waits = remind && (user === requester || user === OWNER || onBehalf) && canStartLogin(app, user, method) && waitForCredential(app, user, method.kind, runId, requester);
    await expireCommandCredential(app, user, method, remind && (!waits || renews));
    if (renews) {
      if (remind) notice = `${method.name}的访问令牌不可用，omem 会先自动续签。不要让对方重新登录；只有续签凭据确认失效才会发授权通知。`;
    } else if (waits) {
      startCredentialLogin(app, user, method.kind, `运行 ${command.name} 时${method.name}报告${result.reason === "expired" ? "登录过期" : "没有登录"}。`)
        .catch(() => { /* Reported to them by the login itself. */ });
      notice = `已把${method.name}的登录链接发给${userName(app, user)}，授权完成后这段对话会自动接着做。不要自己发起登录，也不要为等授权设唤醒或轮询；先把这次没查到的告诉对方。`;
    }
  }
  if (resource && result.reason === "denied") recordAccess(app, method.kind, resource, user, false, runId, result.applyUrl ?? undefined);
  return notice ? { ...result, notice } : result;
}
