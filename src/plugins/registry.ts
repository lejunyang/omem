import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { authFetch, loginProvider, registerLoginProvider } from "../auth/providers.ts";
import { registerAuthenticator } from "../auth/authenticators.ts";
import { registerAgentLogin } from "../agents/agent-logins.ts";
import { registerCredential } from "../agents/credential-registry.ts";
import { accountCatalog, declarePluginBackends, registerPluginBackends } from "../agents/catalog.ts";
import { pluginBackendSchema } from "./backends.ts";
import { replaceSubscriptions } from "./event-store.ts";
import { registerProcessHooks, rememberGateScopes, subscriptions } from "./process-hooks.ts";
import { registerFeatures } from "../auth/features.ts";
import { appConfig } from "../auth/apps.ts";
import { listConnections } from "../auth/vault.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { saveConfig } from "../core/config.ts";
import { commitLibrary } from "../core/git.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { agentSpecSchema, setPluginSpecSource, splitFrontmatter, type AgentSpec } from "../agents/specs.ts";
import { CORE_TOOLS, TOOL_GROUPS, expandTools } from "../agents/tool-help.ts";
import { registerTool, saveSourceFor, toolList, unregisterTools, watchesFor, type ToolContext } from "../agents/tools.ts";
import { platformList, registerPlatform } from "./platforms.ts";
import { pluginObjectKinds, registerObject, withObjectActions } from "./objects.ts";
import { describeHooks, registerHook } from "./hooks.ts";
import { htmlToMarkdown } from "../sources/html.ts";
import { blockTool, pluginContext, type PluginEnv } from "./blocks.ts";
import { ensureService, serviceSchema, stopPluginServices, streamSchema } from "./services.ts";
import { pluginSettings, settingFieldSchema } from "./settings.ts";
import { acceptCredentialDeclarations, codeHash, setTrust, trustMode, trustState, type RunMode } from "./trust.ts";
import { startSandbox } from "./sandbox.ts";
import { importFresh } from "./fresh-import.ts";
import { installInfo } from "./install.ts";
import { broughtBy, seedContributions, pluginMcpSchema } from "./contributions.ts";
import { pluginSpaceSchema, pluginSpaces, ensurePluginSpaces, describeSpaces } from "./spaces.ts";
import { registerPluginChannel, type ChannelState } from "./channels.ts";
import { checkSlot, type SlotEntry } from "./slots.ts";
import { readLinks } from "./links.ts";
import type { PluginApi, PluginBlock, PluginRegister, PluginSourceInput, PluginTool } from "./types.ts";

/**
 * Plugins (docs/v2/plugins.md): a directory with plugin.yaml, agent specs, skills, an optional
 * server.ts (tools and content blocks), services and an optional page. Built-in ones live in the
 * package's plugins/ (pages built to web/dist/plugins/<id>/); the owner's own in <data>/plugins/,
 * where code (server.ts, services) runs only once the owner has trusted it (trust.ts), and again
 * after every change to it. The host never branches on a plugin's name: what a plugin may do is
 * what its manifest declares.
 */
