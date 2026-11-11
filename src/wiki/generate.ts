import type { App } from "../core/app.ts";
import { findSpace, relatedIds } from "../core/spaces.ts";
import { canWrite, OWNER, scopeFor } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { createRun } from "../agents/runs.ts";
import type { Execution } from "../agents/execution.ts";
import { listPages } from "./store.ts";

/** Chat, HTTP and CLI enter the same planning/writing pipeline. */
export function generateWiki(app: App, input: {
  spaceId: string;
  focus?: string;
  autoWrite?: boolean;
  sourceSpaces?: string[];
  userId?: string;
  parentId?: string | null;
  readable?: string[] | null;
  writable?: string[] | null;
  /** AI for the plan and every page (validated by the caller). */
  ai?: Execution;
  /** Existing pages to revise as the focus says: each goes straight to a writer, nothing is planned. */
  pages?: string[];
}) {
  const userId = input.userId ?? OWNER;
  const allowed = scopeFor(app, userId, input.readable ?? null);
  const checkRead = (id: string) => {
    if (!findSpace(app, id)) throw new HttpError(404, `没有空间 ${id}；用 list_spaces 查看`);
    if (allowed && !allowed.includes(id)) throw new HttpError(403, `本次任务不能访问空间 ${id}`);
    return id;
  };
  const spaceId = checkRead(input.spaceId);
  if (!canWrite(app, userId, spaceId) || (input.writable && !input.writable.includes(spaceId)) || findSpace(app, spaceId)!.kind === "worktree")
    throw new HttpError(403, `本次任务不能写入空间 ${spaceId} 的 Wiki`);
  const sources = input.sourceSpaces ?? relatedIds(app, spaceId).filter(id => !allowed || allowed.includes(id));
  const readSpaces = [...new Set([spaceId, ...sources.map(checkRead)])];
  if (input.pages?.length) {
    if (!input.focus?.trim()) throw new HttpError(400, "更新指定页面要在 focus 里写清改什么");
    const existing = new Map(listPages(app, spaceId).map((p) => [p.slug, p]));
    const missing = input.pages.filter((slug) => !existing.has(slug));
    if (missing.length) throw new HttpError(404, `空间 ${spaceId} 没有页面 ${missing.join("、")}；新页面走规划（不传 pages）`);
    const runs = [...new Set(input.pages)].map((slug) => {
      const p = existing.get(slug)!;
      return createRun(app, {
        kind: "wiki-write", spaceId, title: `写作：${p.title}`, userId, parentId: input.parentId,
        input: { brief: { slug, title: p.title, kind: p.kind, question: p.summary || p.title, outline: "按本人的补充要求修改这一页，其余内容保留", entry_points: [] }, instructions: input.focus, readSpaces, ai: input.ai },
      });
    });
    return Object.assign(runs[0], { writeRuns: runs.map((r) => r.id) });
  }
  return createRun(app, {
    kind: "wiki-plan", spaceId, title: "规划 Wiki 目录", userId, parentId: input.parentId,
    input: { focus: input.focus, autoWrite: input.autoWrite ?? true, readSpaces, ai: input.ai },
  });
}
