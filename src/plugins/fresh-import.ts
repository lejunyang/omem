import { realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Import a plugin's server file anew, together with the files it imports from the plugin's own
 * folder. Node caches ES modules by URL and cannot unload them, so the entry gets a fresh
 * `?omem-v=` each time (trust given again, a linked folder changed) and a resolve hook, registered
 * once, gives every file under the same plugin folder that it imports, directly or further down,
 * the same query. Without it a changed `./src/x.mjs` kept the copy loaded when the service started
 * (the entry then asked for an export the old copy did not have). The folder's own node_modules keep
 * their URLs: dependencies rarely change, and loading them again each time would only grow memory.
 *
 * The hook sees every import of the process after the first plugin loads, so it is the in-thread
 * `module.registerHooks` (Node 22.15+; nothing measurable per import), not the off-thread
 * `module.register` (a round trip to the hooks thread on every dynamic import, about 30 times slower).
 */
type Resolved = { url: string; format?: string | null; shortCircuit?: boolean };
type ResolveHook = (specifier: string, context: { parentURL?: string }, next: (specifier: string, context: { parentURL?: string }) => Resolved) => Resolved;

export function withVersion(parent: string | undefined, r: Resolved): Resolved {
  if (!parent || !parent.includes("omem-v=") || !r.url.startsWith("file:")) return r;
  const p = new URL(parent);
  const root = p.searchParams.get("omem-root");
  const v = p.searchParams.get("omem-v");
  if (!root || !v) return r;
  const u = new URL(r.url);
  if (u.search || !u.href.startsWith(root) || u.href.slice(root.length).split("/").includes("node_modules")) return r;
  u.searchParams.set("omem-root", root);
  u.searchParams.set("omem-v", v);
  return { ...r, url: u.href };
}

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  const registerHooks = (nodeModule as { registerHooks?: (hooks: { resolve: ResolveHook }) => unknown }).registerHooks;
  // Without it (older Node) only the entry loads anew, as before.
  if (typeof registerHooks === "function") registerHooks({ resolve: (specifier, context, next) => withVersion(context.parentURL, next(specifier, context)) });
  else console.warn("[omem] 这个 Node 没有 module.registerHooks：插件重新加载时只换入口文件，它引用的文件要重启服务才换新");
}

/** `root`: the plugin's folder; files under it (outside node_modules) load anew with the entry. */
export async function importFresh(file: string, root: string): Promise<unknown> {
  hook();
  // Node resolves file URLs to their real path, so the root is compared the same way.
  let base = pathToFileURL(realpathSync(root)).href;
  if (!base.endsWith("/")) base += "/";
  const url = new URL(pathToFileURL(realpathSync(file)).href);
  url.searchParams.set("omem-root", base);
  url.searchParams.set("omem-v", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return import(url.href);
}
