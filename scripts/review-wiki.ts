import { taskFlag, taskTargets } from "./task-args.js";
import { restoreReviewKnowledge, writeReviewKnowledgeIndex } from "../apps/server/src/review/knowledge.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createReviewStore } from "../apps/server/src/review/store.js";
import { runReviewSync } from "../apps/server/src/review/sync.js";
import { runCodeSync } from "../apps/server/src/code/sync.js";
import { currentSnapshotId, listFiles, symbolsOfSnapshot } from "../apps/server/src/code/store.js";
import { generateCodeUnderstanding, listUnderstandings, understandingDetail } from "../apps/server/src/code/understanding-store.js";
import { buildUnderstandingModelPort } from "../apps/server/src/code/understanding-model.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { exportGeneratedUnderstanding, GENERATED_DIR } from "../apps/server/src/code/artifacts.js";
import { moduleForPath } from "../packages/contracts/src/code-modules.js";

const root = process.env.REVIEW_REPO_ROOT ?? process.cwd();
const generate = taskFlag("generate");
const targets = taskTargets();
if (generate && !targets.length) throw new Error("Specify --target=<repo-relative file or directory>; generation is explicitly scoped");
const store = createReviewStore(root);
const stage = join(root, ".repo-review/runtime/wiki-build");
mkdirSync(stage, { recursive: true });
try {
  console.log("capture", await runReviewSync(store, root));
  console.log("projection", await runCodeSync(store, root));
  const sharedKnowledge = restoreReviewKnowledge(store, root).repository;
  if (!generate && sharedKnowledge.list().length) { writeReviewKnowledgeIndex(root, sharedKnowledge.list()); console.log("Shared knowledge index rebuilt"); }
  if (generate) {
    const config = loadReviewCodeModelConfig();
    const model = buildUnderstandingModelPort({ ...config, workspaceDir: join(root, ".repo-review/runtime/agent-workspace") });
    if (!model) throw new Error("Set REVIEW_CODE_MODEL_CONFIG before requesting generation");
    for (const targetId of targets) {
      console.log("generate", targetId, config.model);
      const result = await generateCodeUnderstanding(store, root, model, { targetId, timeoutMs: config.idleTimeoutMs ?? config.timeoutMs, maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens, contextReserveTokens: config.contextReserveTokens });
      console.log("result", result);
      if (!result.ok) throw new Error(`Generation failed for ${targetId}: ${result.errors.join(", ")}`);
      const file = exportGeneratedUnderstanding(store, root, result.understandingId, stage);
      mkdirSync(join(root, GENERATED_DIR), { recursive: true });
      copyFileSync(join(stage, file), join(root, GENERATED_DIR, file));
    }
  }
  if (!generate && sharedKnowledge.list().length) process.exitCode = 0;
  else {
  const snapshotId = currentSnapshotId(store)!;
  const files = listFiles(store).filter(f => !f.removed);
  const symbols = symbolsOfSnapshot(store, snapshotId);
  const symbolById = new Map(symbols.map(s => [s.symbolId, s]));
  const fileById = new Map(files.map(f => [f.fileId, f]));
  const modules = new Map<string, typeof files>();
  for (const file of files) { const name = moduleForPath(file.path); const group = modules.get(name) ?? []; group.push(file); modules.set(name, group); }
  const lines = ["# omem 仓库 Wiki", "", "由固定 Capture 版本派生；结构信息来自解析器，模型说明是可追溯的派生材料。源码与设计文档仍是证据来源。", "", "运行 `osdk run review:build` 更新本文与索引；启动 `osdk run dev:review` 可自动重建本地索引并浏览引用。", "", "## 模块目录", "", "| 模块 | 文件数 |", "| --- | ---: |"];
  for (const [name, group] of [...modules].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| [${name}](#${name}) | ${group.length} |`);
  const current = listUnderstandings(store);
  for (const [name, group] of [...modules].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("", `## ${name}`, "");
    const notes = current.filter(row => group.some(f => f.path === row.target_id || f.path.startsWith(String(row.target_id).replace(/\/$/, "") + "/")));
    // One latest result per target; model output precedes curated background.
    const shown = new Set<string>();
    notes.sort((a, b) => Number(a.seed) - Number(b.seed) || String(b.generated_at).localeCompare(String(a.generated_at)));
    for (const note of notes) {
      const key = String(note.target_id); if (shown.has(key)) continue; shown.add(key);
      const output = understandingDetail(store, String(note.understanding_id))!.output as import("../packages/agent-runtime/src/code-understanding.js").CodeUnderstandingOutput;
      const readable = (text: string) => text.replace(/sym_[a-f0-9]+/g, id => symbolById.get(id)?.qualifiedName ?? "未定位符号");
      lines.push(`### ${key}`, "", note.seed ? "来源：人工整理；未执行模型语义复核。" : `来源：${note.model} · ${note.generated_at}；通过结构与引用校验，未经独立语义复核。`, "");
      for (const text of output.module_responsibilities) lines.push(`- ${readable(text)}`);
      lines.push("", "边界：", "", ...output.boundaries.map(text => `- ${readable(text)}`), "", "关键流程：", "", ...output.key_flows.map(flow => `- **${flow.name}**：${readable(flow.description)}`), "", "限制与未决：", "", ...[...output.risks_and_limits, ...output.unknowns].map(text => `- ${readable(text)}`), "", "代码引用：", "");
      for (const id of output.referenced_node_ids) { const sym = symbolById.get(id); const file = sym && fileById.get(sym.fileId); if (sym && file) lines.push(`- [${file.path} · ${sym.qualifiedName}](../${file.path}#L${sym.rangeStart?.line ?? 1})`); }
    }
    if (!notes.length) lines.push("暂无经过来源校验的模块说明，以下为确定性文件目录。", "");
    for (const file of group) lines.push(`- [${file.path}](../${file.path})`);
  }
  const markdown = lines.join("\n") + "\n";
  writeFileSync(join(stage, "wiki.md"), markdown);
  const destination = join(root, ".repo-review/wiki.md");
  if (!existsSync(destination) || readFileSync(destination, "utf8") !== markdown) copyFileSync(join(stage, "wiki.md"), destination);
  console.log(`Wiki written: ${destination}; ${files.length} files, ${modules.size} modules`);
  }
} finally { store.close(); }
