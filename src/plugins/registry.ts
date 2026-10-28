import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { commitLibrary } from "../core/git.ts";
import { createSpace, findSpace, type SpaceKind } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { agentSpecSchema, setPluginSpecSource, splitFrontmatter, type AgentSpec } from "../agents/specs.ts";
import { CORE_TOOLS, TOOL_GROUPS } from "../agents/tool-help.ts";
import { registerTool, toolList, type ToolContext } from "../agents/tools.ts";
import { blockTool, pluginContext, type PluginEnv } from "./blocks.ts";
import { GENERIC_BLOCKS, genericToolName } from "./generic.ts";
import { pluginSettings, settingFieldSchema } from "./settings.ts";
import type { PluginApi, PluginBlock, PluginRegister, PluginTool } from "./types.ts";

/**
 * Plugins (docs/v2/plugins.md): a directory with plugin.yaml, agent specs, skills, an optional
 * server.ts (tools and content blocks) and an optional page. Built-in ones live in the package's
 * plugins/ (pages built to web/dist/plugins/<id>/); the owner's own in <data>/plugins/, where
 * server code is not loaded (only declarations, skills and a ready-built web/). The host never
 * branches on a plugin's name: what a plugin may do is what its manifest declares.
 */
const ID = /^[a-z][a-z0-9]{1,23}$/;
const SPEC = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const manifestSchema = z.object({
  id: z.string().regex(ID, "插件 id 只能用小写字母和数字，字母开头，2–24 个字符"),
  name: z.string().min(1),
  description: z.string().default(""),
  icon: z.string().default("box"),
  space: z.object({ id: z.string(), name: z.string(), kind: z.enum(["learning", "topic", "project"]).default("topic"), description: z.string().default("") }).optional(),
  agents: z.array(z.string().regex(SPEC)).default([]),
  skills: z.array(z.string()).default([]),
  /** Host tools the plugin's agents may use, besides its own and the plugin tools (plugin_query, plugin_form…). */
  tools: z.array(z.string()).default([]),
  page: z.object({ title: z.string() }).optional(),
  settings: z.array(settingFieldSchema).default([]),
});
export type PluginManifest = z.infer<typeof manifestSchema>;

export type LoadedPlugin = {
  manifest: PluginManifest;
  dir: string;
  /** builtin: ships with omem; data: the owner's, in <data>/plugins (no server code). */
  source: "builtin" | "data";
  specs: AgentSpec[];
  /** Tools the plugin registered; `page` ones its page may call. */
  tools: { name: string; page: boolean }[];
  blocks: Map<string, PluginBlock>;
  env: PluginEnv;
};

/** Every plugin's agents may use these, whatever the manifest lists. */
export const PLUGIN_TOOLS = ["plugin_query", "plugin_put", ...[...GENERIC_BLOCKS.keys()].map(genericToolName)];

const plugins = new Map<string, LoadedPlugin>();

const here = dirname(fileURLToPath(import.meta.url));
/** Package root, both from source (src/plugins) and the build (dist/src/plugins). */
function packageRoot() {
  for (const c of [resolve(here, "../.."), resolve(here, "../../..")]) if (existsSync(join(c, "plugins")) && existsSync(join(c, "package.json"))) return c;
  return resolve(here, "../..");
}
const built = /[\\/]dist[\\/]src[\\/]plugins$/.test(here);
export const builtinPluginsDir = () => join(packageRoot(), "plugins");
export const dataPluginsDir = (app: App) => join(app.home, "plugins");

export const listPlugins = () => [...plugins.values()];
export const findPlugin = (id: string) => plugins.get(id) ?? null;
export function getPlugin(id: string) {
  const p = plugins.get(id);
  if (!p) throw new HttpError(404, `没有插件 ${id}`);
  return p;
}

/** The ToolContext of a plugin tool's call, narrowed to what server.ts may see. */
function asPlugin(env: PluginEnv, ctx: ToolContext) {
  return pluginContext(ctx.app, env, { userId: ctx.userId ?? OWNER, spaceId: ctx.spaceId, runId: ctx.runId, actor: ctx.actor });
}

// The host's blocks (form, chart) are handed in for whichever plugin the run belongs to.
for (const def of GENERIC_BLOCKS.values()) {
  const name = genericToolName(def.kind);
  registerTool(blockTool(name, def, (ctx) => (ctx.plugin ? plugins.get(ctx.plugin)?.env ?? null : null)));
  CORE_TOOLS.add(name);
}
TOOL_GROUPS.find((g) => g.id === "plugins")?.tools.push(...[...GENERIC_BLOCKS.keys()].map(genericToolName));

