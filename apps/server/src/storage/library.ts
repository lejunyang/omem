import {
  existsSync,
  readdirSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  copyFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { contentHash, coldDirectory, putCold, archiveMessage } from "./cold.js";
import { activeReaders, acquireLibraryMaintenance } from "./library-lock.js";
import { migrateDatabase } from "./migrations.js";

function inside(parent: string, child: string) {
  const r = relative(resolve(parent), resolve(child));
  return !r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r);
}
function fileHash(path: string) {
  const fd = openSync(path, "r"),
    hash = createHash("sha256"),
    chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const size = readSync(fd, chunk);
      if (!size) break;
      hash.update(chunk.subarray(0, size));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function files(
  directory: string,
  rejectLinks = true,
): { path: string; bytes: number; modified: number }[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name),
      st = lstatSync(path);
    if (st.isSymbolicLink()) {
      if (rejectLinks) throw Error(`请先处理数据目录中的符号链接：${path}`);
      return [{ path, bytes: st.size, modified: st.mtimeMs }];
    }
    return st.isDirectory()
      ? files(path, rejectLinks)
      : st.isFile()
        ? [{ path, bytes: st.size, modified: st.mtimeMs }]
        : [];
  });
}
const bytes = (directory: string) =>
  files(directory, false).reduce((n, f) => n + f.bytes, 0);
const existsTable = (db: DatabaseSync, name: string) =>
  !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
