import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { App } from "../core/app.ts";
import type { Config } from "../core/config.ts";
import { vectorChanges, type VectorChange } from "./vectors.ts";
import { searchPhases, searchStage } from "./trace.ts";

export type ReadJob =
  | { op: "sql"; sql: string; params: SQLInputValue[]; stage?: string }
  | { op: "vector"; query: string; spaces?: string[]; limit: number; config: Pick<Config, "embeddings">; vector?: Float32Array }
  | { op: "rerank"; query: string; passages: string[]; config: Pick<Config, "rerank">; timeoutMs: number };
type Reply = { id: number; result?: unknown; error?: string; phases?: Parameters<typeof searchPhases>[0]; stats?: { spaces: number; vectors: number; bytes: number } };
export class SearchTimeout extends Error {
  constructor() { super("检索通道超时"); this.name = "SearchTimeout"; }
}

/** A reusable read-only process; queue time counts towards the deadline. No shell or HTTP. */
export class ReadProcess {
  private child: ChildProcess | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private generation = 0;
  private active: { id: number; reject: (e: Error) => void } | null = null;
  private unlisten: (() => void) | null = null;
  stats = { spaces: 0, vectors: 0, bytes: 0 };
  readonly path: string;
  constructor(path: string) { this.path = path; }

  private start() {
    if (this.child?.connected) return this.child;
    this.unlisten?.(); this.unlisten = null;
    const file = new URL(import.meta.url.endsWith(".ts") ? "./read-worker.ts" : "./read-worker.js", import.meta.url);
    const child = fork(fileURLToPath(file), [this.path], { serialization: "advanced", execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    this.child = child;
    child.on("error", () => { if (this.child === child) this.active?.reject(new Error("检索进程无法启动")); });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.active?.reject(new Error("检索进程已退出"));
      this.child = null;
      this.unlisten?.(); this.unlisten = null;
      this.stats = { spaces: 0, vectors: 0, bytes: 0 };
    });
    const invalidate = (change: VectorChange) => {
      if (change.op === "add" && (!change.home || join(change.home, "omem.db") !== this.path)) return;
      if (child.connected) child.send({ op: "invalidate", change }, () => {});
    };
    vectorChanges.on("change", invalidate);
    this.unlisten = () => vectorChanges.off("change", invalidate);
    child.unref(); child.channel?.unref();
    return child;
  }

  async request<T>(job: ReadJob, budgetMs = 5000): Promise<T> {
    const id = ++this.seq;
    const generation = this.generation;
    const deadline = Date.now() + budgetMs;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (this.active?.id === id) {
          this.active.reject(new SearchTimeout());
          this.stop();
        }
        reject(new SearchTimeout());
      }, budgetMs);
    });
    const work = this.tail.then(() => {
      if (generation !== this.generation) throw new SearchTimeout();
      if (Date.now() >= deadline) throw new SearchTimeout();
      const child = this.start();
      return new Promise<Reply>((resolve, reject) => {
        const finish = (e?: Error, value?: Reply) => {
          child.off("message", message);
          if (this.active?.id === id) this.active = null;
          if (e) reject(e); else resolve(value!);
        };
        const message = (m: Reply) => {
          if (m.id !== id) return;
          if (m.stats) this.stats = m.stats;
          finish(m.error ? new Error(m.error) : undefined, m);
        };
        this.active = { id, reject: (e) => finish(e) };
        child.on("message", message);
        child.send({ id, job }, (e) => { if (e) finish(new Error("检索进程通信失败")); });
      });
    });
    this.tail = work.catch(() => {});
    try {
      const reply = await Promise.race([work, timeout]);
      if (reply.phases) searchPhases(reply.phases);
      return reply.result as T;
    }
    finally { clearTimeout(timer!); }
  }

  stop() {
    this.generation++;
    this.active?.reject(new Error("检索进程已停止"));
    this.child?.kill("SIGKILL");
    this.child = null;
    this.unlisten?.(); this.unlisten = null;
    this.stats = { spaces: 0, vectors: 0, bytes: 0 };
  }
}

type Lane = "sql" | "vector" | "rerank";
const readers = new WeakMap<App, Map<Lane, ReadProcess>>();
export function readProcess(app: App, lane: Lane = "sql") {
  let lanes = readers.get(app);
  if (!lanes) {
    readers.set(app, lanes = new Map());
    app.events.once("close", () => closeReadProcess(app));
  }
  let reader = lanes.get(lane);
  if (!reader) {
    lanes.set(lane, reader = new ReadProcess(join(app.home, "omem.db")));
  }
  return reader;
}
export function closeReadProcess(app: App) { for (const reader of readers.get(app)?.values() ?? []) reader.stop(); readers.delete(app); }
export function readProcessStats(app: App) { return Object.fromEntries([...(readers.get(app) ?? [])].map(([lane, reader]) => [lane, reader.stats])); }

export async function searchRows<T>(app: App, stage: string, sql: string, ...params: SQLInputValue[]): Promise<T[]> {
  try { return await searchStage(stage, () => readProcess(app).request<T[]>({ op: "sql", sql, params, stage })); }
  catch (e) { if ((e as Error).name === "SearchTimeout") return []; throw e; }
}
