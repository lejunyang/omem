import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * One SQLite file holds everything that is not a human-readable file:
 * sources and their chunks, the search index, memories, items, runs.
 * Wiki pages live as Markdown in the library (a Git repository); the
 * `pages` table is only their search projection.
 */
/** Knowledge-base nodes from what captures kept in meta (no network); idempotent, exported for tests. */
export const FILL_WIKI_NODES = `
  insert or ignore into wiki_spaces(id, name)
    select json_extract(meta, '$.wikiSpaceId'), max(coalesce(json_extract(meta, '$.wikiSpaceName'), ''))
    from sources where kind = 'doc' and coalesce(json_extract(meta, '$.wikiSpaceId'), '') != '' group by 1;
  insert or ignore into wiki_nodes(token, wiki_space_id, parent_token, title, obj_token, obj_type, source_id, error)
    select json_extract(meta, '$.wikiNodeToken'), json_extract(meta, '$.wikiSpaceId'), json_extract(meta, '$.wikiParentNodeToken'), title,
      json_extract(meta, '$.documentId'), 'docx', id, json_extract(meta, '$.wikiMetadataError')
    from sources where kind = 'doc' and deleted_at is null and coalesce(json_extract(meta, '$.wikiNodeToken'), '') != ''
    order by (uri like '%/wiki/%') desc, updated_at desc;
  insert or ignore into wiki_nodes(token, wiki_space_id, title)
    select json_extract(meta, '$.wikiParentNodeToken'), json_extract(meta, '$.wikiSpaceId'), coalesce(json_extract(meta, '$.wikiParentTitle'), '')
    from sources where kind = 'doc' and deleted_at is null and coalesce(json_extract(meta, '$.wikiParentNodeToken'), '') != '';
`;

