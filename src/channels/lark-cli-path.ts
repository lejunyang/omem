import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The package's JS launcher delegates to the native binary next to its scripts directory. */
export function larkCliInstallation() {
  let script: string;
  try {
    script = createRequire(import.meta.url).resolve("@larksuite/cli/scripts/run.js");
  } catch {
    throw new Error("未安装 @larksuite/cli；请重新安装 omem 依赖");
  }
  const root = dirname(dirname(script));
  return { script, root, binary: join(root, "bin", process.platform === "win32" ? "lark-cli.exe" : "lark-cli") };
}