const ID = /^[a-z][a-z0-9]{1,23}$/;
const SPEC = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const manifestSchema = z.object({
  id: z.string().regex(ID, "插件 id 只能用小写字母和数字，字母开头，2–24 个字符"),
  name: z.string().min(1),
  description: z.string().default(""),
  /** Shown in settings → 插件; an installed package's own version wins (install.ts). */
  version: z.string().optional(),
  /**
   * The server file when it is not server.ts / .js / .mjs at the top: a build's output (`dist/server.js`).
   * Not under the directories the trust hash leaves out (trust.ts), so a change to it needs trust again.
   */
  server: z
    .string()
    .regex(/^(?![\\/])(?!.*\.\.)[\w./-]+\.(ts|js|mjs)$/, "server 写插件目录里的相对路径（.ts、.js 或 .mjs）")
    .refine((f) => !/^(\.\/)?(web|agents|skills|node_modules|\.git)\//.test(f), "server 不能放在 web/、agents/、skills/、node_modules/ 里（信任不核对这些目录）")
    .optional(),
  /** The nav icon: a name from web/src/lib/icons.ts, or an .svg in the page's directory (web/, or web/public/ for a built page). */
  icon: z.string().regex(/^([a-z][a-z0-9-]*|[\w./-]+\.svg)$/, "图标写图标名，或页面目录里的 .svg 文件").default("box"),
  space: pluginSpaceSchema.optional(),
  spaces: z.array(pluginSpaceSchema).default([]),
  agents: z.array(z.string().regex(SPEC)).default([]),
  skills: z.array(z.string()).default([]),
  rules: z.array(z.string().regex(SPEC)).default([]),
  /** Flow definitions (`flows/<id>.yaml`), added to the owner's flows when they have none of that id (contributions.ts). */
  flows: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "流程 id 只能用小写字母、数字和连字符，最长 48 字符")).default([]),
  mcp: z.record(z.string().regex(SPEC), pluginMcpSchema).default({}),
  backends: z.array(pluginBackendSchema).max(20).default([]).refine(v => new Set(v.map(e => e.id)).size === v.length, "后端 id 不能重复"),
  /** Host tools the plugin's agents may use, besides its own and the plugin tools (plugin_query, ask_user, show…). */
  tools: z.array(z.string()).default([]),
  page: z.object({ title: z.string() }).optional(),
  /**
   * Its page may hold a voice conversation (docs/v2/plugins.md, “语音”): the shell takes the microphone
   * and connects to the voice model (settings → AI → 语音) with the plugin's instructions, no tools.
   */
  voice: z.boolean().default(false),
  settings: z.array(settingFieldSchema).default([]),
  /** Processes the plugin keeps running (services.ts); code, so a data-directory plugin needs trust. */
  services: z.array(serviceSchema).default([]),
  /** WebSockets to a service that the plugin's page may open (through the shell, as the owner). */
  streams: z.array(streamSchema).default([]),
  /** Platforms its tools act on as the person using them (docs/v2/multi-user.md, “插件扩展”): the page says when one is not connected. */
  connectors: z.array(z.object({ provider: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), features: z.array(z.string()).default([]) })).default([]),
  /**
   * What its code will do, shown before the owner trusts it (docs/v2/plugins.md, “第三方插件”): tools that
   * write, connectors and platform packs it registers. Enforced for plugins in the data directory: code that
   * registers more than declared is refused.
   */
  permissions: z
    .object({
      events: z.array(z.enum(["item.status", "item.created", "review.finished", "finding.decision", "finding.resolution", "finding.thread"])).default([]),
      flow: z.object({ gate: z.boolean().optional(), run: z.boolean().optional(), signal: z.boolean().optional() }).strict().optional(),
      notify: z.object({ deliver: z.boolean().default(false), ask: z.boolean().default(false) }).optional(),
      sourceParser: z.boolean().default(false),
      wikiPageKind: z.boolean().default(false),
      reviewProvider: z.boolean().default(false),
      itemProvider: z.boolean().default(false),
      retriever: z.boolean().default(false),
      reranker: z.boolean().default(false),
      embedder: z.boolean().default(false),
      metricProvider: z.boolean().default(false),
      write: z.boolean().default(false),
      connectors: z.array(z.string()).default([]),
      platforms: z.array(z.string()).default([]),
      authenticators: z.array(z.string()).default([]),
      /** Backends it brings a login method for (`api.agentLogin`, docs/v2/agent-accounts.md §6): it writes credentials into members' account folders. */
      credential: z.boolean().default(false),
      agentLogin: z.array(z.string()).default([]),
    })
    .default({ events: [], sourceParser: false, wikiPageKind: false, reviewProvider: false, itemProvider: false, metricProvider: false, retriever: false, reranker: false, embedder: false, write: false, connectors: [], platforms: [], authenticators: [], credential: false, agentLogin: [] }),
}).refine((m) => Object.keys(m.mcp).every((n) => /^[a-z][a-z0-9-]{0,39}$/.test(`${m.id}-${n}`)), "MCP 服务加插件前缀后最多 40 个字符")
  .refine((m) => m.agents.every((n) => `${m.id}-${n}`.length <= 48), "档案加插件前缀后最多 48 个字符")
  .superRefine((m, ctx) => {
    const spaces = pluginSpaces(m);
    if (new Set(spaces.map((s) => s.id)).size !== spaces.length) ctx.addIssue({ code: "custom", message: "space 和 spaces 的空间 id 不能重复" });
    for (const s of spaces) for (const skill of s.skills ?? [])
      if (!m.skills.includes(skill)) ctx.addIssue({ code: "custom", message: `空间 ${s.id} 的技能 ${skill} 不在本包中` });
  });
export type PluginManifest = z.infer<typeof manifestSchema>;

export type LoadedPlugin = {
  manifest: PluginManifest;
  dir: string;
  /** builtin: ships with omem; data: the owner's, in <data>/plugins, or linked from a directory on this machine (`linked`). */
  source: "builtin" | "data";
  /** `omem plugin link`: read where it is, not copied; trusted by directory; this device only (links.ts). */
  linked: boolean;
  /**
   * Whether its code runs: builtin; none (a data plugin without code); trusted; or, for a data
   * plugin with code the owner has not confirmed (yet, or since it changed), required / changed.
   */
  trust: "builtin" | "none" | "trusted" | "required" | "changed";
  /** The owner turned it off (config plugins.disabled): no code, agents, page or nav entry. */
  enabled: boolean;
  specs: AgentSpec[];
  /** Tools the plugin registered; `page` ones its page may call. */
  tools: { name: string; page: boolean; write: boolean; approval: boolean }[];
  /** Connectors and platform packs its code registered, for the permissions it shows. */
  providers: string[];
  platforms: string[];
  /** Login methods for members' AI accounts its code registered (`<backend>:<id>`). */
  logins: string[];
  blocks: Map<string, PluginBlock>;
  /** Where its display blocks show on omem's own pages (api.slot, slots.ts). */
  slots: SlotEntry[];
  /** Undo what api.connector registered (providers and their features). */
  connectors: (() => void)[];
  channels: ChannelState[];
  env: PluginEnv;
};

