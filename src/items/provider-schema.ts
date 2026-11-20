import type { Db } from "../core/db.ts";

// Child-first for clearing a snapshot with foreign keys enabled.
export const providerDeviceTables = ["item_provider_writes", "item_provider_links", "item_provider_targets"] as const;

export function migrateItemProviders(db: Db) {
  db.exec(`
    create table if not exists item_provider_targets (
      id text primary key, provider text not null, target text not null,
      user_id text not null references users(id), space_id text not null references spaces(id),
      mode text not null, import_mode text not null, enabled integer not null default 1, cursor text, error text, subjects text not null default '{}',
      unique(user_id, space_id, provider, target)
    );
    create table if not exists item_provider_links (
      item_id text primary key references items(id) on delete cascade,
      target_id text not null references item_provider_targets(id),
      external_key text not null, synced_at text not null, snapshot text not null, dismissed integer not null default 0,
      unique(target_id, external_key)
    );
    create table if not exists item_provider_writes (
      id text primary key, item_id text not null unique references item_provider_links(item_id) on delete cascade,
      status text not null, revision text not null, ask_id text, state text not null, error text
    );
  `);
}
