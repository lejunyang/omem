import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace, getSpace } from "../core/spaces.ts";
import { scopeFor } from "../core/users.ts";
import { HttpError, truncate } from "../core/util.ts";
import { requireReadable } from "../auth/visibility.ts";
import { canonicalSourceId } from "../sources/duplicates.ts";
import { materialSpaces, materialsBrief } from "../items/materials.ts";
import type { Execution } from "../agents/execution.ts";
import { homeOf } from "../agents/home.ts";
import { createRun, registerHandler, runUser, type Run } from "../agents/runs.ts";
import { designLine, designMarkdown } from "./render.ts";
import { createDesign, getDesign, setDesignStatus, updateDesign, type Design } from "./store.ts";

/**
 * Following someone else's technical design (docs/v2/coding-plan.md §4.1): the `designer` role reads
 * the document and the code, extracts what the author decided and assesses it, and hands in an
 * `external` design; the owner gets a notification, and the conversation it was asked from gets the
 * result. A newer version of the document is assessed again on the same design.
 */

/**
 * A design document as `src:<id>`: given as `src:<id>`, an id, or the link it was taken in from. It
 * must exist, sit in a space the caller may read, and be readable by them (restricted ones, Feishu access).
 */
export async function resolveDesignSources(app: App, refs: string[], who: { userId: string; spaces: string[] | null }): Promise<string[]> {
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const bare = ref.startsWith("src:") ? ref.slice(4).replace(/#.*$/, "") : ref;
    const byId = one<{ id: string; space_id: string }>(app.db, "select id, space_id from sources where id = ? and deleted_at is null", canonicalSourceId(app, bare));
    const rows = byId ? [byId] : all<{ id: string; space_id: string }>(app.db, "select id, space_id from sources where (uri = ? or json_extract(meta, '$.url') = ?) and deleted_at is null order by length(uri) limit 5", ref, ref);
    const readable = rows.filter((r) => !who.spaces || who.spaces.includes(r.space_id));
    if (!rows.length) throw new HttpError(404, `找不到原件 ${ref}：先用 import_url 把文档收进来（飞书文档也一样），再传它的 src:<原件id>`);
    if (!readable.length) throw new HttpError(403, `原件 ${ref} 所在的空间这次不能读`);
    if (readable.length > 1) throw new HttpError(400, `“${ref}”对应多个原件：${readable.map((r) => `src:${r.id}（${r.space_id}）`).join("、")}；传其中一个的 src:<id>`);
    await requireReadable(app, who.userId, readable[0].id);
    if (!out.includes(`src:${readable[0].id}`)) out.push(`src:${readable[0].id}`);
  }
  if (!out.length) throw new HttpError(400, "至少给一份方案文档（sources）");
  return out;
}

const sourceSpace = (app: App, ref: string) => one<{ space_id: string }>(app.db, "select space_id from sources where id = ?", ref.replace(/^src:/, ""))?.space_id;

/**
 * Start (or restart, on `designId`) the assessment of an outside design. The caller has checked the
 * spaces: `spaceId` writable, `repos` and `sources` readable (resolveDesignSources).
 */
export function startAssessment(app: App, o: {
  title: string; sources: string[]; repos: string[]; spaceId: string; userId: string;
  itemId?: string | null; author?: string | null; note?: string; designId?: string; parentId?: string | null; ai?: Execution;
  /** What the caller may read at most (null: everything). */
  readable: string[] | null;
}): { design: Design; run: Run } {
  let design: Design;
  if (o.designId) {
    const d = getDesign(app, o.designId);
    if (d.origin !== "external") throw new HttpError(400, `方案 ${d.id} 不是别人的方案，不能重新评估`);
    if (d.spaceId !== o.spaceId) throw new HttpError(400, `方案 ${d.id} 在空间 ${d.spaceId}`);
    if (one(app.db, "select 1 from runs where kind = 'design' and status in ('queued', 'running') and json_extract(input, '$.designId') = ?", d.id))
      throw new HttpError(409, `方案 ${d.id} 正在评估，等这一次完成`);
    design = updateDesign(app, d.id, { title: o.title, sources: o.sources, repos: o.repos.length ? o.repos : undefined, author: o.author ?? undefined, itemId: o.itemId ?? undefined });
    setDesignStatus(app, d.id, "drafting");
  } else {
    design = createDesign(app, { spaceId: o.spaceId, itemId: o.itemId, title: o.title, origin: "external", author: o.author, sources: o.sources, repos: o.repos, userId: o.userId });
  }
  const allowed = scopeFor(app, o.userId, o.readable);
  const wanted = [design.spaceId, ...design.repos, ...design.sources.flatMap((s) => sourceSpace(app, s) ?? []), ...(design.itemId ? materialSpaces(app, design.itemId, o.userId) : [])];
  const readSpaces = [...new Set(wanted)].filter((id) => findSpace(app, id) && (!allowed || allowed.includes(id)));
  const r = createRun(app, {
    kind: "design",
    spaceId: design.spaceId,
    title: truncate(`评估方案：${design.title}`, 80),
    input: { designId: design.id, mode: "assess", note: o.note?.trim() || undefined, readSpaces, repos: design.repos, ...(o.ai ? { ai: o.ai } : {}) },
    parentId: o.parentId ?? undefined,
    userId: o.userId,
  });
  return { design: getDesign(app, design.id), run: r };
}