/** Every plugin's agents may use these, whatever the manifest lists (questions and views show on the plugin's page). */
export const PLUGIN_TOOLS = ["plugin_query", "plugin_put", "ask_user", "wait_answer", "show"];

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

/** A plugin's `whenConnected` tools: for people with a working connection to one of its connectors. */
export const connectedTo = (plugin: string) => (app: App, userId: string) => listConnections(app, userId).some((c) => c.status === "active" && c.provider.startsWith(`${plugin}-`));

/** The ToolContext of a plugin tool's call, narrowed to what server.ts may see. */
function asPlugin(env: PluginEnv, ctx: ToolContext) {
  return { ...pluginContext(ctx.app, env, { userId: ctx.userId ?? OWNER, spaceId: ctx.spaceId, runId: ctx.runId, actor: ctx.actor }), saveSource: (input: PluginSourceInput) => saveSourceFor(ctx, input), watches: watchesFor(ctx) };
}

async function importServer(dir: string, m: PluginManifest, source: LoadedPlugin["source"]): Promise<PluginRegister | null> {
  const id = m.id;
  const file = source === "builtin" ? (built ? join(packageRoot(), "dist", "plugins", id, "server.js") : join(dir, "server.ts")) : serverFile(dir, m);
  if (!file || !existsSync(file)) return null;
  // A changed file must load anew after trust is withdrawn and given again, and so must the files
  // it imports from the plugin's folder (fresh-import.ts); a built-in's are next to its server file.
  const mod = (await importFresh(file, source === "builtin" ? dirname(file) : dir)) as { default?: PluginRegister };
  if (typeof mod.default !== "function") throw new Error(`插件 ${id} 的 server 没有默认导出 register(api)`);
  return mod.default;
}

const SERVER_FILES = ["server.ts", "server.js", "server.mjs"];
/** A data plugin's server file: the one its manifest names, else server.ts / .js / .mjs at the top. */
export const serverFile = (dir: string, m: PluginManifest) => (m.server ? join(dir, m.server) : SERVER_FILES.map((f) => join(dir, f)).find((f) => existsSync(f)));
/** A data plugin brings code when it has a server file or services. */
export const hasCode = (dir: string, m: PluginManifest) => m.backends.length > 0 || m.services.length > 0 || Object.values(m.mcp).some((s) => !!s.command) || !!m.server || SERVER_FILES.some((f) => existsSync(join(dir, f)));

/** Tools and blocks are process-wide (like the host's own tools); register a plugin once. */
async function register(app: App, dir: string, manifest: PluginManifest, source: LoadedPlugin["source"], linked = false): Promise<LoadedPlugin> {
  declarePluginBackends(manifest.id, manifest.name, manifest.backends.map(({env, ...e}) => ({...e, envNames: env})));
  const own: LoadedPlugin["tools"] = [];
  const blocks = new Map<string, PluginBlock>();
  for (const st of manifest.streams) if (!manifest.services.some((x) => x.name === st.service)) throw new Error(`流 ${st.name} 用的服务 ${st.service} 没有在 services 里声明`);
  const p: LoadedPlugin = {
    manifest,
    dir,
    source,
    trust: source === "builtin" ? "builtin" : hasCode(dir, manifest) ? trustState(app, manifest.id, dir, linked, manifest.permissions.notify, manifest.permissions.embedder, manifest.backends, manifest.permissions.flow, manifest.permissions.credential) : "none",
    linked,
    enabled: !app.config.plugins.disabled.includes(manifest.id),
    specs: [],
    tools: own,
    providers: [],
    platforms: [],
    logins: [],
    blocks,
    slots: [],
    connectors: [],
    channels: [],
    env: {
      id: manifest.id,
      title: manifest.page?.title ?? manifest.name,
      def: (kind) => blocks.get(kind),
      settings: (app, userId) => pluginSettings(app, manifest.id, manifest.settings, userId),
      sessionFor: (spec) => {
        const s = p.specs.find((x) => x.name === spec) ?? p.specs[0];
        return s ? { agent: s.name, spaceId: s.space ?? manifest.space?.id ?? "personal" } : null;
      },
    },
  };
  try {
    if (p.enabled && (p.trust === "builtin" || p.trust === "trusted")) await loadCode(app, p);
    else if (p.enabled && p.trust !== "none") console.warn(`[omem] 插件 ${manifest.id} 需要信任：在设置 → 插件里看过代码和 MCP 命令、确认后才会运行；档案、技能和页面照常可用`);
    p.specs = readSpecs(p);
    return p;
  } catch (e) {
    unloadCode(p);
    throw e;
  }
}

