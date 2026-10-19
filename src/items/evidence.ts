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

/**
 * A short readable excerpt for a reference, so a reader sees what it says before opening it:
 * the cited lines of a source (chat lines without their time and message id), a memory, or a
 * conversation message. Null when the reference no longer resolves.
 */
export function refExcerpt(app: App, ref: string, max = 60): { title: string; text: string; spaceId: string } | null {
  const m = /^(src|mem|msg):([A-Za-z0-9_-]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(ref);
  if (!m) return null;
  const clip = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  if (m[1] === "mem") {
    const r = one<{ text: string; space_id: string }>(app.db, "select text, space_id from memories where id = ?", m[2]);
    return r ? { title: "记忆", text: clip(r.text), spaceId: r.space_id } : null;
  }
  if (m[1] === "msg") {
    const r = one<{ text: string; role: string; space_id: string }>(app.db, "select m.text, m.role, c.space_id from messages m join conversations c on c.id = m.conversation_id where m.id = ?", m[2]);
    return r ? { title: r.role === "user" ? "本人说" : "助理说", text: clip(r.text), spaceId: r.space_id } : null;
  }
  const s = one<{ title: string; kind: string; text: string; space_id: string }>(app.db, "select title, kind, text, space_id from sources where id = ? and deleted_at is null", m[2]);
  if (!s) return null;
  const lines = s.text.split("\n");
  const from = m[3] ? Math.max(1, Number(m[3])) : 1;
  const to = Math.min(lines.length, m[4] ? Number(m[4]) : m[3] ? from : Math.min(lines.length, 3));
  const picked = lines.slice(from - 1, to).map((l) =>
    s.kind === "chat"
      ? l
          .replace(/^\[[^\]]*\]\s*/, "") // [2026-10-19 07:02 · 话题 …]
          .replace(/\s*\((?:om|omt)_[\w-]+\)\s*$/, "") // trailing (om_…)
          .replace(/ ⏎ /g, " ")
      : l,
  );
  return { title: s.title, text: clip(picked.join(" ")), spaceId: s.space_id };
}
