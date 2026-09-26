import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SUPPORTED_SCHEMA_VERSION = 2;

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly actualVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `Database schema ${actualVersion} is newer than supported schema ${supportedVersion}; refusing to write`,
    );
    this.name = "UnsupportedSchemaVersionError";
  }
}

type Migration = {
  version: number;
  name: string;
  statements: readonly string[];
  checksum: string;
};

export type MigrationHooks = {
  /** Acceptance-test seam. Throwing here must roll the whole migration back. */
  beforeCommit?: (version: number, db: DatabaseSync) => void;
};

const baselineStatements = [
  `CREATE TABLE IF NOT EXISTS migrations(
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  "CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, external_id TEXT NOT NULL, head TEXT, UNIQUE(namespace,external_id))",
  "CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), version INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL, previous_id TEXT, created_at TEXT NOT NULL, UNIQUE(source_id,version))",
  "CREATE TABLE IF NOT EXISTS fragments(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions(id), ordinal INTEGER NOT NULL, text TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES fragments(id), to_id TEXT NOT NULL REFERENCES fragments(id), kind TEXT NOT NULL, UNIQUE(from_id,to_id,kind))",
  "CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, before_id TEXT, after_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, change_id TEXT REFERENCES changes(id), title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, dedupe_key TEXT UNIQUE)",
  "CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL, due_at TEXT, evidence_id TEXT REFERENCES fragments(id), status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)",
] as const;

const batchTwoStatements = [
  `CREATE TABLE IF NOT EXISTS migrations(
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  "ALTER TABLE tasks ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'personal'",
  "ALTER TABLE tasks ADD COLUMN owner_id TEXT",
  "ALTER TABLE tasks ADD COLUMN due_expression TEXT",
  "ALTER TABLE tasks ADD COLUMN next_step TEXT NOT NULL DEFAULT ''",
  `CREATE TABLE capture_receipts(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    producer TEXT NOT NULL,
    event_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    source_sequence TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, producer, event_id)
  )`,
  `CREATE TABLE source_state(
    source_id TEXT PRIMARY KEY REFERENCES sources(id),
    workspace_id TEXT NOT NULL,
    registered_scope TEXT NOT NULL,
    head_revision_id TEXT REFERENCES revisions(id),
    validity_epoch INTEGER NOT NULL DEFAULT 1 CHECK(validity_epoch >= 1),
    capture_policy TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `INSERT INTO source_state(source_id,workspace_id,registered_scope,head_revision_id,validity_epoch,capture_policy,updated_at)
   SELECT id,'personal','{}',head,1,'{}',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM sources`,
  `CREATE TABLE jobs(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    input_refs TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    role_version TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','leased','running','succeeded','skipped','awaiting_decision','retry_wait','failed','cancelled')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
    not_before TEXT NOT NULL,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    result_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, kind, input_digest, role_version, policy_version)
  )`,
  `CREATE TABLE job_attempts(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    generation INTEGER NOT NULL CHECK(generation >= 1),
    model TEXT,
    effort TEXT,
    prompt_hash TEXT NOT NULL,
    skill_hash TEXT NOT NULL,
    tool_hash TEXT NOT NULL,
    usage TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE(job_id, attempt)
  )`,
  `CREATE TABLE observations(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT REFERENCES jobs(id),
    actor TEXT NOT NULL,
    observed_at TEXT,
    intent TEXT,
    scope TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('unknown','partial','success','failure')),
    evidence TEXT NOT NULL,
    derived_from TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE proposals(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('task','claim','episode','procedure')),
    operation TEXT NOT NULL CHECK(operation IN ('create','update','supersede')),
    target_id TEXT,
    expected_versions TEXT NOT NULL,
    body TEXT NOT NULL,
    scope TEXT NOT NULL,
    evidence TEXT NOT NULL,
    uncertainties TEXT NOT NULL,
    reason TEXT NOT NULL,
    origin TEXT NOT NULL,
    digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('proposed','validating','rejected','awaiting_decision','approved','applied','stale','failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, digest)
  )`,
  `CREATE TABLE evidence_assessments(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    proposal_digest TEXT NOT NULL,
    quote_asset_verdict TEXT NOT NULL CHECK(quote_asset_verdict IN ('valid','invalid','ambiguous')),
    semantic_verdict TEXT NOT NULL CHECK(semantic_verdict IN ('supported','contradicted','insufficient','needs_scope')),
    reviewer_version TEXT NOT NULL,
    role_version TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, proposal_digest, reviewer_version, role_version)
  )`,
  `CREATE TABLE memories(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('claim','episode','procedure')),
    scope TEXT NOT NULL,
    head_revision_id TEXT,
    version INTEGER NOT NULL CHECK(version >= 1),
    status TEXT NOT NULL CHECK(status IN ('active','superseded','invalidated','archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE memory_revisions(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    memory_id TEXT NOT NULL REFERENCES memories(id),
    version INTEGER NOT NULL CHECK(version >= 1),
    body TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    status TEXT NOT NULL CHECK(status IN ('active','superseded','invalidated','archived')),
    evidence_set TEXT NOT NULL,
    supersedes_revision_id TEXT REFERENCES memory_revisions(id),
    created_at TEXT NOT NULL,
    UNIQUE(memory_id, version)
  )`,
  `CREATE TABLE decisions(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    proposal_digest TEXT NOT NULL,
    expected_versions TEXT NOT NULL,
    owner_binding TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','context_requested','expired','stale')),
    request_id TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, proposal_digest),
    UNIQUE(workspace_id, request_id)
  )`,
  `CREATE TABLE feedback(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    producer TEXT NOT NULL,
    event_id TEXT NOT NULL,
    subject_type TEXT NOT NULL CHECK(subject_type IN ('revision','query','job','proposal')),
    subject_id TEXT NOT NULL,
    actor_provenance TEXT NOT NULL,
    correction TEXT,
    outcome TEXT,
    evidence TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, producer, event_id)
  )`,
  `CREATE TABLE delivery_intents(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    change_id TEXT NOT NULL REFERENCES changes(id),
    channel_binding_version INTEGER NOT NULL CHECK(channel_binding_version >= 1),
    channel TEXT NOT NULL,
    target TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    provider_uuid TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','sending','delivered','retry_wait','failed','unknown','cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, change_id, channel, target)
  )`,
  `CREATE TABLE deliveries(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    intent_id TEXT NOT NULL REFERENCES delivery_intents(id),
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    state TEXT NOT NULL CHECK(state IN ('sending','delivered','retry_wait','failed','unknown')),
    receipt TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE(intent_id, attempt)
  )`,
  `CREATE TABLE event_inbox(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    action_id TEXT,
    payload_digest TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    state TEXT NOT NULL CHECK(state IN ('received','processing','processed','failed')),
    UNIQUE(workspace_id, app_id, event_id),
    UNIQUE(workspace_id, app_id, action_id)
  )`,
  `CREATE TABLE application_receipts(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    proposal_id TEXT,
    proposal_digest TEXT NOT NULL,
    application_generation INTEGER NOT NULL CHECK(application_generation >= 1),
    request_digest TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('memory','task')),
    entity_id TEXT NOT NULL,
    entity_version INTEGER NOT NULL CHECK(entity_version >= 1),
    change_id TEXT NOT NULL REFERENCES changes(id),
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, application_id),
    UNIQUE(workspace_id, proposal_digest, application_generation)
  )`,
  "CREATE INDEX jobs_ready_idx ON jobs(state, not_before)",
  "CREATE INDEX job_attempts_job_idx ON job_attempts(job_id, attempt)",
  "CREATE INDEX proposals_state_idx ON proposals(workspace_id, state, created_at)",
  "CREATE INDEX memory_revisions_memory_idx ON memory_revisions(memory_id, version)",
  "CREATE INDEX delivery_intents_state_idx ON delivery_intents(state, updated_at)",
  "CREATE INDEX event_inbox_state_idx ON event_inbox(state, received_at)",
] as const;

const checksum = (statements: readonly string[]) =>
  createHash("sha256")
    .update(statements.join("\n-- statement --\n"))
    .digest("hex");

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "foundation",
    statements: baselineStatements,
    checksum: checksum(baselineStatements),
  },
  {
    version: 2,
    name: "batch-two-contracts",
    statements: batchTwoStatements,
    checksum: checksum(batchTwoStatements),
  },
];

const legacyV1Checksum = createHash("sha256")
  .update("omem-foundation-user-version-1")
  .digest("hex");

const userVersion = (db: DatabaseSync) =>
  Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );

const tableExists = (db: DatabaseSync, table: string) =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  );

function validateHistory(db: DatabaseSync, version: number) {
  if (!tableExists(db, "migrations")) {
    if (version === 0 || version === 1) return;
    throw Error(`Schema ${version} is missing migration history`);
  }
  const rows = db
    .prepare("SELECT version,name,checksum FROM migrations ORDER BY version")
    .all() as { version: number; name: string; checksum: string }[];
  for (const row of rows) {
    if (row.version > version)
      throw Error(
        `Migration history ${row.version} is ahead of schema ${version}`,
      );
    const expected = migrations.find(
      (migration) => migration.version === row.version,
    );
    if (!expected) throw Error(`Unknown applied migration ${row.version}`);
    const accepted =
      row.checksum === expected.checksum ||
      (row.version === 1 && row.checksum === legacyV1Checksum);
    if (!accepted)
      throw Error(
        `Migration ${row.version} checksum does not match this build`,
      );
  }
  for (const expected of migrations.filter(
    (migration) => migration.version <= version,
  )) {
    if (!rows.some((row) => row.version === expected.version))
      throw Error(`Schema ${version} is missing migration ${expected.version}`);
  }
}

function applyMigration(
  db: DatabaseSync,
  migration: Migration,
  hooks: MigrationHooks,
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentVersion = userVersion(db);
    if (currentVersion >= migration.version) {
      db.exec("COMMIT");
      return;
    }
    if (currentVersion !== migration.version - 1)
      throw Error(
        `Cannot apply migration ${migration.version} from schema ${currentVersion}`,
      );
    for (const statement of migration.statements) db.exec(statement);
    if (migration.version === 2) {
      db.prepare(
        "INSERT OR IGNORE INTO migrations(version,name,checksum,applied_at) VALUES(1,?,?,?)",
      ).run("foundation-legacy", legacyV1Checksum, new Date().toISOString());
    }
    db.prepare(
      "INSERT INTO migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
    ).run(
      migration.version,
      migration.name,
      migration.checksum,
      new Date().toISOString(),
    );
    hooks.beforeCommit?.(migration.version, db);
    db.exec(`PRAGMA user_version=${migration.version}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrateDatabase(db: DatabaseSync, hooks: MigrationHooks = {}) {
  db.exec("PRAGMA foreign_keys=ON");
  const initialVersion = userVersion(db);
  if (initialVersion > SUPPORTED_SCHEMA_VERSION)
    throw new UnsupportedSchemaVersionError(
      initialVersion,
      SUPPORTED_SCHEMA_VERSION,
    );
  validateHistory(db, initialVersion);
  for (const migration of migrations) {
    if (migration.version > initialVersion)
      applyMigration(db, migration, hooks);
  }
  validateHistory(db, SUPPORTED_SCHEMA_VERSION);
  db.exec("PRAGMA journal_mode=WAL");
  return SUPPORTED_SCHEMA_VERSION;
}
