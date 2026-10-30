import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { HttpError, truncate } from "../core/util.ts";
import { materialSpaces, materialsBrief } from "../items/materials.ts";
import { ownerCorrections, reqTree } from "../items/requirements.ts";
import { getItem } from "../items/store.ts";
import { runRole } from "./runner.ts";
import { createRun, registerHandler, runUser } from "./runs.ts";

/**
 * “拆需求点” (docs/v2/requirements.md): the req-splitter role reads an item's materials and writes the
 * requirement tree of a business space; what it writes waits for the owner's confirmation. The role is
 * the owner's to customize on the Agent page (its guide, its model, skills attached to it, e.g. one that
 * also creates the test cases on an internal test platform), so the host only gives it the item.
 */
export function startReqSplit(app: App, opts: { itemId: string; space?: string; note?: string; userId: string; parentId?: string | null }) {
  const item = getItem(app, opts.itemId);
  if (item.userId !== opts.userId) throw new HttpError(403, "只能拆自己的事项");
  return createRun(app, {
    kind: "req-split",
    spaceId: opts.space ?? item.spaceId,
    title: truncate(`拆需求点：${item.title}`, 80),
    input: { itemId: item.id, note: opts.note?.trim() || undefined },
    parentId: opts.parentId ?? undefined,
    userId: opts.userId,
  });
}

registerHandler("req-split", async (ctx) => {
  const { itemId, note } = ctx.run.input as { itemId: string; note?: string };
  const user = runUser(ctx.app, ctx.run.id);
  const spaceId = ctx.run.spaceId!;
  const tree = reqTree(ctx.app, spaceId, { tests: false, depth: 4 });
  // How the owner fixed earlier splits in this space: the same kind of thing should come out right now.
  const fixes = ownerCorrections(ctx.app, { spaceId, limit: 15 });
  const task = [
    `给事项 ${itemId} 拆需求点，写进空间 ${spaceId} 的需求树。`,
    materialsBrief(ctx.app, itemId, user),
    tree.length ? `空间 ${spaceId} 现有的需求树（前四层，不含测试点；完整的用 req_tree 看）：\n${tree.map((n) => `${"  ".repeat(n.depth)}- ${n.id} ${n.title}`).join("\n")}` : `空间 ${spaceId} 还没有需求树。`,
    fixes.lines.length ? `## 本人以前对拆分结果的修改（同样的问题这次不要再出现）\n\n${fixes.lines.join("\n")}` : "",
    note ? `## 本人的要求\n\n${note}` : "",
    "不用把需求点挂到事项上：你新建或修改的节点里最上层的那些，宿主会作为这个事项的材料（kind: req）挂上。",
  ].filter(Boolean).join("\n\n");
  const r = await runRole(ctx.app, {
    role: "req-splitter",
    spaceId,
    alsoRead: materialSpaces(ctx.app, itemId, user),
    task,
    runId: ctx.run.id,
    signal: ctx.signal,
    onEvent: (e) => ctx.event(e.type, e),
    userId: user,
  });
  run(ctx.app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
  const scoped = await scopeItem(ctx.app, ctx.run.id, itemId, user);
  return { summary: r.text.trim(), scoped };
});

/** The topmost nodes this run created or changed (in its own space) become the item's `req` materials. */
async function scopeItem(app: App, runId: string, itemId: string, userId: string) {
  const { all } = await import("../core/db.ts");
  const { findReq, reqPath } = await import("../items/requirements.ts");
  const touched = all<{ node_id: string }>(app.db, "select distinct node_id from req_versions where run_id = ?", runId).map((r) => findReq(app, r.node_id)).filter((n) => !!n && n.status === "active");
  const ids = new Set(touched.map((n) => n!.id));
  // A node whose ancestor was also touched is covered by it; otherwise the node itself (a feature
  // added under an existing page scopes just that feature, not the whole page).
  const tops = touched.filter((n) => !reqPath(app, n!).slice(0, -1).some((a) => ids.has(a.id))).map((n) => n!.id);
  if (!tops.length) return 0;
  const { addMaterials } = await import("../items/materials.ts");
  addMaterials(app, itemId, tops.map((ref) => ({ kind: "req" as const, ref })), userId, "agent");
  return tops.length;
}
