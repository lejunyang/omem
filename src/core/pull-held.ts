import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { App } from "./app.ts";
import { buildSnapshot, type SnapshotSelection } from "./pull-transfer.ts";

/**
 * A snapshot kept on disk for a while, so the puller can take it in pieces (`Range`) and go on from
 * where a broken connection left it. The streamed snapshot (`GET /api/peer/snapshot`) is made anew for
 * every request: over a link that breaks now and then, or through a device that only forwards a
 * request for so long, a large one never got through, and each attempt started from nothing.
 *
 * Kept under the data directory (the system's temporary directory can be memory, or a smaller disk).
 * One that nobody asked about for half an hour is removed; at most two exist at a time, the one used
 * longest ago going first; what an earlier process left behind is cleared when the service starts.
 */
export type HeldState = "building" | "ready" | "failed";
export type HeldInfo = { id: string; state: HeldState; size?: number; error?: string };
type Held = HeldInfo & { dir: string; file: string; usedAt: number; tar?: ChildProcess };

const HOLD_MS = 30 * 60_000;
const MAX_HELD = 2;
const held = new Map<string, Held>();
let sweeper: NodeJS.Timeout | undefined;

const root = (app: App) => join(app.home, "tmp", "pull-held");
const info = (h: Held): HeldInfo => ({ id: h.id, state: h.state, ...(h.size === undefined ? {} : { size: h.size }), ...(h.error ? { error: h.error } : {}) });

/** What a process that is gone left behind. */
export function clearHeldSnapshots(app: App) {
  if (held.size) return;
  rmSync(root(app), { recursive: true, force: true });
}

function drop(h: Held) {
  held.delete(h.id);
  h.tar?.kill();
  // A file still being read (Windows) stays until the next sweep or the next start.
  try { rmSync(h.dir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* cleared later */ }
  if (!held.size && sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

function sweep(nowMs = Date.now()) {
  for (const h of [...held.values()]) if (nowMs - h.usedAt > HOLD_MS) drop(h);
}

/** Start making a snapshot to keep; `heldSnapshot` says when it is ready. */
export function holdSnapshot(app: App, selection?: SnapshotSelection): HeldInfo {
  clearHeldSnapshots(app);
  sweep();
  for (const old of [...held.values()].sort((a, b) => a.usedAt - b.usedAt).slice(0, Math.max(0, held.size - MAX_HELD + 1))) drop(old);
  const id = randomBytes(12).toString("hex");
  const dir = join(root(app), id);
  mkdirSync(dir, { recursive: true });
  const h: Held = { id, state: "building", dir, file: join(dir, "snapshot.tar"), usedAt: Date.now() };
  held.set(id, h);
  sweeper ??= setInterval(() => sweep(), 60_000);
  sweeper.unref();
  void (async () => {
    // The snapshot's own files next to the archive: the same disk, and gone with it.
    const built = await buildSnapshot(app, selection, dir);
    try {
      if (held.get(id) !== h) return;
      // tar writes the file itself: gigabytes do not pass through this process.
      const fd = openSync(h.file, "w");
      try {
        await new Promise<void>((resolve, reject) => {
          const tar = spawn("tar", ["-cf", "-", ...built.members], { stdio: ["ignore", fd, "pipe"] });
          h.tar = tar;
          let error = "";
          tar.stderr!.on("data", (b: Buffer) => { error = (error + b.toString()).slice(-500); });
          tar.on("error", reject);
          tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`归档失败：${error || code}`))));
        });
      } finally {
        closeSync(fd);
        h.tar = undefined;
      }
    } finally {
      rmSync(built.dir, { recursive: true, force: true });
    }
    if (held.get(id) !== h) return;
    h.size = statSync(h.file).size;
    h.state = "ready";
    h.usedAt = Date.now();
  })().catch((e) => {
    h.state = "failed";
    h.error = (e as Error).message.slice(0, 500);
  });
  return info(h);
}

/** How a kept snapshot stands; asking keeps it for another while. */
export function heldSnapshot(id: string): (HeldInfo & { file: string }) | null {
  const h = held.get(id);
  if (!h) return null;
  h.usedAt = Date.now();
  return { ...info(h), file: h.file };
}

export function dropHeldSnapshot(id: string) {
  const h = held.get(id);
  if (h) drop(h);
  return { dropped: !!h };
}

/** `Range: bytes=a-b` against a size: the bytes to send, `null` when it asks for none of them. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number; partial: boolean } | null {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return { start: 0, end: size - 1, partial: false };
  const start = Number(m[1]);
  const end = Math.min(size - 1, m[2] ? Number(m[2]) : size - 1);
  return start >= size || end < start ? null : { start, end, partial: true };
}

/** Tests: as if the half hour had passed. */
export function sweepHeldSnapshotsForTests(nowMs: number) {
  sweep(nowMs);
  return held.size;
}
