import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, statSync, utimesSync } from "node:fs";
import { chmod, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../core/util.ts";
import type { App } from "../core/app.ts";
import { workRootOf } from "./code-tasks.ts";
import { getRun } from "./runs.ts";

const retention = 7 * 86400_000;
const capacity = 2 * 1024 ** 3;
const active = new Map<string, number>();
const pending = new WeakSet<App>();
const du = promisify(execFile);
// Unmounted scopes cannot change until their next acquisition.
const sizes = new Map<string, { used: number; bytes: number }>();

function scope(app: App, runId: string, user: string, guest: boolean, sender?: string) {
  const { kind, input } = getRun(app, runId);
  if (guest) {
    if (kind === "guest" && input.senderId && input.chatId)
      return [user, "guest-chat", input.bot ?? "main", input.senderId, input.chatId];
    if (sender && kind === "ask" && input.conversationId)
      return [user, "guest-thread", sender, input.conversationId];
    return [user, "guest-run", runId];
  }
  if (kind === "ask" && input.conversationId) return [user, "thread", input.conversationId];
  if (kind === "code" || kind === "review") return [user, "code", workRootOf(app, runId)];
  if (kind === "agent" && typeof input.helperOf === "string") return [user, "code", workRootOf(app, input.helperOf)];
  if (input.itemId && (kind.startsWith("flow-") || kind.startsWith("item-")) && !(Array.isArray(input.items) && input.items.length > 1))
    return [user, "item", input.itemId];
  return [user, "run", runId];
}

function tmpRoot(home: string) { return join(realpathSync(home), "sandbox", "tmp"); }

/** Only files/ is mounted. The host owns the enclosing directory and its last-use timestamp. */
export function acquireSandboxTmp(app: App, runId: string | null, user: string, guest: boolean, sender?: string) {
  const root = tmpRoot(app.home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = runId
    ? join(root, sha256(JSON.stringify(scope(app, runId, user, guest, sender))))
    : mkdtempSync(join(root, "turn-"));
  const last = runId && statSync(dir, { throwIfNoEntry: false });
  if (last && !active.has(dir) && last.mtimeMs < Date.now() - retention)
    void discard(root, dir).catch(logCleanupError);
  const path = join(dir, "files");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const now = new Date();
  utimesSync(dir, now, now);
  sizes.delete(dir);
  active.set(dir, (active.get(dir) ?? 0) + 1);
  return { path, release() {
    const count = active.get(dir)! - 1;
    if (count) { active.set(dir, count); return; }
    active.delete(dir);
    if (!runId) {
      void discard(root, dir).catch(logCleanupError);
    } else {
      const end = new Date();
      utimesSync(dir, end, end);
      if (!pending.has(app)) {
        pending.add(app);
        setTimeout(() => {
          pending.delete(app);
          if (existsSync(root)) void pruneSandboxTmp(app.home).catch(logCleanupError);
        }, 30_000).unref();
      }
    }
  } };
}

export function logCleanupError(e: unknown) {
  console.warn("[omem] 清理沙箱临时目录失败", e);
}

// Repair only directories in a detached tree. Pin each one before chmod, including when the backend
// left it unreadable. Symlinks and hard-linked files must never change permissions on the host.
async function unlockDirectories(dir: string) {
  const handle = await open(dir, 0x200000 | constants.O_NOFOLLOW | constants.O_DIRECTORY); // Linux O_PATH
  try {
    const pinned = "/proc/self/fd/" + handle.fd;
    await chmod(pinned, 0o700);
    for (const entry of await readdir(pinned, { withFileTypes: true })) {
      if (entry.isDirectory()) await unlockDirectories(join(pinned, entry.name));
    }
  } finally { await handle.close(); }
}

async function removeTrash(dir: string) {
  try { await rm(dir, { recursive: true, force: true }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EACCES") throw e;
    await unlockDirectories(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

function discard(root: string, dir: string) {
  const trash = join(root, "trash-" + randomUUID());
  renameSync(dir, trash);
  sizes.delete(dir);
  return removeTrash(trash);
}

/** Trim retained data, newest first. Live mounts remain in use until their last token is revoked. */
export async function pruneSandboxTmp(home: string, maxBytes = capacity, maxAge = retention) {
  const root = tmpRoot(home);
  if (!existsSync(root)) return;
  const cutoff = Date.now() - maxAge;
  const recent = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const dir = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("trash-")) {
      await removeTrash(dir).catch(logCleanupError);
      continue;
    }
    const used = statSync(dir, { throwIfNoEntry: false })?.mtimeMs;
    if (used === undefined) continue;
    if (!active.has(dir) && (used < cutoff || entry.name.startsWith("turn-"))) await discard(root, dir).catch(logCleanupError);
    else recent.push({ dir, used, live: active.has(dir) });
  }
  let remaining = maxBytes;
  for (const { dir, used, live } of recent.sort((a, b) => Number(b.live) - Number(a.live) || b.used - a.used)) {
    const cached = sizes.get(dir);
    let size = cached?.used === used ? cached.bytes : undefined;
    if (size === undefined) {
      try {
        // du counts allocated blocks and does not follow links. Scan each changed scope off the event loop.
        const { stdout } = await du("du", ["-skx", "--", dir]);
        size = parseInt(stdout, 10) * 1024;
      } catch (e) {
        if ((e as { code?: number | string }).code !== 1) throw e;
        if (active.has(dir)) continue; // Files can disappear while du measures a running scope.
        size = Infinity; // An unreadable idle tree cannot be retained within the budget.
      }
    }
    // A turn may have acquired or released this scope during the scan.
    if (statSync(dir, { throwIfNoEntry: false })?.mtimeMs !== used) continue;
    if (active.has(dir)) { remaining -= size; continue; }
    if (size <= remaining) {
      remaining -= size;
      sizes.set(dir, { used, bytes: size });
    } else await discard(root, dir).catch(logCleanupError);
  }
}
