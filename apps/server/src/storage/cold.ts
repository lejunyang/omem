import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const contentHash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function coldDirectory(dataDir: string): string | null {
  const file = join(dataDir, "cold-store.json");
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || typeof value.directory !== "string")
    throw Error("冷存储配置无效");
  return resolve(dataDir, value.directory);
}
export function readAsset(dataDir: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const hot = join(dataDir, "assets", id);
  if (existsSync(hot)) return readFileSync(hot);
  const cold = coldDirectory(dataDir);
  if (!cold) return null;
  const file = join(cold, "assets", id);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  if (contentHash(bytes) !== id)
    throw Error("冷存储原件校验失败，请检查磁盘或恢复备份");
  return bytes;
}
/** Copy, check and rename before removing a hot copy. Interrupted copies cannot become heads. */
export function putCold(
  directory: string,
  group: "assets" | "messages",
  id: string,
  bytes: Buffer,
) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("冷存储标识无效");
  const parent = join(directory, group);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const file = join(parent, id);
  if (existsSync(file)) {
    if (!readFileSync(file).equals(bytes))
      throw Error("冷存储内容与原件不一致，保留热数据");
    return;
  }
  const temp = file + "." + randomUUID();
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    if (!readFileSync(temp).equals(bytes)) throw Error("冷存储写入校验失败");
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    if (process.platform !== "win32") {
      const dir = openSync(parent, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
export function archiveMessage(directory: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)),
    id = contentHash(bytes);
  putCold(directory, "messages", id, gzipSync(bytes));
  return id;
}
export function hydrateMessage<T extends Record<string, any>>(
  dataDir: string,
  row: T,
): T {
  if (!row.cold_payload) return row;
  const directory = coldDirectory(dataDir);
  if (!directory || !/^[a-f0-9]{64}$/.test(row.cold_payload))
    throw Error("此消息的冷存储不可用，请挂载归档磁盘");
  const file = join(directory, "messages", row.cold_payload);
  if (!existsSync(file)) throw Error("此消息的冷存储不可用，请挂载归档磁盘");
  const bytes = gunzipSync(readFileSync(file));
  if (contentHash(bytes) !== row.cold_payload)
    throw Error("冷存储消息校验失败");
  return { ...row, ...JSON.parse(bytes.toString()) };
}
