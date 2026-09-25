// Produce a portable, offline HTML artifact. No source corpus or credentials are bundled.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
const output = await build({
  entryPoints: [new URL("./app.jsx", import.meta.url).pathname],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "inline",
});
const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
const notices = await readFile(
  new URL("./THIRD_PARTY_NOTICES.txt", import.meta.url),
  "utf8",
);
const script = output.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await writeFile(
  new URL("./index.html", import.meta.url),
  `<!doctype html>
<!-- omem v0.1 interaction prototype. Fictional examples; simulated AI; no network requests.
Visual reference: user-provided 企业知识管理系统-前端设计稿.html.
Design: neutral black/white/gray, document-first reading, recursive evidence dialogs.
Source: app.jsx + data.js + styles.css. Rebuild with npm ci && npm run build. -->
<!-- Third-party notices: ${notices.replace(/-->/g, "-- >")} -->
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>omem · 有来处的记忆</title><style>${css}</style></head><body><div id="root"></div><script>window.OMEM_TWEAKS=/*EDITMODE-BEGIN*/{"fontSize":16,"density":"舒展"}/*EDITMODE-END*/;</script><script>${script}</script></body></html>`,
);
console.log("Built self-contained docs/prototype/index.html");
