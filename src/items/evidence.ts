import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { accessibleSpaces } from "../core/users.ts";
import { HttpError } from "../core/util.ts";

/** References may cross spaces only when both the caller and the item's owner can read them. */
export function validateItemRefs(app: App, refs: string[], userId: string, scope: string[] | null = null) {
  const allowed = accessibleSpaces(app, userId);
  for (const ref of refs) {
    const m = /^(src|mem|msg):([A-Za-z0-9_-]+)(?:#L([1-9]\d*)(?:-L([1-9]\d*))?)?$/.exec(ref);
    if (!m || (m[1] !== "src" && m[3])) throw new HttpError(400, `来源格式错误：${ref}`);
    const row = m[1] === "src"
      ? one<{ space_id: string; lines?: number }>(app.db, "select space_id, length(text)-length(replace(text,char(10),''))+1 as lines from sources where id=? and deleted_at is null", m[2])
      : m[1] === "mem"
        ? one<{ space_id: string }>(app.db, "select space_id from memories where id=?", m[2])
        : one<{ space_id: string }>(app.db, "select c.space_id from messages m join conversations c on c.id=m.conversation_id where m.id=?", m[2]);
    if (!row) throw new HttpError(400, `来源不存在或已删除：${ref}`);
    if ((scope && !scope.includes(row.space_id)) || (allowed && !allowed.includes(row.space_id))) throw new HttpError(403, `无权引用空间 ${row.space_id} 的来源`);
    if (m[3] && (Number(m[4] ?? m[3]) < Number(m[3]) || Number(m[4] ?? m[3]) > ("lines" in row ? Number(row.lines) : 0))) throw new HttpError(400, `来源行号越界：${ref}`);
  }
}
