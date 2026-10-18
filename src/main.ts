import "./agents/jobs.ts";
import { learningTick, scheduleMemoryReview, scheduleSpaceSync } from "./agents/jobs.ts";
import { createRun, listRuns, startWorker } from "./agents/runs.ts";
import { sweepWorktreeSpaces } from "./agents/worktree-index.ts";
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
  // Delegation worktrees removed by hand take their temporary index with them.
  sweepWorktreeSpaces(app);
});

registerScheduleKind("memory-review", (app) => scheduleMemoryReview(app));
registerScheduleKind("learn", (app) => learningTick(app));
registerScheduleKind("activity", (app) => {
  import("./sources/activity.ts").then((m) => m.recordCodeActivity(app)).catch((e) => console.warn("[omem] 记录代码活动失败：", e.message));
});
registerScheduleKind("brief", (app) => createRun(app, { kind: "brief", spaceId: "personal", title: "简报" }));
registerScheduleKind("lark-curate", (app, s) => createRun(app, { kind: "curate", spaceId: "personal", title: "筛选值得关注的飞书群", input: { direction: (s.config as { direction?: string }).direction } }));
registerScheduleKind("lark-poll", (app) => {
  import("./channels/lark-personal.ts").then((m) => m.pollLark(app)).catch((e) => console.warn("[omem] 飞书消息采集失败：", e.message));
});

registerScheduleKind("lark-docs-watch", (app) => {
  import("./channels/lark-docs.ts")
    .then((m) => m.checkInBackground(app))
    .catch((e) => console.warn("[omem] 检查飞书文档更新失败：", e.message));
});

export type BootOptions = { port?: number; host?: string; quiet?: boolean; background?: boolean };

/** Open the library, start the API, the run worker and (optionally) background schedules. */
const require_vectors = await import("./search/vectors.ts");

export async function boot(home?: string, opts: BootOptions = {}) {
  const app = App.open(home);
  ensurePersonalSpace(app);
  ensureDefaultSchedules(app);
  for (const s of listSpaces(app)) syncWiki(app, s.id);
  sweepWorktreeSpaces(app);
  const { seedBuiltinSkills } = await import("./agents/specs.ts");
  const { packageRoot } = await import("./setup.ts");
  seedBuiltinSkills(app, packageRoot());
  const server = await startServer(app, opts);
  startWorker(app);
  if (opts.background !== false) {
    restartScheduler(app);
    import("./channels/lark-messages.ts")
      .then((m) => m.cleanUpLarkIds(app))
      .catch((e) => console.warn("[omem] 整理飞书聊天里的 id 失败：", e.message));
    // Long jobs interrupted by a restart carry on (runs are re-queued by the worker itself).
    import("./channels/lark-docs.ts")
      .then((m) => m.resumeRefresh(app))
      .catch((e) => console.warn("[omem] 继续重新读取飞书文档失败：", e.message));
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
      // Load the vector matrices before the first question needs them.
      setTimeout(() => {
        try {
          const { vectorIndex } = require_vectors;
          vectorIndex().search(app, new Float32Array(0), undefined, 1);
        } catch {}
      }, 1000).unref();
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
