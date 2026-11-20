import { tx, type Db } from "../core/db.ts";

// Child-first for clearing a snapshot with foreign keys enabled.
export const providerDeviceTables = ["item_provider_writes", "external_item_links", "item_provider_targets"] as const;

export function migrateItemProviders(db: Db) {
  tx(db, () => {
    const legacy = db.prepare("select 1 from sqlite_master where name='item_provider_links'").get();
    if (legacy) db.exec("alter table item_provider_writes rename to legacy_provider_writes");
    db.exec(`
      create table if not exists item_provider_targets (
        id text primary key, provider text not null, target text not null,
        user_id text not null references users(id), space_id text not null references spaces(id),
        mode text not null, import_mode text not null, enabled integer not null default 1, cursor text, error text, subjects text not null default '{}',
        unique(user_id, space_id, provider, target)
      );
      create table if not exists external_item_links (
        item_id text primary key references items(id) on delete cascade,
        target_id text not null references item_provider_targets(id),
        provider text not null, user_id text not null, subjects text not null,
        direction text not null default 'pull', error text, revision text,
        external_key text not null, synced_at text not null, snapshot text not null, dismissed integer not null default 0,
        unique(provider, user_id, subjects, external_key)
      );
      create table if not exists item_provider_writes (
        id text primary key, item_id text not null unique references external_item_links(item_id) on delete cascade,
        status text not null, revision text not null, ask_id text, state text not null, error text
      );
    `);
    if (legacy) db.exec(`
      insert into external_item_links(item_id,target_id,provider,user_id,subjects,external_key,synced_at,snapshot,dismissed,revision,error)
        select l.item_id,t.id,t.provider,t.user_id,t.subjects,l.external_key,l.synced_at,l.snapshot,l.dismissed,json_extract(l.snapshot,'$.revision'),w.error
        from item_provider_links l join item_provider_targets t on t.id=l.target_id
        left join legacy_provider_writes w on w.item_id=l.item_id order by l.rowid
        on conflict(provider,user_id,subjects,external_key) do nothing;
      insert into item_provider_writes select w.* from legacy_provider_writes w join external_item_links l on l.item_id=w.item_id;
      drop table legacy_provider_writes;
      drop table item_provider_links;
    `);
  });
}
