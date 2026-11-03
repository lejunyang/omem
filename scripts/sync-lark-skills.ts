/**
 * Copy the DocxXML / Markdown syntax references that ship inside lark-cli (`lark-cli skills read`)
 * into the built-in skill skills/library/lark-docs/references/, so the agent writes the format the
 * installed lark-cli expects. Run after upgrading @larksuite/cli:
 *
 *   node scripts/sync-lark-skills.ts
 *
 * The files are lark-cli's own (MIT, github.com/larksuite/cli); only links between them are
 * rewritten to the local names and shell-only sections dropped. SKILL.md is ours and not touched.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runJs = join(root, "node_modules", "@larksuite", "cli", "scripts", "run.js");
const FILES: Record<string, string> = {
  "lark-doc/references/lark-doc-xml.md": "xml.md",
  "lark-doc/references/lark-doc-xml-extended-blocks.md": "xml-extended-blocks.md",
  "lark-doc/references/lark-doc-md.md": "markdown.md",
};

const cli = (...args: string[]) => execFileSync(process.execPath, [runJs, ...args], { encoding: "utf8" });
const version = cli("--version").trim().replace(/^lark-cli version\s*/, "");
const out = join(root, "skills", "library", "lark-docs", "references");

for (const [from, to] of Object.entries(FILES)) {
  let text = cli("skills", "read", from).replace(/\n> Tip: read this skill's own files[^\n]*\n?$/, "\n");
  for (const [f, t] of Object.entries(FILES)) text = text.replaceAll(`(${f.split("/").pop()})`, `(${t})`);
  // Links to files not copied here (whiteboard, other lark-cli skills) stay as names only.
  text = text.replace(/\[(`[^`]+`)\]\((?!xml\.md|xml-extended-blocks\.md|markdown\.md)[^)]+\)/g, "$1");
  // Shell quoting is lark-cli's business here: omem passes content through a file.
  text = text.replace(/\n## Shell[^\n]*\n[^]*?(?=\n## |$)/g, "\n");
  writeFileSync(join(out, to), `<!-- 来自 lark-cli ${version} 的 ${from}（MIT），由 scripts/sync-lark-skills.ts 同步，不要手改 -->\n\n${text.trimEnd()}\n`);
  console.log(`${to} ← ${from}`);
}