/** Run the plugin's server code: its tools and blocks register. Data plugins only once trusted. */
async function loadCode(app: App, p: LoadedPlugin) {
  p.connectors.push(registerPluginBackends(p.manifest.id));
  await loadPluginCode(app, p);
  if (p.trust === "changed") return;
  replaceSubscriptions(app, p.manifest.id, [...subscriptions.values()].filter(s => s.plugin === p.manifest.id).map(s => s.def));
  rememberGateScopes(app, p.manifest.id);
}
async function loadPluginCode(app: App, p: LoadedPlugin) {
  const { manifest } = p;
  const prefix = `${manifest.id}_`;
  if (p.source === "data" && trustMode(app, manifest.id) === "isolated") return loadIsolated(app, p);
  const credentials: Parameters<PluginApi["credential"]>[0][] = [];
  const api: PluginApi = {
    ...processApi(p),
    answerAsk: outletAnswerFor(app, p),
    id: manifest.id,
    object(def) { p.connectors.push(registerObject(manifest.id, def)); },
    hook(def) { p.connectors.push(registerHook(manifest.id, def)); },
    z,
    channel(def) {
      const channel = registerPluginChannel(app, p, def);
      p.channels = p.channels.filter((c) => c.id !== channel.state.id);
      p.channels.push(channel.state);
      p.connectors.push(channel.stop);
      return { receive: channel.receive };
    },
    tool(t: PluginTool<any>) {
      if (!t.name.startsWith(prefix)) throw new Error(`插件 ${manifest.id} 的工具名要以 ${prefix} 开头：${t.name}`);
      if (p.source === "data" && t.write && !manifest.permissions.write) throw new Error(`插件 ${manifest.id} 的工具 ${t.name} 会写入，但清单没有声明 permissions.write`);
      registerTool({ name: t.name, description: t.description, schema: t.schema, write: t.write, available: t.whenConnected ? connectedTo(manifest.id) : undefined, handler: withObjectActions(manifest.id, t.name, (ctx, args) => t.handler(asPlugin(p.env, ctx), args)) }, { approval: t.approval });
      p.tools.push({ name: t.name, page: !!t.page, write: !!t.write, approval: !!t.approval });
    },
    block(b: PluginBlock<any>) {
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(b.kind)) throw new Error(`内容块类型不合法：${b.kind}`);
      if (!b.display && !b.grade) throw new Error(`内容块 ${b.kind} 要么只展示（display），要么能提交（grade）`);
      const name = `${prefix}${b.kind}`;
      registerTool(blockTool(name, b, () => p.env));
      // Handing in a block is what the plugin's agent is there for: offered directly, like a role's submit tool.
      CORE_TOOLS.add(name);
      p.blocks.set(b.kind, b);
      p.tools.push({ name, page: false, write: true, approval: false });
    },
    slot(at, def) {
      p.slots.push(checkSlot(manifest.id, p.blocks, p.slots, at, def));
    },
    connector(def) {
      if (!def.id.startsWith(`${manifest.id}-`)) throw new Error(`插件 ${manifest.id} 的连接器 id 要以 ${manifest.id}- 开头：${def.id}`);
      if (loginProvider(def.id)) throw new Error(`已经有连接器 ${def.id}`);
      if (p.source === "data" && !manifest.permissions.connectors.includes(def.id)) throw new Error(`插件 ${manifest.id} 注册的连接器 ${def.id} 没有在 permissions.connectors 里声明`);
      const { features, ...provider } = def;
      p.connectors.push(registerLoginProvider(provider));
      p.providers.push(def.id);
      if (typeof features === "function" || features?.length) p.connectors.push(registerFeatures(def.id, features));
    },
    authenticator(def) {
      if (!def.id.startsWith(`${manifest.id}-`)) throw new Error(`插件 ${manifest.id} 的鉴权方式 id 要以 ${manifest.id}- 开头：${def.id}`);
      if (p.source === "data" && !manifest.permissions.authenticators.includes(def.id)) throw new Error(`插件 ${manifest.id} 注册的鉴权方式 ${def.id} 没有在 permissions.authenticators 里声明`);
      p.connectors.push(registerAuthenticator(def));
    },
    agentLogin(def) {
      // Only code running inside omem gets here (an isolated plugin's api refuses it: sandbox-runner.ts).
      if (p.source === "data" && !manifest.permissions.agentLogin.includes(def.backend)) throw new Error(`插件 ${manifest.id} 给 ${def.backend} 注册的登录方式没有在 permissions.agentLogin 里声明`);
      if (!accountCatalog(app.config.agents.profiles).some((e) => e.id === def.backend)) throw new Error(`插件 ${manifest.id} 的登录方式 ${def.id}：后端 ${def.backend} 不能按人登录`);
      p.connectors.push(registerAgentLogin(manifest.id, def, () => pluginSettings(app, manifest.id, manifest.settings, OWNER)));
      p.logins.push(`${def.backend}:${def.id}`);
    },
    credential(def) {
      if (!manifest.permissions.credential) throw new Error(`插件 ${manifest.id} 没有声明 permissions.credential`);
      credentials.push(def);
    },
    settings: () => pluginSettings(app, manifest.id, manifest.settings, OWNER),
    fetch: authFetch,
    platform(def) {
      if (p.source === "data" && !manifest.permissions.platforms.includes(def.provider)) throw new Error(`插件 ${manifest.id} 的平台包 ${def.provider} 没有在 permissions.platforms 里声明`);
      p.connectors.push(registerPlatform(manifest.id, def));
      p.platforms.push(def.provider);
    },
    platforms: () => platformList(),
    text: { html: htmlToMarkdown },
    appConfig(provider) {
      if (!provider.startsWith(`${manifest.id}-`)) throw new Error(`插件 ${manifest.id} 只能读自己连接器的配置：${provider}`);
      return appConfig(app, provider);
    },
    service(name: string) {
      const spec = manifest.services.find((s) => s.name === name);
      if (!spec) throw new Error(`插件 ${manifest.id} 没有声明服务 ${name}`);
      return {
        ensure: async () => {
          const { port, token } = await ensureService(app, { id: manifest.id, dir: p.dir }, spec);
          return { url: `http://127.0.0.1:${port}`, token };
        },
      };
    },
  };
  const reg = await importServer(p.dir, manifest, p.source);
  if (reg) await reg(api);
  if (manifest.permissions.credential) {
    const declarations = credentials.map(({ id, provides }) => ({ id, provides })).sort((a, b) => a.id.localeCompare(b.id));
    if (p.source === "data" && !acceptCredentialDeclarations(app, manifest.id, declarations)) {
      unloadCode(p);
      p.trust = "changed";
      return;
    }
    for (const def of credentials) p.connectors.push(registerCredential(manifest.id, def, () => pluginSettings(app, manifest.id, manifest.settings, OWNER), app));
  }
  await actionRungs(app, manifest.id);
  groupTools(p);
}

