import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import { assetPath, optionalRuntime } from "../paths.js";
const exec = promisify(execFile);
export function saveImportAssetSync(dataDir: string, bytes: Buffer) {
  const id = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(dataDir, "assets"), { recursive: true, mode: 0o700 });
  try { writeFileSync(join(dataDir, "assets", id), bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return id;
}
export async function saveImportAsset(dataDir: string, bytes: Buffer) {
  const id = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(dataDir, "assets"), { recursive: true, mode: 0o700 });
  try { await writeFile(join(dataDir, "assets", id), bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return id;
}
export async function documentInput(bytes: Buffer, name: string, dataDir: string, externalId: string): Promise<CaptureInput> {
  const extension = extname(name).toLowerCase();
  if (![".pdf", ".docx"].includes(extension)) throw Error("支持 PDF、DOCX 文件");
  if (!bytes.length || bytes.length > 20_000_000) throw Error("文件不能超过 20 MB");
  const runtime = optionalRuntime("docling");
  const python = join(runtime, "venv/bin/python");
  if (!existsSync(python)) throw Error("文档解析器未准备，请先运行 omem setup documents（开发环境：osdk run documents:prepare）");
  const workspace = join(dataDir, "imports");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(join(workspace, "convert-"));
  try {
    const path = join(tmp, "input" + extension);
    await writeFile(path, bytes, { mode: 0o600 });
    const artifacts = join(runtime, "models");
    const { stdout } = await exec(python, [assetPath("scripts/document-parser/convert.py"), path, existsSync(artifacts) ? artifacts : ""], { timeout: 180_000, maxBuffer: 50_000_000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.markdown !== "string" || !parsed.markdown.trim()) throw Error("解析结果没有正文");
    if (parsed.markdown.length > 200_000) throw Error("解析后的正文超过 20 万字，请按章节拆分后导入");
    for (const block of parsed.blocks) {
      if (block.image) {
        block.imageAssetId = await saveImportAsset(dataDir, Buffer.from(block.image, "base64"));
        delete block.image;
      }
    }
    const originalAssetId = await saveImportAsset(dataDir, bytes);
    const structureAssetId = await saveImportAsset(dataDir, Buffer.from(JSON.stringify(parsed)));
    return { source: "file", externalId, title: basename(name), upstreamVersion: originalAssetId,
      parts: [{ type: "text", text: parsed.markdown }],
      context: { document: { parser: "docling", parserVersion: parsed.parserVersion, originalAssetId, structureAssetId,
        originalName: basename(name), mimeType: extension === ".pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pageCount: parsed.pageCount, warnings: parsed.warnings } } };
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    const message = stderr.split("\n").filter(Boolean).at(-1);
    throw Error(message || (error instanceof Error ? error.message : String(error)));
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
