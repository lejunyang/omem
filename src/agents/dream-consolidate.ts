import type { App } from "../core/app.ts";
import { roleNames } from "../core/config.ts";
import { all, one, run, tx } from "../core/db.ts";
import { json, now } from "../core/util.ts";
import { findSkill, listAgentSpecs } from "./specs.ts";

export type DreamFolder = { profile: string; folder: string; count: number; subjects: string[] };
type Mark = { count: number; date: string; skills: string[] };
const keyOf = (f: Pick<DreamFolder, "profile" | "folder">) => `dream_consolidated:${f.profile}:${f.folder}`;
const dayOf = (app: App) => new Intl.DateTimeFormat("en-CA", { timeZone: app.config.timezone }).format(new Date());
function nightTally(app: App) {
  const value = one<{ value: string }>(app.db, "select value from kv where key = 'dream_consolidate_night'")?.value;
  const tally = json<{ date: string; count: number }>(value ?? "{}", { date: "", count: 0 });
  return tally.date === dayOf(app) ? tally.count : 0;
}

/** Exact folder homes, across readable spaces; shared memories and backend provenance are not ownership. */
export function dreamFolders(app: App, spaces: string[] | null = null): DreamFolder[] {
  const { min, perNight } = app.config.dream.consolidate;
  const remaining = perNight - nightTally(app);
  if (remaining <= 0 || spaces?.length === 0) return [];
  const profiles = new Set<string>([...roleNames, ...listAgentSpecs(app, { includeDrafts: true }).map((s) => s.name)]);
  const scope = spaces ? ` and space_id in (${spaces.map(() => "?").join(",")})` : "";
  const rows = all<{ profile: string; folder: string; count: number }>(app.db,
    `select agent profile, folder, count(*) count from memories where status = 'active' and kind = 'experience'
      and agent is not null and folder != ''${scope} group by agent, folder having count(*) >= ?
      order by count desc, agent, folder`, ...(spaces ?? []), min);
  const out: DreamFolder[] = [];
  for (const f of rows) {
    if (!profiles.has(f.profile)) continue;
    const saved = one<{ value: string }>(app.db, "select value from kv where key = ?", keyOf(f));
    const mark = saved ? json<Mark | null>(saved.value, null) : null;
    // No skill means the dreamer skipped an incoherent folder: wait for growth, too.
    // An adopted skill still exists and must not cause the folder to be drafted again.
    if (mark && f.count < Math.ceil(mark.count * 1.3) && !mark.skills.some((name) => !findSkill(app, name))) continue;
    const subjects = all<{ subject: string }>(app.db,
      `select m.subject from memories m where m.status = 'active' and m.kind = 'experience' and m.agent = ? and m.folder = ?${scope}
        order by (select count(*) from memory_recalls r where r.memory_id = m.id and r.purpose = 'answer') desc,
        m.created_at desc, m.id desc limit 12`, f.profile, f.folder, ...(spaces ?? [])).map((m) => m.subject);
    out.push({ ...f, subjects });
    if (out.length === remaining) break;
  }
  return out;
}

export function dreamFoldersText(folders: DreamFolder[]) {
  return folders.length ? `经验太多的目录：\n${folders.map((f) => `- 档案/角色 ${f.profile} · 目录 ${f.folder} · ${f.count} 条经验\n  标题样本：${f.subjects.join("；")}`).join("\n")}` : "";
}

/** Only after the agent completed: associate saved drafts by their mem: references, not guessed skill names. */
export function markDreamFolders(app: App, folders: DreamFolder[], runId: string) {
  const drafts = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'dream-skill'", runId)
    .map((e) => json<{ name: string; agent: string }>(e.data, { name: "", agent: "" }))
    .flatMap((e) => {
      const skill = findSkill(app, e.name);
      if (!skill || skill.status !== "draft") return [];
      const homes = new Set([...skill.body.matchAll(/\bmem:([a-zA-Z0-9_-]+)/g)].flatMap((m) => {
        const memory = one<{ agent: string; folder: string }>(app.db, "select agent, folder from memories where id = ? and agent = ?", m[1], e.agent);
        return memory ? [keyOf({ profile: memory.agent, folder: memory.folder })] : [];
      }));
      return [{ name: e.name, agent: e.agent, homes }];
    });
  const made: { profile: string; folder: string; skill: string }[] = [];
  tx(app.db, () => {
    for (const f of folders) {
      const skills = [...new Set(drafts.filter((s) => s.agent === f.profile && s.homes.has(keyOf(f))).map((s) => s.name))];
      for (const skill of skills) made.push({ profile: f.profile, folder: f.folder, skill });
      const old = one<{ value: string }>(app.db, "select value from kv where key = ?", keyOf(f));
      const previous = json<Mark | null>(old?.value ?? "null", null);
      const mark: Mark = { count: f.count, date: now(), skills: skills.length ? skills : previous?.skills.filter((name) => !!findSkill(app, name)) ?? [] };
      run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", keyOf(f), JSON.stringify(mark));
    }
    if (folders.length) run(app.db, "insert into kv(key,value) values('dream_consolidate_night',?) on conflict(key) do update set value = excluded.value",
      JSON.stringify({ date: dayOf(app), count: nightTally(app) + folders.length }));
  });
  return made;
}
