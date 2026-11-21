import { extname } from "node:path";
import { z } from "zod";
import type { CallContext, ParserInput, ProcessApi, SourceParser, WikiPageKind } from "./types.ts";
import type { PluginManifest } from "./registry.ts";
import type { App } from "../core/app.ts";
import { HttpError, untilAbort } from "../core/util.ts";

export const MAX_INPUT = 200 * 1024 * 1024;
const id = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const label = z.string().trim().min(1).max(128);
const patterns = z.array(z.string().min(1).max(512)).max(64).optional();
const match = z.object({ extensions: patterns, mimeTypes: patterns, urlPatterns: patterns });
const lines = z.tuple([z.int().positive(), z.int().positive()]);
export const sourceDisplaySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("table"), columns: z.array(label).min(1).max(128), rowLines: z.array(lines).max(20000) }),
  z.object({ kind: z.literal("records"), items: z.array(z.object({ title: z.string().max(512), lines })).max(20000) }),
]);
const output = z.object({
  title: z.string().max(512).optional(), text: z.string().min(1).max(8_000_000).transform(s => s.replace(/\r\n?/g, "\n")),
  meta: z.record(z.string().min(1).max(64), z.string().max(512)).refine(m => Object.keys(m).length <= 32).optional(),
  display: sourceDisplaySchema.optional(),
}).superRefine(({ text, display }, ctx) => {
  if (!display) return;
  const count = text.split("\n").length;
  const ranges = display.kind === "records" ? display.items.map(i => i.lines) : display.rowLines;
  for (const [start, end] of ranges) {
    if (end < start || end > count) {
      ctx.addIssue({ code: "custom", message: "display 行号须在正文范围内，结束行不能早于起始行" });
      break;
    }
  }
});
const upkeep = z.object({ everyDays: z.int().positive().max(3650).optional(), onSourcesChanged: z.boolean().optional() });
type Context = (app: App, user: string, space: string, signal: AbortSignal) => CallContext;
type Entry<T> = { plugin: string; version: string | null; spaces: string[]; context: Context; def: T };
const parsers = new Map<string, Entry<SourceParser> & { errors: Map<string, { user: string; message: string }> }>();
const kinds = new Map<string, Entry<WikiPageKind> & { checkFailed?: boolean }>();
const builtins: Record<string, string> = { page: "普通页面", index: "目录", guide: "指南", concept: "概念", howto: "操作步骤", reference: "参考", topic: "主题", person: "人物", project: "项目", log: "日志", case: "案例" };
type Scope = string | string[] | null;
function available(entry: { spaces: string[] }, scope: Scope) {
  if (scope === null) return true;
  if (typeof scope === "string") return !entry.spaces.length || entry.spaces.includes(scope);
  return scope.some(space => !entry.spaces.length || entry.spaces.includes(space));
}

export function registerFormats(manifest: PluginManifest, version: string | undefined, spaces: string[], context: Context, undo: (() => void)[]): Pick<ProcessApi, "sourceParser" | "wikiPageKind"> {
  const entry = { plugin: manifest.id, version: version ?? null, spaces, context };
  return {
    sourceParser(def) {
      if (!manifest.permissions.sourceParser) throw new Error("缺少 permissions.sourceParser");
      const key = manifest.id + ":" + id.parse(def.id);
      const rule = match.parse(def.match);
      if (parsers.has(key) || !Object.values(rule).some(v => v?.length) || typeof def.parse !== "function") throw new Error("解析器重复或声明无效：" + key);
      parsers.set(key, { ...entry, def: { ...def, label: label.parse(def.label), match: rule }, errors: new Map() });
      undo.push(() => { parsers.delete(key); });
    },
    wikiPageKind(def) {
      if (!manifest.permissions.wikiPageKind) throw new Error("缺少 permissions.wikiPageKind");
      const key = id.parse(def.kind);
      if (Object.hasOwn(builtins, key) || kinds.has(key)) throw new Error("页面类型重复：" + key);
      const meta = z.object({ label, describe: z.string().min(1).max(1024), template: z.string().min(1).max(16000), upkeep: upkeep.optional() }).parse(def);
      kinds.set(key, { ...entry, def: { ...def, ...meta } });
      undo.push(() => { kinds.delete(key); });
    },
  };
}

export function parserList(space: Scope, user = "owner") {
  return [...parsers].filter(([, e]) => available(e, space)).map(([id, e]) => {
    const visible = (error?: { user: string; message: string }) => error && (user === "owner" || error.user === user) ? error.message : null;
    let lastError = typeof space === "string" ? visible(e.errors.get(space)) : null;
    if (typeof space !== "string") for (const [id, error] of e.errors) {
      if ((space === null || space.includes(id)) && visible(error)) lastError = error.message;
    }
    return { id, plugin: e.plugin, version: e.version, label: e.def.label, match: e.def.match, lastError };
  });
}

