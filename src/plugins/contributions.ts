import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, now } from "../core/util.ts";
import { listMcpServers, saveMcpServer } from "../agents/mcp-servers.ts";
import { listRules, saveRule } from "../rules/store.ts";
import { ruleInputSchema } from "../rules/types.ts";
import type { LoadedPlugin } from "./registry.ts";

const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
export const pluginMcpSchema = z.object({
  description: z.string().default(""),
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).default([]),
  url: z.string().regex(/^https?:\/\//i).optional(),
  env: z.array(secretName).default([]),
  headers: z.array(secretName).default([]),
  readOnly: z.boolean().default(false),
}).strict().refine((s) => !!s.command !== !!s.url, "MCP 服务填 command 或 url，二选一")
  .refine((s) => s.url ? !s.env.length : !s.headers.length, "命令用 env，网址用 headers");

/** Reserved host state survives plugin removal and cannot be changed through plugin_query/put. */
function imported(app: App, id: string): Record<string, string> {
  const row = one<{ data: string }>(app.db, "select data from plugin_records where id = ?", `${id}:owner:_setup:rules`);
  return row ? JSON.parse(row.data) : {};
}
function remember(app: App, p: LoadedPlugin, names: Record<string, string>) {
  const at = now(), id = p.manifest.id;
  run(app.db, `insert into plugin_records(id,plugin,user_id,space_id,collection,key,data,created_at,updated_at)
    values(?,?,?,'personal','_setup','rules',?,?,?) on conflict(id) do update set data=excluded.data,updated_at=excluded.updated_at`,
    `${id}:owner:_setup:rules`, id, OWNER, JSON.stringify(names), at, at);
}

type ParsedRule = z.infer<typeof ruleInputSchema>;
/**
 * What of a rule may travel with a plugin. A script, where a rule forwards to and 完全访问 are the
 * owner's own choices on the rules page (rules/store.ts saveRule): a rule with a script or a forward
 * action does not travel, and 完全访问 is dropped. The conversation it posts to, the AI it names and a
 * space unknown here exist only where the rule was made and are dropped too; a scheduled rule that
 * replied into that conversation only tells the owner until they pick one.
 */
export function portableRule(r: ParsedRule, spaceKnown: (id: string) => boolean): ParsedRule {
  const stop = r.actions.find((a) => a.type === "script" || a.type === "forward");
  if (stop) throw new HttpError(400, stop.type === "script" ? "带脚本的规则不随场景包走：脚本只能由本人在规则页保存" : "带转发的规则不随场景包走：转发到哪里要本人在规则页选");
  const keep = (id?: string) => (id && spaceKnown(id) ? id : undefined);
  const scheduled = r.trigger.event === "schedule";
  return {
    ...r,
    enabled: false,
    spaceId: keep(r.spaceId),
    conversationId: undefined,
    actions: r.actions.map((a) => {
      if (a.type !== "agent") return a;
      const b = { ...a, space: keep(a.space) };
      delete b.ai;
      delete b.fullAccess;
      if (scheduled && (b.reply === "auto" || b.reply === "draft")) b.reply = "none";
      if (scheduled && b.failureTo === "chat") delete b.failureTo;
      return b;
    }),
  };
}

/** Why a rule a plugin lists was not created here (shown with the plugin; the others still come in). */
const refused = new Map<string, Record<string, string>>();

/** Only enabled plugins contribute; rules stay disabled and commands wait for trust. */
export function seedContributions(app: App, p: LoadedPlugin) {
  if (!p.enabled) return;
  const names = imported(app, p.manifest.id);
  const errors: Record<string, string> = {};
  for (const file of p.manifest.rules) {
    if (Object.hasOwn(names, file)) continue;
    let began = false;
    try {
      const raw = YAML.parse(readFileSync(join(p.dir, "rules", `${file}.yaml`), "utf8"));
      const input = portableRule(ruleInputSchema.parse({ ...raw, enabled: false }), (id) => !!findSpace(app, id));
      input.actions = input.actions.map((a) => {
        if ((a.type === "agent" || a.type === "watch" || a.type === "meeting-bot") && a.spec && p.manifest.agents.includes(a.spec)) return { ...a, spec: `${p.manifest.id}-${a.spec}` };
        return a;
      });
      app.db.exec("begin");
      began = true;
      const rule = saveRule(app, input, "user", OWNER, { origin: { plugin: p.manifest.id, name: p.manifest.name, file } });
      names[file] = rule.id;
      remember(app, p, names);
      app.db.exec("commit");
      began = false;
    } catch (e) {
      // One rule that cannot come in does not keep the plugin (or its other rules) out.
      if (began) app.db.exec("rollback");
      delete names[file];
      errors[file] = (e as Error).message;
      console.warn(`[omem] 插件 ${p.manifest.id} 的规则 ${file} 没有创建：${errors[file]}`);
    }
  }
  refused.set(p.manifest.id, errors);
  for (const [short, s] of Object.entries(p.manifest.mcp)) {
    const name = `${p.manifest.id}-${short}`;
    if (app.config.mcp.servers[name] || (s.command && p.trust !== "trusted" && p.trust !== "builtin")) continue;
    saveMcpServer(app, name, { description: s.description, readOnly: s.readOnly, command: s.command, args: s.args, url: s.url,
      secrets: Object.fromEntries((s.url ? s.headers : s.env).map((key) => [key, null])) });
  }
}

export function broughtBy(app: App, p: LoadedPlugin) {
  const rules = listRules(app), servers = listMcpServers(app), names = imported(app, p.manifest.id);
  return {
    rules: p.manifest.rules.map((file) => {
      const r = rules.find((r) => r.id === names[file]);
      return { file, id: r?.id ?? null, name: r?.name ?? file, enabled: r?.enabled ?? false, created: Object.hasOwn(names, file), error: refused.get(p.manifest.id)?.[file] ?? null };
    }),
    mcp: Object.entries(p.manifest.mcp).map(([short, s]) => {
      const name = `${p.manifest.id}-${short}`, server = servers.find((x) => x.name === name);
      return { name, added: !!server, missing: server ? server.secrets.filter((x) => !x.set).map((x) => x.name) : s.url ? s.headers : s.env };
    }),
  };
}
