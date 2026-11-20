import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { canReadRun } from "./permissions.ts";
import { sourceReadable } from "./visibility.ts";

const backfills = new WeakMap<App, Promise<void>>();
function ensureFileRefs(app: App) {
  const active = backfills.get(app);
  if (active) return active;
  if (!one(app.db, "select 1 from stored_file_backfill limit 1")) return;
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const job = new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL(`../core/file-refs-worker.${ext}`, import.meta.url), { workerData: join(app.home, "omem.db") });
    worker.once("error", reject);
    worker.once("exit", code => code ? reject(new Error("存储文件归属索引未完成")) : resolve());
  }).finally(() => backfills.delete(app));
  backfills.set(app, job);
  return job;
}

/** A name may be shared by several originals, uploads or runs containing the same bytes. */
export async function storedFileReadable(app: App, userId: string, name: string) {
  if (userId === OWNER) return true;
  await ensureFileRefs(app);
  // Use the requested name's owners even when the bytes are served from its compressed copy.
  const names = "select ? name union select original from file_variants where file=? and status='done'";
  if (one(app.db, `select 1 from stored_file_uploads where user_id=? and name in (${names}) limit 1`, userId, name, name)) return true;
  // Resolve messages in one query; several messages can refer to the same run.
  const owners = all<{ kind: "source" | "run" | "user"; id: string }>(app.db, `
    with names as (${names}), refs as (
      select origin,ref,target from stored_file_refs where name in (select name from names)
    ), chats as (
      select r.ref id from refs r join lark_messages m on m.message_id=r.ref
        where r.origin='lark_messages' and r.target=coalesce(m.source_id,'')
      union select substr(key,10,instr(key,'/')-10) from kv
        where key glob 'lark_res:*' and value in (select name from names)
    ), source_ids as (
      select target id from refs where origin in ('sources','lark_messages')
      union select l.source_id from chats join lark_message_lines l on l.message_id=chats.id
      union select m.source_id from chats join lark_messages m on m.message_id=chats.id
    )
    select 'source' kind,s.id from source_ids join sources s on s.id=source_ids.id where s.deleted_at is null
    union select 'run',target from refs where origin='run_events'
    union select case when m.run_id is null then 'user' else 'run' end, coalesce(m.run_id,c.user_id)
      from refs join messages m on m.id=refs.target join conversations c on c.id=m.conversation_id
      where refs.origin='messages'`, name, name);
  // Old clients could submit an attachment by name. A message reference cannot confer access to a restricted original.
  const originals = owners.filter(owner => owner.kind === "source");
  if (originals.length) {
    for (const original of originals) if (await sourceReadable(app, userId, original.id)) return true;
    return false;
  }
  for (const owner of owners) {
    if (owner.kind === "run" && canReadRun(app, userId, owner.id)) return true;
    if (owner.kind === "user" && owner.id === userId) return true;
  }
  return false;
}
