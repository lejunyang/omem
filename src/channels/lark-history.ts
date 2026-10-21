import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { json } from "../core/util.ts";
import { larkCli } from "./lark-cli.ts";
import { flattenReplies, keepResources, monthOf, persistChatMessages, timeMs, type LarkMessage } from "./lark-messages.ts";

export type HistoryScan = { target: number; end: number; phase: "main" | "threads" | "done"; token?: string; threads: string[]; index: number; earliest?: number; touched: string[]; attemptedAt: number; error?: string; evidence?: "remote-exhausted" };
const key = (chat: string) => `lark_history_scan:${chat}`;
export const historyScan = (app: App, chat: string) => json<HistoryScan | undefined>(one<{value: string}>(app.db, "select value from kv where key=?", key(chat))?.value, undefined);
export function resetHistoryScan(app: App, chat: string) { run(app.db, "delete from kv where key=?", key(chat)); }
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
    if (dir) persist(await keepResources(app, spaceId, chatId, messages, dir, input.ingest, true));
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
    save();
    if (scan.earliest !== undefined) run(app.db, "update lark_cursors set oldest_ms=? where chat_id=?", scan.earliest, chatId);
    return scan;
  } catch (e) {
    scan.error = (e as Error).message.slice(0, 300);
    save();
    throw e;
  } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}
