import { mkdir, copyFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { assetPath, modelWorkspace, developmentCheckout } from "../paths.js";

export async function setupOptional(component: string) {
  if (
    !["documents", "document-models", "decisions", "embedding"].includes(
      component,
    )
  )
    throw Error("可选能力：documents、document-models、decisions、embedding");
  const cwd = modelWorkspace();
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  if (!developmentCheckout) {
    if (!existsSync(join(cwd, "osdk.toml")))
      await copyFile(assetPath("config/models.toml"), join(cwd, "osdk.toml"));
    for (const project of ["document-parser", "startlux"]) {
      await cp(assetPath("scripts", project), join(cwd, "scripts", project), {
        recursive: true,
      });
    }
  }
  async function run(command: string, args: string[]) {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error(`${command} 退出 ${code}`)),
      );
    });
  }
  if (component === "documents")
    await run(process.execPath, [
      assetPath("dist/scripts/document-prepare.js"),
    ]);
  else if (component === "document-models")
    await run(process.execPath, [assetPath("dist/scripts/document-models.js")]);
  else if (component === "decisions") {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw Error(
        "当前 StartLux 运行层使用 MLX，需要 Apple Silicon Mac；其他平台可直接使用 ACP Agent。",
      );
    await run(process.execPath, [
      assetPath("dist/scripts/startlux-prepare.js"),
    ]);
    for (const alias of ["decision-startlux2b", "decision-startlux4b"])
      await run("osdk", ["model", "sync", alias]);
    console.log('已准备 StartLux；配置 decisions.mode 为 "auto" 后重启服务。');
  } else {
    await run("osdk", ["model", "sync", "memory-zh"]);
    console.log(
      "已准备中文向量模型；配置 retrieval.enabled 为 true 后重启服务。",
    );
  }
}
