import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { sandboxData } from "./sandbox-data.ts";
import { omemInstallDir } from "./sandbox.ts";

export function openDataView(view: ReturnType<typeof sandboxData>, paths: string[], links?: {path: string; target: string}[]) {
  const dir = mkdtempSync("/tmp/omem-data-view-");
  const mounts = paths.filter(p => p.startsWith(view.data + "/")).map(p =>
    [p.slice(view.data.length), statSync(p, { throwIfNoEntry: false })?.isFile() ? "file" : "dir"]);
  const result = spawnSync("/usr/bin/python3", ["-I", join(omemInstallDir(), "scripts/sandbox-view.py"),
    "-o", "ro,nosuid,nodev,noexec,auto_unmount", dir], {
    input: JSON.stringify({ ...view, mounts, links: (links ?? []).filter(l => l.path.startsWith(view.data + "/")).map(l => [l.path.slice(view.data.length), l.target]) }), env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10000,
  });
  if (result.status !== 0) {
    rmdirSync(dir);
    throw new Error(result.error?.message ?? result.stderr.trim());
  }
  return { dir, close: () => {
    const r = spawnSync("/bin/fusermount", ["-uz", dir]);
    if (r.status === 0) rmdirSync(dir);
  } };
}
