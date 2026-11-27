// Read the host installation once per launch. Wrappers and the local Git binary are
// read-only mounts; private credentials remain masked independently of these entry points.
import { accessSync, closeSync, constants, openSync, readSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { larkCliInstallation } from "../channels/lark-cli-path.ts";

function entryHeader(file: string) {
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(2048);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString();
  } finally { closeSync(fd); }
}

function pythonPackages(file: string, module: string) {
  const lib = join(dirname(dirname(file)), "lib");
  if (!existsSync(lib)) return [];
  return readdirSync(lib).filter(dir => /^python3(?:\.\d+)?$/.test(dir)).flatMap(dir =>
    ["site-packages", "dist-packages"].map(folder => join(lib, dir, folder, module))).filter(root =>
    existsSync(join(root, "__main__.py")));
}

export const sandboxGate = (dir?: string): dir is string => !!dir?.endsWith("/bin/sandbox/bin/guarded");

export function commandMounts(guarded: string | undefined, path: string | undefined) {
  if (!sandboxGate(guarded)) return [];
  const binds = new Map<string, string>([["/tmp/.omem-programs/node", process.execPath]]);
  const packages = new Set<string>();
  for (const name of readdirSync(guarded)) {
    const wrapper = join(guarded, name);
    if (name === "lark-cli") {
      const { root, binary, script } = larkCliInstallation();
      packages.add(root);
      binds.set(binary, wrapper);
      binds.set(script, wrapper);
    }
    for (const dir of (path ?? "").split(":").filter(isAbsolute)) {
      const link = join(dir, name);
      if (!existsSync(link)) continue;
      const target = realpathSync(link);
      if (target === realpathSync(wrapper) || !statSync(target).isFile()) continue;
      try { accessSync(target, constants.X_OK); } catch { continue; }
      if (name === "git" && !binds.has("/tmp/.omem-programs/git")) binds.set("/tmp/.omem-programs/git", target);
      const header = entryHeader(target);
      if (target.endsWith(".py") || /^#![^\n]*python/.test(header)) {
        const stub = join(guarded, "..", name + ".py");
        binds.set(target, stub);
        const entry = /\nfrom ([a-zA-Z_]\w*)(?:\.\w+)* import main\b/.exec(header);
        for (const root of pythonPackages(target, entry?.[1] ?? name.replaceAll("-", "_"))) {
          packages.add(root);
          binds.set(join(root, "__main__.py"), stub);
        }
      } else if (!header.startsWith("#!") && basename(target) !== name) {
        // A single executable may dispatch many PATH names (a tool manager or BusyBox).
        const key = createHash("sha256").update(target).digest("hex");
        binds.set("/tmp/.omem-programs/native/" + key, target);
        binds.set(target, join(guarded, "..", "dispatch.mjs"));
      } else binds.set(target, wrapper);
      if (!target.includes("/node_modules/")) continue;
      // Only hide the owning package if its manifest identifies this very entry point.
      for (let root = dirname(target); root.includes("/node_modules/"); root = dirname(root)) {
        const manifest = join(root, "package.json");
        if (!existsSync(manifest)) continue;
        if (statSync(manifest).size > 1024 * 1024) break;
        const info = JSON.parse(readFileSync(manifest, "utf8"));
        const entry = typeof info.bin === "string" ? info.bin : info.bin?.[name];
        if (typeof entry === "string" && existsSync(join(root, entry)) && realpathSync(join(root, entry)) === target) packages.add(root);
        break;
      }
    }
  }
  return [...packages].flatMap(root => ["--tmpfs", root]).concat(
    [...binds].flatMap(([dest, source]) => ["--ro-bind", source, dest]));
}