/**
 * A plugin's tools go into its own group; those its object kinds name as actions go into the shared
 * `object-actions` group instead, which the main assistant has: an agent in a flow stage can then use
 * the same tool as the button (under the tool's approval rung), whichever plugin brings it.
 */
const ACTIONS_GROUP = "object-actions";
function outletAnswerFor(app: App, p: LoadedPlugin): PluginApi["answerAsk"] {
  const lifetime = new AbortController();
  p.connectors.push(() => lifetime.abort());
  return async input => {
    const { answerFromOutlet } = await import("./notifier.ts");
    lifetime.signal.throwIfAborted();
    await answerFromOutlet(app, p.manifest.id, input);
  };
}
function processApi(p: LoadedPlugin) {
  const version = p.manifest.permissions.sourceParser
    ? installInfo(p.dir)?.version || p.manifest.version || codeHash(p.dir)
    : p.manifest.version;
  return registerProcessHooks(p.manifest, p.connectors, version);
}

function groupTools(p: LoadedPlugin) {
  const names = p.tools.map((t) => t.name);
  const actions = new Set(pluginObjectKinds().filter((d) => d.plugin === p.manifest.id).flatMap((d) => (d.actions ?? []).map((a) => a.tool)).filter((t) => names.includes(t)));
  const shared = TOOL_GROUPS.find((g) => g.id === ACTIONS_GROUP);
  if (shared) shared.tools = [...new Set([...shared.tools, ...actions])];
  const own = names.filter((n) => !shared || !actions.has(n));
  const group = TOOL_GROUPS.find((g) => g.id === p.manifest.id);
  if (group) group.tools = own;
  else if (own.length) TOOL_GROUPS.push({ capability: "owner", id: p.manifest.id, label: p.manifest.name, tools: own });
}

/**
 * A data plugin's code in its own process (sandbox.ts): its tools and platform readers register as
 * stand-ins. It cannot add content blocks or connectors (they need code inside omem); its declared
 * permissions are checked the same way.
 */
async function loadIsolated(app: App, p: LoadedPlugin) {
  const { manifest } = p;
  const server = serverFile(p.dir, manifest);
  if (!server || !existsSync(server)) return;
  const sb = await startSandbox(app, { id: manifest.id, dir: p.dir, server, services: manifest.services }, {
    ...processApi(p),
    answerAsk: outletAnswerFor(app, p),
    prefix: `${manifest.id}_`,
    packageRoot: packageRoot(),
    connected: connectedTo(manifest.id),
    settings: (userId) => pluginSettings(app, manifest.id, manifest.settings, userId),
    services: (name) => manifest.services.find((s) => s.name === name),
  });
  p.connectors.push(() => sb.stop());
  for (const t of sb.tools) p.tools.push({ name: t.name, page: t.page, write: t.write, approval: t.approval });
  p.platforms.push(...sb.platforms);
  const extra = [...sb.tools.filter((t) => t.write && !manifest.permissions.write).map((t) => `会写入的工具 ${t.name}（permissions.write）`), ...sb.platforms.filter((x) => !manifest.permissions.platforms.includes(x)).map((x) => `平台包 ${x}（permissions.platforms）`)];
  if (extra.length) {
    unloadCode(p);
    throw new Error(`插件 ${manifest.id} 做了清单没有声明的事：${extra.join("、")}`);
  }
  await actionRungs(app, manifest.id);
  groupTools(p);
}

/** An object action's tool starts on “ask every time” the first time omem sees it (src/flows/object-actions.ts). */
async function actionRungs(app: App, plugin: string) {
  (await import("../flows/object-actions.ts")).seedActionRungs(app, plugin);
}

