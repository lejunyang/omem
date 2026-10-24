import type { App } from "../core/app.ts";
import { findSpace, relatedIds } from "../core/spaces.ts";
import { canWrite, OWNER, scopeFor } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { createRun } from "../agents/runs.ts";
import type { Execution } from "../agents/execution.ts";

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
  return createRun(app, {
    kind: "wiki-plan", spaceId, title: "规划 Wiki 目录", userId, parentId: input.parentId,
    input: { focus: input.focus, autoWrite: input.autoWrite ?? true, readSpaces, ai: input.ai },
  });
}
