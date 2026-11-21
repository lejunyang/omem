import { join } from "node:path";
import { App } from "../core/app.ts";
import type { Config } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { disableGitFsmonitor } from "../core/git.ts";
import { importDirectoryLocally, syncDirectoryLocally, type ImportReport } from "./import.ts";
import type { ImportJob, ImportMessage } from "./import-process.ts";

import type { FileParsers } from "../plugins/formats.ts";

type Start = { home: string; config: Config; job: ImportJob; list: FileParsers["list"] };
type ParseReply = { result: Awaited<ReturnType<FileParsers["parse"]>> } | { error: string };
let receive: ((reply: ParseReply) => void) | undefined;
let resume: (() => void) | undefined;
let started = false;
const send = (m: ImportMessage) => process.send?.(m);
process.on("disconnect", () => process.exit(0));
process.on("message", (m: Start & { continue?: boolean; parsed?: ParseReply }) => {
  if (m.parsed) { receive?.(m.parsed); receive = undefined; return; }
  if (m.continue) { resume?.(); resume = undefined; return; }
  if (started) return;
  started = true;
  void run(m);
});

async function run(m: Start) {
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
    const parsers: FileParsers = {
      list: m.list,
      parse: (key, input) => new Promise((resolve, reject) => {
        receive = reply => "error" in reply ? reject(new Error(reply.error)) : resolve(reply.result);
        send({ parse: { key, input } });
      }),
    };
    result = m.job.kind === "sync"
      ? await syncDirectoryLocally(app, m.job.spaceId, progress, parsers)
      : await importDirectoryLocally(app, m.job.spaceId, m.job.dir, progress, parsers);
  } catch (e) {
    error = (e as Error).message;
  } finally {
    app?.db.close();
  }
  process.send?.(error !== undefined ? { error } : { result }, undefined, undefined, () => process.exit(error !== undefined ? 1 : 0));
}
