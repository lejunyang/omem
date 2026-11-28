// Read a single stable regular file. A member can replace names in their HOME while
// a run starts, so a link must never authorize the service to read another file.
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync } from "node:fs";

export function sandboxNpmrc(path: string): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return Buffer.alloc(0); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || readlinkSync("/proc/self/fd/" + fd) !== path) return Buffer.alloc(0);
    if (stat.size > 1024 * 1024) throw new Error("沙箱的 npm 配置超过 1 MiB");
    const bytes = Buffer.alloc(stat.size);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const original = bytes.subarray(0, count);
    const text = original.toString("utf8");
    let continued = false;
    const clean = text.split(/(?<=\n)/).filter(line => {
      const key = line.split("=", 1)[0]!.trim().replace(/^[;#\s"']+|["']+$/g, "");
      const secret = /(?:^|:)(?:_?auth(?:token)?|_?password|username|token(?:helper)?|cert(?:file)?|key(?:file)?)(?:\[\])?$/i.test(key);
      const drop = continued || secret;
      continued = drop && /\\\s*$/.test(line);
      return !drop;
    }).join("").replace(/(https?:\/\/)[^\s/@]+@/gi, "$1");
    return clean === text ? original : Buffer.from(clean);
  } finally { closeSync(fd); }
}
