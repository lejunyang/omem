import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { omemInstallDir, sandboxSupport } from "./sandbox.ts";

export type HomeStore = { root: string; identity: string; home: string };
export type HomeOverlay = { home: string; sources: string[]; upper: string; work: string };

export function homeStore(data: string, home: string, identity: string): HomeStore {
  // The upper and work directories must be outside the lower (also when data lives in HOME).
  if (data !== home && !data.startsWith(home + "/")) return { root: join(data, "sandbox-home"), identity, home };
  const base = join("/var/tmp", "omem-home-" + process.getuid?.());
  return { root: join(base, createHash("sha256").update(data).digest("hex")), identity, home };
}

function call<T>(root: string, action: string, input: object = {}): T {
  const r = spawnSync("/usr/bin/python3", ["-I", join(omemInstallDir(), "scripts/sandbox-home.py")], {
    input: JSON.stringify({ root, action, ...input }), encoding: "utf8", timeout: action === "probe" ? 8000 : undefined,
  });
  if (r.status !== 0) throw new Error(r.error?.message ?? (r.stderr.trim() || "身份层操作失败"));
  return JSON.parse(r.stdout) as T;
}

const support = new Map<string, { ok: boolean; reason?: string }>();
export function overlaySupport(store: HomeStore) {
  const box = sandboxSupport();
  if (!box.ok || !box.bwrap) return { ok: false, reason: box.reason ?? "缺少 bubblewrap" };
  const key = box.bwrap + ":" + store.root;
  const known = support.get(key);
  if (known) return known;
  let result;
  try {
    if (store.root.startsWith(store.home + "/")) throw new Error("身份层目录位于 HOME 内");
    call(store.root, "probe", { bwrap: box.bwrap });
    result = { ok: true };
  } catch (error) { result = { ok: false, reason: (error as Error).message }; }
  support.set(key, result);
  return result;
}

export function homeLayers(store: HomeStore) {
  return existsSync(store.root) ? call<{ identity: string; bytes: number }[]>(store.root, "list") : [];
}
export function clearHomeLayer(store: HomeStore) {
  if (existsSync(store.root)) call(store.root, "clear", { identity: store.identity });
}

export function openHomeLayer(store: HomeStore, hidden: string[], mounts: string[]) {
  const inside = (p: string) => p.startsWith(store.home + "/");
  const roots = [...new Set(hidden.filter(inside))].sort((a, b) => a.length - b.length);
  const masks = roots.filter(p => !roots.some(q => p.startsWith(q + "/"))).map(p =>
    [relative(store.home, p), !!statSync(p, { throwIfNoEntry: false })?.isDirectory() || mounts.some(q => q.startsWith(p + "/"))]);
  // Real directories in this highest lower layer prevent an old symlink from redirecting a grant.
  const parents = [...new Set(mounts.filter(inside).map(p => relative(store.home, dirname(p))).filter(Boolean))];
  const { run, base } = call<{ run: string; base?: string }>(store.root, "begin", { identity: store.identity, masks, parents });
  return { overlay: { home: store.home, sources: [realpathSync(store.home), ...(base ? [base] : []), join(run, "mask")],
    upper: join(run, "upper"), work: join(run, "work") }, close: () => call<boolean>(store.root, "finish", { identity: store.identity, run }) };
}
