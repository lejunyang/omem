import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { readKeys } from "../core/ai-keys.ts";
import { HttpError } from "../core/util.ts";
import { listAgentSpecs, listSkills, readAgentSpec, readRaw, readSkill, splitFrontmatter } from "../agents/specs.ts";
import { expandTools } from "../agents/tool-help.ts";
import { listMcpServers } from "../agents/mcp-servers.ts";
import { getRule, listRules } from "../rules/store.ts";
import { ruleInputSchema } from "../rules/types.ts";
import { builtinPluginsDir, dataPluginsDir, manifestSchema } from "./registry.ts";
import { portableRule } from "./contributions.ts";

export const packSchema = z.object({
  id: z.string(), name: z.string().trim().min(1), description: z.string().default(""),
  agents: z.array(z.string()).default([]), skills: z.array(z.string()).default([]), rules: z.array(z.string()).default([]), mcp: z.array(z.string()).default([]),
  out: z.string().optional(), allow: z.array(z.string()).default([]),
});
export type PackInput = z.input<typeof packSchema>;

/** Resolve the existing parent too: an output path through a junction must not reach live plugins. */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
}
const within = (parent: string, child: string) => { const rel = relative(parent, child); return !rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); };

/** Copy bytes, reject links, and collect everything before writing anything. */
function collectTree(dir: string, prefix: string, files: Map<string, Buffer>) {
  if (lstatSync(dir).isSymbolicLink()) throw new HttpError(400, `不打包符号链接：${prefix}`);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name), name = `${prefix}/${e.name}`;
    if (e.isSymbolicLink()) throw new HttpError(400, `不打包符号链接：${name}`);
    if (e.isDirectory()) collectTree(path, name, files);
    else if (e.isFile()) files.set(name, readFileSync(path));
  }
}

/** Keys can contain a JSON map (MCP headers/env): scan its individual values too, without printing any. */
function secretValues(app: App) {
  const values = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v) {
      // A value this short is no key, and would match ordinary text everywhere.
      if (v.length >= 8) values.add(v);
      try { const parsed: unknown = JSON.parse(v); if (parsed && typeof parsed === "object") add(parsed); } catch { /* ordinary key */ }
    } else if (v && typeof v === "object") Object.values(v).forEach(add);
  };
  Object.values(readKeys(app.home)).forEach(add);
  return [...values];
}

export function packChoices(app: App) {
  return { agents: listAgentSpecs(app).map((a) => ({ id: a.name, name: a.name })),
    skills: listSkills(app).map((s) => ({ id: s.name, name: s.name })),
    rules: listRules(app).filter((r) => !r.temporary).map((r) => ({ id: r.id, name: r.name })),
    mcp: listMcpServers(app).map((s) => ({ id: s.name, name: s.name })) };
}