async function importServer(dir: string, id: string): Promise<PluginRegister | null> {
  const file = built ? join(packageRoot(), "dist", "plugins", id, "server.js") : join(dir, "server.ts");
  if (!existsSync(file)) return null;
  const mod = (await import(pathToFileURL(file).href)) as { default?: PluginRegister };
  if (typeof mod.default !== "function") throw new Error(`插件 ${id} 的 server 没有默认导出 register(api)`);
  return mod.default;
}

/** Tools and blocks are process-wide (like the host's own tools); register a plugin once. */
async function register(dir: string, manifest: PluginManifest, source: LoadedPlugin["source"]): Promise<LoadedPlugin> {
  const own: LoadedPlugin["tools"] = [];
  const blocks = new Map<string, PluginBlock>();
  const prefix = `${manifest.id}_`;
  const p: LoadedPlugin = {
    manifest,
    dir,
    source,
    specs: [],
    tools: own,
    blocks,
    env: {
      id: manifest.id,
      title: manifest.page?.title ?? manifest.name,
      def: (kind) => blocks.get(kind) ?? GENERIC_BLOCKS.get(kind),
      settings: (app, userId) => pluginSettings(app, manifest.id, manifest.settings, userId),
      sessionFor: (spec) => {
        const s = p.specs.find((x) => x.name === spec) ?? p.specs[0];
        return s ? { agent: s.name, spaceId: s.space ?? manifest.space?.id ?? "personal" } : null;
      },
    },
  };
  const api: PluginApi = {
    id: manifest.id,
    tool(t: PluginTool<any>) {
      if (!t.name.startsWith(prefix)) throw new Error(`插件 ${manifest.id} 的工具名要以 ${prefix} 开头：${t.name}`);
      registerTool({ name: t.name, description: t.description, schema: t.schema, write: t.write, handler: (ctx, args) => t.handler(asPlugin(p.env, ctx), args) });
      own.push({ name: t.name, page: !!t.page });
    },
    block(b: PluginBlock<any>) {
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(b.kind)) throw new Error(`内容块类型不合法：${b.kind}`);
      if (!b.display && !b.grade) throw new Error(`内容块 ${b.kind} 要么只展示（display），要么能提交（grade）`);
      const name = `${prefix}${b.kind}`;
      registerTool(blockTool(name, b, () => p.env));
      // Handing in a block is what the plugin's agent is there for: offered directly, like a role's submit tool.
      CORE_TOOLS.add(name);
      blocks.set(b.kind, b);
      own.push({ name, page: false });
    },
  };
  if (source === "builtin") {
    const reg = await importServer(dir, manifest.id);
    if (reg) await reg(api);
  } else if (existsSync(join(dir, "server.ts")) || existsSync(join(dir, "server.js"))) {
    console.warn(`[omem] 插件 ${manifest.id} 在数据目录里，暂不加载它的服务端代码；档案、技能和页面照常可用`);
  }
  if (own.length) TOOL_GROUPS.push({ id: manifest.id, label: manifest.name, tools: own.map((t) => t.name) });
  p.specs = readSpecs(p);
  return p;
}

function readSpecs(p: LoadedPlugin): AgentSpec[] {
  const { manifest } = p;
  const allowed = new Set([...manifest.tools, ...p.tools.map((t) => t.name), ...PLUGIN_TOOLS]);
  const known = new Set(toolList().map((t) => t.name));
  for (const t of allowed) if (!known.has(t)) console.warn(`[omem] 插件 ${manifest.id} 声明了不存在的工具 ${t}`);
  return manifest.agents.map((n) => {
    const file = join(p.dir, "agents", `${n}.md`);
    if (!existsSync(file)) throw new Error(`插件 ${manifest.id} 缺少档案 agents/${n}.md`);
    const { meta, body } = splitFrontmatter(readFileSync(file, "utf8"));
    const listed = Array.isArray(meta.tools) ? (meta.tools as string[]) : null;
    for (const t of listed ?? []) if (!allowed.has(t)) console.warn(`[omem] 插件 ${manifest.id} 的档案 ${n} 用了清单之外的工具 ${t}，已忽略`);
    const spec = agentSpecSchema.parse({
      ...meta,
      name: `${manifest.id}-${n}`,
      plugin: manifest.id,
      space: meta.space ?? manifest.space?.id,
      tools: (listed ?? [...allowed]).filter((t) => allowed.has(t) && known.has(t)),
      skills: meta.skills ?? manifest.skills,
    });
    return { ...spec, prompt: body };
  });
}

