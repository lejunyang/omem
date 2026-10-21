import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json } from "../core/util.ts";
import { retentionChats, retentionRule } from "./lark-retention.ts";

type Event = { data: any; retryAt: number; attempts: number; abandonedAt?: number; error?: string };
const draining = new WeakSet<App>();
export const refreshPageQuery = "select message_id,create_ms from lark_messages indexed by lark_messages_chat_cursor where chat_id=? and (create_ms,message_id)>(?,?) and create_ms>=? order by create_ms,message_id limit ?";
/** Persist before acknowledging Feishu; failed enrichments survive restart. */
export function queueCaptureEvent(app: App, id: string, data: unknown) {
  if (one(app.db, "select 1 from kv where key=?", `lark_capture_receipt:${id}`)) return;
  run(app.db, "insert or ignore into kv(key,value) values(?,?)", `lark_capture_event:${id}`, JSON.stringify({ data, retryAt: 0, attempts: 0 }));
}
/** Feishu has no documented message-updated event. Re-read recent known messages as the bot. */
export function queueRetentionRefresh(app: App, now = Date.now()) {
  // Bounded keyset cleanup; kv's binary primary key is used by explicit ranges, not LIKE.
  for (const prefix of ["lark_bot_refresh:", "lark_bot_snapshot:"]) {
    const positionKey = `lark_cleanup:${prefix}`;
    const position = one<{value:string}>(app.db,"select value from kv where key=?",positionKey)?.value ?? prefix;
    const rows = all<{key:string}>(app.db,"select key from kv where key>? and key<? order by key limit 40",position,prefix+"\uffff");
    for (const row of rows) if (!one(app.db,"select 1 from lark_messages where message_id=? and create_ms>=?",row.key.slice(prefix.length),now-72*3600_000)) run(app.db,"delete from kv where key=?",row.key);
    run(app.db,"insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value",positionKey,rows.length===40 ? rows.at(-1)!.key : prefix);
  }
  const chats = retentionChats(app).filter(s => retentionRule(app,s.chatId) && s.lifecycle!=="disbanded" && s.invite!=="removed" && (s.invite==="joined" || !!s.botEventAt));
  const rotateKey = "lark_refresh_chat_position";
  const last = one<{value:string}>(app.db,"select value from kv where key=?",rotateKey)?.value;
  chats.sort((a,b) => a.chatId.localeCompare(b.chatId));
  const pivot = chats.findIndex(c=>c.chatId===last)+1;
  const ordered = [...chats.slice(pivot),...chats.slice(0,pivot)];
  let budget = 20;
  for (const chat of ordered) {
    if (!budget) break;
    const key = `lark_refresh_scan:${chat.chatId}`;
    const scan = json<{time:number; id:string; readyAt:number}>(one<{value:string}>(app.db,"select value from kv where key=?",key)?.value,{time:0,id:"",readyAt:0});
    if (scan.readyAt>now) continue;
    const limit = budget;
    const rows = all<{message_id:string;create_ms:number}>(app.db,
      refreshPageQuery,
      chat.chatId,scan.time,scan.id,now-72*3600_000,limit);
    budget -= rows.length;
    for (const row of rows) {
      const due = Number(one<{value:string}>(app.db,"select value from kv where key=?",`lark_bot_refresh:${row.message_id}`)?.value ?? 0);
      if (due<=now-600_000) {
        queueCaptureEvent(app,`refresh:${row.message_id}`,{updateId:row.message_id});
        run(app.db,"insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value",`lark_bot_refresh:${row.message_id}`,String(now));
      }
    }
    const tail = rows.at(-1);
    const next = rows.length<limit ? {time:0,id:"",readyAt:now+600_000} : {time:tail!.create_ms,id:tail!.message_id,readyAt:0};
    run(app.db,"insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value",key,JSON.stringify(next));
    run(app.db,"insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value",rotateKey,chat.chatId);
  }
}
export async function drainCaptureEvents(app: App, process: (data: any) => Promise<void>) {
  if (draining.has(app)) return;
  draining.add(app);
  try {
    if (!one(app.db, "select 1 from kv where key='lark_capture_receipts_v2'")) {
      run(app.db, "insert or ignore into kv(key,value) select replace(key,'lark_capture_event:','lark_capture_receipt:'),value from kv where key like 'lark_capture_event:%' and key not like 'lark_capture_event:refresh:%' and json_type(value,'$.doneAt') is not null");
      run(app.db, "delete from kv where key like 'lark_capture_event:%' and json_type(value,'$.doneAt') is not null");
      run(app.db, "insert into kv(key,value) values('lark_capture_receipts_v2','1')");
    }
    for (const row of all<{ key: string; value: string }>(app.db, "select key,value from kv where key>='lark_capture_event:' and key<'lark_capture_event;' and json_type(value,'$.data') is not null and json_type(value,'$.abandonedAt') is null and coalesce(json_extract(value,'$.retryAt'),0)<=? order by key limit 40", Date.now())) {
      const event = json<Event>(row.value, {} as Event);
      if (!event.data || event.retryAt > Date.now()) continue;
      try {
        await process(event.data);
        if (row.key.startsWith("lark_capture_event:refresh:")) run(app.db, "delete from kv where key=?", row.key);
        else {
          run(app.db, "insert or replace into kv(key,value) values(?,?)", row.key.replace("lark_capture_event:", "lark_capture_receipt:"), JSON.stringify({ doneAt: Date.now() }));
          run(app.db, "delete from kv where key=?", row.key);
        }
      } catch {
        event.attempts++;
        event.retryAt = Date.now() + Math.min(60, event.attempts * 5) * 60_000;
        if (event.attempts >= 10) event.abandonedAt = Date.now();
        event.error = event.abandonedAt ? "机器人事件保存失败已达十次，停止自动重试，请核查权限或消息状态" : "机器人事件保存或资源读取失败，等待重试";
        run(app.db, "update kv set value=? where key=?", JSON.stringify(event), row.key);
      }
    }
  } finally { draining.delete(app); }
}
