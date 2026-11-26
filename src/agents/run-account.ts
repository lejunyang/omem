import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { one } from "../core/db.ts";
import { OWNER, userName } from "../core/users.ts";
import { accountEntryFor, accountState, selectedMemberAccount } from "./accounts.ts";
import { sourceOf } from "./capacity.ts";
import { selectedCredential } from "./credentials.ts";
import { machineLoginUser } from "./machine-login.ts";
import { accountOf } from "./sandbox.ts";

/**
 * Whose AI account a run uses, recorded with its backend and model (runs.ai.account) and shown with the run.
 * `holder`: the person whose login it is (the owner, the member themselves, or the member a credential is
 * borrowed from); `login`: the account name a login check saw, when it said one; `borrowed`: the requester
 * is not the holder; `reason`: why that account was chosen (a member's runs); `key`: a shared API key, no
 * one's login; `name`: a member holder's name then (the page names the owner itself). Runs on another
 * device (`peer`) or omem's cloud backend say nothing: the account is not here.
 */
export type RunAccount = { holder: string; name?: string; login?: string; borrowed?: boolean; reason?: string; key?: true };

export function runAccount(app: App, profile: AgentProfile, userId: string = OWNER): RunAccount | undefined {
  if (profile.peer || profile.transport === "doubao") return undefined;
  if (profile.keyRef) return { holder: OWNER, key: true };
  const choice = selectedMemberAccount(profile);
  const use = selectedCredential(profile);
  const own = accountOf(profile);
  const holder = use?.holder ?? own?.userId ?? choice?.holder ?? OWNER;
  let login: string | undefined;
  if (use) login = one<{ account_name: string | null }>(app.db, "select account_name from credential_holds where user_id = ? and kind = ?", use.holder, use.kind)?.account_name ?? undefined;
  else if (own) {
    const entry = accountEntryFor(app, profile);
    login = entry ? accountState(app, own.userId, entry.id).user : undefined;
  } else login = machineLoginUser(app, sourceOf(profile));
  return {
    holder,
    ...(holder !== OWNER ? { name: userName(app, holder) } : {}),
    ...(login ? { login } : {}),
    ...(holder !== userId ? { borrowed: true } : {}),
    ...(choice?.reason ? { reason: choice.reason } : {}),
  };
}
