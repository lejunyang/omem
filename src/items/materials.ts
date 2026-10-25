import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError, json, now } from "../core/util.ts";
import { accessibleSpaces } from "../core/users.ts";
import { addItemEvent, getItem } from "./store.ts";

/**
 * What an item is about, kept with it (docs/v2/review.md §5.1): originals (documents, chats),
 * conversations with omem, repositories with a branch, whole spaces to read (a migration's source
 * repository), and the delegations and reviews done for it. Reviews and delegations of the item read
 * these; the item page shows them together.
 */
export type MaterialKind = "source" | "conversation" | "repo" | "space" | "run";
export const MATERIAL_KINDS: readonly MaterialKind[] = ["source", "conversation", "repo", "space", "run"];
export type MaterialInput = { kind: MaterialKind; ref: string; branch?: string; base?: string; label?: string; note?: string };
export type Material = {
  id: number;
  kind: MaterialKind;
  ref: string;
  label: string;
  /** repo: { space, branch, base }; source: { hash } at the time it was added; any: { note }. */
  meta: { space?: string; branch?: string; base?: string; hash?: string; note?: string };
  addedBy: string;
  createdAt: string;
};
/** A material as a reader sees it now: where it lives, whether it can be read, whether it changed. */
export type MaterialView = Material & { spaceId: string | null; title: string; status: string | null; readable: boolean; changed: boolean; missing: boolean };

type Row = { id: number; item_id: string; kind: string; ref: string; label: string; meta: string; added_by: string; created_at: string };
const toMaterial = (r: Row): Material => ({ id: r.id, kind: r.kind as MaterialKind, ref: r.ref, label: r.label, meta: json(r.meta, {}), addedBy: r.added_by, createdAt: r.created_at });

export function itemMaterials(app: App, itemId: string): Material[] {
  return all<Row>(app.db, "select * from item_materials where item_id = ? order by kind, id", itemId).map(toMaterial);
}

