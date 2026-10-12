import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * One SQLite file holds everything that is not a human-readable file:
 * sources and their chunks, the search index, memories, items, runs.
 * Wiki pages live as Markdown in the library (a Git repository); the
 * `pages` table is only their search projection.
 */
const migrations: string[] = [
  `
  create table spaces (
    id text primary key,
    name text not null,
    kind text not null default 'topic',      -- personal | project | repo | learning | topic
    description text not null default '',
    root_path text,                           -- repo spaces: working tree on disk
    settings text not null default '{}',
    created_at text not null,
    updated_at text not null
  );

  create table sources (
    id text primary key,
    space_id text not null references spaces(id),
    kind text not null,                       -- doc | code | chat | note | web | image | conversation
    uri text not null,                        -- stable identity: relative path, url, chat id
    title text not null,
    mime text,
    hash text not null,
    text text not null,
    meta text not null default '{}',
    captured_at text not null,
    updated_at text not null,
    deleted_at text,
    unique(space_id, uri)
  );
  create index sources_space on sources(space_id, kind, updated_at);

  create table chunks (
    id integer primary key,
    source_id text not null references sources(id) on delete cascade,
    space_id text not null,
    ord integer not null,
    kind text not null,                       -- section | symbol | window | message | file
    title text not null default '',
    path text not null default '',            -- heading path or qualified symbol
    line_start integer not null,
    line_end integer not null,
    text text not null,
    embedding blob
  );
  create index chunks_source on chunks(source_id, ord);
  create virtual table chunks_fts using fts5(title, body, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 2");

  create table symbols (
    id integer primary key,
    source_id text not null references sources(id) on delete cascade,
    space_id text not null,
    name text not null,
    qname text not null,
    kind text not null,
    line_start integer not null,
    line_end integer not null,
    signature text,
    exported integer not null default 0
  );
  create index symbols_name on symbols(space_id, name);
  create table code_refs (
    source_id text not null references sources(id) on delete cascade,
    space_id text not null,
    from_qname text not null,
    to_name text not null,
    kind text not null,                       -- import | call
    line integer not null
  );
  create index code_refs_to on code_refs(space_id, to_name);

  create table pages (
    id text primary key,                      -- space/slug
    space_id text not null,
    slug text not null,
    title text not null,
    summary text not null default '',
    kind text not null default 'page',
    body text not null,
    hash text not null,
    updated_at text not null
  );
  create virtual table pages_fts using fts5(title, body, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 2");
  create table page_rowids (rowid integer primary key, page_id text unique not null);
  create table page_links (from_id text not null, to_id text not null, primary key(from_id, to_id));
  create table page_cites (page_id text not null, source_id text not null, line_start integer, line_end integer, hash text);
  create index page_cites_source on page_cites(source_id);

  create table memories (
    id text primary key,
    space_id text not null,
    kind text not null,                       -- fact | agreement | preference | experience | person | decision
    subject text not null default '',
    content text not null,
    status text not null default 'active',    -- active | superseded | retracted
    valid_from text,
    valid_to text,
    superseded_by text,
    supersedes text,
    source_refs text not null default '[]',
    created_by text not null default 'agent', -- agent | user
    created_at text not null,
    updated_at text not null
  );
  create index memories_space on memories(space_id, status);
  create virtual table memories_fts using fts5(subject, content, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 2");
  create table memory_rowids (rowid integer primary key, memory_id text unique not null);

  create table items (
    id text primary key,
    space_id text not null,
    kind text not null,                       -- todo | waiting | reminder | watch | decision
    title text not null,
    detail text not null default '',
    status text not null default 'open',      -- open | waiting | snoozed | done | cancelled
    priority integer not null default 2,
    due_at text,
    remind_at text,
    waiting_on text,
    watch text,                               -- watch items: json {sources:[..], spaces:[..], query}
    source_refs text not null default '[]',
    created_at text not null,
    updated_at text not null,
    closed_at text
  );
  create index items_open on items(status, remind_at);
  create table item_events (
    id integer primary key,
    item_id text not null references items(id) on delete cascade,
    at text not null,
    kind text not null,                       -- created | updated | note | status | reminded
    text text not null,
    source_refs text not null default '[]',
    actor text not null default 'agent'
  );

  create table conversations (
    id text primary key,
    space_id text not null,
    channel text not null default 'web',
    title text not null default '',
    external_id text,
    created_at text not null,
    updated_at text not null
  );
  create table messages (
    id text primary key,
    conversation_id text not null references conversations(id) on delete cascade,
    role text not null,                       -- user | assistant
    text text not null,
    run_id text,
    meta text not null default '{}',
    created_at text not null
  );
  create index messages_conv on messages(conversation_id, created_at);

  create table runs (
    id text primary key,
    kind text not null,
    space_id text,
    status text not null default 'queued',    -- queued | running | done | failed | cancelled
    title text not null default '',
    input text not null default '{}',
    output text not null default '{}',
    profile_id text,
    parent_id text,
    error text,
    created_at text not null,
    started_at text,
    finished_at text
  );
  create index runs_status on runs(status, created_at);
  create table run_events (
    run_id text not null references runs(id) on delete cascade,
    seq integer not null,
    at text not null,
    type text not null,                       -- text | tool | status | change | error
    data text not null,
    primary key(run_id, seq)
  );

  create table schedules (
    id text primary key,
    kind text not null,                       -- heartbeat | dream | lark-poll | wiki-lint
    cron text not null,
    space_id text,
    config text not null default '{}',
    enabled integer not null default 0,
    last_run_at text
  );

  create table cards (
    id text primary key,
    space_id text not null,
    front text not null,
    back text not null,
    source_refs text not null default '[]',
    state text not null,                      -- serialized FSRS card
    due_at text not null,
    created_at text not null,
    suspended integer not null default 0
  );
  create index cards_due on cards(space_id, suspended, due_at);
  create table card_reviews (card_id text not null, at text not null, rating integer not null);

  create table kv (key text primary key, value text not null);

  create table notifications (
    id text primary key,
    at text not null,
    title text not null,
    body text not null default '',
    link text,
    read_at text
  );
  `,
  // Cross-file call resolution: qualifier of `ns.fn()` calls, import bindings,
  // and the resolved target symbol when the import chain can be followed.
  `
  alter table code_refs add column qualifier text;
  alter table code_refs add column bindings text;
  alter table code_refs add column to_source_id text;
  alter table code_refs add column to_qname text;
  create index code_refs_target on code_refs(to_source_id, to_qname);
  create index code_refs_from on code_refs(source_id, from_qname);
  -- force code files to be re-parsed on the next sync so refs get bindings
  update sources set hash = '' where kind = 'code';
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  const version = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  for (let i = version; i < migrations.length; i++) {
    db.exec("begin");
    try {
      db.exec(migrations[i]);
      db.exec(`pragma user_version = ${i + 1}`);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function one<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(db: Db, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}
