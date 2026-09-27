import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SUPPORTED_SCHEMA_VERSION = 7;

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

const durableJobsAndInputsStatements = [
  "ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts >= 1)",
  "ALTER TABLE jobs ADD COLUMN last_error TEXT",
  "ALTER TABLE jobs ADD COLUMN error_kind TEXT",
  "ALTER TABLE jobs ADD COLUMN finished_at TEXT",
  "ALTER TABLE jobs ADD COLUMN parent_job_id TEXT REFERENCES jobs(id)",
  "ALTER TABLE jobs ADD COLUMN cause TEXT NOT NULL DEFAULT 'capture'",
  "ALTER TABLE job_attempts ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE job_attempts ADD COLUMN error_kind TEXT",
  "ALTER TABLE job_attempts ADD COLUMN outcome TEXT",
  `CREATE TABLE job_control_requests(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    request_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('cancel','retry')),
    payload_digest TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, request_id)
  )`,
  `CREATE TABLE input_batches(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('chat','screen')),
    stream_key TEXT NOT NULL,
    event_ids TEXT NOT NULL,
    first_observed_at TEXT,
    last_observed_at TEXT,
    first_received_at TEXT NOT NULL,
    last_received_at TEXT NOT NULL,
    late_for_batch_id TEXT REFERENCES input_batches(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    job_id TEXT REFERENCES jobs(id),
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, source, stream_key, id)
  )`,
  `CREATE TABLE input_events(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('chat','screen')),
    producer TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    envelope TEXT NOT NULL,
    observed_at TEXT,
    received_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','batched')),
    batch_id TEXT REFERENCES input_batches(id),
    UNIQUE(workspace_id, producer, event_id)
  )`,
  "CREATE INDEX jobs_lease_idx ON jobs(state, lease_expires_at)",
  "CREATE INDEX job_control_job_idx ON job_control_requests(job_id, created_at)",
  "CREATE INDEX input_events_pending_idx ON input_events(state, source, stream_key, received_at)",
  "CREATE INDEX input_batches_stream_idx ON input_batches(workspace_id, source, stream_key, created_at)",
] as const;

const roleRuntimeStatements = [
  "ALTER TABLE job_attempts ADD COLUMN role_bundle_hash TEXT",
  "ALTER TABLE job_attempts ADD COLUMN context_hash TEXT",
  "ALTER TABLE job_attempts ADD COLUMN output_schema TEXT",
  "ALTER TABLE job_attempts ADD COLUMN session_id TEXT",
  "ALTER TABLE job_attempts ADD COLUMN loaded_skills TEXT",
  "ALTER TABLE job_attempts ADD COLUMN allowed_tools TEXT",
  `CREATE TABLE runtime_requests(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    provider_request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('permission','elicitation')),
    payload_digest TEXT NOT NULL,
    options TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','denied','expired','resolved')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(session_id, provider_request_id)
  )`,
  `CREATE TABLE role_outputs(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    attempt INTEGER NOT NULL,
    output_schema TEXT NOT NULL,
    output_digest TEXT NOT NULL,
    output_json TEXT NOT NULL,
    trace_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(job_id, attempt)
  )`,
  "CREATE INDEX runtime_requests_state_idx ON runtime_requests(state, expires_at)",
  "CREATE INDEX role_outputs_job_idx ON role_outputs(job_id, attempt)",
] as const;

