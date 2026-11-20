/** Indexed reverse lookup of structured storage references. Text links carry no authority. */
// Plugin-provided metadata on older sources could contain arbitrary file names.
const hostSource = "s.deleted_at is null and (s.meta->>'originKey' is null or s.meta->>'capturedBy' is null)";
const origins = [
  {
    table: "sources", key: "id", columns: "id,meta,deleted_at",
    rows: `select s.rowid pos, s.id ref, json_extract(s.meta,'$.original') name, s.id target from sources s where ${hostSource}
           union all select s.rowid, s.id, m.value, s.id from sources s, json_each(s.meta,'$.media') m
           where ${hostSource} and m.type='text'`,
  },
  {
    table: "messages", key: "id", columns: "id,role,meta",
    rows: `select m.rowid pos, m.id ref, a.value->>'name' name, m.id target
           from messages m, json_each(m.meta,'$.attachments') a where m.role='user' and a.type='object'`,
  },
  {
    table: "lark_messages", key: "message_id", columns: "message_id,resources,source_id",
    rows: `select m.rowid pos, m.message_id ref, r.value->>'file' name, coalesce(r.value->>'sourceId',m.source_id,'') target
           from lark_messages m, json_each(m.resources) r where r.type='object'`,
  },
  {
    table: "run_events", key: "run_id || ':' || $.seq", columns: "run_id,seq,type,data",
    rows: `select rowid pos, run_id || ':' || seq ref, data->>'name' name, run_id target from run_events where type='image'`,
  },
];

export const FILE_REFS_MIGRATION = `
create table stored_file_refs(origin text not null, ref text not null, name text not null, target text not null,
  primary key(origin,ref,name,target)) without rowid;
create index stored_files_by_name on stored_file_refs(name,origin,target);
create index cached_chat_files on kv(value,key) where key glob 'lark_res:*';
create table stored_file_uploads(name text not null, user_id text not null, primary key(name,user_id));
create table stored_file_backfill(origin text primary key, pos integer not null, last integer not null);
${origins.map(({ table, key, columns, rows }) => {
  const view = "file_refs_" + table;
  const clear = (row: string) => `delete from stored_file_refs where origin='${table}' and ref=${row}.${key.replaceAll("$",row)};`;
  const fill = `insert or ignore into stored_file_refs select distinct '${table}',ref,name,target from ${view}
    where pos=new.rowid and typeof(name)='text' and name!='' and target is not null;`;
  // An insert can also replace an existing row without SQLite firing its delete trigger.
  return `create view ${view} as ${rows};
    create trigger ${view}_insert after insert on ${table} begin ${clear("new")} ${fill} end;
    create trigger ${view}_update after update of ${columns} on ${table} begin ${clear("old")} ${fill} end;
    create trigger ${view}_delete after delete on ${table} begin ${clear("old")} end;
    insert into stored_file_backfill select '${table}',0,max(rowid) from ${table} having max(rowid)>0;`;
}).join("\n")}`;

/** On an upgraded database only. The caller runs this in a worker; short transactions yield the writer lock. */
export function backfillFileRefs(db: import("node:sqlite").DatabaseSync) {
  for (const { table } of origins) {
    const pending = db.prepare("select pos,last from stored_file_backfill where origin=?");
    const fill = db.prepare(`insert or ignore into stored_file_refs select ?,ref,name,target from file_refs_${table}
      where pos>? and pos<=? and typeof(name)='text' and name!='' and target is not null`);
    for (;;) {
      db.exec("begin immediate");
      try {
        const cursor = pending.get(table);
        if (!cursor) { db.exec("commit"); break; }
        const end = Math.min(Number(cursor.last), Number(cursor.pos) + 2048);
        fill.run(table, cursor.pos, end);
        if (end === cursor.last) db.prepare("delete from stored_file_backfill where origin=?").run(table);
        else db.prepare("update stored_file_backfill set pos=? where origin=?").run(end, table);
        db.exec("commit");
      } catch (e) { db.exec("rollback"); throw e; }
    }
  }
}
