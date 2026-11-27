import { closeSync, existsSync, openSync, readlinkSync, realpathSync } from "node:fs";

export function withPinnedBinds<T>(args: string[], selected: ReadonlySet<string> | undefined, start: (args: string[], fds: number[]) => T, firstFd = 3): T {
  const argv = [...args];
  // Pin every bind source before startup. A directory renamed between approval and
  // mount must never turn a workspace mount into a grant on a different host path.
  const fds: number[] = [];
  try {
    for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
      const arg = argv[i];
      if (arg !== "--bind" && arg !== "--ro-bind" && arg !== "--ro-bind-try") continue;
      const source = argv[i + 1]!;
      if (selected && !selected.has(source)) continue;
      if (arg === "--ro-bind-try" && !existsSync(source)) { argv.splice(i--, 3); continue; }
      const fd = openSync(source, 0x200000); // Linux O_PATH, also works for a Unix socket.
      fds.push(fd);
      const expected = ["/bin", "/lib", "/lib64", "/sbin"].includes(source) ? realpathSync(source) : source;
      if (readlinkSync("/proc/self/fd/" + fd) !== expected) throw new Error("执行器挂载来源已改变");
      argv[i] = arg === "--bind" ? "--bind-fd" : "--ro-bind-fd";
      argv[i + 1] = String(firstFd + fds.length - 1);
      i += 2;
    }
    return start(argv, fds);
  } finally { for (const fd of fds) closeSync(fd); }
}
