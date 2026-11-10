// 注入页面的脚本（内容脚本、面板 eval 注入的钩子）必须是单文件、无 import 的 IIFE：
// 主构建（vite.config.ts）是多入口 ES 模块，会拆出共享 chunk，不能直接注入。这里逐个入口单独打包到 dist/inject/。
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const entries = ["page-hook", "page-bridge", "simulator-env", "pick-overlay"];
const watch = process.argv.includes("--watch");

for (const name of entries) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: "dist/inject",
      emptyOutDir: false,
      minify: true,
      sourcemap: false,
      watch: watch ? {} : null,
      lib: {
        entry: `src/inject/${name}.ts`,
        formats: ["iife"],
        name: `omemInject_${name.replace(/-/g, "_")}`,
        fileName: () => `${name}.js`
      }
    }
  });
}
console.log(`inject: ${entries.map((name) => `${name}.js`).join(", ")}`);
