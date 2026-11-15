import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { HttpError, now } from "../core/util.ts";
import { setTrust } from "./trust.ts";

/**
 * Linked plugins (docs/v2/plugins.md, “开发中的插件”): `omem plugin link <dir>` while writing one. omem
 * reads it where it is — nothing is copied — and loads it again when its files change. It is trusted
 * by directory (trust.ts), so editing it needs no new confirmation; the settings page marks it 开发中.
 *
 * The records are this device's (`<data>/plugins/.links.json`): a pull replaces the database and the
 * library, files, runs and repositories, never plugins/ or secrets/, so a link is neither carried to
 * another device nor overwritten by one. Only a directory on this machine can be linked, and only from
 * this machine's command line: there is no HTTP route that links one.
 */
export type LinkRecord = { dir: string; linkedAt: string };
const file = (app: App) => join(app.home, "plugins", ".links.json");

export function readLinks(app: App): Record<string, LinkRecord> {
  try {
    const all = JSON.parse(readFileSync(file(app), "utf8")) as Record<string, LinkRecord>;
    return Object.fromEntries(Object.entries(all).filter(([id, r]) => /^[a-z][a-z0-9]{1,23}$/.test(id) && typeof r?.dir === "string"));
  } catch {
    return {};
  }
}
function writeLinks(app: App, all: Record<string, LinkRecord>) {
  mkdirSync(join(app.home, "plugins"), { recursive: true });
  writeFileSync(file(app), JSON.stringify(all, null, 2));
}

/** A directory on this machine (not a network share), resolved through links, holding plugin.yaml. */
export function localPluginDir(input: string) {
  const given = input.trim();
  if (!given) throw new HttpError(400, "要给插件目录");
  if (/^(\\\\|\/\/)/.test(given) || /^[a-z][a-z0-9+.-]*:\/\//i.test(given)) throw new HttpError(400, `只能链接这台机器上的目录：${given}`);
  const abs = resolve(given);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new HttpError(400, `没有这个目录：${abs}`);
  const dir = realpathSync.native(abs);
  if (/^(\\\\|\/\/)/.test(dir)) throw new HttpError(400, `只能链接这台机器上的目录：${dir} 在网络上`);
  if (!existsSync(join(dir, "plugin.yaml"))) throw new HttpError(400, `${dir} 里没有 plugin.yaml：不是 omem 插件`);
  return dir;
}

/**
 * Link a plugin directory for development. Refuses an id a built-in plugin, an installed one or a
 * hand-made one in plugins/ already has; linking the same id to another directory replaces the link
 * (and its trust, which was for the old directory). Loading it is the caller's (the running service
 * notices the change itself, `watchLinkedPlugins`).
 */
export async function linkPlugin(app: App, input: string) {
  const dir = localPluginDir(input);
  const { builtinPluginsDir, dataPluginsDir, manifestSchema } = await import("./registry.ts");
  const parsed = manifestSchema.safeParse(YAML.parse(readFileSync(join(dir, "plugin.yaml"), "utf8")));
  if (!parsed.success) throw new HttpError(400, `plugin.yaml 不对：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const id = parsed.data.id;
  if (existsSync(join(builtinPluginsDir(), id))) throw new HttpError(409, `插件 id ${id} 和内置插件重名`);
  if (existsSync(join(dataPluginsDir(app), id))) throw new HttpError(409, `数据目录里已经有插件 ${id}（${join(dataPluginsDir(app), id)}）：换个 id，或先删掉它`);
  const all = readLinks(app);
  const before = all[id];
  if (before?.dir !== dir) setTrust(app, id, null);
  all[id] = { dir, linkedAt: before?.dir === dir ? before.linkedAt : now() };
  writeLinks(app, all);
  return { id, dir, replaced: !!before && before.dir !== dir, again: before?.dir === dir };
}

/** Drop a link (the directory itself is left alone) and the trust that went with it. */
export function unlinkPlugin(app: App, id: string) {
  const all = readLinks(app);
  if (!all[id]) return false;
  delete all[id];
  writeLinks(app, all);
  setTrust(app, id, null);
  return true;
}

/** Changes that do not need a reload: pages are read from the directory on every request. */
const QUIET = /^(node_modules|\.git|web)(\/|$)/;

/**
 * In the running service: load a linked plugin again when its files change (a moment after the last
 * change), and pick up `omem plugin link` / `unlink` from the command line. Returns a stop function.
 */
export function watchLinkedPlugins(app: App, opts: { delayMs?: number } = {}) {
  const delay = opts.delayMs ?? 300;
  const watching = new Map<string, { dir: string; w: FSWatcher }>();
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = false;
  const later = (key: string, fn: () => Promise<void> | void) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      if (!stopped) void Promise.resolve().then(fn).catch((e) => console.warn(`[omem] 开发中的插件 ${key}：${(e as Error).message}`));
    }, delay));
  };
  const reload = (id: string) => later(id, async () => {
    const { reloadLinked } = await import("./registry.ts");
    const p = await reloadLinked(app, id);
    app.emit({ type: "plugin", plugin: id, conversationId: "" });
    console.log(p ? `[omem] 开发中的插件 ${id} 有改动，已重新加载` : `[omem] 插件 ${id} 的链接去掉了`);
  });
  const watchDir = (id: string, dir: string) => {
    try {
      const w = watch(dir, { recursive: true }, (_event, name) => {
        if (!QUIET.test(String(name ?? "").replace(/\\/g, "/"))) reload(id);
      });
      w.on("error", () => {});
      w.unref();
      watching.set(id, { dir, w });
    } catch (e) {
      console.warn(`[omem] 看不住开发中的插件 ${id} 的目录（${(e as Error).message}）：改了要重启 omem`);
    }
  };
  /** The links as they are now: watch new ones, drop gone ones; `first`: what loadPlugins just loaded. */
  const sync = (first = false) => {
    const links = readLinks(app);
    for (const [id, x] of watching)
      if (links[id]?.dir !== x.dir) {
        x.w.close();
        watching.delete(id);
        if (!links[id]) reload(id);
      }
    for (const [id, link] of Object.entries(links))
      if (!watching.has(id) && existsSync(link.dir)) {
        watchDir(id, link.dir);
        if (!first) reload(id);
      }
  };
  sync(true);
  mkdirSync(join(app.home, "plugins"), { recursive: true });
  let list: FSWatcher | null = null;
  try {
    list = watch(join(app.home, "plugins"), (_event, name) => {
      if (String(name ?? "") === ".links.json") later("(links)", () => sync());
    });
    list.on("error", () => {});
    list.unref();
  } catch {}
  return () => {
    stopped = true;
    for (const t of timers.values()) clearTimeout(t);
    for (const x of watching.values()) x.w.close();
    list?.close();
  };
}
