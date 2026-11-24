import { runAccess } from "./own-sandbox.ts";
import { ownRun } from "./own-run.ts";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { accountBlocked, accountFor, memberAccountPlan } from "./accounts.ts";
import { excluded } from "./capacity.ts";
import { accountOf } from "./sandbox.ts";
import { runBackend } from "./dispatch.ts";
import { profileFor, recordIsolation } from "./runner.ts";
import { replyOf } from "./types.ts";

/**
 * One model call with no omem tools, for small judgements and rewrites the host needs (is this
 * notification muted, merge two versions of a role). The assistant's backend first, one other
 * as fallback; null when none answers, and callers fall back to doing nothing.
 */
export async function askModel(app: App, prompt: string, opts: { timeoutMs?: number; signal?: AbortSignal; userId?: string; memberRouting?: boolean } = {}): Promise<string | null> {
  const profiles = allProfiles(app.config);
  let base: AgentProfile | undefined;
  try {
    base = profileFor(app, "assistant");
  } catch {
    base = profiles[0];
  }
  const chain = base ? [base, ...profiles.filter((p) => p.id !== base!.id)] : profiles;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45_000);
  timer.unref();
  opts.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const eligible = opts.memberRouting && opts.userId ? chain.flatMap(p => {
      const plan = memberAccountPlan(app, opts.userId!, p);
      return plan.kind === "ready" && !excluded(app, plan.profile) ? [plan.profile] : [];
    }) : chain.filter(p => !opts.userId || !accountBlocked(app, opts.userId, p));
    for (const candidate of eligible.slice(0, 2)) {
      if (ctrl.signal.aborted) break;
      try {
        const profile = opts.memberRouting ? candidate : accountFor(app, opts.userId, candidate);
        const cwd = accountOf(profile)?.home ?? app.home;
        const isolation = ownRun(app, profile, cwd, true);
        const access = runAccess(app.config.agents.fullAccess, { owner: !opts.userId || opts.userId === "owner", box: isolation.box, allowWrites: false });
        if (opts.userId) recordIsolation(app, null, opts.userId, profile);
        const r = await runBackend(app, profile, { cwd, ownSandbox: isolation.box, ...access, prompt, allowWrites: false, modes: ["read-only"], signal: ctrl.signal }, () => {});
        const text = replyOf(r).trim();
        if (text) return text;
      } catch {
        // next backend
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The first JSON object in a model's answer. */
export function jsonIn<T>(text: string | null): T | null {
  const m = /\{[\s\S]*\}/.exec(text ?? "");
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}
