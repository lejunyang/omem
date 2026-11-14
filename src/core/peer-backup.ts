import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "./app.ts";
import { saveConfig } from "./config.ts";
import { one, run } from "./db.ts";
import { notify } from "./notify.ts";
import { findPeer, peerJson } from "./peers.ts";
import { HttpError, json, now } from "./util.ts";

/**
 * Keeping a copy of another device's data here, by itself (`backups` in the settings): every twenty
 * minutes the schedule looks at each backup that is due — is the device there (straight or through
 * another device)? — and when it answers, pulls its data into the backup's directory, the same pull as
 * `omem peer pull <device> --to <dir>` (merged in: the database, the library, attachments it lacks,
 * repositories). A device that is away is simply looked for again next time, so a laptop that loses
 * its way to the device during the day catches up the evening it is back.
 *
 * The pull runs in a process of its own: merging a large database would hold this service's event
 * loop; its temporary files go under the backup directory (`.pull-tmp`). The directory is a data directory like any other: `omem --home <dir> serve --no-background`
 * opens it to look at.
 */
export const BACKUP_PARTS = ["library", "files", "repos", "runs"] as const;
export type Backup = App["config"]["backups"][number];
export type BackupState = {
  /** The last pull that finished well. */
  okAt?: string;
  summary?: string;
  ms?: number;
  /** The last look: when, and what came of it. */
  triedAt?: string;
  problem?: string;
  /** The device did not answer at the last look. */
  away?: boolean;
  /** When the owner was last told it is not getting through. */
  toldAt?: string;
  /** A backup that has not got through yet: since when it has been trying. */
  failingSince?: string;
};

const key = (peer: string) => `peer_backup:${peer}`;
const stateOf = (app: App, peer: string): BackupState => json<BackupState>(one<{ value: string }>(app.db, "select value from kv where key = ?", key(peer))?.value, {});
const save = (app: App, peer: string, s: BackupState) => run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", key(peer), JSON.stringify(s));

const running = new Set<string>();

/** Every backup with how it stands. */
export function listBackups(app: App) {
  return app.config.backups.map((b) => ({ ...b, ...stateOf(app, b.peer), running: running.has(b.peer), paired: !!findPeer(app, b.peer) }));
}

/** Add or change the backup of a device. */
export function setBackup(app: App, b: { peer: string; to: string; everyHours?: number; parts?: string[] }) {
  if (!findPeer(app, b.peer)) throw new HttpError(404, `没有名为 ${b.peer} 的设备：先 omem peer add 配对`);
  const to = resolve(b.to);
  if (to === resolve(app.home)) throw new HttpError(400, "备份目录不能是这台 omem 自己的数据目录：换一个目录，或用 omem peer pull 合并进来");
  const parts = (b.parts ?? ["library", "files", "repos"]).filter((p): p is (typeof BACKUP_PARTS)[number] => (BACKUP_PARTS as readonly string[]).includes(p));
  const entry: Backup = { peer: b.peer, to, everyHours: Math.min(720, Math.max(1, Math.round(b.everyHours ?? 12))), parts };
  const next = structuredClone(app.config);
  next.backups = [...next.backups.filter((x) => x.peer !== b.peer), entry];
  saveConfig(next, app.home);
  Object.assign(app.config, next);
  return entry;
}
export function removeBackup(app: App, peer: string) {
  const next = structuredClone(app.config);
  next.backups = next.backups.filter((x) => x.peer !== peer);
  saveConfig(next, app.home);
  Object.assign(app.config, next);
  return { ok: true };
}

function cliScript() {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = resolve(here, "../cli.js");
  return existsSync(js) ? js : resolve(here, "../cli.ts");
}

