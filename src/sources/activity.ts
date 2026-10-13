import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { git, isGitRepo } from "../core/git.ts";
import { listSpaces } from "../core/spaces.ts";
import { sha256 } from "../core/util.ts";
import { appendToSource } from "./store.ts";

/**
 * Code activity: what changed in each repository space since the last look —
 * new commits (with their size) and the shape of uncommitted work. One
 * activity source per repository and day, so the brief, the dreamer and the
 * assistant can tell what the owner has been working on.
 */
function kv(app: App, key: string, value?: string) {
  if (value === undefined) return one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value;
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, value);
  return value;
}

export function recordCodeActivity(app: App) {
  const touched: { spaceId: string; sourceId: string; lines: number }[] = [];
  for (const space of listSpaces(app)) {
    if (!space.rootPath || !isGitRepo(space.rootPath)) continue;
    const root = space.rootPath;
    const lines: string[] = [];
    const head = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    const lastHead = kv(app, `activity:${space.id}:head`);
    if (head && head !== lastHead) {
      const range = lastHead && git(root, ["cat-file", "-e", lastHead]).ok ? [`${lastHead}..${head}`] : ["--since=24.hours", head];
      const log = git(root, ["log", ...range, "--no-merges", "--date=format:%m-%d %H:%M", "--pretty=format:%x1e%h%x1f%an%x1f%ad%x1f%s", "--shortstat"]).stdout;
      for (const entry of log.split("\x1e").filter((e) => e.trim())) {
        const [header, ...rest] = entry.split("\n");
        const [hash, author, date, subject] = header.split("\x1f");
        const stat = rest.join(" ").trim().replace(/\s+/g, " ");
        lines.push(`[${date}] 提交 ${hash}（${author}，${branch}）：${subject}${stat ? `｜${stat}` : ""}`);
      }
      kv(app, `activity:${space.id}:head`, head);
    }
    // Uncommitted work: record it when its shape changes.
    // Porcelain lines start with a two-letter status and may begin with a space: only trim the end.
    const status = git(root, ["status", "--porcelain"]).stdout.trimEnd();
    const sig = sha256(status + git(root, ["diff", "--shortstat"]).stdout);
    if (status && sig !== kv(app, `activity:${space.id}:dirty`)) {
      const files = status.split("\n").filter(Boolean).map((l) => l.slice(3).trim());
      const stat = git(root, ["diff", "--shortstat"]).stdout.trim();
      const at = new Date().toTimeString().slice(0, 5);
      lines.push(`[${at}] 未提交改动 ${files.length} 个文件${stat ? `（${stat}）` : ""}：${files.slice(0, 12).join(", ")}${files.length > 12 ? " …" : ""}`);
    }
    kv(app, `activity:${space.id}:dirty`, status ? sig : "");
    if (!lines.length) continue;
    const day = new Date().toISOString().slice(0, 10);
    const r = appendToSource(app, { spaceId: space.id, kind: "activity", uri: `activity:git:${day}`, title: `代码活动 ${day}（${space.name}）`, lines, meta: { repo: root, day } });
    touched.push({ spaceId: space.id, sourceId: r.id, lines: lines.length });
  }
  return touched;
}
