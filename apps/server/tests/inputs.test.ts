import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureSchema,
  type CaptureInput,
} from "../../../packages/contracts/src/index.js";
import { hookInput } from "../src/connectors.js";
import { HookSpool, SpoolCapacityError } from "../src/inputs/spool.js";
import { Store } from "../src/store.js";

const directories: string[] = [];
const temporary = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// On POSIX, secret-bearing spool files/directories must be created owner-only
// (0o600 / 0o700). Windows NTFS does not expose Unix mode bits through
// fs.stat (it reports 0o666 for everything); the owner-only guarantee there
// is enforced by ACLs on the per-user temp directory. On Windows we still
// verify the path exists and is accessible to the owner (statSync succeeds,
// which the subsequent content read also proves) rather than weakening the
// security intent on POSIX.
function expectOwnerOnlyMode(target: string, expectedMode: number) {
  const stats = statSync(target);
  if (platform === "win32") {
    expect(stats.isFile() || stats.isDirectory()).toBe(true);
    return;
  }
  expect(stats.mode & 0o777).toBe(expectedMode);
}

describe("B2-02 buffered input acceptance", () => {
  it("A-I01 persists offline hook input and clears only a matching capture receipt", async () => {
    const spoolDirectory = temporary("omem-spool-");
    const rawEvent = {
      event_id: "hook-event-1",
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    };
    const capture = captureSchema.parse(hookInput(rawEvent));
    const forwarded = spawnSync(
      process.execPath,
      ["--import", "tsx", "apps/server/src/hook-forward.ts"],
      {
        cwd: process.cwd(),
        input: JSON.stringify(rawEvent),
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          OMEM_URL: "http://127.0.0.1:1",
          OMEM_HOOK_SPOOL: spoolDirectory,
          OMEM_HOOK_PROFILE_ID: "traex-default-v1",
        },
      },
    );
    expect(forwarded.status).toBe(0);
    expect(forwarded.stdout).toBe("");
    expect(forwarded.stderr).toContain("queued for retry");
    const first = new HookSpool(spoolDirectory);
    expect(first.enqueue(capture).duplicate).toBe(true);
    expect(
      await first.flush(async () => {
        throw Error("offline");
      }),
    ).toMatchObject([{ eventId: "hook-event-1", delivered: false }]);
    expect(first.pending()).toHaveLength(1);

    const restarted = new HookSpool(spoolDirectory);
    expect(restarted.enqueue(capture).duplicate).toBe(true);
    expect(
      await restarted.flush(async () => ({ receipt: null })),
    ).toMatchObject([
      {
        eventId: "hook-event-1",
        delivered: false,
        error: "CAPTURE_RECEIPT_MISMATCH",
      },
    ]);
    expect(restarted.pending()).toHaveLength(1);

    const dataDirectory = temporary("omem-spool-store-");
    const store = new Store(dataDirectory);
    try {
      expect(
        await restarted.flush(async (input) => store.capture(input)),
      ).toMatchObject([{ eventId: "hook-event-1", delivered: true }]);
      expect(restarted.pending()).toHaveLength(0);
      restarted.enqueue(capture);
      await restarted.flush(async (input) => store.capture(input));
      expect(restarted.pending()).toHaveLength(0);
      expect(
        (
          store.db
            .prepare("SELECT count(*) AS count FROM capture_receipts")
            .get() as {
            count: number;
          }
        ).count,
      ).toBe(1);
      expect(store.list()).toHaveLength(1);
      expect(store.jobs.list()).toHaveLength(1);
    } finally {
      store.close();
    }
    expectOwnerOnlyMode(spoolDirectory, 0o700);
  });

  it("A-I02 blocks event conflicts/capacity overflow and applies capture profiles", () => {
    const spoolDirectory = temporary("omem-spool-limits-");
    const spool = new HookSpool(spoolDirectory, {
      maxEntries: 1,
      maxBytes: 100_000,
    });
    const first = captureSchema.parse(
      hookInput(
        {
          event_id: "same-event",
          hook_event_name: "UserPromptSubmit",
          prompt: "keep this ghp_abcdefghijklmnopqrst",
          tool_response: "must not be retained",
          thoughts: "private chain",
          secret: "raw-secret-value",
        },
        { id: "prompt-only-v1", fields: ["prompt"], maxChars: 10_000 },
      ),
    );
    const serialized = JSON.stringify(first);
    expect(serialized).toContain("keep this [REDACTED]");
    expect(serialized).not.toContain("must not be retained");
    expect(serialized).not.toContain("private chain");
    expect(serialized).not.toContain("raw-secret-value");
    spool.enqueue(first);
    const pendingFile = readdirSync(spoolDirectory).find((name) =>
      name.endsWith(".json"),
    )!;
    expectOwnerOnlyMode(join(spoolDirectory, pendingFile), 0o600);

    const conflicting = captureSchema.parse({
      ...first,
      parts: [{ type: "text", text: "different payload" }],
    });
    expect(() => spool.enqueue(conflicting)).toThrow(
      "HOOK_SPOOL_EVENT_CONFLICT",
    );

    const overflow = captureSchema.parse(
      hookInput({
        event_id: "overflow-event",
        hook_event_name: "Stop",
        prompt: "sensitive-overflow-payload",
      }),
    );
    expect(() => spool.enqueue(overflow)).toThrow(SpoolCapacityError);
    const warning = readFileSync(
      join(spoolDirectory, "warnings.jsonl"),
      "utf8",
    );
    expect(warning).toContain('"kind":"capacity"');
    expect(warning).not.toContain("sensitive-overflow-payload");

    const store = new Store(temporary("omem-input-conflict-"));
    try {
      store.capture(first);
      expect(() => store.capture(conflicting)).toThrow(
        "CAPTURE_EVENT_CONFLICT",
      );
      expect(store.list()).toHaveLength(1);
      expect(store.jobs.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("A-I03 forces bounded chat/screen windows, deduplicates noise and traces late events", () => {
    const store = new Store(temporary("omem-aggregation-"));
    const start = new Date("2026-09-27T00:00:00.000Z");
    const event = (
      source: "chat" | "screen",
      id: string,
      text: string,
      observedAt: Date,
    ): CaptureInput =>
      captureSchema.parse({
        source,
        externalId: `${source}:${id}`,
        title: source === "chat" ? "Project room" : "Editor window",
        observedAt: observedAt.toISOString(),
        parts: [{ type: "text", text }],
        context:
          source === "chat"
            ? { conversationId: "conversation-1" }
            : { application: "Editor", windowTitle: "task.ts" },
        provenance: {
          collectorId: `${source}-connector`,
          actorId: source === "chat" ? "owner" : null,
          actorType: source === "chat" ? "owner" : "system",
          actorVerifiedBy: source === "chat" ? "signed-event" : null,
          sourceUri: null,
          eventId: id,
          eventAt: observedAt.toISOString(),
          timezone: "Asia/Shanghai",
          quoted: false,
          forwarded: false,
          producerKind: "original",
        },
      });
    try {
      store.inputs.ingest(event("chat", "c1", "same noise", start), start);
      store.inputs.ingest(
        event("chat", "c2", "same noise", new Date(start.getTime() + 100_000)),
        new Date(start.getTime() + 100_000),
      );
      store.inputs.ingest(
        event(
          "chat",
          "c3",
          "useful update",
          new Date(start.getTime() + 200_000),
        ),
        new Date(start.getTime() + 200_000),
      );
      store.inputs.ingest(
        event(
          "chat",
          "c4",
          "still active",
          new Date(start.getTime() + 299_000),
        ),
        new Date(start.getTime() + 299_000),
      );
      expect(
        store.inputs.flushReady((input) => store.capture(input), {
          now: new Date(start.getTime() + 299_000),
        }),
      ).toEqual([]);
      const forced = store.inputs.flushReady((input) => store.capture(input), {
        now: new Date(start.getTime() + 300_000),
      });
      expect(forced).toHaveLength(1);
      expect(forced[0]).toMatchObject({
        eventIds: [
          "chat-connector:c1",
          "chat-connector:c2",
          "chat-connector:c3",
          "chat-connector:c4",
        ],
        lateForBatchId: null,
      });
      const firstRevision = store.revision(forced[0]!.revisionId)!;
      expect(firstRevision.parts).toHaveLength(3);
      expect(firstRevision.context.aggregation).toMatchObject({
        eventIds: [
          "chat-connector:c1",
          "chat-connector:c2",
          "chat-connector:c3",
          "chat-connector:c4",
        ],
        windowStartedAt: start.toISOString(),
        windowEndedAt: new Date(start.getTime() + 299_000).toISOString(),
      });

      const lateObserved = new Date(start.getTime() + 150_000);
      store.inputs.ingest(
        event("chat", "c-late", "late supplement", lateObserved),
        new Date(start.getTime() + 310_000),
      );
      const supplement = store.inputs.flushReady(
        (input) => store.capture(input),
        {
          now: new Date(start.getTime() + 326_000),
        },
      );
      expect(supplement).toHaveLength(1);
      expect(supplement[0]?.lateForBatchId).toBe(forced[0]?.batchId);
      expect(supplement[0]?.revisionId).not.toBe(forced[0]?.revisionId);

      store.inputs.ingest(
        event(
          "screen",
          "s1",
          "unchanged screen",
          new Date(start.getTime() + 400_000),
        ),
        new Date(start.getTime() + 400_000),
      );
      store.inputs.ingest(
        event(
          "screen",
          "s2",
          "unchanged screen",
          new Date(start.getTime() + 401_000),
        ),
        new Date(start.getTime() + 401_000),
      );
      const screen = store.inputs.flushReady((input) => store.capture(input), {
        now: new Date(start.getTime() + 401_000),
        maxEvents: 2,
      });
      expect(screen).toHaveLength(1);
      expect(screen[0]?.eventIds).toEqual([
        "screen-connector:s1",
        "screen-connector:s2",
      ]);
      expect(store.revision(screen[0]!.revisionId)?.parts).toHaveLength(1);
      expect(store.inputs.pendingCount()).toBe(0);
      expect(store.inputs.batches()).toHaveLength(3);
      expect(store.jobs.list()).toHaveLength(3);
    } finally {
      store.close();
    }
  });
});
