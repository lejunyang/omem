import { randomBytes } from "node:crypto";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";

/**
 * The kinds of task the sweep sorts answers into (docs/v2/reply-sweep.md “任务类型”). Data, not code: a
 * new library has none; the sweep defines one when nothing in the list fits (marked as its own), the owner
 * renames, merges, moves or drops them, and what the owner did is never undone by the sweep. Two levels:
 * a kind can sit under another (报警排查 under 问题排查), and counts roll up to the upper one.
 */
export type TaskType = {
  id: string; name: string; parentId: string | null; description: string; spaces: string[];
  status: "active" | "merged" | "dropped"; mergedInto: string | null; definedBy: "agent" | "owner"; definedRun: string | null;
  ownerNote: string | null; createdAt: string; updatedAt: string;
};
type Row = { id: string; name: string; parent_id: string | null; description: string; spaces: string; status: TaskType["status"]; merged_into: string | null; defined_by: TaskType["definedBy"]; defined_run: string | null; owner_note: string | null; created_at: string; updated_at: string };
const toType = (r: Row): TaskType => ({
  id: r.id, name: r.name, parentId: r.parent_id, description: r.description, spaces: json<string[]>(r.spaces, []), status: r.status,
  mergedInto: r.merged_into, definedBy: r.defined_by, definedRun: r.defined_run, ownerNote: r.owner_note, createdAt: r.created_at, updatedAt: r.updated_at,
});
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export function listTaskTypes(app: App, opts: { all?: boolean } = {}): TaskType[] {
  return all<Row>(app.db, `select * from task_types ${opts.all ? "" : "where status = 'active'"} order by created_at`).map(toType);
}

export function getTaskType(app: App, id: string): TaskType | null {
  const r = one<Row>(app.db, "select * from task_types where id = ?", id);
  return r ? toType(r) : null;
}

/** The kind a name or id stands for now: merged ones lead to where they went. */
export function resolveTaskType(app: App, nameOrId: string): TaskType | null {
  let t = getTaskType(app, nameOrId) ?? listTaskTypes(app, { all: true }).find((x) => norm(x.name) === norm(nameOrId) && x.status !== "merged")
    ?? listTaskTypes(app, { all: true }).find((x) => norm(x.name) === norm(nameOrId)) ?? null;
  for (let i = 0; t?.status === "merged" && t.mergedInto && i < 10; i++) t = getTaskType(app, t.mergedInto);
  return t;
}

/** A kind that applies to work in this space: everywhere, or listed for it. */
const appliesTo = (t: TaskType, spaceId: string | null) => !t.spaces.length || (!!spaceId && t.spaces.includes(spaceId));

