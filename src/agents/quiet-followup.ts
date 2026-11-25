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

/** Follow explicit parent links, including timed and message wakes back to their setter. */
function chain(app: App, r: Run) {
  const chain = [r];
  const seen = new Set([r.id]);
  while (r.parentId && !seen.has(r.parentId)) {
    if (!one(app.db, "select 1 from runs where id = ? and coalesce(user_id, ?) = ?", r.parentId, OWNER, OWNER)) break;
    r = getRun(app, r.parentId);
    chain.push(r);
    seen.add(r.id);
  }
  return chain;
}

function alreadyTakenUp(app: App, ids: string[]) {
  return !!one(app.db, `with chain as (select value id from json_each(?))
    select 1 where
      exists(select 1 from notifications where user_id=? and json_extract(context,'$.runId') in (select id from chain))
      or exists(select 1 from asks where status='pending' and run_id in (select id from chain))
      or exists(select 1 from lark_sent where run_id in (select id from chain))
      or exists(select 1 from card_interactions where message_id is not null and run_id in (select id from chain))
      or exists(select 1 from item_events where run_id in (select id from chain))
      or exists(select 1 from item_changes c where c.run_id in (select id from chain)
        or exists(select 1 from json_each(c.added) a where json_extract(a.value,'$.runId') in (select id from chain)))`, JSON.stringify(ids), OWNER);
}

/** At terminal completion, not when the tool is called: the run can still arrange a recheck. */
export function checkQuietFollowup(app: App, id: string) {
  const r = getRun(app, id);
  if (r.status !== "done" || r.output.stayQuietState !== "unresolved" || !r.output.stayQuiet || runUser(app, id) !== OWNER) return;
  const lineage = chain(app, r);
  const context = lineage.map((p) => contextOfRun(app, p.id)).find(Boolean);
  const rule = lineage.map((p) => p.input.rule as { name?: string } | undefined).find(Boolean);
  // A recheck the assistant set for itself is also a live matter; background housekeeping is not.
  if (!rule && !context && !r.input.wake) return;
  const runIds = lineage.map((p) => p.id);
  if (alreadyTakenUp(app, runIds)) return;
  const at = now();
  if (pendingWakes(app).some((w) => w.setBy.runId && runIds.includes(w.setBy.runId) && (!w.expiresAt || w.expiresAt > at))) return;
  const keys = lineage.flatMap((p) => scopeOf(app, p.id));
  const msgs = lineage.flatMap((p) => (p.input.messageIds as string[] | undefined) ?? []);
  const records = msgs.length ? all<{ id: string; text: string; recheck: string | null; external: string | null; chat: string | null; topic: string | null; position: number | null }>(app.db,
    `select x.id, x.text, json_extract(x.meta, '$.recheck') recheck, json_extract(x.meta, '$.externalId') external,
       coalesce(m.chat_id, json_extract(x.meta, '$.chatId')) chat, m.thread_id topic,
       coalesce(m.position, json_extract(x.meta, '$.larkPosition')) position
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
  const problems = all<{ id: string; title: string; recheck_at: string | null; status: string }>(app.db, `select p.id, p.title, p.recheck_at, c.status from listen_problems p join listen_contexts c on c.id = p.context_id
    where p.state != 'closed' and (p.run_id in (${runIds.map(() => "?").join(",")}) ${explicitProblems.length ? `or p.id in (${explicitProblems.map(() => "?").join(",")})` : ""})`, ...runIds, ...explicitProblems);
  if (problems.some((p) => p.status === "active" && p.recheck_at)) return;
  if (lineage.some((p) => hasRunningInScope(app, p.id))) return;
  const messages = [...new Set([...keys.filter((k) => k.kind === "message").map((k) => k.key), ...records.flatMap((m) => m.external ? [m.external] : [])])];
  const dedup = [...messages.map((m) => `message:${m}`), ...[...new Set([...explicitProblems, ...problems.map((p) => p.id)])].map((p) => `problem:${p}`)];
  if (!dedup.length) dedup.push(...(records.length ? records.map((m) => `turn-message:${m.id}`) : [`run:${lineage.at(-1)!.id}`]));
  const message = messages[0];
  const captured = message && one<{ source_id: string | null; line: number | null; chat_id: string | null; position: number | null }>(app.db,
    `select s.id source_id, l.line, m.chat_id, m.position from lark_messages m
      left join lark_message_lines l on l.message_id=m.message_id
      left join sources s on s.id=l.source_id and s.deleted_at is null
      where m.message_id=? order by s.id is null, s.id limit 1`, message);
  const chat = keys.find((k) => k.kind === "chat");
  const trigger = records.find(m => m.external === message);
  const chatId = (captured && captured.chat_id) || trigger?.chat || chat?.key;
  const chatUrl = chatId && externalUrl(`lark:${chatId}`);
  const position = (captured && captured.position) ?? trigger?.position;
  const sourceUrl = chatUrl && position != null
    ? `${chatUrl}&position=${position}`
    : captured && captured.source_id && captured.line != null ? `#/sources/${captured.source_id}?from=${captured.line}&to=${captured.line}` : null;
  const source = sourceUrl ? `[打开原消息](${sourceUrl})`
    : [chatUrl ? `[打开原会话](${chatUrl})` : "", message ? `消息：${message}` : ""].filter(Boolean).join(" · ");
  const origin = lineage.findLast((p) => p.input.rule || contextOfRun(app, p.id)) ?? r;
  const triggers = origin.input.triggers as { summary?: string }[] | undefined;
  const subject = problems[0]?.title || triggers?.[0]?.summary || trigger?.text || origin.title;
  const label = rule?.name ? `规则「${rule.name}」` : context ? `关注「${context.name}」` : "约好的复查";
  tx(app.db, () => {
    const slots = dedup.map((key) => `quiet_unresolved:${sha256(key)}`);
    const already = slots.some((key) => one(app.db, "select 1 from kv where key = ?", key));
    for (const key of slots) run(app.db, "insert or ignore into kv(key,value) values(?,?)", key, id);
    if (!already) notify(app, { title: `${label}：问题还在，这次没有告诉任何人`, urgency: "normal", runId: id, link: `#/runs/${id}`,
      body: `${truncate(subject, 360)}\n\n最后判断：${r.output.stayQuiet}${source ? `\n\n${source}` : ""}` });
  });
}
