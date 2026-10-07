import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

// Source and compiled entrypoints share one package root. Never locate executable
// assets through the caller's cwd (which may be an unrelated repository).
function locatePackage() {
  for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, "utf8")).name === "omem"
    )
      return dir;
    if (dirname(dir) === dir)
      throw Error("omem 安装不完整：找不到 package.json");
  }
}
export const packageRoot = locatePackage();
export const developmentCheckout = existsSync(
  join(packageRoot, "apps/server/src/main.ts"),
);
export const assetPath = (...parts: string[]) => join(packageRoot, ...parts);
export const defaultDataDir = () =>
  resolve(
    process.env.OMEM_DATA_DIR ||
      (developmentCheckout
        ? join(packageRoot, ".omem")
        : join(homedir(), ".omem")),
  );
export const configPath = () =>
  resolve(
    process.env.OMEM_CONFIG ||
      (developmentCheckout
        ? join(packageRoot, "omem.local.json")
        : join(defaultDataDir(), "config.json")),
  );
export const modelWorkspace = () =>
  developmentCheckout ? packageRoot : join(defaultDataDir(), "optional");
export const optionalRuntime = (name: string) =>
  join(modelWorkspace(), ".osdk/runtime", name);

export const pythonInVenv = (
  runtime: string,
  platform: NodeJS.Platform = process.platform,
) =>
  join(
    runtime,
    "venv",
    ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
  );