export function defineTaskType(app: App, input: { name: string; parent?: string | null; description: string; spaces?: string[]; by: "agent" | "owner"; run?: string | null }): TaskType {
  const name = truncate(input.name.trim(), 40);
  if (name.length < 2) throw new HttpError(400, "类型名至少两个字");
  const same = listTaskTypes(app, { all: true }).find((t) => norm(t.name) === norm(name) && t.status !== "merged");
  if (same?.status === "active") throw new HttpError(409, `已有类型「${same.name}」`);
  if (same?.status === "dropped" && input.by === "agent") throw new HttpError(409, `本人删掉过「${same.name}」${same.ownerNote ? `：${same.ownerNote}` : ""}，不再建`);
  let parentId: string | null = null;
  if (input.parent?.trim()) {
    const parent = resolveTaskType(app, input.parent.trim());
    if (!parent || parent.status !== "active") throw new HttpError(400, `没有类型「${input.parent}」，上一级要用现有的`);
    if (parent.parentId) throw new HttpError(400, `「${parent.name}」已经是细类，类型只有两级`);
    parentId = parent.id;
  }
  const at = now();
  const id = `tt${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  if (same) run(app.db, "delete from task_types where id = ?", same.id);
  run(app.db, "insert into task_types(id, name, parent_id, description, spaces, status, defined_by, defined_run, created_at, updated_at) values(?,?,?,?,?,?,?,?,?,?)",
    same?.id ?? id, name, parentId, truncate(input.description.trim(), 200), JSON.stringify(input.spaces ?? []), "active", input.by, input.run ?? null, at, at);
  return getTaskType(app, same?.id ?? id)!;
}

/**
 * The owner's changes: rename, describe, move under another (or to the top), limit to spaces, drop with
 * a reason, merge into another (its tasks and its sub-kinds go along). An owner's change makes the kind
 * the owner's: the sweep only uses it from then on.
 */
export function updateTaskType(app: App, id: string, patch: { name?: string; description?: string; parent?: string | null; spaces?: string[]; status?: "active" | "dropped"; mergeInto?: string; note?: string | null }): TaskType {
  const t = getTaskType(app, id);
  if (!t) throw new HttpError(404, "没有这个类型");
  const at = now();
  if (patch.mergeInto) {
    const into = resolveTaskType(app, patch.mergeInto);
    if (!into || into.status !== "active" || into.id === t.id) throw new HttpError(400, "要合并到一个现有的、别的类型");
    tx(app.db, () => {
      run(app.db, "update task_types set status = 'merged', merged_into = ?, owner_note = coalesce(?, owner_note), defined_by = 'owner', updated_at = ? where id = ?", into.id, patch.note ?? null, at, t.id);
      run(app.db, "update task_types set parent_id = ?, updated_at = ? where parent_id = ?", into.parentId ? into.parentId : into.id, at, t.id);
      run(app.db, "update reply_tasks set type_id = ?, updated_at = ? where type_id = ?", into.id, at, t.id);
    });
    return getTaskType(app, t.id)!;
  }
  let parentId = t.parentId;
  if (patch.parent !== undefined) {
    if (!patch.parent) parentId = null;
    else {
      const parent = resolveTaskType(app, patch.parent);
      if (!parent || parent.status !== "active" || parent.id === t.id) throw new HttpError(400, "上一级要是一个现有的、别的类型");
      if (parent.parentId) throw new HttpError(400, `「${parent.name}」已经是细类，类型只有两级`);
      if (one(app.db, "select 1 from task_types where parent_id = ? and status = 'active'", t.id)) throw new HttpError(400, `「${t.name}」下面还有细类，不能放到别的类型下面`);
      parentId = parent.id;
    }
  }
  const name = patch.name?.trim() ? truncate(patch.name.trim(), 40) : t.name;
  if (norm(name) !== norm(t.name) && listTaskTypes(app).some((x) => x.id !== t.id && norm(x.name) === norm(name))) throw new HttpError(409, `已有类型「${name}」`);
  run(app.db, "update task_types set name = ?, description = ?, parent_id = ?, spaces = ?, status = ?, owner_note = ?, defined_by = 'owner', updated_at = ? where id = ?",
    name, patch.description !== undefined ? truncate(patch.description.trim(), 200) : t.description, parentId, JSON.stringify(patch.spaces ?? t.spaces),
    patch.status ?? (t.status === "merged" ? "active" : t.status), patch.note !== undefined ? patch.note : t.ownerNote, at, t.id);
  return getTaskType(app, t.id)!;
}

/** The list as the sweep reads it: the kinds that apply to these spaces, sub-kinds under theirs, and what the owner dropped and why. */
export function taskTypesText(app: App, spaces: string[]): string {
  const types = listTaskTypes(app, { all: true });
  const active = types.filter((t) => t.status === "active" && (!t.spaces.length || t.spaces.some((s) => spaces.includes(s))));
  const line = (t: TaskType) => `${t.name}${t.description ? `：${t.description}` : ""}${t.definedBy === "agent" ? "（回扫自动定的）" : ""}`;
  const tops = active.filter((t) => !t.parentId || !active.some((p) => p.id === t.parentId));
  const dropped = types.filter((t) => t.status === "dropped");
  return [
    tops.length ? tops.map((t) => [`- ${line(t)}`, ...active.filter((c) => c.parentId === t.id).map((c) => `  - ${line(c)}`)].join("\n")).join("\n") : "（还没有任何类型：按下面的说法新建）",
    ...(dropped.length ? ["", "本人删掉的（不要再建同样的）：", ...dropped.map((t) => `- ${t.name}${t.ownerNote ? `：${t.ownerNote}` : ""}`)] : []),
  ].join("\n");
}

export { appliesTo as taskTypeAppliesTo };