/** The owner confirms a data plugin's code (as it is now): it runs from here on, no restart. */
export async function trustPlugin(app: App, id: string, mode: RunMode = "isolated") {
  const p = getPlugin(id);
  if (p.source !== "data" || !hasCode(p.dir, p.manifest)) throw new HttpError(400, `插件 ${id} 不需要信任`);
  const before = trustMode(app, id);
  if (p.trust !== "trusted" || before !== mode) {
    setTrust(app, id, p.dir, mode, p.linked, p.manifest.permissions.notify, p.manifest.permissions.embedder, p.manifest.backends, p.manifest.permissions.flow, p.manifest.permissions.credential);
    unloadCode(p);
    p.trust = "trusted";
    try {
      if (p.enabled) await loadCode(app, p);
      if (p.enabled) seedContributions(app, p);
      if (p.enabled) retryContributions(app, p);
    } catch (e) {
      // Code that does not load (or does more than it declares) is not trusted after all.
      unloadCode(p);
      setTrust(app, id, null);
      p.trust = "required";
      throw e;
    }
    p.specs = readSpecs(p);
  }
  return describePlugin(p);
}

/** Trust withdrawn: its tools and blocks go away and its services stop at once. */
export function untrustPlugin(app: App, id: string) {
  const p = getPlugin(id);
  if (p.source !== "data") throw new HttpError(400, `插件 ${id} 是内置的`);
  setTrust(app, id, null);
  unloadCode(p);
  replaceSubscriptions(app, id, []);
  p.trust = hasCode(p.dir, p.manifest) ? "required" : "none";
  p.specs = readSpecs(p);
  return describePlugin(p);
}

function unloadCode(p: LoadedPlugin) {
  const names = p.tools.map((t) => t.name);
  unregisterTools(names);
  const shared = TOOL_GROUPS.find((g) => g.id === ACTIONS_GROUP);
  if (shared) shared.tools = shared.tools.filter((t) => !names.includes(t));
  p.tools.splice(0);
  for (const undo of p.connectors.splice(0)) undo();
  p.providers.splice(0);
  p.platforms.splice(0);
  p.logins.splice(0);
  p.blocks.clear();
  p.slots.splice(0);
  stopPluginServices(p.manifest.id);
  const group = TOOL_GROUPS.findIndex((g) => g.id === p.manifest.id);
  if (group >= 0) TOOL_GROUPS.splice(group, 1);
}

/** Its services and streams are usable only when its code may run. */
export const codeRuns = (p: LoadedPlugin) => p.enabled && (p.trust === "builtin" || p.trust === "trusted");

/** Turn a plugin on or off (config plugins.disabled): its code loads or unloads at once, no restart. */
export async function setPluginEnabled(app: App, id: string, on: boolean) {
  const p = getPlugin(id);
  const disabled = new Set(app.config.plugins.disabled);
  if (on) disabled.delete(id);
  else disabled.add(id);
  app.config.plugins = { ...app.config.plugins, disabled: [...disabled] };
  saveConfig(app.config, app.home);
  if (p.enabled !== on) {
    unloadCode(p);
    p.enabled = on;
    try {
      if (on && (p.trust === "builtin" || p.trust === "trusted")) await loadCode(app, p);
      p.specs = readSpecs(p);
      if (on) {
        seedSkills(app, p);
        ensurePluginSpaces(app, p.manifest.id, p.manifest);
        seedContributions(app, p);
        retryContributions(app, p);
      }
    } catch (e) {
      unloadCode(p);
      p.specs = readSpecs(p);
      throw e;
    }
  }
  return describePlugin(p);
}

/** A plugin just installed or updated in the data directory (install.ts): (re)read it; its code waits for trust. */
export async function reloadPlugin(app: App, id: string) {
  forgetPlugin(id);
  await loadPlugins(app, [{ dir: dataPluginsDir(app), source: "data" }]);
  return describePlugin(getPlugin(id));
}

/** Drop a plugin from this process (before its directory is removed). */
export function forgetPlugin(id: string) {
  const p = plugins.get(id);
  if (!p) return;
  if (p.source === "builtin") throw new HttpError(400, `插件 ${id} 是内置的`);
  unloadCode(p);
  declarePluginBackends(id, p.manifest.name, []);
  plugins.delete(id);
}

