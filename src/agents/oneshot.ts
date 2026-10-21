import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { runBackend } from "./dispatch.ts";
import { profileFor } from "./runner.ts";
import { replyOf } from "./types.ts";

/**
 * One model call with no omem tools, for small judgements and rewrites the host needs (is this
 * notification muted, merge two versions of a role). The assistant's backend first, one other
 * as fallback; null when none answers, and callers fall back to doing nothing.
 */
export async function askModel(app: App, prompt: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
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
    for (const profile of chain.slice(0, 2)) {
      if (ctrl.signal.aborted) break;
      try {
        const r = await runBackend(app, profile, { cwd: app.home, prompt, allowWrites: false, modes: ["read-only"], signal: ctrl.signal }, () => {});
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
