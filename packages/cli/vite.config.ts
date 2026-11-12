import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// One file for Node with everything bundled in (commander, the MCP SDK): the published package has
// no dependencies. Node built-ins stay imports.
const at = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const { version } = JSON.parse(readFileSync(at("package.json"), "utf8")) as { version: string };
const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
export default defineConfig({
  define: { __OMEM_CLI_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: true, target: "node" },
  build: {
    outDir: at("dist"),
    emptyOutDir: true,
    target: "node20",
    minify: false,
    ssr: at("src/main.ts"),
    rollupOptions: {
      external: builtins,
      output: { format: "es", entryFileNames: "omem.js", inlineDynamicImports: true, banner: "#!/usr/bin/env node" },
    },
  },
});
