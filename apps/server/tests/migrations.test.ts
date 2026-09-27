import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Store } from "../src/store.js";
import {
  migrateDatabase,
  UnsupportedSchemaVersionError,
} from "../src/storage/migrations.js";
import type {
  ApplicationMetadata,
  MemoryApplication,
  TaskApplication,
} from "../src/storage/repository.js";

const directories: string[] = [];
const makeDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "omem-migration-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const legacySchema = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE sources(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, external_id TEXT NOT NULL, head TEXT, UNIQUE(namespace,external_id));
  CREATE TABLE revisions(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), version INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL, previous_id TEXT, created_at TEXT NOT NULL, UNIQUE(source_id,version));
  CREATE TABLE fragments(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions(id), ordinal INTEGER NOT NULL, text TEXT NOT NULL);
  CREATE TABLE edges(id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES fragments(id), to_id TEXT NOT NULL REFERENCES fragments(id), kind TEXT NOT NULL, UNIQUE(from_id,to_id,kind));
  CREATE TABLE changes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, before_id TEXT, after_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE notifications(id TEXT PRIMARY KEY, change_id TEXT REFERENCES changes(id), title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, dedupe_key TEXT UNIQUE);
  CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL, due_at TEXT, evidence_id TEXT REFERENCES fragments(id), status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
  PRAGMA user_version=1;
