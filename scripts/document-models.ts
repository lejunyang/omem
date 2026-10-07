import { execFileSync } from "node:child_process";
import { mkdir, symlink, readlink, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(".osdk/runtime/docling/models");
await mkdir(root, { recursive: true });
for (const [alias, folder] of [["docling-layout", "docling-project--docling-layout-heron"], ["docling-tables", "docling-project--docling-models"]]) {
  execFileSync("osdk", ["model", "sync", alias!], { stdio: "inherit" });
  execFileSync("osdk", ["model", "verify", alias!, "--json"], { stdio: "pipe" });
  const { model } = JSON.parse(execFileSync("osdk", ["model", "show", alias!, "--json"], { encoding: "utf8" }));
  const target = join(root, folder!);
  try { if (await readlink(target) === model.snapshot_path) continue; await unlink(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await symlink(model.snapshot_path, target, process.platform === "win32" ? "junction" : "dir");
}
console.log("PDF 解析模型已准备；导入时仅使用已安装模型。");