type Puller = (app: App, b: Backup) => Promise<{ ok: boolean; output: string }>;
/** The pull, in a process of its own: what `omem peer pull <device> --to <dir> --only … -y` prints. */
const pullInChild: Puller = (app, b) =>
  new Promise((done) => {
    // The snapshot is unpacked next to where it goes: a large one must not fill the system's temporary
    // directory (often a smaller disk than the one chosen for the backup).
    const tmp = join(b.to, ".pull-tmp");
    mkdirSync(tmp, { recursive: true });
    const child = spawn(process.execPath, [cliScript(), "--home", app.home, "peer", "pull", b.peer, "--to", b.to, "--only", b.parts.join(","), "-y"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    let out = "";
    const take = (d: Buffer) => (out = (out + d.toString()).slice(-4000));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => done({ ok: false, output: e.message }));
    child.on("close", (code) => done({ ok: code === 0, output: out.trim() }));
  });
let puller: Puller = pullInChild;
/** Tests: replace the child process. */
export function setBackupPullerForTests(fn: Puller | null) {
  puller = fn ?? pullInChild;
}

/** What the pull said it brought, in a line. */
const summarize = (output: string) => output.split("\n").map((l) => l.trim()).filter((l) => /新增 \d|合并完成|知识库冲突/.test(l)).slice(-12).map((l) => l.replace(/\s+/g, " ")).join("；").slice(0, 600);

const STALE_MS = 3 * 86400_000;

/** Pull one backup now (when the device answers). */
export async function runBackup(app: App, peer: string, opts: { probeMs?: number } = {}): Promise<BackupState & { ran: boolean }> {
  const b = app.config.backups.find((x) => x.peer === peer);
  if (!b) throw new HttpError(404, `没有设置 ${peer} 的备份`);
  if (running.has(peer)) return { ...stateOf(app, peer), ran: false };
  running.add(peer);
  const prev = stateOf(app, peer);
  const started = Date.now();
  try {
    // Is it there? A quick question first: a device that is away costs nothing more.
    try {
      await peerJson(app, peer, "/api/diag", undefined, opts.probeMs ?? 15_000);
    } catch (e) {
      const s: BackupState = { ...prev, triedAt: now(), away: true, problem: (e as Error).message.slice(0, 200) };
      save(app, peer, tellIfStale(app, b, s));
      return { ...s, ran: false };
    }
    const r = await puller(app, b);
    const s: BackupState = r.ok
      ? { okAt: now(), summary: summarize(r.output) || "没有新内容", ms: Date.now() - started, triedAt: now() }
      : { ...prev, triedAt: now(), away: false, problem: r.output.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 400) || "拉取没有成功" };
    if (r.ok) console.log(`[omem] 备份 ${peer} → ${b.to}：${s.summary}（${Math.round((s.ms ?? 0) / 1000)} 秒）`);
    else console.warn(`[omem] 备份 ${peer} 没有成功：${s.problem}`);
    save(app, peer, r.ok ? s : tellIfStale(app, b, s));
    return { ...s, ran: true };
  } finally {
    running.delete(peer);
  }
}

/** Not through for days (or never, days after it was set up): the owner hears once in a while. */
function tellIfStale(app: App, b: Backup, s: BackupState): BackupState {
  // Counted from the last good pull; for a backup that never got through, from its first failed look.
  const from = Date.parse(s.okAt ?? s.failingSince ?? "") || 0;
  if (!from) return { ...s, failingSince: now() };
  const told = Date.parse(s.toldAt ?? "") || 0;
  if (Date.now() - from < STALE_MS || Date.now() - told < STALE_MS) return s;
  notify(app, {
    title: `${b.peer} 的备份${s.okAt ? `已经 ${Math.floor((Date.now() - Date.parse(s.okAt)) / 86400_000)} 天没更新` : "一直没成功"}`,
    body: `${s.away ? "这几天一直连不上它" : "连得上，但拉取出错"}：${s.problem ?? ""}\n\n备份目录：${b.to}。连上后会自动再拉；也可以运行 omem peer backup ${b.peer} --now。`,
    link: "#/settings?tab=peers",
  });
  return { ...s, toldAt: now() };
}

/** The schedule's look: every backup that is due and not running, one after another. */
export async function backupTick(app: App) {
  for (const b of app.config.backups) {
    const s = stateOf(app, b.peer);
    if (running.has(b.peer) || !findPeer(app, b.peer)) continue;
    if (s.okAt && Date.now() - Date.parse(s.okAt) < b.everyHours * 3600_000) continue;
    await runBackup(app, b.peer).catch((e) => console.warn(`[omem] 备份 ${b.peer} 出错：`, (e as Error).message));
  }
}
