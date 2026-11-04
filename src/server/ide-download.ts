import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The VS Code server builds web VS Code runs (ide-web.ts), downloaded by omem itself instead of by
 * `code serve-web`: serve-web keeps its download in memory and shows nothing while it takes minutes
 * (the Windows build is about 200 MB), so the waiting page could not say how far it is. Builds go
 * where serve-web keeps its own (`<cli-data-dir>/serve-web/<commit>/`) and it runs them with
 * `--commit-id`.
 */
export const DEFAULT_UPDATE_URL = "https://update.code.visualstudio.com";

export type ServerBuild = { commit: string; version: string | null; url: string; sha256: string | null };

export type ServerDownload = {
  /** first: no build yet, the page waits for it; update: a newer one while the cached one runs. */
  purpose: "first" | "update";
  state: "checking" | "downloading" | "extracting" | "ready" | "error";
  commit?: string;
  version?: string | null;
  received: number;
  total: number | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

/** The update service's name for this machine's web server build, null where VS Code has none. */
export function serverPlatform(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === "win32") return arch === "arm64" ? "server-win32-arm64-web" : arch === "x64" ? "server-win32-x64-web" : null;
  if (platform === "darwin") return arch === "arm64" ? "server-darwin-arm64-web" : arch === "x64" ? "server-darwin-web" : null;
  if (platform === "linux") return arch === "arm64" ? "server-linux-arm64-web" : arch === "arm" ? "server-linux-armhf-web" : arch === "x64" ? "server-linux-x64-web" : null;
  return null;
}

/** The newest stable build for this machine, as the update service announces it. */
export async function latestServer(updateUrl: string, timeoutMs = 20_000): Promise<ServerBuild> {
  const platform = serverPlatform();
  if (!platform) throw new Error(`VS Code 没有 ${process.platform}-${process.arch} 的网页版服务端`);
  const res = await fetch(`${updateUrl.replace(/\/$/, "")}/api/update/${platform}/stable/latest`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`查询最新的 VS Code 服务端失败（HTTP ${res.status}）`);
  const v = (await res.json()) as { version?: string; productVersion?: string; name?: string; url?: string; sha256hash?: string };
  if (!v.version || !/^[0-9a-f]{40}$/.test(v.version) || !v.url) throw new Error("更新服务返回的版本信息不完整");
  return { commit: v.version, version: v.productVersion ?? v.name ?? null, url: v.url, sha256: v.sha256hash ?? null };
}

/** The files a usable build has; an interrupted copy lacks some and is never run. */
export function serverFiles(platform: string = process.platform) {
  return ["product.json", platform === "win32" ? "node.exe" : "node", "out/server-main.js", platform === "win32" ? "bin/code-server.cmd" : "bin/code-server"];
}
export const completeServer = (dir: string) => serverFiles().every((file) => existsSync(join(dir, file)));

/**
 * Download `build` into `<root>/<commit>`, reporting bytes as they come; checked against the
 * announced SHA-256, unpacked beside it and moved in only when complete.
 */
export async function downloadServer(root: string, build: ServerBuild, progress: (received: number, total: number | null, state: "downloading" | "extracting") => void) {
  mkdirSync(root, { recursive: true });
  const final = join(root, build.commit);
  if (completeServer(final)) return final;
  const zip = /\.zip(\?|$)/.test(build.url);
  const part = join(root, `.omem-${build.commit}${zip ? ".zip" : ".tar.gz"}`);
  const staging = join(root, `.omem-${build.commit}.unpack`);
  rmSync(staging, { recursive: true, force: true });
  try {
    const res = await fetch(build.url, { signal: AbortSignal.timeout(60 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`下载 VS Code 服务端失败（HTTP ${res.status}）`);
    const total = Number(res.headers.get("content-length")) || null;
    const hash = createHash("sha256");
    const out = createWriteStream(part);
    let received = 0;
    progress(0, total, "downloading");
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((ok) => out.once("drain", () => ok()));
        progress(received, total, "downloading");
      }
    } finally {
      await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())));
    }
    progress(received, total, "downloading");
    if (total && received !== total) throw new Error(`下载不完整（${received} / ${total} 字节）`);
    if (build.sha256 && hash.digest("hex") !== build.sha256.toLowerCase()) throw new Error("下载的 VS Code 服务端校验不一致");
    progress(received, total, "extracting");
    mkdirSync(staging, { recursive: true });
    // bsdtar (Windows 10+, macOS) reads zip too; the Linux builds are tar.gz.
    await untar(root, basename(part), basename(staging));
    // The archive holds one folder (vscode-server-<platform>-web/).
    const entries = readdirSync(staging, { withFileTypes: true });
    const inner = entries.length === 1 && entries[0].isDirectory() ? join(staging, entries[0].name) : staging;
    if (!completeServer(inner)) throw new Error("下载的 VS Code 服务端缺文件");
    rmSync(final, { recursive: true, force: true });
    renameSync(inner, final);
    return final;
  } finally {
    rmSync(part, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Unpack with paths relative to `cwd` (GNU tar takes `C:` for a remote host). On Windows the
 * system's bsdtar, which reads the zip builds: Git's GNU tar earlier on PATH cannot.
 */
function untar(cwd: string, archive: string, into: string) {
  const system = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : null;
  return new Promise<void>((ok, fail) => {
    const child = spawn(system && existsSync(system) ? system : "tar", ["-xf", archive, "-C", into], { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`解压 VS Code 服务端失败：${err.trim() || `tar 退出码 ${code}`}`))));
  });
}

/** Builds other than the ones to keep, and what an interrupted omem download left. */
export function pruneServers(root: string, keep: string[]) {
  if (!existsSync(root)) return;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const name = d.name;
    const drop = name.startsWith(".omem-") || (d.isDirectory() && /^[0-9a-f]{40}$/.test(name) && !keep.includes(name));
    // A build still running (an older serve-web's server on Windows) cannot go yet: next time.
    if (drop) try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* in use */ }
  }
}