/** The file the owner's editor starts from: everything resolved, so a saved copy keeps the plugin scope. */
function specRaw(name: string) {
  for (const p of plugins.values()) {
    const s = p.specs.find((x) => x.name === name);
    if (!s) continue;
    const { prompt, name: _n, updatedBy: _u, ...meta } = s;
    for (const [k, v] of Object.entries(meta)) if (v === undefined || (Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) delete (meta as Record<string, unknown>)[k];
    if (meta.status === "active") delete (meta as Record<string, unknown>).status;
    if (meta.writes === false) delete (meta as Record<string, unknown>).writes;
    return `---\n${YAML.stringify(meta).trim()}\n---\n\n${prompt}\n`;
  }
  return null;
}

setPluginSpecSource({
  find: (_app, name) => {
    for (const p of plugins.values()) {
      const s = p.specs.find((x) => x.name === name);
      if (s) return s;
    }
    return null;
  },
  list: () => [...plugins.values()].flatMap((p) => p.specs),
  raw: specRaw,
});

/** Skills ship with the plugin and are copied into the library once, like the built-in ones. */
function seedSkills(app: App, p: LoadedPlugin) {
  const added: string[] = [];
  for (const name of p.manifest.skills) {
    const src = join(p.dir, "skills", name, "SKILL.md");
    const dest = join(app.libraryDir, "_skills", name);
    if (!existsSync(src) || existsSync(join(dest, "SKILL.md"))) continue;
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), readFileSync(src, "utf8"));
    added.push(name);
  }
  if (added.length) commitLibrary(app.libraryDir, `omem: add skills of plugin ${p.manifest.id}: ${added.join(", ")}`);
}

function ensureSpace(app: App, m: PluginManifest) {
  if (m.space && !findSpace(app, m.space.id)) createSpace(app, { id: m.space.id, name: m.space.name, kind: m.space.kind as SpaceKind, description: m.space.description });
}

/**
 * Load (once per process) and set up for this library: space, skills. Built-in plugins first; a
 * plugin in the data directory with the same id is skipped. A broken plugin is skipped with a warning.
 */
export async function loadPlugins(app: App, roots: { dir: string; source: LoadedPlugin["source"] }[] = [{ dir: builtinPluginsDir(), source: "builtin" }, { dir: dataPluginsDir(app), source: "data" }]) {
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      const dir = join(root.dir, entry.name);
      if (!entry.isDirectory() || !existsSync(join(dir, "plugin.yaml"))) continue;
      try {
        const manifest = manifestSchema.parse(YAML.parse(readFileSync(join(dir, "plugin.yaml"), "utf8")));
        if (manifest.id !== entry.name) throw new Error(`目录名 ${entry.name} 与插件 id ${manifest.id} 不一致`);
        let p = plugins.get(manifest.id);
        if (p && p.dir !== dir) throw new Error(`已有同名插件（${p.source === "builtin" ? "内置" : p.dir}）`);
        if (!p) {
          p = await register(dir, manifest, root.source);
          plugins.set(manifest.id, p);
        }
        ensureSpace(app, p.manifest);
        seedSkills(app, p);
      } catch (e) {
        console.warn(`[omem] 跳过插件 ${entry.name}：${(e as Error).message}`);
      }
    }
  }
  return listPlugins();
}

/** The plugin brings a page of its own (web/index.html); without one the shell shows its default page. */
export const hasOwnPage = (p: LoadedPlugin) => existsSync(join(p.dir, "web", "index.html"));

/**
 * The built page, looked up each time so a fresh build is picked up: built-in pages are built to
 * web/dist/plugins/<id>; a data-directory plugin's web/ is served as it is (already built).
 */
export function pluginWebDir(p: LoadedPlugin) {
  const web = p.source === "builtin" ? join(packageRoot(), "web", "dist", "plugins", p.manifest.id) : join(p.dir, "web");
  return existsSync(join(web, "index.html")) ? web : null;
}

/** For the nav and the plugin list: what each one offers. */
export function describePlugin(p: LoadedPlugin) {
  return {
    id: p.manifest.id,
    name: p.manifest.name,
    description: p.manifest.description,
    icon: p.manifest.icon,
    source: p.source,
    space: p.manifest.space?.id ?? null,
    agents: p.specs.map((s) => ({ name: s.name, description: s.description })),
    // own: the plugin's page in a sandboxed frame (built or not yet); otherwise the shell's default page.
    page: p.manifest.page ? { title: p.manifest.page.title, own: hasOwnPage(p), built: !!pluginWebDir(p) } : null,
    settings: p.manifest.settings.length > 0,
  };
}