function readSpecs(p: LoadedPlugin): AgentSpec[] {
  const { manifest } = p;
  if (!p.enabled) return [];
  const allowed = new Set([...expandTools(manifest.tools), ...p.tools.map((t) => t.name), ...PLUGIN_TOOLS]);
  const known = new Set(toolList().map((t) => t.name));
  for (const t of allowed) if (!known.has(t)) console.warn(`[omem] 插件 ${manifest.id} 声明了不存在的工具 ${t}`);
  return manifest.agents.map((n) => {
    const file = join(p.dir, "agents", `${n}.md`);
    if (!existsSync(file)) throw new Error(`插件 ${manifest.id} 缺少档案 agents/${n}.md`);
    const { meta, body } = splitFrontmatter(readFileSync(file, "utf8"));
    const listed = Array.isArray(meta.tools) ? expandTools(meta.tools as string[]) : null;
    for (const t of listed ?? []) if (!allowed.has(t)) console.warn(`[omem] 插件 ${manifest.id} 的档案 ${n} 用了清单之外的工具 ${t}，已忽略`);
    const spec = agentSpecSchema.parse({
      ...meta,
      name: `${manifest.id}-${n}`,
      plugin: manifest.id,
      space: meta.space ?? manifest.space?.id,
      tools: (listed ?? [...allowed]).filter((t) => allowed.has(t) && known.has(t)),
      skills: meta.skills ?? manifest.skills,
      // Only the servers the plugin brings: the owner's own (and their credentials) are not a plugin's to name.
      mcpServers: Array.isArray(meta.mcpServers) ? meta.mcpServers.filter((n: string) => manifest.mcp[n]).map((n: string) => `${manifest.id}-${n}`) : [],
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
    // The files themselves, never what a link in the plugin points at (anything on this machine).
    cpSync(dirname(src), dest, { recursive: true, filter: (from) => !lstatSync(from).isSymbolicLink() });
    added.push(name);
  }
  if (added.length) commitLibrary(app.libraryDir, `omem: add skills of plugin ${p.manifest.id}: ${added.join(", ")}`);
}

/**
 * Load (once per process) and set up for this library: space, skills. Built-in plugins first; a
 * plugin in the data directory with the same id is skipped. A broken plugin is skipped with a warning.
 */
let host: App | null = null;

/** The icon the nav shows: the owner's choice (settings → 插件), else the manifest's; an .svg becomes its URL. */
export function pluginIcon(p: LoadedPlugin) {
  const icon = host?.config.plugins.icons[p.manifest.id] || p.manifest.icon;
  return icon.endsWith(".svg") ? `/plugins/${p.manifest.id}/${icon.replace(/^\.?\//, "")}` : icon;
}

/** The owner picks another nav icon for a plugin (a built-in name; empty: back to the manifest's). */
export function setPluginIcon(app: App, id: string, icon: string) {
  const p = getPlugin(id);
  if (icon && !/^[a-z][a-z0-9-]*$/.test(icon)) throw new HttpError(400, "图标名不对");
  const icons = { ...app.config.plugins.icons };
  if (icon) icons[p.manifest.id] = icon;
  else delete icons[p.manifest.id];
  app.config.plugins = { ...app.config.plugins, icons };
  saveConfig(app.config, app.home);
  return describePlugin(p);
}

/** Without roots: the built-in plugins, the data directory's, then the ones linked on this device (links.ts). */
export async function loadPlugins(app: App, roots?: { dir: string; source: LoadedPlugin["source"] }[], include?: (m: PluginManifest) => boolean) {
  host = app;
  const loaded: { p: LoadedPlugin; name: string }[] = [];
  for (const root of roots ?? [{ dir: builtinPluginsDir(), source: "builtin" }, { dir: dataPluginsDir(app), source: "data" }]) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      const dir = join(root.dir, entry.name);
      if (!entry.isDirectory() || !existsSync(join(dir, "plugin.yaml"))) continue;
      const p = await loadDir(app, dir, root.source, entry.name, false, include);
      if (p) loaded.push({ p, name: entry.name });
    }
  }
  if (!roots) for (const [id, link] of Object.entries(readLinks(app))) {
    const p = await loadDir(app, link.dir, "data", id, true, include);
    if (p) loaded.push({ p, name: id });
  }
  // What they bring goes in once every plugin's code has run: a pack's flow may name another plugin's object kind.
  for (const { p, name } of loaded) seedLoaded(app, p, name);
  return listPlugins();
}

/** One plugin directory: `name` is the id it must have (its directory's name, or what it was linked as). Its code runs; what it brings is seedLoaded's. */
async function loadDir(app: App, dir: string, source: LoadedPlugin["source"], name: string, linked = false, include?: (m: PluginManifest) => boolean): Promise<LoadedPlugin | null> {
  try {
    if (linked && !existsSync(join(dir, "plugin.yaml"))) throw new Error(`链接的目录 ${dir} 不在了或没有 plugin.yaml`);
    const manifest = manifestSchema.parse(YAML.parse(readFileSync(join(dir, "plugin.yaml"), "utf8")));
    if (include && !include(manifest)) return null;
    if (manifest.id !== name) throw new Error(linked ? `链接时它是 ${name}，现在 plugin.yaml 写的是 ${manifest.id}：重新 omem plugin link` : `目录名 ${name} 与插件 id ${manifest.id} 不一致`);
    let p = plugins.get(manifest.id);
    if (p && p.dir !== dir) throw new Error(`已有同名插件（${p.source === "builtin" ? "内置" : p.dir}）`);
    if (!p) {
      p = await register(app, dir, manifest, source, linked);
      plugins.set(manifest.id, p);
    }
    return p;
  } catch (e) {
    console.warn(`[omem] 跳过插件 ${name}：${(e as Error).message}`);
    return null;
  }
}
function seedLoaded(app: App, p: LoadedPlugin, name: string) {
  if (!p.enabled) return;
  try {
    seedSkills(app, p);
    ensurePluginSpaces(app, p.manifest.id, p.manifest);
    seedContributions(app, p);
  } catch (e) {
    console.warn(`[omem] 跳过插件 ${name}：${(e as Error).message}`);
  }
}

/**
 * A linked plugin changed (its files, or its link): read it again the way an installed one is after an
 * update. Trusted by directory, so its code runs again without asking; null once it is unlinked.
 */
export async function reloadLinked(app: App, id: string) {
  host = app;
  const p = plugins.get(id);
  if (p && !p.linked) throw new HttpError(400, `插件 ${id} 不是链接的`);
  if (p) forgetPlugin(id);
  const link = readLinks(app)[id];
  const again = link ? await loadDir(app, link.dir, "data", id, true) : null;
  if (again) {
    seedLoaded(app, again, id);
    if (again.enabled) retryContributions(app, again);
  }
  const now = plugins.get(id);
  return now ? describePlugin(now) : null;
}

/**
 * A plugin's code came in (turned on, trusted): the flows and rules other packs could not add for want
 * of its object kinds get another try (what was added before, or deleted by the owner, is left alone).
 */
function retryContributions(app: App, except: LoadedPlugin) {
  for (const other of plugins.values()) {
    if (other === except || !other.enabled || (!other.manifest.flows.length && !other.manifest.rules.length)) continue;
    try { seedContributions(app, other); } catch (e) { console.warn(`[omem] 插件 ${other.manifest.id} 带来的配置没有补上：${(e as Error).message}`); }
  }
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

/** Under scripts/dev.ts the Vite dev server serves built-in pages from source (web/vite-plugin-pages.ts). */
const devPages = (p: LoadedPlugin) => p.source === "builtin" && process.env.OMEM_DEV_PAGES === "1";

/** For the nav and the plugin list: what each one offers. */
export function describePlugin(p: LoadedPlugin) {
  return {
    id: p.manifest.id,
    name: p.manifest.name,
    description: p.manifest.description,
    icon: pluginIcon(p),
    iconChosen: !!host?.config.plugins.icons[p.manifest.id],
    source: p.source,
    backends: p.manifest.backends.map(e => ({ id: `${p.manifest.id}:${e.id}`, name: e.name, command: e.command, args: e.args ?? [] })),
    // Linked for development (omem plugin link): the page marks it 开发中.
    linked: p.linked,
    slots: p.slots.map((s) => ({ at: s.at, block: s.block })),
    // Callbacks from outside (hooks.ts): the address without its secret, and whether one is set.
    hooks: describeHooks(host ?? null, p.manifest.id),
    space: p.manifest.space?.id ?? null,
    spaces: describeSpaces(host, p.manifest.id, p.manifest),
    agents: p.manifest.agents.map((n) => ({ name: `${p.manifest.id}-${n}`, description: p.specs.find((s) => s.name === `${p.manifest.id}-${n}`)?.description ?? "" })),
    skills: p.manifest.skills,
    ...(host ? broughtBy(host, p) : { flows: [], rules: [], mcp: [] }),
    channels: p.channels,
    // own: the plugin's page in a sandboxed frame (built or not yet); otherwise the shell's default page.
    page: p.enabled && p.manifest.page ? { title: p.manifest.page.title, own: hasOwnPage(p), built: !!pluginWebDir(p) || devPages(p) } : null,
    enabled: p.enabled,
    runMode: p.source === "data" && p.trust !== "none" ? (host ? trustMode(host, p.manifest.id) : "isolated") : null,
    version: installInfo(p.dir)?.version || p.manifest.version || null,
    installed: installInfo(p.dir),
    settings: p.manifest.settings.length > 0,
    trust: p.trust,
    dir: p.source === "data" ? p.dir : null,
    tools: p.tools.map((t) => t.name),
    services: p.manifest.services.map((s) => ({ name: s.name, description: s.description, command: [s.command, ...s.args].join(" ") })),
    streams: p.manifest.streams.map((s) => ({ name: s.name, description: s.description, service: s.service })),
    connectors: p.manifest.connectors,
    // Its page may hold voice conversations (the shell takes the microphone).
    voice: p.manifest.voice,
    // What it may do, for the owner deciding to trust or keep it.
    // Before its code runs, what the manifest declares.
    permissions: {
      tools: p.tools.filter((t) => !t.name.startsWith("plugin_")).map((t) => ({ name: t.name, write: t.write, approval: t.approval })),
      writes: p.tools.some((t) => t.write) || (!codeRuns(p) && p.manifest.permissions.write),
      flow: p.manifest.permissions.flow,
      notify: p.manifest.permissions.notify,
      embedder: p.manifest.permissions.embedder,
      embeddingNotice: p.manifest.permissions.embedder ? "要算向量的正文（原件分块、记忆、查询）会交给这个插件，插件可能把它发到外部服务。" : null,
      hostTools: p.manifest.tools,
      providers: codeRuns(p) ? p.providers : p.manifest.permissions.connectors,
      platforms: codeRuns(p) ? p.platforms : p.manifest.permissions.platforms,
      // Backends it logs members in to (writes credentials into their account folders).
      agentLogin: codeRuns(p) ? [...new Set(p.logins.map((l) => l.split(":")[0]))] : p.manifest.permissions.agentLogin,
      // Credentials it registers for members (agents/credentials.ts): a linked folder's code is re-confirmed on every change.
      credential: p.manifest.permissions.credential,
      uses: p.manifest.connectors.map((c) => c.provider),
      services: [...p.manifest.services.map((s) => [s.command, ...s.args].join(" ")), ...Object.values(p.manifest.mcp).filter((s) => s.command).map((s) => [s.command, ...s.args].join(" "))],
      space: p.manifest.space?.id ?? null,
    },
  };
}
