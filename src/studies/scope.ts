import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { getItem, type Item } from "../items/store.ts";
import { can } from "../auth/permissions.ts";
import { canWrite } from "../core/users.ts";
import { HttpError, json, now } from "../core/util.ts";
import { git } from "../core/git.ts";
import { getSpace } from "../core/spaces.ts";

export function studyRepos(app: App, item: Item) {
  const candidates = all<{ id: string; name: string; root_path: string | null }>(app.db,
    "select id,name,root_path from spaces where kind='repo' and (id=? or parent_id=?) order by case when id=? then 0 else 1 end,rowid", item.spaceId, item.spaceId, item.spaceId);
  return candidates.filter((r) => can(app, item.userId, "space.read", r.id));
}
export function studyScope(app: App, itemId: string) {
  const item = getItem(app, itemId), candidates = studyRepos(app, item);
  const saved = one<{ repos: string; allow_code: number; third_party: number; push_remote: string; push_prefix: string }>(app.db, "select * from study_scopes where item_id=?", itemId);
  const ids = saved ? json<string[]>(saved.repos, []) : candidates.some((r) => r.id === item.spaceId) ? [item.spaceId] : candidates.map((r) => r.id);
  return { repos: ids.flatMap((id) => { const r = candidates.find((r) => r.id === id); return r ? [{ id: r.id, name: r.name }] : []; }), allowCode: !!saved?.allow_code, thirdParty: !!saved?.third_party, pushRemote: saved?.push_remote ?? "", pushPrefix: saved?.push_prefix ?? "" };
}
export function scopeView(app: App, itemId: string) {
  return { ...studyScope(app, itemId), candidates: studyRepos(app, getItem(app, itemId)).map(({ id, name }) => ({ id, name })) };
}
export function putScope(app: App, itemId: string, patch: { repos?: string[]; allowCode?: boolean; thirdParty?: boolean; pushRemote?: string; pushPrefix?: string }, user: string) {
  const item = getItem(app, itemId);
  if (item.userId !== user || !canWrite(app, user, item.spaceId)) throw new HttpError(403, "只有事项本人且空间可写时能修改范围");
  const candidates = studyRepos(app, item);
  if (patch.repos?.some((id) => !candidates.some((r) => r.id === id))) throw new HttpError(400, "仓库必须是事项空间自己或下面本人可读的仓库空间");
  const current = studyScope(app, itemId);
  const repos = [...new Set(patch.repos ?? current.repos.map((r) => r.id))];
  const remote = patch.pushRemote ?? current.pushRemote, prefix = patch.pushPrefix ?? current.pushPrefix;
  if (prefix && (!prefix.endsWith("/") || /\.\.|\s|:/.test(prefix) || !git(app.home, ["check-ref-format", `refs/heads/${prefix}${itemId}/test`]).ok)) throw new HttpError(400, "分支前缀必须以 / 结尾，不能含 ..、空白、冒号或非法 Git 字符");
  if (remote && (!repos.length || /^-|\s|:|[/\\]/.test(remote) || repos.some((id) => {
    const root = getSpace(app, id).rootPath;
    const r = root ? git(root, ["remote"]) : null;
    return !r?.ok || !r.stdout.split(/\r?\n/).includes(remote);
  }))) throw new HttpError(400, "远端必须已配置在范围内的每个仓库里");
  run(app.db, `insert into study_scopes(item_id,repos,allow_code,third_party,push_remote,push_prefix,updated_at) values(?,?,?,?,?,?,?)
    on conflict(item_id) do update set repos=excluded.repos,allow_code=excluded.allow_code,third_party=excluded.third_party,push_remote=excluded.push_remote,push_prefix=excluded.push_prefix,updated_at=excluded.updated_at`,
    itemId, JSON.stringify(repos), (patch.allowCode ?? current.allowCode) ? 1 : 0, (patch.thirdParty ?? current.thirdParty) ? 1 : 0, remote, prefix, now());
  return scopeView(app, itemId);
}