`;

const legacyFixture = {
  sourceId: "source-fixed",
  oldRevisionId: "revision-fixed-v1",
  headRevisionId: "revision-fixed-v2",
  oldFragmentId: "fragment-fixed-v1",
  headFragmentId: "fragment-fixed-v2",
  edgeId: "edge-fixed",
  taskId: "task-fixed",
  imageBytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
};

function createLegacyDatabase(directory: string, withData = false) {
  const file = join(directory, "omem.sqlite");
  const db = new DatabaseSync(file);
  db.exec(legacySchema);
  if (!withData) {
    db.close();
    return;
  }

  const assetId = createHash("sha256")
    .update(legacyFixture.imageBytes)
    .digest("hex");
  mkdirSync(join(directory, "assets"), { recursive: true });
  writeFileSync(join(directory, "assets", assetId), legacyFixture.imageBytes);
  const oldBody = JSON.stringify({
    parts: [
      { type: "text", text: "immutable old bytes" },
      { type: "image", assetId, mimeType: "image/png", label: "old image" },
    ],
    context: { application: "legacy" },
    observedAt: "2026-09-20T01:02:03.000Z",
  });
  const headBody = JSON.stringify({
    parts: [{ type: "text", text: "current bytes" }],
    context: {},
  });
  db.prepare("INSERT INTO sources VALUES(?,?,?,?)").run(
    legacyFixture.sourceId,
    "manual",
    "legacy-external",
    legacyFixture.headRevisionId,
  );
  db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)").run(
    legacyFixture.oldRevisionId,
    legacyFixture.sourceId,
    1,
    "Legacy material",
    oldBody,
    "fingerprint-v1",
    null,
    "2026-09-20T01:02:03.000Z",
  );
  db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)").run(
    legacyFixture.headRevisionId,
    legacyFixture.sourceId,
    2,
    "Legacy material",
    headBody,
    "fingerprint-v2",
    legacyFixture.oldRevisionId,
    "2026-09-21T01:02:03.000Z",
  );
  db.prepare("INSERT INTO fragments VALUES(?,?,?,?)").run(
    legacyFixture.oldFragmentId,
    legacyFixture.oldRevisionId,
    0,
    "immutable old bytes",
  );
  db.prepare("INSERT INTO fragments VALUES(?,?,?,?)").run(
    legacyFixture.headFragmentId,
    legacyFixture.headRevisionId,
    0,
    "current bytes",
  );
  db.prepare("INSERT INTO edges VALUES(?,?,?,?)").run(
    legacyFixture.edgeId,
    legacyFixture.headFragmentId,
    legacyFixture.oldFragmentId,
    "references",
  );
  db.prepare(
    "INSERT INTO tasks(id,title,detail,due_at,evidence_id,status,created_at,version) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    legacyFixture.taskId,
    "Legacy task",
    "preserve me",
    "2026-09-30T00:00:00.000Z",
    legacyFixture.oldFragmentId,
    "open",
    "2026-09-20T01:02:03.000Z",
    7,
  );
  db.close();
}

const scalar = (db: DatabaseSync, sql: string) =>
  Number(Object.values(db.prepare(sql).get() as Record<string, unknown>)[0]);

describe("B2-01 migration acceptance", () => {
  it("A-M01 preserves v1 identities, bytes, revisions, references, tasks and old API reads", async () => {
    const directory = makeDirectory();
    createLegacyDatabase(directory, true);
    const before = new DatabaseSync(join(directory, "omem.sqlite"));
    const oldBody = String(
      (
        before
          .prepare("SELECT body FROM revisions WHERE id=?")
          .get(legacyFixture.oldRevisionId) as { body: string }
      ).body,
    );
    before.close();

    const store = new Store(directory);
    try {
      expect(scalar(store.db, "PRAGMA user_version")).toBe(5);
      const revision = store.revision(legacyFixture.oldRevisionId);
      expect(revision).toMatchObject({
        id: legacyFixture.oldRevisionId,
        sourceId: legacyFixture.sourceId,
        version: 1,
        previousId: null,
        current: false,
      });
      expect(revision?.fragments[0]).toMatchObject({
        id: legacyFixture.oldFragmentId,
        text: "immutable old bytes",
      });
      expect(
        (
          store.db
            .prepare("SELECT body FROM revisions WHERE id=?")
            .get(legacyFixture.oldRevisionId) as { body: string }
        ).body,
      ).toBe(oldBody);
      const image = revision?.parts.find((part) => part.type === "image");
      expect(image?.type).toBe("image");
      if (image?.type !== "image") throw Error("legacy image missing");
      expect(store.asset(image.assetId)).toEqual(legacyFixture.imageBytes);
      expect(
        store.evidence(legacyFixture.headFragmentId)?.outgoing,
      ).toMatchObject([
        { id: legacyFixture.edgeId, targetId: legacyFixture.oldFragmentId },
      ]);
      expect(store.tasks()).toMatchObject([
        {
          id: legacyFixture.taskId,
          evidenceId: legacyFixture.oldFragmentId,
          version: 7,
        },
      ]);
      expect(store.list()).toMatchObject([
        {
          id: legacyFixture.headRevisionId,
          sourceId: legacyFixture.sourceId,
          version: 2,
        },
      ]);
      expect(
        store.db.prepare("SELECT * FROM source_state").get(),
      ).toMatchObject({
        source_id: legacyFixture.sourceId,
        head_revision_id: legacyFixture.headRevisionId,
        validity_epoch: 1,
      });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
    }

    const { app } = await buildApp({
      dataDir: directory,
      agentCwd: join(directory, "agent"),
      host: "127.0.0.1",
      port: 4317,
      captureRoots: [],
      notifications: { mode: "instant" },
      profiles: [],
    });
    try {
      const revisionResponse = await app.inject({
        url: `/api/revisions/${legacyFixture.oldRevisionId}`,
        headers: { host: "localhost" },
      });
      expect(revisionResponse.statusCode).toBe(200);
      expect(revisionResponse.json()).toMatchObject({
        id: legacyFixture.oldRevisionId,
        version: 1,
        fragments: [{ id: legacyFixture.oldFragmentId }],
      });
      const taskResponse = await app.inject({
        url: "/api/tasks",
        headers: { host: "localhost" },
      });
      expect(taskResponse.statusCode).toBe(200);
      expect(taskResponse.json()).toMatchObject([
        { id: legacyFixture.taskId, version: 7 },
      ]);
    } finally {
      await app.close();
    }
  });

  it("A-M02 rolls back an interrupted migration and is idempotent across restarts", () => {
    const directory = makeDirectory();
    createLegacyDatabase(directory);
    const file = join(directory, "omem.sqlite");
    const interrupted = new DatabaseSync(file);
    expect(() =>
      migrateDatabase(interrupted, {
        beforeCommit(version) {
          if (version === 2) throw Error("injected migration interruption");
        },
      }),
    ).toThrow("injected migration interruption");
    expect(scalar(interrupted, "PRAGMA user_version")).toBe(1);
    expect(
      interrupted
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='migrations'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      interrupted
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .map((row) => String((row as { name: string }).name)),
    ).not.toContain("workspace_id");
    interrupted.close();

    const first = new Store(directory);
    expect(scalar(first.db, "PRAGMA user_version")).toBe(5);
    expect(scalar(first.db, "SELECT count(*) FROM migrations")).toBe(5);
    const schemaCount = scalar(
      first.db,
      "SELECT count(*) FROM sqlite_master WHERE type IN ('table','index')",
    );
    first.close();

    const second = new Store(directory);
    try {
      expect(scalar(second.db, "PRAGMA user_version")).toBe(5);
      expect(scalar(second.db, "SELECT count(*) FROM migrations")).toBe(5);
      expect(
        scalar(
          second.db,
          "SELECT count(*) FROM sqlite_master WHERE type IN ('table','index')",
        ),
      ).toBe(schemaCount);
    } finally {
      second.close();
    }

    const v2Directory = makeDirectory();
    createLegacyDatabase(v2Directory);
    const v2File = join(v2Directory, "omem.sqlite");
    const v2Interrupted = new DatabaseSync(v2File);
    expect(() =>
      migrateDatabase(v2Interrupted, {
        beforeCommit(version) {
          if (version === 3) throw Error("stop at deployable v2");
        },
      }),
    ).toThrow("stop at deployable v2");
    expect(scalar(v2Interrupted, "PRAGMA user_version")).toBe(2);
    expect(scalar(v2Interrupted, "SELECT count(*) FROM migrations")).toBe(2);
    v2Interrupted.close();
    const upgradedFromV2 = new Store(v2Directory);
    try {
      expect(scalar(upgradedFromV2.db, "PRAGMA user_version")).toBe(5);
      expect(scalar(upgradedFromV2.db, "SELECT count(*) FROM migrations")).toBe(
        5,
      );
      expect(
        upgradedFromV2.db
          .prepare("PRAGMA table_info(jobs)")
          .all()
          .map((row) => String((row as { name: string }).name)),
      ).toContain("max_attempts");
    } finally {
      upgradedFromV2.close();
    }

    const v3Directory = makeDirectory();
    createLegacyDatabase(v3Directory);
    const v3File = join(v3Directory, "omem.sqlite");
    const v3Interrupted = new DatabaseSync(v3File);
    expect(() =>
      migrateDatabase(v3Interrupted, {
        beforeCommit(version) {
          if (version === 4) throw Error("stop at deployable v3");
        },
      }),
    ).toThrow("stop at deployable v3");
    expect(scalar(v3Interrupted, "PRAGMA user_version")).toBe(3);
    expect(scalar(v3Interrupted, "SELECT count(*) FROM migrations")).toBe(3);
    v3Interrupted.close();
    const upgradedFromV3 = new Store(v3Directory);
    try {
      expect(scalar(upgradedFromV3.db, "PRAGMA user_version")).toBe(5);
      expect(scalar(upgradedFromV3.db, "SELECT count(*) FROM migrations")).toBe(
        5,
      );
      expect(
        upgradedFromV3.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_requests'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      upgradedFromV3.close();
    }

    const v4Directory = makeDirectory();
    createLegacyDatabase(v4Directory);
    const v4File = join(v4Directory, "omem.sqlite");
    const v4Interrupted = new DatabaseSync(v4File);
    expect(() =>
      migrateDatabase(v4Interrupted, {
        beforeCommit(version) {
          if (version === 5) throw Error("stop at deployable v4");
        },
      }),
    ).toThrow("stop at deployable v4");
    expect(scalar(v4Interrupted, "PRAGMA user_version")).toBe(4);
    expect(scalar(v4Interrupted, "SELECT count(*) FROM migrations")).toBe(4);
    v4Interrupted.close();
    const upgradedFromV4 = new Store(v4Directory);
    try {
      expect(scalar(upgradedFromV4.db, "PRAGMA user_version")).toBe(5);
      expect(scalar(upgradedFromV4.db, "SELECT count(*) FROM migrations")).toBe(
        5,
      );
      expect(
        upgradedFromV4.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='policy_evaluations'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      upgradedFromV4.close();
    }
  });

  it("A-M03 refuses a newer database without changing its schema bytes", () => {
    const directory = makeDirectory();
    const file = join(directory, "omem.sqlite");
    const future = new DatabaseSync(file);
    future.exec(
      "CREATE TABLE future_marker(value TEXT NOT NULL); INSERT INTO future_marker VALUES('untouched'); PRAGMA user_version=99;",
    );
    future.close();
    const before = readFileSync(file);

    expect(() => new Store(directory)).toThrow(UnsupportedSchemaVersionError);
    expect(readFileSync(file)).toEqual(before);
    const verify = new DatabaseSync(file);
    expect(scalar(verify, "PRAGMA user_version")).toBe(99);
    expect(
      (
        verify.prepare("SELECT value FROM future_marker").get() as {
          value: string;
        }
      ).value,
    ).toBe("untouched");
    expect(
      verify
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='migrations'",
        )
        .get(),
    ).toBeUndefined();
    verify.close();
  });

  it("A-M04 rolls memory/task, receipt and notifications back on change/outbox failure", () => {
    const directory = makeDirectory();
    const store = new Store(directory);
    const metadata = (suffix: string): ApplicationMetadata => ({
      workspaceId: "personal",
      applicationId: `application-${suffix}`,
      proposalDigest: createHash("sha256").update(suffix).digest("hex"),
      generation: 1,
      title: `Apply ${suffix}`,
      details: `details ${suffix}`,
      delivery: {
        channelBindingVersion: 1,
        channel: "in_app",
        target: "notification-center",
      },
    });
    const memory: MemoryApplication = {
      metadata: metadata("memory"),
      memory: {
        kind: "claim",
        scope: { workspace_id: "personal" },
        body: { statement: "transactional memory" },
        evidenceSet: [],
      },
    };
    const task: TaskApplication = {
      metadata: metadata("task"),
      task: {
        title: "transactional task",
        detail: "must not be partial",
        nextStep: "verify rollback",
      },
    };
    try {
      store.db.exec(
        `CREATE TRIGGER inject_change_failure BEFORE INSERT ON changes
         WHEN NEW.kind='memory' BEGIN SELECT RAISE(ABORT,'injected change failure'); END;`,
      );
      expect(() => store.applications.applyMemory(memory)).toThrow(
        "injected change failure",
      );
      expect(scalar(store.db, "SELECT count(*) FROM memories")).toBe(0);
      expect(scalar(store.db, "SELECT count(*) FROM memory_revisions")).toBe(0);
      expect(
        scalar(store.db, "SELECT count(*) FROM application_receipts"),
      ).toBe(0);
      expect(scalar(store.db, "SELECT count(*) FROM changes")).toBe(0);
      expect(scalar(store.db, "SELECT count(*) FROM notifications")).toBe(0);
      expect(scalar(store.db, "SELECT count(*) FROM delivery_intents")).toBe(0);
      store.db.exec("DROP TRIGGER inject_change_failure");

      store.db.exec(
        `CREATE TRIGGER inject_outbox_failure BEFORE INSERT ON delivery_intents
         BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END;`,
      );
      expect(() => store.applications.applyTask(task)).toThrow(
        "injected outbox failure",
      );
      expect(scalar(store.db, "SELECT count(*) FROM tasks")).toBe(0);
      expect(scalar(store.db, "SELECT count(*) FROM task_revisions")).toBe(0);
      expect(
        scalar(store.db, "SELECT count(*) FROM application_receipts"),
      ).toBe(0);
      expect(scalar(store.db, "SELECT count(*) FROM changes")).toBe(0);
      expect(scalar(store.db, "SELECT count(*) FROM notifications")).toBe(0);
      expect(scalar(store.db, "SELECT count(*) FROM delivery_intents")).toBe(0);
      store.db.exec("DROP TRIGGER inject_outbox_failure");

      const applied = store.applications.applyTask(task);
      const replayed = store.applications.applyTask(task);
      expect(applied).toMatchObject({
        entityType: "task",
        entityVersion: 1,
        duplicate: false,
      });
      expect(replayed).toMatchObject({
        id: applied.id,
        entityId: applied.entityId,
        changeId: applied.changeId,
        duplicate: true,
      });
      expect(scalar(store.db, "SELECT count(*) FROM tasks")).toBe(1);
      expect(scalar(store.db, "SELECT count(*) FROM task_revisions")).toBe(1);
      expect(
        scalar(store.db, "SELECT count(*) FROM application_receipts"),
      ).toBe(1);
      expect(scalar(store.db, "SELECT count(*) FROM changes")).toBe(1);
      expect(scalar(store.db, "SELECT count(*) FROM notifications")).toBe(1);
      expect(scalar(store.db, "SELECT count(*) FROM delivery_intents")).toBe(1);
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