/** `src:<id>#L1-L9` and links to it read as the id; a repository is `<space>#<branch>`. */
function normalize(m: MaterialInput) {
  const ref = m.ref.trim();
  if (m.kind === "source") return ref.replace(/^src:/, "").replace(/#.*$/, "");
  if (m.kind === "repo") return `${ref.split("#")[0]}#${m.branch?.trim() || ref.split("#")[1] || ""}`;
  return ref;
}

/** What the material is and which space it belongs to; throws when it does not exist. */
function resolve(app: App, kind: MaterialKind, ref: string): { spaceId: string | null; title: string; hash?: string; status?: string; userId?: string } {
  if (kind === "source") {
    const s = one<{ space_id: string; title: string; hash: string; deleted_at: string | null }>(app.db, "select space_id, title, hash, deleted_at from sources where id = ?", ref);
    if (!s) throw new HttpError(404, `原件不存在：${ref}`);
    return { spaceId: s.space_id, title: s.title, hash: s.hash, status: s.deleted_at ? "deleted" : undefined };
  }
  if (kind === "conversation") {
    const c = one<{ space_id: string; title: string; user_id: string }>(app.db, "select space_id, title, user_id from conversations where id = ?", ref);
    if (!c) throw new HttpError(404, `会话不存在：${ref}`);
    return { spaceId: c.space_id, title: c.title || ref, userId: c.user_id };
  }
  if (kind === "run") {
    const r = one<{ space_id: string | null; title: string; status: string; user_id: string | null }>(app.db, "select space_id, title, status, user_id from runs where id = ?", ref);
    if (!r) throw new HttpError(404, `运行不存在：${ref}`);
    return { spaceId: r.space_id, title: r.title, status: r.status, userId: r.user_id ?? undefined };
  }
  const id = kind === "repo" ? ref.split("#")[0] : ref;
  const s = findSpace(app, id);
  if (!s) throw new HttpError(404, `空间不存在：${id}`);
  if (kind === "repo" && !s.rootPath) throw new HttpError(400, `空间 ${id} 没有关联 Git 仓库`);
  return { spaceId: s.id, title: kind === "repo" ? `${s.name} · ${ref.split("#")[1] || "当前检出"}` : s.name };
}

/**
 * Add materials to an item; the reader must be able to see each one (its space), and only its own
 * conversations and runs. Adding one that is there already updates its label and note.
 */
export function addMaterials(app: App, itemId: string, list: MaterialInput[], userId: string, by: "user" | "agent" = "agent") {
  const item = getItem(app, itemId);
  if (item.userId !== userId) throw new HttpError(403, "不能修改他人的事项");
  const allowed = accessibleSpaces(app, userId);
  const added: Material[] = [];
  for (const m of list) {
    const ref = normalize(m);
    if (!ref || ref === "#") throw new HttpError(400, "材料缺少 ref");
    const r = resolve(app, m.kind, ref);
    if (allowed && r.spaceId && !allowed.includes(r.spaceId)) throw new HttpError(403, `不能访问空间 ${r.spaceId}`);
    if (r.userId && r.userId !== userId) throw new HttpError(403, "只能加自己的会话和运行");
    const meta: Material["meta"] = {
      ...(m.kind === "repo" ? { space: ref.split("#")[0], branch: ref.split("#")[1] || undefined, base: m.base?.trim() || undefined } : {}),
      ...(r.hash ? { hash: r.hash } : {}),
      ...(m.note?.trim() ? { note: m.note.trim() } : {}),
    };
    const label = m.label?.trim() || r.title;
    run(app.db, `insert into item_materials(item_id, kind, ref, label, meta, added_by, created_at) values(?,?,?,?,?,?,?)
      on conflict(item_id, kind, ref) do update set label = excluded.label, meta = excluded.meta`, itemId, m.kind, ref, label, JSON.stringify(meta), by, now());
    added.push(toMaterial(one<Row>(app.db, "select * from item_materials where item_id = ? and kind = ? and ref = ?", itemId, m.kind, ref)!));
  }
  if (added.length) addItemEvent(app, itemId, "updated", `加入材料：${added.map((m) => m.label).join("、")}`, by);
  return added;
}

/** Remove by material id or by `kind:ref`. */
export function removeMaterials(app: App, itemId: string, keys: (number | string)[], userId: string, by: "user" | "agent" = "agent") {
  const item = getItem(app, itemId);
  if (item.userId !== userId) throw new HttpError(403, "不能修改他人的事项");
  const gone: string[] = [];
  for (const key of keys) {
    const row = typeof key === "number" || /^\d+$/.test(key)
      ? one<Row>(app.db, "select * from item_materials where item_id = ? and id = ?", itemId, Number(key))
      : one<Row>(app.db, "select * from item_materials where item_id = ? and kind = ? and ref = ?", itemId, key.split(":")[0], key.split(":").slice(1).join(":"));
    if (!row) continue;
    run(app.db, "delete from item_materials where id = ?", row.id);
    gone.push(row.label);
  }
  if (gone.length) addItemEvent(app, itemId, "updated", `移除材料：${gone.join("、")}`, by);
  return gone.length;
}

/** Materials with their current state, limited to what this reader may see. */
export function materialViews(app: App, itemId: string, userId: string): MaterialView[] {
  const allowed = accessibleSpaces(app, userId);
  return itemMaterials(app, itemId).map((m) => {
    try {
      const r = resolve(app, m.kind, m.ref);
      const readable = !allowed || !r.spaceId || allowed.includes(r.spaceId);
      return { ...m, spaceId: r.spaceId, title: readable ? r.title : m.label, status: r.status ?? null, readable, changed: !!(m.meta.hash && r.hash && m.meta.hash !== r.hash), missing: r.status === "deleted" };
    } catch {
      return { ...m, spaceId: null, title: m.label, status: null, readable: false, changed: false, missing: true };
    }
  });
}

/** Spaces a review or delegation of the item should be able to read. */
export function materialSpaces(app: App, itemId: string, userId: string) {
  return [...new Set(materialViews(app, itemId, userId).filter((m) => m.readable && !m.missing && m.spaceId && m.kind !== "run").map((m) => m.spaceId!))];
}

const KIND_LABEL: Record<MaterialKind, string> = { source: "原件", conversation: "会话", repo: "仓库分支", space: "空间", run: "运行" };

/** The item and its materials, as a section of a review's or delegation's task. */
export function materialsBrief(app: App, itemId: string, userId: string) {
  const item = getItem(app, itemId);
  const list = materialViews(app, itemId, userId).filter((m) => m.readable && !m.missing);
  const line = (m: MaterialView) => {
    const ref = m.kind === "source" ? `src:${m.ref}` : m.kind === "repo" ? `仓库空间 ${m.meta.space}，分支 ${m.meta.branch ?? "当前检出"}${m.meta.base ? `，基线 ${m.meta.base}` : ""}` : m.kind === "space" ? `空间 ${m.ref}` : m.kind === "conversation" ? `会话 ${m.ref}` : `运行 ${m.ref}（${m.status ?? ""}）`;
    return `- [${KIND_LABEL[m.kind]}] ${m.title} — ${ref}${m.changed ? "（加入后有更新）" : ""}${m.meta.note ? `：${m.meta.note}` : ""}`;
  };
  return [
    `## 所属事项：${item.title}（${item.id}）`,
    item.detail ? item.detail : "",
    list.length ? `材料（用 read_source 读原件，search 限定到这些空间检索；“运行”是之前为这个事项做过的交办或评审，可用 read_run 看结论）：\n${list.map(line).join("\n")}` : "这个事项还没有材料。",
  ].filter(Boolean).join("\n\n");
}

/**
 * A delegation or review started for an item becomes one of its materials, and so does a branch it
 * reviews: the item page then shows the work and the code next to the documents.
 */
export function linkRunToItem(app: App, run: { id: string; title: string; input: Record<string, unknown> }, itemId: string, userId: string) {
  const branches = (run.input.branches ?? {}) as Record<string, { branch: string; base?: string }>;
  addMaterials(app, itemId, [
    { kind: "run", ref: run.id, label: run.title },
    ...Object.entries(branches).map(([space, b]) => ({ kind: "repo" as const, ref: space, branch: b.branch, base: b.base })),
  ], userId);
}

/** Items a run was done for (it is one of their materials). */
export function itemsOfRun(app: App, runId: string) {
  return all<{ id: string; title: string; status: string }>(app.db, "select i.id, i.title, i.status from item_materials m join items i on i.id = m.item_id where m.kind = 'run' and m.ref = ?", runId);
}
