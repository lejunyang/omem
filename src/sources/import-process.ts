import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import type { App, AppEvent } from "../core/app.ts";
import { vectorIndex } from "../search/vectors.ts";
import { fileParsers } from "../plugins/formats.ts";
import type { ParserInput } from "../plugins/types.ts";
import type { ImportReport } from "./import.ts";

export type ImportJob = { user?: string } & ({ kind: "sync"; spaceId: string } | { kind: "directory"; spaceId: string; dir: string });
export type ImportMessage = { parse: { key: string; input: ParserInput } } | { event: AppEvent } | { progress: { done: number; total: number } } | { result: ImportReport } | { error: string };
type Queue = { tail: Promise<unknown>; closed: boolean; cancel?: () => void };
const queues = new WeakMap<App, Queue>();

/** One writer per app. The worker walks files, indexes parsed text and resolves the call graph. */
export function directoryImport(app: App, job: ImportJob, progress?: (done: number, total: number) => void): Promise<ImportReport> {
  let queue = queues.get(app);
  if (!queue) {
    queue = { tail: Promise.resolve(), closed: false };
    queues.set(app, queue);
    const own = queue;
    app.events.once("close", () => { own.closed = true; own.cancel?.(); });
  }
  const own = queue;
  const work = own.tail.then(() => {
    if (own.closed) throw new Error("服务已关闭，目录导入取消");
    return execute(app, own, job, progress);
  });
  own.tail = work.catch(() => {});
  return work;
}

function execute(app: App, queue: Queue, job: ImportJob, progress?: (done: number, total: number) => void): Promise<ImportReport> {
  const file = new URL(import.meta.url.endsWith(".ts") ? "./import-worker.ts" : "./import-worker.js", import.meta.url);
  const child: ChildProcess = fork(fileURLToPath(file), [], { serialization: "advanced", execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const lifetime = new AbortController();
  const parsers = fileParsers(app, job.spaceId, job.user ?? "owner", lifetime.signal);
  const events: AppEvent[] = [];
  return new Promise((resolve, reject) => {
    let finished = false;
    const flush = async () => {
      for (let i = 0; events.length; i++) {
        if (!queue.closed) app.emit(events.shift()!);
        else events.shift();
        if (i % 100 === 99) await setImmediate();
      }
    };
    const finish = async (error?: Error, result?: ImportReport) => {
      if (finished) return;
      finished = true;
      lifetime.abort();
      clearTimeout(timer);
      queue.cancel = undefined;
      child.removeAllListeners("message");
      if (error) child.kill("SIGKILL");
      // A failed/interrupted import may already have committed some files.
      try {
        vectorIndex().evict([job.spaceId]);
        if (!queue.closed) app.emit({ type: "changed", entity: "space", id: job.spaceId });
        await flush();
      } catch (e) { error ??= e as Error; }
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => void finish(new Error("目录导入超过 30 分钟，已保存的文件保留，可重试同步")), 30 * 60_000);
    queue.cancel = () => void finish(new Error("服务已关闭，目录导入取消"));
    child.on("error", () => void finish(new Error("目录导入进程无法启动")));
    child.on("exit", () => void finish(new Error("目录导入进程提前退出；已保存的文件保留，可重试同步")));
    child.on("message", (m: ImportMessage) => {
      if ("parse" in m) {
        const reply = (parsed: unknown) => {
          if (!finished) child.send({ parsed }, (error) => { if (error) void finish(error); });
        };
        void parsers.parse(m.parse.key, m.parse.input).then(result => reply({ result }), error => reply({ error: String(error.message) }));
      } else if ("event" in m) events.push(m.event);
      else if ("progress" in m) {
        // The worker waits here with no write transaction open, so run progress
        // and source-change listeners can safely write through the host connection.
        void flush().then(() => {
          if (finished) return;
          vectorIndex().evict([job.spaceId]);
          progress?.(m.progress.done, m.progress.total);
          child.send({ continue: true }, (e) => { if (e) void finish(new Error("目录导入进程通信失败")); });
        }).catch((e: Error) => void finish(e));
      } else if ("error" in m) void finish(new Error(m.error));
      else void finish(undefined, m.result);
    });
    child.send({ home: app.home, config: app.config, list: parsers.list, job }, (e) => { if (e) void finish(new Error("目录导入进程通信失败")); });
  });
}