const migrations: string[] = [
  `
  create table spaces (
    id text primary key,
    name text not null,
    kind text not null default 'topic',      -- personal | project | repo | learning | topic（界面显示“通用”）
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
  // Conversations become threads: a channel key (chat, topic, thread), a live or
  // resumable agent session, a rolling summary for cold starts, per-chat settings.
  // Runs get a lane (one at a time per thread) and a not-before time (burst merge).
  `
  alter table conversations add column status text not null default 'active';
  alter table conversations add column parent_id text;
  alter table conversations add column summary text not null default '';
  alter table conversations add column summary_at text;
  alter table conversations add column settings text not null default '{}';
  alter table conversations add column agent_profile text;
  alter table conversations add column agent_session text;
  alter table conversations add column agent_cwd text;
  alter table conversations add column agent_turns integer not null default 0;
  create index conversations_key on conversations(channel, external_id, status);
  create table chat_settings (
    channel text not null,
    chat_id text not null,
    settings text not null default '{}',
    primary key(channel, chat_id)
  );
  alter table runs add column lane text;
  alter table runs add column not_before text;
  create index runs_lane on runs(lane, status);
  `,
  // Room for more than one person: users, their channel identities, space
  // membership and per-user API tokens. Everything existing belongs to "owner".
  `
  create table users (
    id text primary key,
    name text not null,
    role text not null default 'member',      -- owner | member
    settings text not null default '{}',
    created_at text not null,
    disabled_at text
  );
  insert into users(id, name, role, created_at) values ('owner', '本人', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  create table identities (
    channel text not null,                    -- lark | telegram | onebot | web …
    external_id text not null,                -- open_id, Telegram user id, QQ number…
    user_id text not null references users(id),
    created_at text not null,
    primary key(channel, external_id)
  );
  create table space_members (
    space_id text not null,
    user_id text not null,
    role text not null default 'reader',      -- reader | editor | owner
    primary key(space_id, user_id)
  );
  create table api_tokens (
    token_hash text primary key,
    user_id text not null,
    label text not null default '',
    created_at text not null,
    last_used_at text
  );
  alter table spaces add column owner_id text not null default 'owner';
  alter table conversations add column user_id text not null default 'owner';
  alter table items add column user_id text not null default 'owner';
  alter table memories add column user_id text;
  alter table cards add column user_id text not null default 'owner';
  alter table card_reviews add column user_id text not null default 'owner';
  alter table runs add column user_id text;
  alter table notifications add column user_id text not null default 'owner';
  create index items_user on items(user_id, status);
  create index conversations_user on conversations(user_id, updated_at);
  create index cards_user on cards(user_id, suspended, due_at);
  `,
  // Learning goals: what someone is learning, how many new cards a day, when to remind.
  `
  create table learn_goals (
    id text primary key,
    user_id text not null default 'owner',
    space_id text not null,
    title text not null,
    detail text not null default '',
    daily_new integer not null default 10,
    remind_at text not null default '20:30',     -- local HH:MM
    status text not null default 'active',       -- active | paused | done
    created_at text not null,
    updated_at text not null,
    last_fed_at text,
    last_reminded_at text
  );
  alter table cards add column goal_id text;
  `,
  // Feishu: interactive cards the bot sent and who may act on them; per-chat
  // capture cursors for the owner's messages; messages already handed to a handler.
  `
  create table card_interactions (
    id text primary key,
    channel text not null default 'lark',
    message_id text,
    chat_id text,
    conversation_id text,
    run_id text,
    purpose text not null,                    -- agent | draft
    allowed text not null default '[]',       -- open_ids allowed to act; [] = anyone in the chat
    payload text not null default '{}',
    status text not null default 'open',      -- open | done | expired
    created_at text not null,
    handled_at text,
    handled_by text
  );
  create index card_interactions_msg on card_interactions(message_id);
  create table lark_cursors (
    chat_id text primary key,
    name text not null default '',
    chat_mode text not null default '',
    last_time integer not null default 0,
    last_ids text not null default '[]',
    updated_at text
  );
  create table handled_messages (
    channel text not null,
    message_id text not null,
    rule text not null default '',
    run_id text,
    at text not null,
    primary key(channel, message_id)
  );
  `,
  // Background runs that found nothing (heartbeat/dream/ingest "QUIET") are hidden
  // from the run list by default; failures and runs that produced output still show.
  `
  alter table runs add column quiet integer not null default 0;
  create index runs_quiet on runs(quiet, created_at);
  `,
  // Which backend/model/effort produced a memory, for evaluating model quality.
  `
  alter table memories add column agent_profile text;
  alter table memories add column model text;
  alter table memories add column effort text;
  alter table memories add column run_id text;
  `,
  // Memory quality: write-time rejections, review verdicts, shadow (comparison) runs,
  // and procedural memories scoped to one agent spec.
  `
  alter table memories add column reviewed_at text;
  alter table memories add column review_verdict text;   -- keep | rewrite | retract
  alter table memories add column review_note text;
  alter table memories add column reviewed_by text;
  alter table memories add column agent text;            -- agent spec name: only that spec (and the owner) sees it
  alter table memories add column tags text not null default '[]';
  update memories set reviewed_at = updated_at, review_verdict = 'keep', reviewed_by = 'legacy' where created_by = 'user';
  create index memories_review on memories(reviewed_at, status);
  create table memory_rejections (
    id text primary key,
    space_id text not null,
    tool text not null,
    kind text not null,
    content text not null,
    codes text not null default '[]',
    run_id text,
    agent_profile text,
    model text,
    effort text,
    shadow integer not null default 0,
    at text not null
  );
  create index memory_rejections_at on memory_rejections(at);
  create table shadow_writes (
    id text primary key,
    run_id text not null,
    parent_run_id text,
    space_id text,
    tool text not null,
    args text not null default '{}',
    agent_profile text,
    model text,
    effort text,
    verdict text,
    verdict_note text,
    at text not null
  );
  create index shadow_writes_run on shadow_writes(parent_run_id, run_id);
  alter table lark_cursors add column kind text not null default '';     -- p2p | bot | own-bot | group | topic | thread
  alter table lark_cursors add column muted integer not null default 0;
  alter table lark_cursors add column involved integer not null default 0;  -- the owner spoke or was @-mentioned here
  `,
  // Feishu messages kept structured next to the chat source text: replies/quotes, images and
  // reactions render as a chat, and history can be backfilled into monthly archive sources.
  `
  create table lark_messages (
    message_id text primary key,
    chat_id text not null,
    thread_id text,
    parent_id text,
    sender_id text,
    sender_name text not null default '',
    sender_kind text not null default 'user',   -- user | app | owner | system
    msg_type text not null default 'text',
    content text not null default '',
    create_ms integer not null,
    source_id text,                             -- chat source this message is a line of (null: only fetched as quoted context)
    line integer,
    archive text,                               -- YYYY-MM for backfilled history, null for live capture
    resources text not null default '{}',       -- resource key -> { sourceId?, file?, name?, type }
    reactions text not null default '[]'
  );
  create index lark_messages_chat on lark_messages(chat_id, create_ms);
  create index lark_messages_source on lark_messages(source_id, line);
  alter table lark_cursors add column oldest_ms integer;          -- earliest time already captured (live or backfilled)
  alter table lark_cursors add column backfill_to_ms integer;     -- backfill history down to this time
  alter table lark_cursors add column backfill_ingest integer not null default 0;
  `,
  // Spaces that belong together (a repo and the service it calls, a project and its repos):
  // runs scoped to one space also read the related ones, and searches include them by default.
  `
  create table space_relations (
    space_a text not null,                      -- the smaller id of the pair
    space_b text not null,
    note text not null default '',              -- how they relate, in a sentence
    origin text not null default 'owner',       -- owner | agent
    status text not null default 'active',      -- active | rejected (the owner removed it; agents do not add it again)
    evidence text not null default '',          -- what an agent saw (shared citations, dependencies)
    created_at text not null,
    updated_at text not null,
    primary key (space_a, space_b)
  );
  `,
  // People seen in Feishu: open_ids differ per app (lark-cli vs the bot), so a person is matched by email,
  // and the bot @-mentions by the tenant-wide user_id. Mentions of a message keep lark-cli's ids.
  `
  create table lark_people (
    email text,
    name text not null default '',
    cli_open_id text unique,
    bot_open_id text unique,
    user_id text,
    updated_at text not null
  );
  create unique index lark_people_email on lark_people(email) where email is not null;
  create index lark_people_user on lark_people(user_id);
  create index lark_people_name on lark_people(name);
  alter table lark_messages add column mentions text not null default '[]';   -- [{ id (lark-cli open_id), name }]
  `,
  // Notification evidence is a snapshot, independent of the item's accumulated evidence.
  `
  alter table notifications add column context text not null default '{}';
  create table item_repairs (
    id text primary key, at text not null, user_id text not null, run_id text,
    reason text not null, snapshot text not null
  );
  create table item_update_proposals (
    id text primary key, item_id text not null references items(id), user_id text not null,
    from_space text not null, run_id text, note text not null, source_refs text not null,
    status text not null default 'pending', created_at text not null, applied_at text, resolution text, resolved_by text, resolved_run_id text
  );
  `,
  // Feishu topic keys keep the thread id as Feishu sends it (omt_…). Work topics opened by omem
  // used to drop the prefix, so the owner's replies in the topic became a second conversation:
  // normalise the keys, then fold each later duplicate into the earliest conversation of the topic.
  `
  update conversations set external_id = substr(external_id, 1, instr(external_id, '#')) || 'omt_' || substr(external_id, instr(external_id, '#') + 1)
    where channel = 'lark' and instr(external_id, '#') > 0 and substr(external_id, instr(external_id, '#') + 1, 4) != 'omt_';
  create temp table topic_dupes as
    select c.id as dupe, (select k.id from conversations k where k.channel = 'lark' and k.external_id = c.external_id and k.status = 'active' order by k.created_at limit 1) as keep
    from conversations c
    where c.channel = 'lark' and c.status = 'active' and instr(c.external_id, '#') > 0
      and exists (select 1 from conversations o where o.channel = 'lark' and o.external_id = c.external_id and o.status = 'active' and o.created_at < c.created_at);
  update messages set conversation_id = (select keep from topic_dupes where dupe = messages.conversation_id) where conversation_id in (select dupe from topic_dupes);
  update conversations set status = 'archived', settings = json_set(coalesce(settings, '{}'), '$.mergedInto', (select keep from topic_dupes where dupe = conversations.id)) where id in (select dupe from topic_dupes);
  drop table topic_dupes;
  `,
  // Turns asked in a merged duplicate belong to the conversation it was merged into.
  `
  update runs set input = json_set(input, '$.conversationId', (select json_extract(c.settings, '$.mergedInto') from conversations c where c.id = json_extract(runs.input, '$.conversationId')))
    where json_extract(input, '$.conversationId') in (select id from conversations where json_extract(settings, '$.mergedInto') is not null);
  update runs set lane = (select json_extract(c.settings, '$.mergedInto') from conversations c where c.id = runs.lane)
    where lane in (select id from conversations where json_extract(settings, '$.mergedInto') is not null) and status not in ('queued', 'running');
  `,
  // Recall accounting: every time a memory is returned by recall, and whether the run used it.
  // Lets the owner see which memories are effective vs never recalled.
  `
  create table memory_recalls (
    id integer primary key autoincrement,
    memory_id text not null,
    run_id text,
    agent_profile text,
    agent_spec text,
    used integer not null default 0,
    at text not null
  );
  create index memory_recalls_mem on memory_recalls(memory_id, at);
  `,
  // Data fixes: a run that used a memory marked every earlier recall of it as used too, so
  // recompute "used" per run; agent runs stored their whole narration a second time (fullText).
  `
  update memory_recalls set used = case when run_id is not null and (
      exists (select 1 from runs r where r.id = memory_recalls.run_id and instr(coalesce(r.output, ''), memory_recalls.memory_id) > 0)
      or exists (select 1 from messages m where m.run_id = memory_recalls.run_id and instr(m.text, memory_recalls.memory_id) > 0)
      or exists (select 1 from run_events e where e.run_id = memory_recalls.run_id and e.type in ('tool-write', 'text') and instr(e.data, memory_recalls.memory_id) > 0)
    ) then 1 else 0 end;
  update runs set output = json_remove(output, '$.fullText') where kind = 'agent' and json_type(output, '$.fullText') is not null;
  `,
  // Changes a profile review proposes for an agent spec or built-in role (prompt, skill,
  // settings); the owner applies or rejects them. Memories are written directly (checked and reviewed).
  `
  create table profile_proposals (
    id text primary key,
    target text not null,
    kind text not null,
    title text not null,
    body text not null,
    reason text not null default '',
    status text not null default 'pending',
    run_id text,
    created_at text not null,
    resolved_at text,
    resolved_by text
  );
  create index profile_proposals_target on profile_proposals(target, status);
  `,
  // The digest step of multi-agent work is gone (the main assistant coordinates instead).
  `
  update runs set status = 'cancelled', finished_at = coalesce(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) where kind = 'agent-followup' and status in ('queued', 'running');
  `,
  // Rules (docs/v2/rules.md): when an event matches, run the actions; each firing is logged and
  // each event handled once per rule.
  `
  create table rules (
    id text primary key,
    name text not null,
    description text not null,
    enabled integer not null default 0,
    trigger text not null,
    conditions text,
    judge text not null default 'code',
    actions text not null,
    created_by text not null default 'user',
    created_at text not null,
    updated_at text not null,
    hits integer not null default 0,
    last_fired_at text
  );
  create table rule_firings (
    id integer primary key autoincrement,
    rule_id text not null,
    event_key text not null,
    at text not null,
    summary text not null default '',
    judged_by text not null,
    reason text not null default '',
    results text not null default '[]'
  );
  create index rule_firings_rule on rule_firings(rule_id, at);
  create table rule_handled (rule_id text not null, key text not null, at text not null, primary key (rule_id, key));
  `,
  `alter table lark_messages add column raw_content text;
   create index lark_messages_chat_cursor on lark_messages(chat_id,create_ms,message_id);`,
  // Background runs that said a sentence before QUIET were not recognized as quiet (jobs.ts isQuiet).
  `update runs set quiet = 1
    where quiet = 0 and status = 'done' and kind in ('heartbeat','wiki-lint','curate','memory-review','dream','profile-review')
      and upper(rtrim(trim(coalesce(case when json_valid(output) then json_extract(output, '$.summary') end, '')), '。.!！*\`_ ' || char(10) || char(13))) like '%QUIET';`,
  // Memory vectors for passive recall (the same model as chunks; cleared when it changes).
  `alter table memories add column embedding blob;
   alter table memory_recalls add column via text not null default 'recall';`,
  // Questions, suggested next steps and approvals put to the owner (agents/asks.ts).
  `create table asks (
    id text primary key,
    run_id text,
    conversation_id text,
    user_id text not null default 'owner',
    kind text not null,
    question text not null default '',
    options text not null default '[]',
    allow_text integer not null default 1,
    tool text,
    args text,
    context text,
    status text not null default 'pending',
    answer text,
    choice integer,
    approved integer,
    result text,
    consumed integer not null default 0,
    shown_at text,
    created_at text not null,
    answered_at text,
    answered_by text
  );
  create index asks_conversation on asks(conversation_id, status);
  create index asks_run on asks(run_id);
  create index asks_pending on asks(status, created_at);`,
  // Temporary rules an agent sets to be woken by an event (agents/wakes.ts): expiry, who set it.
  `alter table rules add column temporary text;`,
  `alter table rules add column space_id text references spaces(id);
   alter table rules add column conversation_id text references conversations(id) on delete set null;`,
  `create table archive_rules(id text primary key, body text not null, priority integer not null);
   create table source_routes(source_id text primary key references sources(id) on delete cascade, origin_space text not null,
     mode text not null, reason text not null, rule_id text, decision_hash text, pending integer not null default 0, ingest integer not null default 0);
   create table source_locations(origin_space text not null, uri text not null, source_id text not null references sources(id) on delete cascade, primary key(origin_space,uri));
   create table source_moves(id integer primary key autoincrement, source_id text not null, from_space text not null, to_space text not null, reason text not null, at text not null);`,
  `alter table archive_rules drop column priority;
   update archive_rules set body = json_remove(body, '$.priority');`,
  // Structured code review (docs/v2/review.md): one row per check per round, findings under it.
  `create table reviews(id text primary key, code_run_id text not null references runs(id) on delete cascade, round integer not null default 1,
     check_name text not null, tier text, profile_id text, model text, effort text, verdict text not null, summary text not null default '',
     status text not null default 'done', created_at text not null);
   create index reviews_run on reviews(code_run_id, round);
   create table review_findings(id integer primary key autoincrement, review_id text not null references reviews(id) on delete cascade,
     severity text not null, file_path text, line integer, title text not null, detail text not null default '', suggestion text not null default '',
     evidence text not null default '[]', confidence text not null default 'medium', state text not null default 'open');
   create index review_findings_review on review_findings(review_id);`,
  // review-lead's rulings on findings (accepted / rejected / merged into another).
  `alter table review_findings add column merged_into integer;
   alter table review_findings add column triage_note text not null default '';`,
  // The AI a run actually used (backend, model, effort), recorded when its first Agent call succeeds.
  `alter table runs add column ai text;`,
  // Memory folders: one home per memory inside its space ('' = not filed yet). The table keeps
  // a folder's description (what belongs there) and folders that are empty for now.
  `alter table memories add column folder text not null default '';
   create index memories_folder on memories(space_id, folder);
   create table memory_folders(space_id text not null, path text not null, description text not null default '',
     created_by text not null default 'agent', created_at text not null, updated_at text not null, primary key(space_id, path));`,
  // Items close themselves (src/items/expiry.ts). item_checks remembers how far the owner's later
  // activity in an item's source chat has been looked at, so the same evidence is judged once.
  // Items already past their deadline when this arrives wait for the owner to review the backlog.
  `create table item_checks(item_id text primary key references items(id) on delete cascade, checked_at text not null, evidence_ms integer not null default 0, reactions_at text);
   insert or replace into kv(key, value) values('item_expiry_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`,
  // Turns a wake-up started that ended QUIET, and the wake-up runs themselves (the turn they start
  // is listed on its own), were kept in the run list.
  `update runs set quiet = 1
    where quiet = 0 and status = 'done' and json_valid(input) and json_extract(input, '$.wake') = 1 and kind in ('ask','agent')
      and upper(rtrim(trim(coalesce(case when json_valid(output) then json_extract(output, '$.answer') end, '')), '。.!！*\`_ ' || char(10) || char(13))) like '%QUIET';
   update runs set quiet = 1 where quiet = 0 and status = 'done' and kind = 'wake';`,
  // Archiving follows the judgement already made on another source of the same conversation.
  `create index sources_chat on sources(json_extract(meta, '$.chatId')) where json_extract(meta, '$.chatId') is not null;`,
  // Several Feishu bots: a card is updated through the bot that posted it (null = the main bot).
  `alter table card_interactions add column bot text;`,
  // How much an original matters to the owner (src/sources/attention.ts): focus / normal / reference /
  // ignore, and who set it (owner, agent, rule). Notes mark line ranges as outdated, key or wrong.
  // Attention rules give new material a level; digest jobs work through stored material in batches.
  `alter table sources add column attention text;
   alter table sources add column attention_by text;
   create index sources_attention on sources(space_id, attention) where attention is not null;
   create table source_notes(id integer primary key, source_id text not null references sources(id) on delete cascade, line_start integer, line_end integer,
     kind text not null, note text not null default '', ref text, by text not null default 'agent', run_id text, created_at text not null);
   create index source_notes_source on source_notes(source_id);
   create table attention_rules(id text primary key, body text not null);
   create table digest_jobs(id text primary key, space_id text not null references spaces(id), mode text not null, body text not null,
     status text not null default 'active', total integer not null default 0, done integer not null default 0, run_id text, created_at text not null, updated_at text not null);
   create table digest_done(job_id text not null references digest_jobs(id) on delete cascade, source_id text not null, hash text not null, at text not null, primary key(job_id, source_id));`,
  // Built-in roles a run used ('|coder|reviewer|'), for filtering runs by role; older runs get the
  // role their kind runs. Items gain materials (documents, chats, repositories with a branch, runs)
  // that delegations and reviews of the item read; review checks may map requirement change points
  // to the code.
  `alter table runs add column roles text;
   update runs set roles = '|' || case kind
     when 'ask' then 'assistant' when 'ingest' then 'ingest' when 'archive' then 'archivist' when 'archive-rule-draft' then 'archive-rule-writer'
     when 'wiki-plan' then 'wiki-planner' when 'wiki-write' then 'wiki-writer' when 'wiki-lint' then 'wiki-linter' when 'heartbeat' then 'heartbeat'
     when 'dream' then 'dreamer' when 'code' then 'coder' when 'tutor' then 'tutor' when 'learn-feed' then 'tutor' when 'brief' then 'brief'
     when 'curate' then 'curator' when 'triage' then 'triager' when 'digest' then 'distiller' when 'thread-summary' then 'summarizer'
     when 'memory-review' then 'memory-reviewer' when 'memory-organize' then 'memory-organizer' when 'item-settle' then 'item-keeper'
     when 'profile-review' then 'coach' when 'guest' then 'guest' when 'agent-followup' then 'assistant' end || '|'
   where kind in ('ask','ingest','archive','archive-rule-draft','wiki-plan','wiki-write','wiki-lint','heartbeat','dream','code','tutor','learn-feed','brief','curate','triage','digest','thread-summary','memory-review','memory-organize','item-settle','profile-review','guest','agent-followup');
   update runs set roles = coalesce(roles, '|') || (select group_concat(check_name, '|') from (select distinct check_name from reviews where code_run_id = runs.id)) || '|'
   where exists (select 1 from reviews where code_run_id = runs.id);
   update runs set roles = coalesce(roles, '|') || 'review-lead|' where json_extract(output, '$.reviewLead.by') = 'lead';
   create table item_materials(id integer primary key, item_id text not null references items(id) on delete cascade, kind text not null,
     ref text not null, label text not null default '', meta text not null default '{}', added_by text not null default 'agent', created_at text not null,
     unique(item_id, kind, ref));
   create index item_materials_ref on item_materials(kind, ref);
   alter table reviews add column change_points text;`,
  // The owner's call on each finding (src/agents/review-fix.ts): fix / later / wontfix and why.
  `alter table review_findings add column decision text;
   alter table review_findings add column decision_note text not null default '';`,
  // Integer primary keys are local counters. Give business rows a portable identity and
  // revision so pulling two databases neither collides nor loses later review decisions.
  ["item_events", "memory_recalls", "rule_firings", "source_moves", "review_findings", "source_notes", "item_materials", "archive_rules", "attention_rules",
    "reviews", "asks", "lark_messages", "item_update_proposals", "profile_proposals", "source_routes", "source_locations", "item_checks", "chat_settings", "digest_done"].map((table) => `
    alter table ${table} add column sync_key text not null default '';
    alter table ${table} add column sync_updated_at text not null default '';
    update ${table} set sync_key = lower(hex(randomblob(16))), sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
    create unique index ${table}_sync on ${table}(sync_key) where sync_key != '';
    create trigger ${table}_sync_insert after insert on ${table} when new.sync_key = '' begin
      update ${table} set sync_key = lower(hex(randomblob(16))), sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where rowid = new.rowid;
    end;
    create trigger ${table}_sync_update after update on ${table}
      when new.sync_key = old.sync_key and new.sync_updated_at = old.sync_updated_at begin
      update ${table} set sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where rowid = new.rowid;
    end;
  `).join("\n") + `
    create table pull_aliases(table_name text not null, remote_key text not null, local_key text not null,
      primary key(table_name, remote_key));
  `,
  // Plugins (docs/v2/plugins.md): each plugin's own records, and the content blocks its agents
  // put in front of the owner (answers kept here, never sent to the page before submission).
  `
  create table plugin_records (
    id text primary key,
    plugin text not null,
    user_id text not null default 'owner',
    space_id text not null,
    collection text not null,
    key text not null,
    data text not null,
    created_at text not null,
    updated_at text not null
  );
  create unique index plugin_records_key on plugin_records(plugin, user_id, collection, key);
  create index plugin_records_recent on plugin_records(plugin, user_id, collection, created_at);
  create table plugin_blocks (
    id text primary key,
    plugin text not null,
    kind text not null,
    conversation_id text not null,
    run_id text,
    user_id text not null default 'owner',
    data text not null,
    status text not null default 'open',
    answers text,
    result text,
    created_at text not null,
    submitted_at text,
    updated_at text not null
  );
  create index plugin_blocks_conversation on plugin_blocks(conversation_id, created_at);
  `,
  // Meetings the owner joined (rules can bring bots in and listen): src/channels/lark-meetings.ts.
  `
  create table lark_meetings (
    meeting_id text primary key,
    meeting_no text,
    topic text not null default '',
    calendar_event_id text,
    status text not null,
    participants text not null default '[]',
    plan text,
    bots text not null default '[]',
    source_id text,
    space_id text,
    page_token text,
    reader text,
    agent_seq integer not null default 0,
    agent_at text,
    error text,
    started_at text not null,
    ended_at text,
    minutes_token text,
    updated_at text not null
  );
  create index lark_meetings_status on lark_meetings(status, updated_at);
  create table lark_meeting_lines (
    meeting_id text not null,
    key text not null,
    seq integer not null,
    at_ms integer not null,
    kind text not null,
    speaker text not null default '',
    speaker_id text,
    text text not null,
    primary key (meeting_id, key)
  );
  create index lark_meeting_lines_seq on lark_meeting_lines(meeting_id, seq);
  `,
  // How many a meeting's calendar event invited (null: unknown).
  `alter table lark_meetings add column invited integer;`,
  // Read-only share links for what a message sent outside omem cites (core/shares.ts): a snapshot of
  // the cited items, found by the token's hash. A message's position in its chat (lark-cli's
  // message_position) makes a Feishu link that opens the chat at that message.
  `
  create table shares (
    id text primary key,
    token_hash text not null unique,
    user_id text not null default 'owner',
    run_id text,
    message_id text,
    origin text not null default '',
    title text not null default '',
    items text not null default '[]',
    created_at text not null,
    expires_at text,
    revoked_at text,
    views integer not null default 0,
    viewed_at text
  );
  create index shares_user on shares(user_id, created_at);
  create index shares_run on shares(run_id);
  alter table lark_messages add column position integer;
  `,
  // Where a wiki page used to live: a moved page keeps its old paths so links and citations to them still open it (src/wiki/store.ts movePages).
  `create table page_aliases(space_id text not null, alias text not null, slug text not null, primary key(space_id, alias));
  create index page_aliases_slug on page_aliases(space_id, slug);`,
  // What omem's bots posted in Feishu (src/channels/lark-feedback.ts), so a reaction on it finds the
  // run that wrote it; and the reactions themselves (everyone's; removing one only fills removed_at).
  `
  create table lark_sent (
    message_id text primary key,
    chat_id text,
    run_id text,
    conversation_id text,
    purpose text not null default 'answer',   -- answer | notification | card | progress
    bot text not null default 'main',
    at text not null
  );
  create index lark_sent_run on lark_sent(run_id);
  create table feedback (
    id text primary key,
    channel text not null default 'lark',
    message_id text not null,
    run_id text,
    bot text,
    on_bot integer not null default 1,        -- 0: the owner's reaction on someone else's message
    actor_id text not null,
    actor_kind text not null,                 -- owner | member | guest | bot
    emoji text not null,
    polarity text not null,                   -- positive | negative | ack | neutral
    at text not null,
    removed_at text
  );
  create index feedback_message on feedback(message_id);
  create index feedback_run on feedback(run_id, at);
  create index feedback_at on feedback(at);
  `,
  // Profile proposals nobody answered expire after 14 days (src/agents/proposals.ts); the notice
  // sent before that is recorded so it goes out once.
  `alter table profile_proposals add column expiry_notice_at text;`,
  // Feishu knowledge bases as a tree (src/sources/catalog.ts): every node a doc sits under, captured
  // or not (source_id null), so the sources page and agents can browse and set levels by folder.
  // Filled from what earlier captures kept in meta (no network); checked_at stays null until the node
  // is read again (`lark-docs-refresh` with `unchecked`), which also writes the missing ancestors.
  // Levels set on a catalog node hold for its subtree (sources/attention.ts `setNodeLevel`); each
  // source keeps the nearest one in node_level so search can filter in SQL.
  `
  alter table sources add column node_level text;
  alter table sources add column node_level_by text;
  create table source_node_levels (
    space_id text not null,
    node_key text not null,
    level text not null,
    by text not null,
    status text not null default 'active',
    reason text not null default '',
    run_id text,
    updated_at text not null,
    primary key (space_id, node_key)
  );
  create table wiki_spaces (id text primary key, name text not null default '', checked_at text);
  create table wiki_nodes (
    token text primary key,
    wiki_space_id text,
    parent_token text,
    title text not null default '',
    obj_token text,
    obj_type text,
    node_type text,
    has_child integer,
    source_id text,
    checked_at text,
    error text
  );
  create index wiki_nodes_parent on wiki_nodes(parent_token);
  create index wiki_nodes_obj on wiki_nodes(obj_token) where obj_token is not null;
  ${FILL_WIKI_NODES}
  `,
  // Notes anchored to their passage and reviewed by the owner (sources/attention.ts, anchor.ts):
  // quote / quote_hash follow the passage when a document is read again, stale_at when it is gone;
  // agents' notes are pending until the owner confirms or rejects them. How often a note shaped search
  // results is counted per device (review order). source_cites: which answers cite a source (a light
  // ranking boost with the pages that cite it, sources/cites.ts).
  `
  alter table source_notes add column quote text;
  alter table source_notes add column quote_hash text;
  alter table source_notes add column status text not null default 'pending';
  alter table source_notes add column stale_at text;
  update source_notes set status = 'confirmed' where by = 'owner';
  create table source_note_hits (note_id integer primary key, n integer not null default 0, at text);
  create table source_cites (source_id text not null, ref text not null, kind text not null, at text not null, primary key (source_id, ref));
  create index source_cites_ref on source_cites(ref);
  `,
  // The same Feishu document captured by its /docx/ link and as a knowledge-base page: merged into the
  // wiki copy by an explicit job (sources/duplicates.ts); the old id stays as an alias so citations resolve.
  `
  create table source_aliases (alias_id text primary key, source_id text not null, reason text not null, detail text not null default '{}', created_at text not null);
  create index source_aliases_target on source_aliases(source_id);
  `,
  // Nightly replay (src/agents/replay.ts, docs/v2/replay.md): one past question answered again as of
  // its time, a baseline re-run against one variant that changes a single axis, deterministic checks,
  // a blind judge in both orders; what the result changes (memory re-review, suggestions) in replay_effects.
  `
  create table replays (
    id text primary key,
    task_run_id text,                         -- the replay run (kind replay)
    signal text not null,                     -- negative | correction | notFound | timeout | slow | normal | positive | manual
    task_type text,
    axis text not null,                       -- R1 R2 R3 S1 S2 M1 M2 M3 W1 W2 A1 A2
    variant text not null default '{}',       -- what the variant arm changed
    as_of text not null,
    base_run_id text not null,                -- the original run
    baseline_run_id text,                     -- the baseline re-run (kind replay-arm)
    arm_run_id text,                          -- the variant (kind replay-arm)
    touched text not null default '{}',       -- what the original run touched: memories, sources, pages
    checks text not null default '{}',
    verdict text,                             -- win | loss | tie | void | failed (from the variant's side)
    judge text not null default '{}',
    cost text not null default '{}',
    status text not null default 'running',   -- running | done | failed
    at text not null,
    finished_at text
  );
  create index replays_base on replays(base_run_id, axis);
  create index replays_at on replays(at);
  create table replay_effects (
    id text primary key,
    replay_id text not null,
    target_kind text not null,                -- memory | source | attention-rule | space | page | item | profile | routing | dream
    target_id text,
    effect text not null,                     -- rereview | helped | level | rule | relate | lint | import | prompt | digest-noise
    note text not null default '',
    status text not null default 'pending',   -- pending | adopted | ignored | applied | info
    at text not null,
    resolved_at text
  );
  create index replay_effects_replay on replay_effects(replay_id);
  create index replay_effects_target on replay_effects(target_kind, target_id, effect);
  `,
  // Every Feishu knowledge base the owner can see (channels/lark-knowledge.ts): what discovery read
  // (description, type, top-level sample; gone_at when no longer listed), the kb-scout's proposal
  // (which space, priority, initial level) and the owner's decision, and the daily reading into the
  // mapped space. A row with discovered_at null is only known from a captured doc. lark_kb_reads: one
  // row per day's batch of a knowledge base (read, already there, not docs, failed).
  `
  alter table wiki_spaces add column description text not null default '';
  alter table wiki_spaces add column space_type text;
  alter table wiki_spaces add column visibility text;
  alter table wiki_spaces add column discovered_at text;
  alter table wiki_spaces add column last_seen_at text;
  alter table wiki_spaces add column gone_at text;
  alter table wiki_spaces add column sample text;
  alter table wiki_spaces add column status text not null default 'new';
  alter table wiki_spaces add column target_space text;
  alter table wiki_spaces add column priority text not null default 'normal';
  alter table wiki_spaces add column level text not null default 'normal';
  alter table wiki_spaces add column daily_share integer;
  alter table wiki_spaces add column proposal text;
  alter table wiki_spaces add column scouted_at text;
  alter table wiki_spaces add column decided_at text;
  alter table wiki_spaces add column decided_by text;
  alter table wiki_spaces add column paused integer not null default 0;
  alter table wiki_spaces add column crawl_id text;
  alter table wiki_spaces add column updated_at text;
  create index wiki_spaces_status on wiki_spaces(status) where discovered_at is not null;
  create table lark_kb_reads (
    id integer primary key,
    at text not null,
    kb_id text not null,
    space_id text not null,
    read integer not null default 0,
    known integer not null default 0,
    skipped integer not null default 0,
    failed integer not null default 0
  );
  create index lark_kb_reads_kb on lark_kb_reads(kb_id, at);
  create index lark_kb_reads_at on lark_kb_reads(at);
  `,
  // Compressed stored media (core/media.ts): references keep the original name, stored-files.ts opens the variant.
  `create table file_variants (
    original text primary key,
    status text not null,
    file text,
    mode text not null,
    quality text not null default '',
    codec text not null default '',
    original_bytes integer not null,
    bytes integer,
    error text,
    created_at text not null
  );
  create index file_variants_file on file_variants(file) where file is not null;
  `,
  // Requirement trees (items/requirements.ts): per space, system → module → page → feature, test
  // points under features; every change kept as a version (a correction or a business change).
  `create table req_nodes (
    id text primary key,
    space_id text not null,
    parent_id text,
    kind text not null,
    seq integer not null default 0,
    title text not null,
    body text not null default '',
    acceptance text not null default '',
    refs text not null default '[]',
    tests text not null default '[]',
    confirmed integer not null default 0,
    status text not null default 'active',
    version integer not null default 1,
    created_by text not null default 'agent',
    created_at text not null,
    updated_at text not null
  );
  create index req_nodes_tree on req_nodes(space_id, parent_id, seq);
  create table req_versions (
    id text primary key,
    node_id text not null,
    version integer not null,
    change text not null,
    title text not null,
    body text not null default '',
    acceptance text not null default '',
    refs text not null default '[]',
    tests text not null default '[]',
    parent_id text,
    reason text not null default '',
    source_refs text not null default '[]',
    by text not null default 'agent',
    run_id text,
    at text not null
  );
  create index req_versions_node on req_versions(node_id, version);
  create table req_links (
    id text primary key,
    from_id text not null,
    to_id text not null,
    kind text not null default 'relates',
    note text not null default '',
    created_at text not null,
    unique(from_id, to_id)
  );
  create index req_links_to on req_links(to_id);
  create table req_status (
    id text primary key,
    node_id text not null,
    run_id text not null,
    round integer not null default 1,
    status text not null,
    locations text not null default '[]',
    note text not null default '',
    at text not null,
    unique(node_id, run_id, round)
  );
  create index req_status_node on req_status(node_id, at);
  create virtual table reqs_fts using fts5(title, body, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 2");
  create table req_rowids (rowid integer primary key, node_id text unique not null);
  `,
  // Delegations and branch reviews for an item live in the item's space (code.ts homeSpace); earlier
  // ones took the first repository's. Move them, their rounds and their reviews over.
  `with recursive fam(id, item) as (
     select id, json_extract(input, '$.itemId') from runs
      where kind = 'code' and json_extract(input, '$.itemId') is not null and json_extract(input, '$.repos') is not null
     union
     select r.id, fam.item from runs r join fam on r.parent_id = fam.id or json_extract(r.input, '$.continueFrom') = fam.id or json_extract(r.input, '$.codeRunId') = fam.id
   )
   update runs set space_id = (select i.space_id from fam join items i on i.id = fam.item where fam.id = runs.id limit 1)
    where id in (select fam.id from fam join items i on i.id = fam.item)
      and space_id in (select id from spaces where root_path is not null)
      and space_id != (select i.space_id from fam join items i on i.id = fam.item where fam.id = runs.id limit 1);
   alter table review_findings add column owner_suggestion text;`,
  // …and an item with a requirement tree is the tree's business: its work moves there (from the
  // repository's space, or from the item's own space when that is not the tree's, e.g. personal).
  `with recursive home(item, space) as (
     select i.id, coalesce((select n.space_id from item_materials m join req_nodes n on n.id = m.ref where m.item_id = i.id and m.kind = 'req' and n.status = 'active' order by m.id limit 1), i.space_id) from items i
   ), fam(id, item) as (
     select id, json_extract(input, '$.itemId') from runs
      where kind = 'code' and json_extract(input, '$.itemId') is not null and json_extract(input, '$.repos') is not null
     union
     select r.id, fam.item from runs r join fam on r.parent_id = fam.id or json_extract(r.input, '$.continueFrom') = fam.id or json_extract(r.input, '$.codeRunId') = fam.id
   )
   update runs set space_id = (select h.space from fam join home h on h.item = fam.item where fam.id = runs.id limit 1)
    where id in (select fam.id from fam join home h on h.item = fam.item join items i on i.id = fam.item
                  where runs.space_id in (select id from spaces where root_path is not null) or runs.space_id = i.space_id)
      and space_id != (select h.space from fam join home h on h.item = fam.item where fam.id = runs.id limit 1);`,
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