const governedMemoryStatements = [
  "ALTER TABLE proposals ADD COLUMN policy_result TEXT",
  "ALTER TABLE proposals ADD COLUMN impact_count INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE decisions ADD COLUMN action TEXT",
  "ALTER TABLE decisions ADD COLUMN resolved_at TEXT",
  "ALTER TABLE feedback ADD COLUMN payload_digest TEXT",
  `CREATE TABLE policy_evaluations(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    proposal_digest TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('auto_apply','awaiting_decision','reject')),
    reasons TEXT NOT NULL,
    impact_count INTEGER NOT NULL CHECK(impact_count >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, proposal_digest, policy_version)
  )`,
  `CREATE TABLE proposal_source_reads(
    proposal_id TEXT NOT NULL REFERENCES proposals(id),
    source_id TEXT NOT NULL REFERENCES sources(id),
    source_revision_id TEXT NOT NULL REFERENCES revisions(id),
    validity_epoch INTEGER NOT NULL CHECK(validity_epoch >= 1),
    PRIMARY KEY(proposal_id, source_id, source_revision_id)
  )`,
  `CREATE TABLE memory_dependencies(
    memory_revision_id TEXT NOT NULL REFERENCES memory_revisions(id),
    source_id TEXT NOT NULL REFERENCES sources(id),
    source_revision_id TEXT NOT NULL REFERENCES revisions(id),
    validity_epoch INTEGER NOT NULL CHECK(validity_epoch >= 1),
    state TEXT NOT NULL CHECK(state IN ('current','stale')),
    PRIMARY KEY(memory_revision_id, source_revision_id)
  )`,
  `CREATE TABLE task_revisions(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    version INTEGER NOT NULL CHECK(version >= 1),
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    due_at TEXT,
    due_expression TEXT,
    owner_id TEXT,
    next_step TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','done')),
    evidence_set TEXT NOT NULL,
    correction_feedback_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, version)
  )`,
  `INSERT INTO task_revisions(
     id,workspace_id,task_id,version,title,detail,due_at,due_expression,
     owner_id,next_step,status,evidence_set,correction_feedback_id,created_at
   ) SELECT id || ':v' || version,workspace_id,id,version,title,detail,due_at,
     due_expression,owner_id,next_step,status,
     CASE WHEN evidence_id IS NULL THEN '[]' ELSE json_array(evidence_id) END,
     NULL,created_at FROM tasks`,
  `CREATE TABLE feedback_constraints(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    subject_id TEXT,
    feedback_id TEXT NOT NULL REFERENCES feedback(id),
    kind TEXT NOT NULL CHECK(kind IN ('fact_correction','task_assignment','method_scope','weak_signal','policy_suggestion')),
    match_key TEXT NOT NULL,
    replacement TEXT,
    strength TEXT NOT NULL CHECK(strength IN ('confirmed','weak','shadow')),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, feedback_id, match_key)
  )`,
  "CREATE INDEX policy_evaluations_outcome_idx ON policy_evaluations(workspace_id, outcome, created_at)",
  "CREATE INDEX proposal_source_reads_source_idx ON proposal_source_reads(source_id, validity_epoch)",
  "CREATE INDEX memory_dependencies_source_idx ON memory_dependencies(source_id, state)",
  "CREATE INDEX feedback_constraints_scope_idx ON feedback_constraints(workspace_id, project_id, subject_id, active)",
] as const;

