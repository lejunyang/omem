import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { OWNER } from "../core/users.ts";
import { now, sha256, truncate } from "../core/util.ts";
import { externalUrl } from "../channels/citations.ts";
import { contextOfRun } from "../channels/watch-trial.ts";
import { hasRunningInScope, scopeOf } from "./run-scope.ts";
import { getRun, runUser, type Run } from "./runs.ts";
import { pendingWakes } from "./wakes.ts";

/** A timed or message wake is the continuation of its setter, including across several rechecks. */
function chain(app: App, r: Run) {
  const chain = [r];
  while (r.input.wake && r.parentId && chain.length < 30 && !chain.some((p) => p.id === r.parentId)) {
    if (!one(app.db, "select 1 from runs where id = ?", r.parentId)) break;
    r = getRun(app, r.parentId);
    chain.push(r);
  }
  return chain;
}

/** At terminal completion, not when the tool is called: the run can still arrange a recheck. */
export function checkQuietFollowup(app: App, id: string) {
  const r = getRun(app, id);
  if (r.status !== "done" || r.output.stayQuietState !== "unresolved" || !r.output.stayQuiet || runUser(app, id) !== OWNER) return;
  const at = now();
  if (pendingWakes(app).some((w) => w.setBy.runId === id && (!w.expiresAt || w.expiresAt > at))) return;
  const lineage = chain(app, r);
  const keys = lineage.flatMap((p) => scopeOf(app, p.id));
  const context = lineage.map((p) => contextOfRun(app, p.id)).find(Boolean);
  const rule = lineage.map((p) => p.input.rule as { name?: string } | undefined).find(Boolean);
  const msgs = lineage.flatMap((p) => (p.input.messageIds as string[] | undefined) ?? []);
  const records = msgs.length ? all<{ id: string; recheck: string | null; external: string | null; chat: string | null; topic: string | null }>(app.db,
    `select x.id, json_extract(x.meta, '$.recheck') recheck, json_extract(x.meta, '$.externalId') external,
       coalesce(m.chat_id, json_extract(x.meta, '$.chatId')) chat, m.thread_id topic
     from messages x left join lark_messages m on m.message_id=json_extract(x.meta, '$.externalId')
     where x.id in (${msgs.map(() => "?").join(",")})`, ...msgs) : [];
  const explicitProblems = [...new Set([...records.map((m) => m.recheck), ...lineage.map((p) => p.input.problemId)].filter((p): p is string => typeof p === "string" && !!p))];
  // A previous batch may already have recorded the same problem. Only match a unique topic in this
  // 关注; another problem in a multi-topic batch is not a reason to stay silent about this one.
  const places = new Map<string, { key: string; topic: string }>();
  for (const m of records) if (m.chat && m.topic) places.set(`${m.chat}:${m.topic}`, { key: m.chat, topic: m.topic });
  for (const k of keys) if (k.kind === "chat" && k.topic) places.set(`${k.key}:${k.topic}`, k);
  if (context && !explicitProblems.length && places.size === 1) {
    const [{ key, topic }] = places.values();
    const problem = one<{ id: string }>(app.db, `select id from listen_problems where context_id=? and chat_id=? and topic_id=? and state!='closed' order by updated_at desc limit 1`, context.id, key, topic);
    if (problem) explicitProblems.push(problem.id);
  }
  const runIds = lineage.map((r) => r.id);
  const problems = all<{ id: string; title: string; recheck_at: string | null; status: string }>(app.db, `select p.id, p.title, p.recheck_at, c.status from listen_problems p join listen_contexts c on c.id = p.context_id
    where p.state != 'closed' and (p.run_id in (${runIds.map(() => "?").join(",")}) ${explicitProblems.length ? `or p.id in (${explicitProblems.map(() => "?").join(",")})` : ""})`, ...runIds, ...explicitProblems);
  if (problems.some((p) => p.status === "active" && p.recheck_at)) return;
  if (lineage.some((p) => hasRunningInScope(app, p.id))) return;
  const messages = [...new Set([...keys.filter((k) => k.kind === "message").map((k) => k.key), ...records.flatMap((m) => m.external ? [m.external] : [])])];
  const dedup = [...messages.map((m) => `message:${m}`), ...[...new Set([...explicitProblems, ...problems.map((p) => p.id)])].map((p) => `problem:${p}`)];
  if (!dedup.length) dedup.push(...(records.length ? records.map((m) => `turn-message:${m.id}`) : [`run:${lineage.at(-1)!.id}`]));
  const message = messages[0];
  const captured = message && one<{ source_id: string; line: number; chat_id: string | null; position: number | null }>(app.db,
    `select l.source_id, l.line, m.chat_id, m.position from lark_message_lines l
      join sources s on s.id=l.source_id and s.deleted_at is null left join lark_messages m on m.message_id=l.message_id
      where l.message_id=? order by l.source_id limit 1`, message);
  const chat = keys.find((k) => k.kind === "chat");
  const sourceUrl = captured ? captured.chat_id && captured.position != null
    ? `${externalUrl(`lark:${captured.chat_id}`)}&position=${captured.position}`
    : `#/sources/${captured.source_id}?from=${captured.line}&to=${captured.line}`
    : chat && externalUrl(`lark:${chat.key}`);
  const source = captured && sourceUrl ? `[打开原消息](${sourceUrl})`
    : [sourceUrl ? `[打开原会话](${sourceUrl})` : "", message ? `消息：${message}` : ""].filter(Boolean).join(" · ");
  const origin = lineage.at(-1)!;
  const triggers = origin.input.triggers as { summary?: string }[] | undefined;
  const subject = problems[0]?.title || triggers?.[0]?.summary || origin.title;
  const label = rule?.name ? `规则「${rule.name}」` : context ? `关注「${context.name}」` : "后台跟进";
  tx(app.db, () => {
    const slots = dedup.map((key) => `quiet_unresolved:${sha256(key)}`);
    const already = slots.some((key) => one(app.db, "select 1 from kv where key = ?", key));
    for (const key of slots) run(app.db, "insert or ignore into kv(key,value) values(?,?)", key, id);
    if (!already) notify(app, { title: `${label}：问题仍未恢复，没有安排后续`, urgency: "normal", runId: id, link: `#/runs/${id}`,
      body: `${truncate(subject, 360)}\n\n最后判断：${r.output.stayQuiet}${source ? `\n\n${source}` : ""}` });
  });
}
