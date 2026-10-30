/**
 * Plugin pages with Vite (docs/v2/plugins.md), shared by web/vite.config.ts and scripts/build-plugins.ts.
 *
 * - `@omem/plugin-sdk` → packages/plugin-sdk (the shell's default page and plugin pages import it).
 * - In development the dev server serves each built-in plugin's page from source with HMR, at the
 *   same /plugins/<id>/ the API serves the build from; /plugins/_sdk/omem.js and omem.css come from
 *   source too. Other /plugins/ paths (pages of data-directory plugins) still go to the API.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

export const repoRoot = resolve(import.meta.dirname, "..");
const sdkDir = join(repoRoot, "packages", "plugin-sdk");

export const sdkAlias = [
  { find: /^@omem\/plugin-sdk$/, replacement: join(sdkDir, "client.ts") },
  { find: /^@omem\/plugin-sdk\/blocks$/, replacement: join(sdkDir, "blocks.ts") },
];

const fsUrl = (path: string) => `/@fs/${path.replace(/\\/g, "/").replace(/^\//, "")}`;

export function pluginPagesDev(): Plugin {
  // A plugin page runs in a sandboxed iframe (origin "null"): its module scripts need CORS. Only
  // what such a page loads gets it: the pages, their sources, the SDK, omem's styles and components
  // (/src/ is web/src, the dev server's root), dependencies and Vite's client; not the data directory.
  const open = ["/plugins/", "/src/", "/@vite/", "/@id/", "/node_modules/", ...["plugins", "packages/plugin-sdk", "web/src", "node_modules"].map((d) => fsUrl(join(repoRoot, d)) + "/")];
  return {
    name: "omem-plugin-pages",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (open.some((p) => url.startsWith(p))) res.setHeader("access-control-allow-origin", "*");
        const path = url.split("?")[0];
        if (path === "/plugins/_sdk/omem.js") return ((req.url = fsUrl(join(sdkDir, "client.ts"))), next());
        if (path === "/plugins/_sdk/omem.css") return ((req.url = fsUrl(join(repoRoot, "web", "src", "styles.css"))), next());
        const m = /^\/plugins\/([a-z][a-z0-9]{1,23})\/(.*)$/.exec(path);
        const web = m && join(repoRoot, "plugins", m[1], "web");
        if (!m || !web || !existsSync(join(web, "index.html"))) return next();
        if (m[2] === "" || m[2] === "index.html") {
          const html = await server.transformIndexHtml(`/plugins/${m[1]}/index.html`, readFileSync(join(web, "index.html"), "utf8"));
          res.setHeader("content-type", "text/html; charset=utf-8");
          return res.end(html);
        }
        // Files next to the page (./main.ts, public/ assets): from the page's directory.
        const file = [join(web, m[2]), join(web, "public", m[2])].find((f) => f.startsWith(web) && existsSync(f));
        if (!file) return next();
        req.url = fsUrl(file) + (url.includes("?") ? url.slice(url.indexOf("?")) : "");
        next();
      });
    },
  };
}
