import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { json } from "../core/util.ts";
import { larkCli } from "./lark-cli.ts";
import { flattenReplies, keepResources, monthOf, persistChatMessages, timeMs, type LarkMessage } from "./lark-messages.ts";

export type HistoryScan = {
  target: number; end: number; phase: "main" | "threads" | "done"; token?: string; threads: string[]; index: number; earliest?: number; touched: string[]; attemptedAt: number; error?: string; evidence?: "remote-exhausted";
  /** Failures in a row on the current page; the next try waits until `retryAt`. */
  failures?: number; retryAt?: number;
  /** Why history of this chat cannot be read at all (not a member any more, no permission); not retried. */
  gaveUp?: string;
};
export const RATE_LIMITED = /(^|\D)429(\D|$)|rate.?limit|too many requests|frequency|频率|限流|99991400/i;
/** Errors that retrying does not fix: the owner left the chat or may not read it. */
const PERMANENT = /230002|can ?not be out of the chat|not (a )?member|chat (does )?not exist|chat_not_found|no permission|permission denied|forbidden/i;
/** After this many failures on one page, keep its messages without the attachments that would not download (fill-files fetches them later). */
const STRICT_TRIES = 3;
const retryDelay = (failures: number) => Math.min(30_000 * 2 ** Math.max(0, failures - 1), 3_600_000);
/** Whether a chat's history should be tried now. */
export const historyDue = (scan: HistoryScan | undefined, now = Date.now()) => !scan?.gaveUp && !(scan?.retryAt && scan.retryAt > now);
const key = (chat: string) => `lark_history_scan:${chat}`;
export const historyScan = (app: App, chat: string) => json<HistoryScan | undefined>(one<{value: string}>(app.db, "select value from kv where key=?", key(chat))?.value, undefined);
export function resetHistoryScan(app: App, chat: string) { run(app.db, "delete from kv where key=?", key(chat)); }
/** The owner asked again: try a chat that was given up on or is waiting out a backoff right away. */
export function retryHistoryNow(app: App, chat: string) {
  const s = historyScan(app, chat);
  if (!s || (!s.gaveUp && !s.retryAt)) return;
  run(app.db, "update kv set value=? where key=?", JSON.stringify({ ...s, gaveUp: undefined, retryAt: undefined, failures: 0 }), key(chat));
}
const iso = (ms: number) => new Date(ms).toISOString();

/** Remote cursors, never dedup counts, prove traversal. One page per chat keeps live work fair. */
export async function historyPage(app: App, input: { chatId: string; name: string; target: number; spaceId: string; owner?: string; ingest: boolean }) {
  const { chatId, target, spaceId, owner } = input;
  const prior = historyScan(app, chatId);
  const scan = (prior?.target === target && (prior.phase !== "done" || prior.evidence === "remote-exhausted") ? prior : undefined) ?? { target, end: Date.now(), phase: "main", threads: [], index: 0, touched: [], attemptedAt: 0 };
  const save = () => run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value", key(chatId), JSON.stringify(scan));
  scan.attemptedAt = Date.now();
  save();
  if (scan.phase === "done") return scan;
  const dir = app.config.lark.capture.attachments ? mkdtempSync(join(tmpdir(), "omem-history-")) : undefined;
  try {
    const thread = scan.phase === "threads" ? scan.threads[scan.index] : undefined;
    // CLI truncates ISO times to seconds. Expand both edges; filter locally to the exact window.
    const args = thread ? ["+threads-messages-list", "--thread", thread, "--order", "desc"] : ["+chat-messages-list", "--chat-id", chatId, "--order", "desc", "--start", iso(Date.parse("2010-01-01T00:00:00Z") - 1000), "--end", iso(Math.ceil(scan.end / 1000) * 1000 + 1000)];
    const v = await larkCli(["im", ...args, "--page-size", "50", "--no-reactions", ...(dir ? ["--download-resources"] : []), ...(scan.token ? ["--page-token", scan.token] : []), "--as", "user", "--format", "json"], dir ? 300_000 : 90_000, dir);
    if (!Array.isArray(v.data?.messages)) throw new Error("历史分页缺少 messages，保留当前页进度");
    const raw = flattenReplies(v.data.messages) as LarkMessage[];
    const messages = raw.filter(m => !m.deleted && timeMs(m.create_time) >= target && timeMs(m.create_time) <= scan.end && !(app.config.lark.appId && m.sender?.id === app.config.lark.appId));
    if (thread) for (const m of messages) m.thread_id = thread;
    const groups = new Map<string, LarkMessage[]>();
    for (const m of messages) { const month = monthOf(timeMs(m.create_time)); groups.set(month, [...(groups.get(month) ?? []), m]); }
    const persist = (resources?: Awaited<ReturnType<typeof keepResources>>) => {
      for (const [month, group] of groups) {
        const result = persistChatMessages(app, { chatId, spaceId, name: input.name, messages: group, owner, resources, archive: month });
        if (result.id && !scan.touched.includes(result.id)) scan.touched.push(result.id);
      }
    };
    persist(); // Even a later resource/page failure leaves the returned bodies available.
    save();
    const strict = (scan.failures ?? 0) < STRICT_TRIES;
    if (!strict) console.warn(`[omem] 回溯飞书历史 ${input.name}：这一页已失败 ${scan.failures} 次，跳过下载不了的附件继续（之后可用 lark fill-files 补拉）`);
    if (dir) persist(await keepResources(app, spaceId, chatId, messages, dir, input.ingest, strict));
    if (typeof v.data.has_more !== "boolean") throw new Error("历史分页缺少 has_more，不能证明耗尽");
    if (v.data.has_more && (typeof v.data.page_token !== "string" || !v.data.page_token || v.data.page_token === scan.token)) throw new Error("历史分页令牌缺失或重复，保留当前页进度");
    if (!thread) for (const m of raw) if (m.thread_id && !scan.threads.includes(m.thread_id)) scan.threads.push(m.thread_id);
    for (const m of messages) scan.earliest = Math.min(scan.earliest ?? Infinity, timeMs(m.create_time));
    // Exhaust every main page. A root timestamp does not bound replies in a different topic.
    const finished = !v.data.has_more;
    if (finished) {
      scan.token = undefined;
      if (thread) scan.index++;
      else scan.phase = "threads";
      if (scan.index >= scan.threads.length) { scan.phase = "done"; scan.evidence = "remote-exhausted"; }
    } else scan.token = v.data.page_token;
    scan.error = undefined;
    scan.failures = 0;
    scan.retryAt = undefined;
    save();
    if (scan.earliest !== undefined) run(app.db, "update lark_cursors set oldest_ms=? where chat_id=?", scan.earliest, chatId);
    return scan;
  } catch (e) {
    scan.error = (e as Error).message.slice(0, 300);
    // Rate limits are the whole loop's to back off from (backfillTick), not this chat's fault.
    if (!RATE_LIMITED.test(scan.error)) {
      scan.failures = (scan.failures ?? 0) + 1;
      if (PERMANENT.test(scan.error)) scan.gaveUp = scan.error;
      else scan.retryAt = Date.now() + retryDelay(scan.failures);
    }
    save();
    throw e;
  } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}
