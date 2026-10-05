import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function readPid(path: string) {
  try {
    return Number(JSON.parse(readFileSync(path, "utf8")).pid);
  } catch {
    throw Error(`无法确认目录锁状态：${path}`);
  }
}
export function activeReaders(directory: string) {
  const leases = join(directory, ".readers");
  if (!existsSync(leases)) return [];
  return readdirSync(leases).flatMap((name) => {
    const path = join(leases, name),
      pid = readPid(path);
    if (alive(pid)) return [{ pid, path }];
    rmSync(path);
    return [];
  });
}
/** Store instances advertise lifetime; maintenance is offline, including foreground dev. */
export function acquireLibraryReader(directory: string) {
  const maintenance = join(directory, ".maintenance");
  if (existsSync(maintenance)) {
    if (alive(readPid(maintenance)))
      throw Error("个人库正在备份或归档，请完成后再启动服务");
    rmSync(maintenance);
  }
  const parent = join(directory, ".readers");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  if (existsSync(maintenance)) {
    rmSync(path);
    throw Error("个人库正在维护，请稍后启动");
  }
  return () => rmSync(path, { force: true });
}
export function acquireLibraryMaintenance(directory: string) {
  const path = join(directory, ".maintenance");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    if (alive(readPid(path))) throw Error("另一个个人库维护命令正在运行");
    rmSync(path);
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    if (activeReaders(directory).length)
      throw Error("请先停止此个人库的服务及前台开发进程，再执行数据维护");
    return () => rmSync(path, { force: true });
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}