function database(directory: string) {
  const path = join(directory, "omem.sqlite");
  if (!existsSync(path))
    throw Error("此目录还没有个人库数据库；先启动一次服务或检查 --data-dir");
  return new DatabaseSync(path);
}
export function libraryInfo(directory: string, config: string) {
  directory = resolve(directory);
  const cold = coldDirectory(directory);
  const groups = [
    "assets",
    "development",
    "agent-workspace",
    "assistant-agents",
    "knowledge-agents",
    "service",
    "optional",
    "imports",
    "secrets",
  ];
  const dbPath = join(directory, "omem.sqlite");
  let counts: Record<string, number> = {},
    databaseBytes = 0,
    reusableBytes = 0;
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const size = Number(db.prepare("PRAGMA page_size").get()!.page_size);
      databaseBytes =
        Number(db.prepare("PRAGMA page_count").get()!.page_count) * size;
      reusableBytes =
        Number(db.prepare("PRAGMA freelist_count").get()!.freelist_count) *
        size;
      for (const table of [
        "sources",
        "revisions",
        "memories",
        "tasks",
        "jobs",
        "personal_lark_messages",
        "retrieval_units",
      ])
        if (existsTable(db, table))
          counts[table] = Number(
            db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,
          );
    } finally {
      db.close();
    }
  }
  return {
    directory,
    config,
    readers: activeReaders(directory).map((r) => r.pid),
    database: { bytes: databaseBytes, reusableBytes, counts },
    directories: groups.map((name) => ({
      name,
      bytes: bytes(join(directory, name)),
    })),
    cold: cold
      ? { directory: cold, available: existsSync(cold), bytes: bytes(cold) }
      : null,
    note: "原文、历史、记忆与事项保留在主库；归档消息载荷和附件按固定标识从冷存储读取。可用空页会被 SQLite 复用，compact 才收缩磁盘文件。",
  };
}
type Manifest = {
  version: 1;
  createdAt: string;
  files: { path: string; bytes: number; sha256: string }[];
  excluded: string[];
};
function copyDirectory(source: string, target: string) {
  for (const f of files(source)) {
    const dest = join(target, relative(source, f.path));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(f.path, dest);
  }
}
/** Offline, portable backup: immutable data + config + encrypted secrets, never PM2 state. */
export function backupLibrary(
  directory: string,
  config: string,
  destination: string,
) {
  directory = resolve(directory);
  destination = resolve(destination);
  const cold = coldDirectory(directory);
  if (inside(directory, destination) || (cold && inside(cold, destination)))
    throw Error("备份目录必须位于个人库和冷存储之外");
  if (existsSync(destination)) throw Error("备份目标已存在，请指定新目录");
  const release = acquireLibraryMaintenance(directory),
    staging = destination + ".partial-" + randomUUID();
  try {
    const db = database(directory);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      db.prepare("VACUUM INTO ?").run(join(staging, "omem.sqlite"));
    } finally {
      db.close();
    }
    for (const name of ["assets", "secrets"])
      copyDirectory(join(directory, name), join(staging, name));
    if (cold) {
      if (!existsSync(cold))
        throw Error("请先挂载冷存储；不能创建缺少历史载荷的备份");
      copyDirectory(cold, join(staging, "cold"));
      writeFileSync(
        join(staging, "cold-store.json"),
        JSON.stringify({ version: 1, directory: "cold" }),
        { mode: 0o600 },
      );
    }
    if (existsSync(config)) copyFileSync(config, join(staging, "config.json"));
    const manifest: Manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      files: files(staging).map((f) => ({
        path: relative(staging, f.path),
        bytes: f.bytes,
        sha256: fileHash(f.path),
      })),
      excluded: [
        "可重新安装的 optional 环境与模型",
        "Agent 临时工作区和文件日志（数据库中的正式输出保留）",
        "PM2 进程状态",
        "环境变量密钥及第三方 CLI 登录",
      ],
    };
    writeFileSync(
      join(staging, "backup.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    renameSync(staging, destination);
    return { destination, ...manifest };
  } finally {
    release();
    rmSync(staging, { recursive: true, force: true });
  }
}
export function restoreLibrary(source: string, destination: string) {
  source = resolve(source);
  destination = resolve(destination);
  if (existsSync(destination))
    throw Error("恢复目标必须是不存在的新目录，现有库不会被覆盖");
  if (inside(source, destination)) throw Error("恢复目标不能位于备份内");
  const manifest = JSON.parse(
    readFileSync(join(source, "backup.json"), "utf8"),
  ) as Manifest;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.some((f) => f.path === "omem.sqlite")
  )
    throw Error("无效的 omem 备份");
  // Validate paths, regular files and all checksums before writing the destination.
  const regular = new Set(files(source).map((f) => f.path));
  for (const f of manifest.files) {
    const path = resolve(source, f.path);
    if (
      isAbsolute(f.path) ||
      relative(source, path) !== f.path ||
      !inside(source, path) ||
      !regular.has(path) ||
      fileHash(path) !== f.sha256
    )
      throw Error(`备份校验失败：${f.path}`);
  }
  const db = new DatabaseSync(join(source, "omem.sqlite"), { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok")
      throw Error("备份数据库损坏");
  } finally {
    db.close();
  }
  const staging = destination + ".partial-" + randomUUID();
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const f of manifest.files) {
      const path = join(staging, f.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, f.path), path);
    }
    renameSync(staging, destination);
    return {
      directory: destination,
      config: join(destination, "config.json"),
      restoredFiles: manifest.files.length,
      next: "用新目录启动服务；机器人解密密钥和第三方 CLI 登录需单独配置，可选模型重新准备。",
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
export function migrateLibrary(
  directory: string,
  config: string,
  destination: string,
) {
  const temporary = resolve(destination) + ".backup-" + randomUUID();
  try {
    backupLibrary(directory, config, temporary);
    return {
      ...restoreLibrary(temporary, destination),
      originalPreserved: true,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
export function archiveLibrary(
  directory: string,
  input: {
    before: string;
    destination?: string;
    apply?: boolean;
    compact?: boolean;
  },
) {
  directory = resolve(directory);
  const cutoff = Date.parse(input.before);
  if (!Number.isFinite(cutoff) || cutoff > Date.now())
    throw Error("before 必须是过去的日期");
  const configured = coldDirectory(directory);
  const destination = input.destination
    ? resolve(input.destination)
    : configured;
  if (!destination) throw Error("首次归档请用 --to 指定独立冷存储目录");
  if (
    destination === directory ||
    inside(destination, directory) ||
    (inside(directory, destination) && destination !== join(directory, "cold"))
  )
    throw Error("冷存储请放在个人库之外，或使用个人库中的 cold 子目录");
  if (configured && configured !== destination)
    throw Error("已有冷存储不能直接改址，请连同个人库迁移或备份恢复");
  const release = input.apply ? acquireLibraryMaintenance(directory) : () => {};
  let db: DatabaseSync | undefined;
  try {
    db = database(directory);
    if (input.apply) migrateDatabase(db);
    const hasCold = db
      .prepare("PRAGMA table_info(personal_lark_messages)")
      .all()
      .some((r) => r.name === "cold_payload");
    const messageWhere = `FROM personal_lark_messages WHERE cold_payload IS NULL AND updated_at<? AND state IN ('ready','review')
      AND id NOT IN (SELECT id FROM personal_lark_messages ORDER BY observed_at DESC LIMIT 200)`;
    const messages = hasCold
      ? Number(
          db
            .prepare(`SELECT count(*) n ${messageWhere}`)
            .get(new Date(cutoff).toISOString())!.n,
        )
      : 0;
    const assets = files(join(directory, "assets")).filter(
      (f) =>
        f.modified < cutoff &&
        /^[a-f0-9]{64}$/.test(relative(join(directory, "assets"), f.path)),
    );
    const result = {
      applied: !!input.apply,
      before: new Date(cutoff).toISOString(),
      destination,
      messages,
      assets: assets.length,
      assetBytes: assets.reduce((n, f) => n + f.bytes, 0),
      note: "保留消息标识、去重摘要、游标、原文修订及其引用。冷存储不是删除；读取旧附件和消息时需要该目录可用。",
    };
    if (!input.apply) return result;
    if (
      !configured &&
      existsSync(destination) &&
      readdirSync(destination).length
    )
      throw Error("首次冷存储目标必须是空目录");
    if (configured && !existsSync(destination))
      throw Error("冷存储未挂载，停止归档");
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "cold-store.json"),
      JSON.stringify({ version: 1, directory: destination }),
      { mode: 0o600 },
    );
    for (const asset of assets) {
      const id = relative(join(directory, "assets"), asset.path),
        value = readFileSync(asset.path);
      if (contentHash(value) !== id) throw Error("原件校验失败，停止归档");
      putCold(destination, "assets", id, value);
      rmSync(asset.path);
    }
    for (const row of db
      .prepare(`SELECT id,raw,decision,resources ${messageWhere}`)
      .iterate(new Date(cutoff).toISOString())) {
      const id = archiveMessage(destination, {
        raw: row.raw,
        decision: row.decision,
        resources: row.resources,
      });
      db.prepare(
        "UPDATE personal_lark_messages SET cold_payload=?,raw='{}',decision=NULL,resources='[]' WHERE id=? AND cold_payload IS NULL",
      ).run(id, String(row.id));
    }
    if (input.compact) db.exec("VACUUM");
    return result;
  } finally {
    db?.close();
    release();
  }
}
/** Finished native runs are identifiable by result.json and teardown of the snapshot. */
export function pruneLibrary(directory: string, before: string, apply = false) {
  const cutoff = Date.parse(before);
  if (!Number.isFinite(cutoff) || cutoff > Date.now())
    throw Error("before 必须是过去的日期");
  const release = apply ? acquireLibraryMaintenance(directory) : () => {};
  try {
    const candidates: { path: string; bytes: number }[] = [];
    for (const root of [
      "agent-workspace",
      "assistant-agents",
      "knowledge-agents",
    ]) {
      for (const f of files(join(directory, root))) {
        if (!f.path.endsWith(sep + "result.json") || f.modified >= cutoff)
          continue;
        const run = dirname(f.path);
        if (
          existsSync(join(run, "originals")) ||
          existsSync(join(run, "snapshot.sqlite"))
        )
          continue;
        if (!existsSync(join(run, "catalog.json"))) continue;
        if (files(run).some((item) => item.modified >= cutoff)) continue;
        candidates.push({ path: run, bytes: bytes(run) });
      }
    }
    if (apply) for (const c of candidates) rmSync(c.path, { recursive: true });
    return {
      applied: apply,
      candidates,
      bytes: candidates.reduce((n, c) => n + c.bytes, 0),
      kept: "正式数据库、原件、冷存储、凭据、未结束任务和 PM2 日志均保留。仅清理可重建的已完成 Agent 工作目录；先预览。",
    };
  } finally {
    release();
  }
}