/** A code-free plugin; no MCP secret value is ever read into its manifest. */
export function packPlugin(app: App, input: PackInput) {
  const o = packSchema.parse(input);
  // Validate the id before it is used in any filesystem path.
  manifestSchema.parse({ id: o.id, name: o.name });
  const dir = resolve(o.out ?? join(app.home, "plugins-out", o.id));
  const target = canonical(dir);
  for (const live of [builtinPluginsDir(), resolve("plugins"), dataPluginsDir(app)]) {
    const root = canonical(resolve(live));
    if (within(root, target) || within(target, root)) throw new HttpError(400, "输出目录不能是仓库或正在使用的 plugins/，也不能包含它");
  }
  if (existsSync(dir)) throw new HttpError(409, "输出目录已存在，请换一个目录");
  const files = new Map<string, Buffer>(), warnings: string[] = [], tools = new Set<string>();
  const agents = [...new Set(o.agents)], skills = [...new Set(o.skills)], rules = [...new Set(o.rules)], mcp = [...new Set(o.mcp)];
  const definitions: Record<string, unknown> = {};
  for (const name of agents) {
    const raw = readRaw(app, "agent", name), { meta, body } = splitFrontmatter(raw);
    delete meta.plugin;
    for (const kind of ["mcpServers", "skills"] as const) {
      const selected = kind === "skills" ? skills : mcp;
      for (const n of Array.isArray(meta[kind]) ? meta[kind] : []) if (!selected.includes(String(n))) warnings.push(`档案 ${name} 的 ${kind} 引用了未打包的 ${n}`);
    }
    meta.tools = expandTools(Array.isArray(meta.tools) ? meta.tools.map(String) : []);
    for (const t of meta.tools as string[]) tools.add(t);
    meta.mcpServers = Array.isArray(meta.mcpServers) ? [...meta.mcpServers] : [];
    // Legacy inline MCP definitions become manifest entries too: values never travel,
    // and their commands must pass the same trust gate as named servers.
    const inline = readAgentSpec(app, name).mcp;
    for (const [key, server] of Object.entries(inline)) {
      let short = `inline-${Object.keys(definitions).length + 1}`;
      while (mcp.includes(short) || Object.hasOwn(definitions, short)) short += "x";
      definitions[short] = "url" in server ? { url: server.url, headers: Object.keys(server.headers), readOnly: server.readOnly } : { command: server.command, args: server.args, env: Object.keys(server.env), readOnly: server.readOnly };
      (meta.mcpServers as string[]).push(short);
      warnings.push(`档案 ${name} 的内嵌 MCP ${key} 转成 ${short}，只保留密钥名`);
    }
    delete meta.mcp;
    files.set(`agents/${name}.md`, Buffer.from(`---\n${YAML.stringify(meta)}---\n${body}\n`));
  }
  for (const name of skills) collectTree(readSkill(app, name).dir, `skills/${name}`, files);
  const ruleNames = rules.map((id, i) => {
    const rule = getRule(app, id);
    if (rule.temporary) throw new HttpError(400, "临时规则不能打包");
    const name = `rule-${i + 1}`;
    // Stored ids, origin, counters and timestamps belong to this installation only.
    // What the owner chose for this installation (a script, a forward target, 完全访问, the conversation,
    // the AI, the space) stays here: contributions.ts portableRule.
    let data;
    try { data = portableRule(ruleInputSchema.parse({ ...rule, enabled: false }), () => false); }
    catch (e) { throw new HttpError(400, `规则「${rule.name}」：${(e as Error).message}`); }
    if (rule.spaceId || rule.conversationId || rule.actions.some((a) => a.type === "agent" && (a.space || a.ai || a.fullAccess)))
      warnings.push(`规则「${rule.name}」的所属空间、发到的会话、指定的 AI 和完全访问没有带走：装上后在规则页重新选`);
    files.set(`rules/${name}.yaml`, Buffer.from(YAML.stringify(data)));
    return name;
  });
  const servers = listMcpServers(app);
  for (const name of mcp) {
    const s = servers.find((s) => s.name === name);
    if (!s) throw new HttpError(404, `没有 MCP 服务 ${name}`);
    definitions[name] = { description: s.description, readOnly: s.readOnly, ...(s.kind === "url" ? { url: s.url, headers: s.secrets.map((s) => s.name) } : { command: s.command, args: s.args, env: s.secrets.map((s) => s.name) }) };
  }
  const manifest = manifestSchema.parse({ id: o.id, name: o.name, description: o.description, agents, skills, rules: ruleNames, mcp: definitions, tools: [...tools] });
  files.set("plugin.yaml", Buffer.from(YAML.stringify(manifest)));
  const keys = secretValues(app), hits: string[] = [], personal = new Set<string>();
  for (const [file, bytes] of files) {
    if (bytes.includes(0)) continue;
    const raw = bytes.toString("utf8");
    const secretLines = new Set<number>();
    for (const key of keys) {
      for (let at = raw.indexOf(key); at >= 0; at = raw.indexOf(key, at + key.length)) secretLines.add(raw.slice(0, at).split("\n").length - 1);
    }
    raw.split(/\r?\n/).forEach((line, i) => {
      // A stored key never leaves, whatever is allowed: --allow only lets a home path through.
      if (secretLines.has(i)) hits.push(`${file}:${i + 1}：存储的密钥（不能放行，先从文件里拿掉）`);
      if (/\/(?:Users|home)\/[^/\s]+\/|[A-Za-z]:[\\/]Users[\\/][^\\/\s]+[\\/]/i.test(line)) {
        const detail = `${file}:${i + 1}：用户目录绝对路径`;
        if (o.allow.includes(file)) warnings.push(`已按 --allow 放行 ${detail}`);
        else hits.push(detail);
      }
      // Not refused (a rule is often about one chat), but the owner should look before sharing it.
      if (/\b(?:oc|ou|on)_[0-9a-f]{20,}\b|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(line)) personal.add(file);
    });
  }
  for (const file of personal) warnings.push(`${file} 里有会话或人员的 id、邮箱：分享前核对`);
  if (hits.length) throw new HttpError(400, `没有写入场景包。以下位置需要清理；用户目录路径可以逐文件用 --allow <file> 放行，存储的密钥不能放行（MCP 密钥值始终不导出）：\n${hits.join("\n")}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) { const file = join(dir, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); }
  return { dir, warnings };
}
