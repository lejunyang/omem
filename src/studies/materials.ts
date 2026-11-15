import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { gitAsync } from "../core/git.ts";
import { studyRepos } from "./scope.ts";
import { sourceText } from "../sources/store.ts";
import { workUri } from "../sources/work.ts";
import type { Item } from "../items/store.ts";

export const capabilitiesPath = (item: string) => `work/studies/${item}/capabilities.md`;
export function coverage(app: App, item: Item) {
  const file = one<{ id: string }>(app.db, "select id from sources where space_id=? and uri=? and deleted_at is null", item.spaceId, workUri(capabilitiesPath(item.id)));
  if (!file) return { path: capabilitiesPath(item.id), ref: null, features: [] as { title: string; trials: number; lastAt: string | null }[] };
  const titles = [...sourceText(app, file.id).matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1]).filter((t) => t !== "没弄清的");
  const history = all<{ object: string; updated_at: string }>(app.db, "select object,updated_at from study_trials where item_id=? and result is not null", item.id);
  return { path: capabilitiesPath(item.id), ref: `src:${file.id}`, features: titles.map((title) => {
    const hits = history.filter((t) => t.object.includes(title));
    return { title, trials: hits.length, lastAt: hits.map((t) => t.updated_at).sort().at(-1) ?? null };
  }) };
}
export async function planningMaterials(app: App, item: Item) {
  const c = coverage(app, item);
  const repos = studyRepos(app, item);
  const commits: string[] = [];
  for (const repo of repos) {
    if (!repo.root_path) continue;
    try {
      const r = await gitAsync(repo.root_path, ["log", "-20", "--format=%s"], { timeoutMs: 5000 });
      if (r.ok) commits.push(`${repo.name}：\n${r.stdout.trim()}`);
    } catch { /* Unavailable repositories contribute no material. */ }
  }
  return [
    `## 功能清单\n${c.path}${c.ref ? `（用 read_source 读 ${c.ref}）` : "（还没有清单）"}`,
    `## 覆盖情况（粗略统计：试验对象文字包含功能标题；只有次数和日期）\n${c.features.map((f) => `- ${f.title}：试过 ${f.trials} 次，最近 ${f.lastAt?.slice(0, 10) ?? "从未"}`).join("\n")}`,
    commits.length ? `## 最近的代码改动（提交标题）\n${commits.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
