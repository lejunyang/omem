import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import { stableDigest } from "../storage/digest.js";

export type SpoolRecord = {
  schemaVersion: 1;
  id: string;
  producer: string;
  eventId: string;
  payloadDigest: string;
  capture: CaptureInput;
  createdAt: string;
};

export type CaptureAcknowledgement = {
  receipt: {
    producer: string;
    eventId: string;
    payloadDigest: string;
    revisionId: string;
  } | null;
};

export class SpoolCapacityError extends Error {
  constructor() {
    super("HOOK_SPOOL_CAPACITY_EXCEEDED");
    this.name = "SpoolCapacityError";
  }
}

const jsonFiles = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort();

export class HookSpool {
  constructor(
    readonly directory: string,
    private readonly options: {
      maxBytes?: number;
      maxEntries?: number;
      retentionMs?: number;
      now?: () => Date;
    } = {},
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  private now() {
    return (this.options.now ?? (() => new Date()))();
  }

  private key(producer: string, eventId: string) {
    return stableDigest({ producer, eventId });
  }

  private path(record: Pick<SpoolRecord, "producer" | "eventId">) {
    return join(
      this.directory,
      this.key(record.producer, record.eventId) + ".json",
    );
  }

  private syncDirectory() {
    try {
      const descriptor = openSync(this.directory, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch {
      // Directory fsync is unsupported on some platforms; file fsync still completed.
    }
  }

  private atomicWrite(path: string, contents: string) {
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeSync(descriptor, contents, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    this.syncDirectory();
  }

  private warn(summary: Record<string, unknown>) {
    const path = join(this.directory, "warnings.jsonl");
    if (existsSync(path) && statSync(path).size >= 1_000_000) return;
    const descriptor = openSync(path, "a", 0o600);
    try {
      writeSync(
        descriptor,
        JSON.stringify({ at: this.now().toISOString(), ...summary }) + "\n",
        undefined,
        "utf8",
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(path, 0o600);
    this.syncDirectory();
  }

  enqueue(capture: CaptureInput) {
    const producer = capture.provenance?.collectorId;
    const eventId = capture.provenance?.eventId;
    if (!producer || !eventId) throw Error("HOOK_EVENT_ID_REQUIRED");
    const payloadDigest = stableDigest(capture);
    const path = this.path({ producer, eventId });
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, "utf8")) as SpoolRecord;
      if (existing.payloadDigest !== payloadDigest)
        throw Error("HOOK_SPOOL_EVENT_CONFLICT");
      return { record: existing, duplicate: true };
    }

    const pending = jsonFiles(this.directory);
    const currentBytes = pending.reduce(
      (total, name) => total + statSync(join(this.directory, name)).size,
      0,
    );
    const record: SpoolRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      producer,
      eventId,
      payloadDigest,
      capture,
      createdAt: this.now().toISOString(),
    };
    const contents = JSON.stringify(record);
    if (
      pending.length >= (this.options.maxEntries ?? 1000) ||
      currentBytes + Buffer.byteLength(contents) >
        (this.options.maxBytes ?? 50_000_000)
    ) {
      this.warn({
        kind: "capacity",
        producer,
        eventId,
        payloadDigest,
        payloadBytes: Buffer.byteLength(contents),
        pendingEntries: pending.length,
        pendingBytes: currentBytes,
      });
      throw new SpoolCapacityError();
    }
    this.atomicWrite(path, contents);
    return { record, duplicate: false };
  }

  pending() {
    const records = jsonFiles(this.directory).map(
      (name) =>
        JSON.parse(
          readFileSync(join(this.directory, name), "utf8"),
        ) as SpoolRecord,
    );
    const cutoff =
      this.now().getTime() - (this.options.retentionMs ?? 7 * 86_400_000);
    for (const record of records) {
      if (Date.parse(record.createdAt) < cutoff)
        this.warn({
          kind: "retention_exceeded",
          producer: record.producer,
          eventId: record.eventId,
          payloadDigest: record.payloadDigest,
        });
    }
    return records.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async flush(
    sender: (capture: CaptureInput) => Promise<CaptureAcknowledgement>,
    limit = 10,
  ) {
    const outcomes: {
      eventId: string;
      delivered: boolean;
      error?: string;
    }[] = [];
    for (const record of this.pending().slice(0, Math.max(0, limit))) {
      try {
        const response = await sender(record.capture);
        const receipt = response.receipt;
        if (
          !receipt ||
          receipt.producer !== record.producer ||
          receipt.eventId !== record.eventId ||
          receipt.payloadDigest !== record.payloadDigest
        )
          throw Error("CAPTURE_RECEIPT_MISMATCH");
        unlinkSync(this.path(record));
        this.syncDirectory();
        outcomes.push({ eventId: record.eventId, delivered: true });
      } catch (error) {
        outcomes.push({
          eventId: record.eventId,
          delivered: false,
          error: error instanceof Error ? error.message : "delivery failed",
        });
        break;
      }
    }
    return outcomes;
  }
}
