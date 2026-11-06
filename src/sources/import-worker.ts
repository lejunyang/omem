import { join } from "node:path";
import { App } from "../core/app.ts";
import type { Config } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { disableGitFsmonitor } from "../core/git.ts";
import { importDirectoryLocally, syncDirectoryLocally, type ImportReport } from "./import.ts";
import type { ImportJob, ImportMessage } from "./import-process.ts";

let resume: (() => void) | undefined;
let started = false;
const send = (m: ImportMessage) => process.send?.(m);
process.on("disconnect", () => process.exit(0));
process.on("message", (m: { home: string; config: Config; job: ImportJob; continue?: boolean }) => {
  if (m.continue) { resume?.(); resume = undefined; return; }
  if (started) return;
  started = true;
  void run(m);
});

async function run(m: { home: string; config: Config; job: ImportJob }) {
  let app: App | undefined;
  let result: ImportReport | undefined;
  let error: string | undefined;
  try {
    disableGitFsmonitor();
    app = new App(m.home, m.config, openDb(join(m.home, "omem.db")));
    app.events.on("event", (event) => send({ event }));
    const progress = (done: number, total: number) => new Promise<void>((resolve) => {
      resume = resolve;
      send({ progress: { done, total } });
    });
    result = m.job.kind === "sync"
      ? await syncDirectoryLocally(app, m.job.spaceId, progress)
      : await importDirectoryLocally(app, m.job.spaceId, m.job.dir, progress);
  } catch (e) {
    error = (e as Error).message;
  } finally {
    app?.db.close();
  }
  process.send?.(error !== undefined ? { error } : { result }, undefined, undefined, () => process.exit(error !== undefined ? 1 : 0));
}
