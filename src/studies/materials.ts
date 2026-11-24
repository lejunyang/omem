import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { gitAsync } from "../core/git.ts";
import { studyRepos } from "./scope.ts";
import { sourceText } from "../sources/store.ts";
import { workUri } from "../sources/work.ts";
import type { Item } from "../items/store.ts";
import { json } from "../core/util.ts";
import { directions, findings, normalize, trials } from "./store.ts";

export const capabilitiesPath = (item: string) => `work/studies/${item}/capabilities.md`;
/**
 * How often each heading of the feature list was tried. A trial counts for the headings it names
 * (`features`, given when the direction was proposed); older trials without them count when their
 * object or check contains the heading, or the command in its backticks as a word.
 */
export function coverage(app: App, item: Item) {
  const file = one<{ id: string }>(app.db, "select id from sources where space_id=? and uri=? and deleted_at is null", item.spaceId, workUri(capabilitiesPath(item.id)));
  if (!file) return { path: capabilitiesPath(item.id), ref: null, features: [] as { title: string; trials: number; lastAt: string | null }[] };
  const titles = [...sourceText(app, file.id).matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1]).filter((t) => t !== "没弄清的");
  const history = all<{ object: string; check: string; features: string; updated_at: string }>(app.db, `select object,"check",features,updated_at from study_trials where item_id=? and result is not null and result!='blocked'`, item.id);
  return { path: capabilitiesPath(item.id), ref: `src:${file.id}`, features: titles.map((title) => {
    const hits = history.filter((t) => covers(title, t));
    return { title, trials: hits.length, lastAt: hits.map((t) => t.updated_at).sort().at(-1) ?? null };
  }) };
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function covers(title: string, t: { object: string; check: string; features: string }) {
  const named = json<string[]>(t.features, []);
  if (named.length) return named.some((n) => normalize(n) === normalize(title));
  const text = `${t.object}\n${t.check}`;
  if (normalize(text).includes(normalize(title))) return true;
  const code = /`([^`]+)`/.exec(title)?.[1]?.trim();
  return !!code && new RegExp(`(^|[^\\p{L}\\p{N}_-])${escape(code)}($|[^\\p{L}\\p{N}_-])`, "iu").test(text);
}
/**
 * What earlier rounds already went after, for the planner: each direction's goal, how it ended and the
 * findings it led to (titles only). Trial details and conclusions stay out, so it still thinks first;
 * repeats are what this is for: four rounds proposing the same three themes is what happens without it.
 */
function pastDirections(app: App, item: Item) {
  const ds = directions(app, item.id).filter((d) => d.state !== "proposed");
  if (!ds.length) return "";
  const fs = findings(app, item.id), ts = trials(app, item.id);
  const lines = ds.map((d) => {
    const own = ts.filter((t) => t.direction_id === d.id && !t.fix_of);
    const found = fs.filter((f) => json<string[]>(f.trials, []).some((id) => own.some((t) => t.id === id)));
    const how = d.state === "dropped" ? d.conclusion === "本轮未选" ? "提过、本人没选" : "放下了" : own.length ? `试了 ${own.filter((t) => t.result).length} 个` : "在做";
    return `- 第 ${d.round} 轮（${how}）：${d.goal}${found.length ? `\n  发现：${found.map((f) => f.title).join("；")}` : ""}`;
  });
  return `## 以前的方向（不要再提目标相同或换个说法的方向；本人在这一轮点名要接着挖的除外）\n${lines.join("\n")}`;
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
    `## 覆盖情况（试验在提方向时标的功能；更早的按对象和检查里出现的功能名粗略统计；只有次数和日期）\n${c.features.map((f) => `- ${f.title}：试过 ${f.trials} 次，最近 ${f.lastAt?.slice(0, 10) ?? "从未"}`).join("\n")}`,
    pastDirections(app, item),
    commits.length ? `## 最近的代码改动（提交标题）\n${commits.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