const larkOnboardingStatements = [
  `CREATE TABLE lark_onboardings(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('new','existing')),
    requested_app_id TEXT,
    requested_config TEXT NOT NULL,
    registration_generation INTEGER NOT NULL CHECK(registration_generation >= 1),
    status TEXT NOT NULL CHECK(status IN ('draft','awaiting_scan','credentials_received','checking','awaiting_pair','active','expired','denied','cancelled','failed')),
    qr_url TEXT,
    qr_expires_at TEXT,
    external_app_id TEXT,
    user_info TEXT,
    connection_version INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cancelled_at TEXT
  )`,
  `CREATE TABLE lark_connections(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    tenant_brand TEXT,
    tenant_key TEXT,
    state TEXT NOT NULL CHECK(state IN ('checking','awaiting_pair','active','disabled','failed')),
    active_version INTEGER,
    owner_open_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, app_id)
  )`,
  `CREATE TABLE lark_connection_versions(
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES lark_connections(id),
    version INTEGER NOT NULL CHECK(version >= 1),
    secret_ref TEXT NOT NULL,
    requested_config TEXT NOT NULL,
    capability_profile TEXT NOT NULL,
    missing_capabilities TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('checking','awaiting_pair','active','failed','superseded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(connection_id, version)
  )`,
  `CREATE TABLE lark_pairing_codes(
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES lark_connections(id),
    connection_version INTEGER NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    candidate_open_id TEXT,
    candidate_chat_id TEXT,
    candidate_chat_type TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL,
    UNIQUE(connection_id, connection_version, code_hash)
  )`,
  `CREATE TABLE lark_bindings(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES lark_connections(id),
    connection_version INTEGER NOT NULL,
    binding_version INTEGER NOT NULL CHECK(binding_version >= 1),
    owner_open_id TEXT NOT NULL,
    target_chat_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('p2p','group')),
    state TEXT NOT NULL CHECK(state IN ('active','superseded','disabled')),
    supersedes_binding_id TEXT REFERENCES lark_bindings(id),
    created_at TEXT NOT NULL,
    UNIQUE(connection_id, binding_version)
  )`,
  `CREATE TABLE lark_onboarding_events(
    id TEXT PRIMARY KEY,
    onboarding_id TEXT NOT NULL REFERENCES lark_onboardings(id),
    status TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX lark_onboarding_state_idx ON lark_onboardings(workspace_id, status, updated_at)",
  "CREATE INDEX lark_connection_versions_state_idx ON lark_connection_versions(connection_id, state, version)",
  "CREATE INDEX lark_pairing_expiry_idx ON lark_pairing_codes(connection_id, expires_at, consumed_at)",
  "CREATE INDEX lark_bindings_active_idx ON lark_bindings(connection_id, state, binding_version)",
  "CREATE INDEX lark_onboarding_events_idx ON lark_onboarding_events(onboarding_id, created_at)",
] as const;

const larkDeliveryStatements = [
  "ALTER TABLE event_inbox ADD COLUMN connection_id TEXT",
  "ALTER TABLE event_inbox ADD COLUMN event_kind TEXT",
  "ALTER TABLE event_inbox ADD COLUMN event_time TEXT",
  "ALTER TABLE event_inbox ADD COLUMN sender_open_id TEXT",
  "ALTER TABLE event_inbox ADD COLUMN chat_id TEXT",
  "ALTER TABLE event_inbox ADD COLUMN message_id TEXT",
  "ALTER TABLE event_inbox ADD COLUMN payload TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN binding_id TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE delivery_intents ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE delivery_intents ADD COLUMN next_attempt_at TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN first_sent_at TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN last_sent_at TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN message_id TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN error_kind TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN last_error TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN lease_owner TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN lease_token TEXT",
  "ALTER TABLE delivery_intents ADD COLUMN lease_expires_at TEXT",
  "ALTER TABLE deliveries ADD COLUMN provider_uuid TEXT",
  `CREATE TABLE lark_targets(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES lark_connections(id),
    binding_version INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('p2p','group')),
    purpose TEXT NOT NULL CHECK(purpose IN ('owner_notification','decision','group_monitoring')),
    capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK(capture_enabled IN (0,1)),
    state TEXT NOT NULL CHECK(state IN ('active','disabled','pending_approval')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(connection_id,binding_version,chat_id,purpose)
  )`,
  `CREATE TABLE lark_connection_leases(
    connection_id TEXT PRIMARY KEY REFERENCES lark_connections(id),
    owner TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE lark_connection_events(
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES lark_connections(id),
    state TEXT NOT NULL CHECK(state IN ('connecting','connected','reconnecting','disconnected','failed')),
    error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE lark_card_actions(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    decision_id TEXT NOT NULL REFERENCES decisions(id),
    proposal_digest TEXT NOT NULL,
    binding_id TEXT NOT NULL REFERENCES lark_bindings(id),
    chat_id TEXT NOT NULL,
    operator_open_id TEXT NOT NULL,
    message_id TEXT,
    nonce_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','consumed','expired','cancelled')),
    result_json TEXT,
    created_at TEXT NOT NULL,
    consumed_at TEXT
  )`,
  "ALTER TABLE delivery_intents ADD COLUMN card_action_id TEXT REFERENCES lark_card_actions(id)",
  `CREATE TABLE lark_card_commands(
    id TEXT PRIMARY KEY,
    inbox_id TEXT NOT NULL REFERENCES event_inbox(id),
    card_action_id TEXT NOT NULL REFERENCES lark_card_actions(id),
    action TEXT NOT NULL CHECK(action IN ('approve','reject','request_context')),
    state TEXT NOT NULL CHECK(state IN ('queued','processing','retry_wait','processed','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    processed_at TEXT,
    UNIQUE(inbox_id)
  )`,
  "CREATE INDEX lark_targets_active_idx ON lark_targets(connection_id,state,purpose)",
  "CREATE INDEX lark_connection_events_idx ON lark_connection_events(connection_id,created_at)",
  "CREATE INDEX lark_delivery_ready_idx ON delivery_intents(channel,state,next_attempt_at)",
  "CREATE INDEX lark_card_commands_state_idx ON lark_card_commands(state,created_at)",
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
  {
    version: 3,
    name: "durable-jobs-and-input-buffers",
    statements: durableJobsAndInputsStatements,
    checksum: checksum(durableJobsAndInputsStatements),
  },
  {
    version: 4,
    name: "versioned-role-runtime",
    statements: roleRuntimeStatements,
    checksum: checksum(roleRuntimeStatements),
  },
  {
    version: 5,
    name: "governed-memory-policy",
    statements: governedMemoryStatements,
    checksum: checksum(governedMemoryStatements),
  },
  {
    version: 6,
    name: "lark-onboarding-and-binding",
    statements: larkOnboardingStatements,
    checksum: checksum(larkOnboardingStatements),
  },
  {
    version: 7,
    name: "lark-realtime-delivery-and-callbacks",
    statements: larkDeliveryStatements,
    checksum: checksum(larkDeliveryStatements),
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