function assessTask(app: App, design: Design, o: { note?: string; userId: string }) {
  const docs = design.sources.map((s) => {
    const row = one<{ title: string; space_id: string }>(app.db, "select title, space_id from sources where id = ?", s.replace(/^src:/, ""));
    return `- ${s}${row ? `《${row.title}》（空间 ${row.space_id}）` : ""}`;
  });
  const repos = design.repos.map((id) => `- ${id}${findSpace(app, id) ? `（${getSpace(app, id).name}）` : ""}`);
  return [
    "# 评估技术方案",
    `这是别人写的技术方案${design.author ? `（作者 ${design.author}）` : ""}《${design.title}》。按角色说明里“评估别人的方案”做：先如实提取作者决定了什么，再回到代码核对每个决定依赖的事实，最后写意见。用 submit_design 交一次结果（方案 ${design.id}）。`,
    `## 方案文档\n\n${docs.join("\n")}\n\n用 read_source 读全文（长文档按 source_outline 分段读）。`,
    design.itemId ? materialsBrief(app, design.itemId, o.userId) : "",
    repos.length ? `## 要核对的仓库\n\n${repos.join("\n")}\n\n用 search、find_symbol、read_source（space 写仓库 id）核对方案依赖的事实，code_history 看这些文件以前出过什么问题。` : "没有指定仓库：只能按文档本身评估，依赖代码的事实写成要问作者的（question），不要猜。",
    o.note ? `## 本人关心的\n\n${o.note}` : "",
    design.revision
      ? `## 上一版的评估（第 ${design.revision} 版）\n\n文档可能更新了。这一版重新提取和评估；上一版的每条意见（C…）都要在这一版出现，写它的 id 和现在的状态（resolved / dropped / 仍是 open）和说明；决定还是同一个的沿用它的 id（D…）。\n\n${designMarkdown(app, design, { mode: "full" })}`
      : "",
  ].filter(Boolean).join("\n\n");
}

registerHandler("design", async (ctx) => {
  const { designId, mode, note, readSpaces } = ctx.run.input as { designId: string; mode: string; note?: string; readSpaces?: string[] };
  if (mode !== "assess") throw new Error(`不认识的方案运行：${mode}`);
  const user = runUser(ctx.app, ctx.run.id);
  const before = getDesign(ctx.app, designId);
  // Back to where it was if this attempt hands nothing in (a first one stays drafting).
  const restore = () => { if (before.revision > 0 && getDesign(ctx.app, designId).runId !== ctx.run.id) setDesignStatus(ctx.app, designId, "assessed"); };
  const { runRole } = await import("../agents/runner.ts");
  let r;
  try {
    r = await runRole(ctx.app, {
      role: "designer",
      spaceId: before.spaceId,
      alsoRead: readSpaces,
      task: assessTask(ctx.app, before, { note, userId: user }),
      runId: ctx.run.id,
      signal: ctx.signal,
      onEvent: (e) => ctx.event(e.type, e),
      userId: user,
    });
  } catch (e) {
    restore();
    throw e;
  }
  run(ctx.app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
  const after = getDesign(ctx.app, designId);
  if (after.runId !== ctx.run.id) {
    restore();
    throw new Error(`评估没有交方案（submit_design）：${truncate(r.text.trim() || "（没有输出）", 300)}`);
  }
  const line = designLine(after);
  const title = `方案评估完成：《${after.title}》`;
  try { notify(ctx.app, { title, body: line, link: `#/design/${after.id}`, runId: ctx.run.id, userId: user }); }
  catch (e) { ctx.event("status", { text: `通知没有发出：${(e as Error).message}` }); }
  // Asked by the assistant in a conversation: the result goes back there, like a task handed to an agent.
  const home = homeOf(ctx.app, ctx.run.id);
  if (home && home.root !== ctx.run.id) {
    const { deliverToThread } = await import("../agents/inbox.ts");
    await deliverToThread(ctx.app, home.conversationId, `${title}（方案 ${after.id}，第 ${after.revision} 版）\n\n${line}\n\n全文用 read_design 看；要问作者的和问题可以整理给本人，发不发由本人决定。`, { runId: ctx.run.id, design: after.id });
  }
  return { summary: r.text.trim(), designId: after.id, revision: after.revision, line };
});
