import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { json } from "../core/util.ts";
import type { RuleEvent } from "./types.ts";

/**
 * A rule's own write-back must not fire it again. A rule watching a table (“a new row → look it up →
 * write the answer back into the row”) has its agent write with lark_write, as the owner; Feishu then
 * sends that write as one more change of the table, made by the owner, and the rule would take it as
 * a new trigger — a loop. So lark_write notes which documents (and records, when the command or its
 * output names them) a rule's run just wrote, for a few minutes (kv `rule_own_writes:<token>`, which
 * survives a restart); a change of that document made only by the owner within the window is skipped
 * for that rule alone. Other rules still see it: for them it is an ordinary change by the owner.
 */

export const OWN_WRITE_WINDOW_MS = 5 * 60_000;
/** The event may be heard a little before the write's answer came back. */
const EARLY_MS = 30_000;

export type OwnWrite = { ruleId: string; runId: string; at: number; records: string[] };
const keyOf = (token: string) => `rule_own_writes:${token}`;
const RECORD = /\brec[A-Za-z0-9]{5,}\b/g;

/** Record ids a lark_write command or its output names (a Base record is `rec…`). */
export function recordIdsIn(...texts: string[]) {
  return [...new Set(texts.flatMap((t) => t.match(RECORD) ?? []))];
}

/** lark_write succeeded in a rule's run: remember what it wrote, for the window. */
export function noteRuleWrite(app: App, tokens: string[], w: Omit<OwnWrite, "at">, at = Date.now()) {
  for (const token of new Set(tokens.filter(Boolean))) {
    const kept = writesTo(app, token, at).filter((x) => !(x.ruleId === w.ruleId && x.runId === w.runId));
    const mine = writesTo(app, token, at).find((x) => x.ruleId === w.ruleId && x.runId === w.runId);
    const merged: OwnWrite = { ...w, at, records: [...new Set([...(mine?.records ?? []), ...w.records])] };
    run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", keyOf(token), JSON.stringify([...kept, merged].slice(-20)));
  }
}

function writesTo(app: App, token: string, at = Date.now()): OwnWrite[] {
  const v = one<{ value: string }>(app.db, "select value from kv where key = ?", keyOf(token))?.value;
  return json<OwnWrite[]>(v ?? "[]", []).filter((x) => at - x.at < OWN_WRITE_WINDOW_MS + 60_000);
}

/**
 * Whether this document change is the rule's own write-back: made only by the owner, heard within the
 * window after the rule's run wrote this document, and — when that write named records — about one of them.
 */
export function ownWriteOf(app: App, ruleId: string, e: RuleEvent): OwnWrite | undefined {
  if (e.kind !== "doc" || !e.doc || !e.change?.byOwner) return undefined;
  const heard = Date.parse(e.change.heardAt ?? e.at) || Date.now();
  return writesTo(app, e.doc.token).find(
    (w) =>
      w.ruleId === ruleId &&
      heard >= w.at - EARLY_MS &&
      heard <= w.at + OWN_WRITE_WINDOW_MS &&
      (!w.records.length || !e.change!.recordId || w.records.includes(e.change!.recordId)),
  );
}
