import { spawnSync } from "node:child_process";
import { connect, createServer } from "node:net";

/** Helpers for the local processes omem runs behind a proxy (web VS Code, plugin services). */

export function freePort() {
  return new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail).listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

export const reachable = (p: number) =>
  new Promise<boolean>((ok) => {
    const s = connect(p, "127.0.0.1");
    s.once("connect", () => (s.destroy(), ok(true)));
    s.once("error", () => ok(false));
  });

/** A running process's command line ("" when it is gone or cannot be read). */
export function commandLine(pid: number) {
  const r = process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true })
    : spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

/** Stop a process and what it started (Windows: the whole tree; elsewhere: its process group, else itself). */
export function killPid(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
}