/** URL globs use a literal prefix and suffix; only '*' is special. */
function urlMatches(url: string, pattern: string) {
  const [prefix, ...parts] = pattern.split("*");
  if (!parts.length) return url === prefix;
  const suffix = parts.pop()!;
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) return false;
  let pos = prefix.length;
  for (const literal of parts) {
    const at = url.indexOf(literal, pos);
    if (at < 0) return false;
    pos = at + literal.length;
  }
  return pos <= url.length - suffix.length;
}

export function pickParser(list: ReturnType<typeof parserList>, order: string[], name: string, builtin: boolean, mime?: string, url?: string) {
  const ext = extname(name).toLowerCase();
  const matched = list.filter(({ match }) => url
    ? match.urlPatterns?.some(pattern => urlMatches(url, pattern))
    : match.extensions?.some(e => "." + e.toLowerCase().replace(/^\./, "") === ext) || match.mimeTypes?.some(m => m.toLowerCase() === mime?.split(";")[0].trim().toLowerCase()));
  return order.map(key => matched.find(p => p.id === key)).find(Boolean) ?? (builtin ? undefined : matched[0]);
}

export async function parseSource(app: App, space: string, user: string, key: string, input: ParserInput, signal?: AbortSignal) {
  const entry = parsers.get(key);
  if (!entry || !available(entry, space)) throw new HttpError(422, "没有能读这种格式的解析器");
  if (input.bytes.length > MAX_INPUT) throw new HttpError(413, "解析输入超过 200 MiB");
  const timeout = AbortSignal.timeout(15000);
  const ctx = entry.context(app, user, space, signal ? AbortSignal.any([signal, timeout]) : timeout);
  try {
    const result = output.parse(await untilAbort(ctx.signal, () => entry.def.parse(ctx, input)));
    return { ...result, parser: { id: key, version: entry.version } };
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 512);
    entry.errors.delete(space);
    entry.errors.set(space, { user, message });
    throw new HttpError(422, key + " 解析失败：" + message);
  }
}

export type FileParsers = {
  list: ReturnType<typeof parserList>;
  parse: (key: string, input: ParserInput) => ReturnType<typeof parseSource>;
};
export function fileParsers(app: App, space: string, user: string, signal?: AbortSignal): FileParsers {
  return { list: parserList(space, user), parse: (key, input) => parseSource(app, space, user, key, input, signal) };
}

export function pageKind(space: string, kind?: string) {
  const entry = kind && kinds.get(kind);
  return entry && available(entry, space) ? entry : undefined;
}
export function kindList(space: Scope, templates = false) {
  return [...Object.entries(builtins).map(([kind, label]) => ({ kind, label, describe: label, plugin: null, hasTemplate: false, ...(templates && { template: null }), upkeep: null })),
    ...[...kinds.values()].filter(e => available(e, space)).map(({ plugin, def }) => ({
      kind: def.kind, label: def.label, describe: def.describe, plugin, hasTemplate: !!def.template, ...(templates && { template: def.template }), upkeep: def.upkeep ?? null,
    }))];
}
export function kindBrief(space: string, selected?: string) {
  const entries = kindList(space).filter(k => k.plugin);
  if (!entries.length) return "";
  return ["插件提供的页面类型（写作参考）：", ...entries.map(k => k.kind + "（" + k.label + "）：" + k.describe),
    pageKind(space, selected)?.def.template].filter(Boolean).join("\n");
}
export const knownKind = (space: string, kind: string) => Object.hasOwn(builtins, kind) || !!pageKind(space, kind);
const issues = z.array(z.object({ line: z.int().positive().optional(), message: z.string().min(1).max(1024) })).max(100);
export async function checkKind(app: App, space: string, user: string, kind: string | undefined, page: { slug: string; title: string; body: string }) {
  const entry = pageKind(space, kind);
  const check = entry?.def.check;
  if (!entry || !check) return [];
  const ctx = entry.context(app, user, space, AbortSignal.timeout(15000));
  try {
    const found = issues.parse(await untilAbort(ctx.signal, () => check(ctx, page)));
    entry.checkFailed = false;
    return found.map(i => ({ kind: "plugin-kind" as const, text: (i.line ? "L" + i.line + " " : "") + i.message }));
  } catch (e) {
    if (!entry.checkFailed) console.warn("[omem] 页面类型检查失败", kind, e instanceof Error ? e.message : String(e));
    entry.checkFailed = true;
    return [];
  }
}
