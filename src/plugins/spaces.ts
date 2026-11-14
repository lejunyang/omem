import { z } from "zod";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { createSpace, findSpace, updateSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { now, slugify } from "../core/util.ts";

export const pluginSpaceSchema = z.object({
  id: z.string().min(1).refine((id) => id === slugify(id) && !id.startsWith("_") && !/^\.{1,2}$/.test(id), "空间 id 需为规范名称，不能以下划线开头或使用路径"),
  name: z.string().min(1),
  kind: z.enum(["learning", "topic", "project"]).default("topic"),
  description: z.string().default(""),
  skills: z.array(z.string()).optional(),
});
type PluginSpace = z.infer<typeof pluginSpaceSchema>;
type SpaceManifest = { space?: PluginSpace; spaces: PluginSpace[] };

export const pluginSpaces = (m: SpaceManifest): PluginSpace[] => [...(m.space ? [m.space] : []), ...m.spaces];

/** Setup receipts survive removal. They describe the install, not ownership of a space. */
function receipts(app: App, plugin: string): Record<string, boolean> {
  const row = one<{ data: string }>(app.db, "select data from plugin_records where id = ?", `${plugin}:owner:_setup:spaces`);
  return row ? JSON.parse(row.data) : {};
}

export function ensurePluginSpaces(app: App, plugin: string, m: SpaceManifest) {
  const spaces = pluginSpaces(m);
  if (!spaces.length) return;
  const states = receipts(app, plugin);
  for (const s of spaces) {
    if (findSpace(app, s.id)) {
      if (!Object.hasOwn(states, s.id)) states[s.id] = false;
      continue;
    }
    createSpace(app, { id: s.id, name: s.name, kind: s.kind, description: s.description });
    if (s.skills?.length) updateSpace(app, s.id, { settings: { skills: s.skills } });
    states[s.id] = true;
  }
  const at = now();
  run(app.db, `insert into plugin_records(id,plugin,user_id,space_id,collection,key,data,created_at,updated_at)
    values(?,?,?,'personal','_setup','spaces',?,?,?) on conflict(id) do update set data=excluded.data,updated_at=excluded.updated_at`,
    `${plugin}:owner:_setup:spaces`, plugin, OWNER, JSON.stringify(states), at, at);
}

export function describeSpaces(app: App | null, plugin: string, m: SpaceManifest) {
  const states = app ? receipts(app, plugin) : {};
  return pluginSpaces(m).map((s) => ({ ...s, created: states[s.id] === true, existing: states[s.id] === false,
    status: states[s.id] === true ? "已创建" : states[s.id] === false ? "已有同名空间，没有改动" : "等待启用" }));
}
