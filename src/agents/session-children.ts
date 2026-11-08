import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentProfile } from "../core/config.ts";

type Helper = { id: string; parent: string };
// Rollout metadata is immutable. Cache only complete first records, never a partly written file.
const records = new Map<string, Helper | null>();

async function firstRecord(path: string): Promise<{ type?: string; payload?: Record<string, unknown> } | undefined> {
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size < 4 * 1024 * 1024) {
      const b = Buffer.allocUnsafe(16 * 1024);
      const { bytesRead } = await file.read(b);
      if (!bytesRead) return;
      const end = b.subarray(0, bytesRead).indexOf(10);
      chunks.push(b.subarray(0, end < 0 ? bytesRead : end));
      size += bytesRead;
      if (end >= 0) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
  } finally { await file.close(); }
}

/** Read ownership only. Archive through the backend protocol; never modify its database or files. */
export async function disposableChildren(profile: AgentProfile, parentId: string, cwd = process.cwd()): Promise<string[]> {
  const history = profile.sessionHistory;
  if (!history || profile.peer) return [];
  const configured = (history.env && (profile.env[history.env] ?? process.env[history.env])) || history.root;
  const root = resolve(cwd, configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured);
  const files: string[] = [];
  async function walk(dir: string) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(join(dir, e.name));
    }
  }
  await walk(join(root, "sessions"));
  const children: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
    for (;;) {
      const path = files[next++];
      if (!path) return;
      let helper = records.get(path);
      if (helper === undefined) {
        let record;
        try { record = await firstRecord(path); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) continue;
          throw e;
        }
        if (!record) continue;
        const p = record.payload;
        const source = p?.source as { subagent?: { other?: string } } | undefined;
        // Guardian approval reviews are disposable. Native worker agents may be resumed by their
        // parent and must not be inferred to be disposable merely because they are descendants.
        helper = record.type === "session_meta" && p?.originator === "omem" && source?.subagent?.other === "guardian"
          && typeof p.id === "string" && typeof p.parent_thread_id === "string" && path.endsWith(`-${p.id}.jsonl`)
          ? { id: p.id, parent: p.parent_thread_id } : null;
        records.set(path, helper);
      }
      if (helper?.parent === parentId && helper.id !== parentId) children.push(helper.id);
    }
  }));
  return children.sort();
}
