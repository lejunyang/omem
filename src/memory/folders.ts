import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, now } from "../core/util.ts";
import { getMemory, memoryHistory } from "./store.ts";

/**
 * Memory folders: each memory has one home inside its space ("工作/项目A/报警排查"), for
 * browsing; tags stay for what cuts across folders (a person, a quarter). The path lives on
 * the memory itself; `memory_folders` holds each folder's description — what belongs there,
 * which is how a writer decides where a new memory goes — and folders that are empty for now.
 */
export const FOLDER_DEPTH = 3;
export const FOLDER_NAME_MAX = 20;

export type MemoryFolder = { spaceId: string; path: string; description: string; /** active memories directly in it */ count: number; /** including subfolders */ total: number };

export function normalizeFolder(p?: string | null) {
  return (p ?? "")
    .split(/[/／>›]+/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("/");
}
export const parentFolder = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const ancestors = (p: string) => p.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"));
const under = (p: string, root: string) => p === root || p.startsWith(root + "/");
/** Names that differ only in spacing, case or punctuation are the same folder. */
const nameKey = (s: string) => s.toLowerCase().replace(/[\s\-_·・、,，.。:：()（）[\]【】"'“”‘’]+/g, "");

export function listFolders(app: App, spaceIds?: string | string[] | null): MemoryFolder[] {
  const ids = spaceIds == null ? null : Array.isArray(spaceIds) ? spaceIds : [spaceIds];
  const inSpaces = ids ? `space_id in (${ids.map(() => "?").join(",") || "null"})` : "1";
  const rows = all<{ space_id: string; path: string; description: string }>(app.db, `select space_id, path, description from memory_folders where ${inSpaces}`, ...(ids ?? []));
  const counts = all<{ space_id: string; folder: string; n: number }>(
    app.db,
    `select space_id, folder, count(*) n from memories where status = 'active' and folder != '' and ${inSpaces} group by space_id, folder`,
    ...(ids ?? []),
  );
  const map = new Map<string, MemoryFolder>();
  const at = (spaceId: string, path: string) => {
    const k = `${spaceId}\n${path}`;
    let f = map.get(k);
    if (!f) map.set(k, (f = { spaceId, path, description: "", count: 0, total: 0 }));
    return f;
  };
  for (const r of rows) for (const p of ancestors(r.path)) at(r.space_id, p);
  for (const r of rows) at(r.space_id, r.path).description = r.description;
  for (const c of counts) {
    at(c.space_id, c.folder).count = c.n;
    for (const p of ancestors(c.folder)) at(c.space_id, p).total += c.n;
  }
  return [...map.values()].sort((a, b) => a.spaceId.localeCompare(b.spaceId) || a.path.localeCompare(b.path, "zh-Hans-CN"));
}

export function unfiledCount(app: App, spaceId: string) {
  return one<{ n: number }>(app.db, "select count(*) n from memories where status = 'active' and folder = '' and space_id = ?", spaceId)!.n;
}

/**
 * Deterministic checks on where a memory is being put (agents only; the owner files as they
 * like): depth and name length, a new folder needs a description, and a new folder whose name
 * matches a sibling's but for spacing or punctuation is the sibling.
 */
export function folderProblems(app: App, spaceId: string, path: string, description?: string): string[] {
  if (!path) return [];
  const segs = path.split("/");
  const out: string[] = [];
  if (segs.length > FOLDER_DEPTH) out.push(`目录最多 ${FOLDER_DEPTH} 层：「${path}」有 ${segs.length} 层。放进上一层，或把中间几层合成一层。`);
  const long = segs.find((s) => s.length > FOLDER_NAME_MAX);
  if (long) out.push(`目录名「${long}」太长（${long.length} 字）：目录名是领域的叫法，几个字就够，细节写进记忆。`);
  const folders = listFolders(app, spaceId);
  if (folders.some((f) => f.path === path)) return out;
  for (const p of ancestors(path)) {
    if (folders.some((f) => f.path === p)) continue;
    const parent = parentFolder(p);
    const name = p.slice(parent ? parent.length + 1 : 0);
    const twin = folders.find((f) => parentFolder(f.path) === parent && nameKey(f.path.slice(parent ? parent.length + 1 : 0)) === nameKey(name));
    if (twin) out.push(`已有目录「${twin.path}」，和「${p}」只差写法：用已有的。`);
    break;
  }
  if (!description?.trim()) {
    const parent = parentFolder(path);
    const siblings = folders.filter((f) => parentFolder(f.path) === parent).map((f) => f.path);
    out.push(
      `「${path}」是新目录，要写一句说明（folder_description）：这里放哪一类记忆。` +
        (siblings.length ? `同一层已有：${siblings.join("、")}，合适的话直接用。` : "") +
        "整个目录树用 list_memory_folders 查看。",
    );
  }
  return out;
}

/** Create a folder (and any missing parents). A description is set on the folder itself; an existing one is kept unless `overwrite`. */
export function ensureFolder(app: App, spaceId: string, path: string, description = "", by: "agent" | "user" = "agent", overwrite = false) {
  if (!path) return;
  const at = now();
  for (const p of ancestors(path)) run(app.db, "insert or ignore into memory_folders(space_id, path, description, created_by, created_at, updated_at) values(?,?,?,?,?,?)", spaceId, p, "", by, at, at);
  if (description.trim())
    run(app.db, `update memory_folders set description = ?, updated_at = ? where space_id = ? and path = ? ${overwrite ? "" : "and description = ''"}`, description.trim(), at, spaceId, path);
}

/** Put memories (with their earlier versions, so history views agree) into a folder; "" = not filed. */
export function moveMemories(app: App, spaceId: string, ids: string[], folder: string, by: "agent" | "user" = "agent") {
  const at = now();
  let moved = 0;
  tx(app.db, () => {
    ensureFolder(app, spaceId, folder, "", by);
    for (const id of ids) {
      const m = getMemory(app, id);
      if (m.spaceId !== spaceId) throw new HttpError(400, `记忆 ${id} 不在空间 ${spaceId}`);
      for (const v of memoryHistory(app, id)) {
        const changed = run(app.db, "update memories set folder = ?, updated_at = ? where id = ? and folder != ?", folder, at, v.id, folder).changes;
        if (changed && v.id === id) moved++;
      }
    }
  });
  if (moved) app.emit({ type: "changed", entity: "memory", id: ids[0], spaceId });
  return moved;
}

/**
 * Move a folder with everything under it to a new path. When the new path exists the two are
 * merged (the existing description wins unless it is empty). Moving to the parent removes the
 * folder: its memories and subfolders go one level up ("" at the top = not filed).
 */
export function relocateFolder(app: App, spaceId: string, from: string, to: string, by: "agent" | "user" = "agent") {
  if (!from) throw new HttpError(400, "要指定目录");
  if (from === to) return 0;
  if (to && under(to, from)) throw new HttpError(400, `不能把「${from}」移到它自己下面`);
  const existing = listFolders(app, spaceId);
  if (!existing.some((f) => f.path === from)) throw new HttpError(404, `目录不存在：${from}`);
  const map = (p: string) => normalizeFolder(to + p.slice(from.length));
  const at = now();
  let moved = 0;
  tx(app.db, () => {
    for (const m of all<{ id: string; folder: string }>(app.db, "select id, folder from memories where space_id = ? and (folder = ? or substr(folder, 1, ?) = ?)", spaceId, from, from.length + 1, from + "/")) {
      run(app.db, "update memories set folder = ?, updated_at = ? where id = ?", map(m.folder), at, m.id);
      moved++;
    }
    const rows = all<{ path: string; description: string; created_by: string; created_at: string }>(app.db, "select path, description, created_by, created_at from memory_folders where space_id = ?", spaceId).filter((r) => under(r.path, from));
    for (const r of rows) run(app.db, "delete from memory_folders where space_id = ? and path = ?", spaceId, r.path);
    if (to) ensureFolder(app, spaceId, to, "", by);
    for (const r of rows) {
      const p = map(r.path);
      if (!p) continue;
      run(app.db, "insert or ignore into memory_folders(space_id, path, description, created_by, created_at, updated_at) values(?,?,?,?,?,?)", spaceId, p, "", r.created_by, r.created_at, at);
      if (r.description) run(app.db, "update memory_folders set description = ?, updated_at = ? where space_id = ? and path = ? and description = ''", r.description, at, spaceId, p);
    }
    for (const r of rows) for (const p of map(r.path) ? ancestors(map(r.path)) : []) run(app.db, "insert or ignore into memory_folders(space_id, path, description, created_by, created_at, updated_at) values(?,?,?,?,?,?)", spaceId, p, "", by, at, at);
  });
  app.emit({ type: "changed", entity: "memory", id: from, spaceId });
  return moved;
}

export function removeFolder(app: App, spaceId: string, path: string, by: "agent" | "user" = "agent") {
  return relocateFolder(app, spaceId, path, parentFolder(path), by);
}

/** The folder tree of a space as text for agents: path, counts, description. */
export function folderTreeText(app: App, spaceId: string) {
  const folders = listFolders(app, spaceId);
  const unfiled = unfiledCount(app, spaceId);
  if (!folders.length) return `空间 ${spaceId} 还没有记忆目录${unfiled ? `；${unfiled} 条记忆未归档` : ""}。`;
  return [
    `空间 ${spaceId} 的记忆目录（条数：直接在该目录下 / 含子目录）：`,
    ...folders.map((f) => `${"  ".repeat(f.path.split("/").length - 1)}- ${f.path}（${f.count}${f.total !== f.count ? ` / ${f.total}` : ""}）${f.description ? `：${f.description}` : "：（没有说明）"}`),
    unfiled ? `未归档：${unfiled} 条` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
