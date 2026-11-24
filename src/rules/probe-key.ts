import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";

/**
 * Where a probe is kept (rules/probes.ts), apart so that the rule store can check a name without
 * pulling in the script runner (and through it the model calls). Not `probe:` — that is the backends'
 * detection (agents/probe.ts).
 */
export const PROBE_KEY = "rule-probe:";

export function probeExists(app: App, name: string) {
  return !!one(app.db, "select 1 from kv where key = ?", PROBE_KEY + name);
}
