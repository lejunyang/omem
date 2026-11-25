export const HOOK_INBOX_MIGRATION = `create table plugin_hook_deliveries (
   id text primary key, plugin text not null, name text not null,
   key text, key_until integer, received_at integer not null,
   status text not null, due_at integer, attempts integer not null default 0, duration_ms integer,
   error text, duplicate_of text, duplicates integer not null default 0, last_duplicate_at integer,
   format text not null, envelope text, body text);
 create index plugin_hook_key on plugin_hook_deliveries(plugin,name,key,key_until) where key_until is not null;
 create index plugin_hook_due on plugin_hook_deliveries(due_at) where status='pending';
 create index plugin_hook_pending on plugin_hook_deliveries(status) where body is not null;
 create index plugin_hook_recent on plugin_hook_deliveries(plugin,name,received_at desc);
 create index plugin_hook_received on plugin_hook_deliveries(received_at);`;

export const HOOK_BODY_HASH_MIGRATION = `alter table plugin_hook_deliveries add column body_hash text;`;
