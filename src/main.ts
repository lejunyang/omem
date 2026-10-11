import "./agents/jobs.ts";
import { scheduleSpaceSync } from "./agents/jobs.ts";
import { createRun, listRuns, startWorker } from "./agents/runs.ts";
import { App } from "./core/app.ts";
import { ensureDefaultSchedules, registerScheduleKind, restartScheduler } from "./core/scheduler.ts";
import { ensurePersonalSpace, listSpaces } from "./core/spaces.ts";
import { embedPending } from "./search/embeddings.ts";
import { startServer } from "./server/http.ts";
import { syncWiki } from "./wiki/store.ts";

registerScheduleKind("heartbeat", (app) => {
  if (!listRuns(app, { kind: "heartbeat", status: "running" }).length && !listRuns(app, { kind: "heartbeat", status: "queued" }).length)
    createRun(app, { kind: "heartbeat", spaceId: "personal", title: "巡检" });
});
registerScheduleKind("dream", (app) => createRun(app, { kind: "dream", spaceId: "personal", title: "整理记忆与页面" }));
registerScheduleKind("repo-sync", (app) => {
  for (const s of listSpaces(app)) if (s.rootPath) scheduleSpaceSync(app, s.id);
});

registerScheduleKind("lark-poll", (app) => {
  import("./channels/lark-personal.ts").then((m) => m.pollLark(app)).catch((e) => console.warn("[omem] 飞书消息采集失败：", e.message));
});

export type BootOptions = { port?: number; host?: string; quiet?: boolean; background?: boolean };

/** Open the library, start the API, the run worker and (optionally) background schedules. */
export async function boot(home?: string, opts: BootOptions = {}) {
  const app = App.open(home);
  ensurePersonalSpace(app);
  ensureDefaultSchedules(app);
  for (const s of listSpaces(app)) syncWiki(app, s.id);
  const server = await startServer(app, opts);
  startWorker(app);
  if (opts.background !== false) {
    restartScheduler(app);
    if (app.config.embeddings.provider !== "none") {
      const loop = async () => {
        try {
          while ((await embedPending(app, 32)) > 0) await new Promise((r) => setTimeout(r, 10));
        } catch (e) {
          console.warn("[omem] 向量化失败：", (e as Error).message);
        }
        setTimeout(loop, 30_000).unref();
      };
      setTimeout(loop, 3000).unref();
    }
    if (app.config.telegram.enabled) {
      const { startTelegram } = await import("./channels/telegram.ts");
      startTelegram(app).catch((e) => console.warn("[omem] Telegram 启动失败：", e.message));
    }
    if (app.config.onebot.enabled) {
      const { startOneBot } = await import("./channels/onebot.ts");
      startOneBot(app).catch((e) => console.warn("[omem] OneBot 启动失败：", e.message));
    }
    if (app.config.lark.enabled) {
      const { startLarkBot } = await import("./channels/lark-bot.ts");
      startLarkBot(app).catch((e) => console.warn("[omem] 飞书机器人启动失败：", e.message));
    }
  }
  return { app, server };
}
