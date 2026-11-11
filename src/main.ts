import "./agents/jobs.ts";
import { learningTick, scheduleMemoryOrganize, scheduleMemoryReview, scheduleSpaceSync, sendItemDigests, sweepItems } from "./agents/jobs.ts";
import { addRunEvent, createRun, listRuns, startWorker } from "./agents/runs.ts";
import { startSessionCleanup } from "./agents/session-cleanup.ts";
import { refreshBranchIndexes, sweepWorktreeSpaces } from "./agents/worktree-index.ts";
import { App } from "./core/app.ts";
import { ensureDefaultSchedules, registerScheduleKind, restartScheduler } from "./core/scheduler.ts";
import { ensurePersonalSpace, listSpaces } from "./core/spaces.ts";
import { embedPending, embedPendingMemories } from "./search/embeddings.ts";
import { readProcess } from "./search/read-process.ts";
import { startMemoryWatch } from "./core/memory-watch.ts";
import { startLoopMonitor } from "./core/loop-monitor.ts";
import { startServer } from "./server/http.ts";
import { syncWiki } from "./wiki/store.ts";

registerScheduleKind("heartbeat", (app) => {
  if (!listRuns(app, { kind: "heartbeat", status: "running" }).length && !listRuns(app, { kind: "heartbeat", status: "queued" }).length)
    createRun(app, { kind: "heartbeat", spaceId: "personal", title: "巡检" });
});
registerScheduleKind("dream", (app) => createRun(app, { kind: "dream", spaceId: "personal", title: "整理记忆与页面" }));
registerScheduleKind("repo-sync", (app) => {
  for (const s of listSpaces(app)) if (s.rootPath) scheduleSpaceSync(app, s.id);
  // Delegation worktrees removed by hand take their temporary index with them; branch indexes follow their branch.
  sweepWorktreeSpaces(app);
  void refreshBranchIndexes(app);
});

registerScheduleKind("memory-review", (app) => scheduleMemoryReview(app));
registerScheduleKind("digest", (app) => void import("./agents/digest.ts").then((m) => m.tickDigestJobs(app)));
registerScheduleKind("memory-organize", (app) => scheduleMemoryOrganize(app));
registerScheduleKind("item-sweep", (app) => {
  void sweepItems(app).catch((e) => console.warn("[omem] 事项收尾失败：", e.message));
  // Coding work the owner finished outside its page (pushed by hand, or carried on by a newer delegation).
  void import("./agents/code-branch.ts").then((m) => m.settleCodeWorks(app)).catch((e) => console.warn("[omem] 编码收尾失败：", e.message));
});
registerScheduleKind("item-digest", (app) => void sendItemDigests(app).catch((e) => console.warn("[omem] 事项清点失败：", e.message)));
registerScheduleKind("profile-review", (app) => {
  void import("./agents/profile-jobs.ts").then((m) => m.nightlyProfileReviews(app));
  // Proposals nobody answered for 14 days expire; a notice goes out two days before.
  void import("./agents/proposals.ts").then((m) => m.expireProposals(app)).catch((e) => console.warn(`[omem] 档案建议过期处理失败：${(e as Error).message}`));
});
// Nightly replay, after the profile reviews (agents/replay.ts); nothing runs until replay-judge has an AI.
registerScheduleKind("replay", (app) => void import("./agents/replay.ts").then((m) => m.scheduleReplays(app)).catch((e) => console.warn(`[omem] 夜间复盘排队失败：${(e as Error).message}`)));
registerScheduleKind("rule", (app, s) => void import("./rules/engine.ts").then((m) => m.fireScheduledRule(app, String((s.config as { ruleId?: string }).ruleId))));
registerScheduleKind("learn", (app) => learningTick(app));
registerScheduleKind("activity", (app) => {
  import("./sources/activity.ts").then((m) => m.recordCodeActivity(app)).catch((e) => console.warn("[omem] 记录代码活动失败：", e.message));
});
registerScheduleKind("brief", (app) => createRun(app, { kind: "brief", spaceId: "personal", title: "简报" }));
registerScheduleKind("lark-curate", (app, s) => createRun(app, { kind: "curate", spaceId: "personal", title: "筛选值得关注的飞书群", input: { direction: (s.config as { direction?: string }).direction } }));
registerScheduleKind("lark-poll", (app) => {
  import("./channels/lark-personal.ts").then((m) => m.pollLark(app)).catch((e) => console.warn("[omem] 飞书消息采集失败：", e.message));
  // Then the people who connected their own Feishu (src/auth/connections.ts), and connections nobody used lately kept alive.
  import("./channels/lark-member-capture.ts").then((m) => m.pollMembers(app)).catch((e) => console.warn("[omem] 成员的飞书采集失败：", e.message));
  import("./auth/connections.ts").then((m) => m.renewConnections(app)).catch((e) => console.warn("[omem] 续期飞书连接失败：", e.message));
});

// Other servers' spaces this one mirrors (core/federation.ts).
registerScheduleKind("peer-sync", (app) => {
  import("./core/federation.ts").then((m) => m.syncAll(app)).catch((e) => console.warn("[omem] 同步其他服务的空间失败：", e.message));
});

registerScheduleKind("lark-docs-watch", (app) => {
  // The bot subscribes to a batch of captured documents first: those get their changes by event.
  void (async () => {
    const { larkBotInfo } = await import("./channels/lark-send.ts");
    if (larkBotInfo("main")) await (await import("./channels/lark-doc-events.ts")).subscribeCapturedDocs(app).catch((e) => console.warn("[omem] 订阅飞书文档变化失败：", e.message));
    (await import("./channels/lark-docs.ts")).checkInBackground(app);
  })().catch((e) => console.warn("[omem] 检查飞书文档更新失败：", e.message));
});

// Feishu knowledge bases (channels/lark-knowledge.ts): weekly discovery, nightly reading.
registerScheduleKind("lark-kb-discover", (app) => {
  import("./channels/lark-knowledge.ts")
    .then((m) => m.discoverKnowledgeBases(app, { scheduled: true }))
    .catch((e) => console.warn("[omem] 发现飞书知识库失败：", e.message));
});
registerScheduleKind("platform-sync", (app) => void import("./plugins/platforms.ts").then((m) => m.syncWatches(app)).catch((e) => console.warn(`[omem] 平台同步失败：${(e as Error).message}`)));
registerScheduleKind("lark-kb-read", (app) => {
  import("./channels/lark-knowledge.ts")
    .then((m) => m.readKnowledgeDaily(app, { scheduled: true }))
    .catch((e) => console.warn("[omem] 读飞书知识库失败：", e.message));
});

export type BootOptions = { port?: number; host?: string; quiet?: boolean; background?: boolean };

/** Open the library, start the API, the run worker and (optionally) background schedules. */

export async function boot(home?: string, opts: BootOptions = {}) {
  const app = App.open(home);
  ensurePersonalSpace(app);
  ensureDefaultSchedules(app);
  // Built-in roles copied only to attach a skill follow the source again (builtin-roles.ts).
  const { simplifyRoleCopies } = await import("./agents/builtin-roles.ts");
  for (const n of simplifyRoleCopies(app)) console.log(`[omem] 内置角色 ${n} 只多挂了技能或工具：改成叠加设置，以后跟着源码更新`);
  for (const s of listSpaces(app)) syncWiki(app, s.id);
  sweepWorktreeSpaces(app);
  const { seedBuiltinSkills } = await import("./agents/specs.ts");
  const { packageRoot } = await import("./setup.ts");
  seedBuiltinSkills(app, packageRoot());
  const { loadPlugins } = await import("./plugins/registry.ts");
  await loadPlugins(app);
  const server = await startServer(app, opts);
  {
    const { compactArchiveQueue } = await import("./sources/archive.ts");
    const n = compactArchiveQueue(app);
    if (n) console.log(`[omem] 合并了排队中的归属判断，取消 ${n} 个重复或已无事可做的任务`);
  }
  {
    const { sweepRoundAsks } = await import("./agents/review-fix.ts");
    const n = sweepRoundAsks(app);
    if (n) console.log(`[omem] ${n} 个交办或评审已经有了新的一轮（或已应用、丢弃），关掉它们旧的待处理卡片`);
  }
  {
    const { reconcileWaiting } = await import("./agents/code-loop.ts");
    const r = reconcileWaiting(app);
    if (r.closed || r.woken || r.moved) console.log(`[omem] 修改项：关掉 ${r.closed} 张已经不等本人的卡片，为 ${r.woken} 个交办叫醒发起的助手，${r.moved} 个没有助手的交办交给本人`);
  }
  {
    // What piled up before questions lapsed by themselves (agents/ask-expiry.ts), and notifications
    // pushed before that was recorded (channels/notify-read.ts): cleared at start, not one by one later.
    const { sweepStaleAsks } = await import("./agents/ask-expiry.ts");
    const s = sweepStaleAsks(app);
    if (s.message + s.work + s.item + s.stale) console.log(`[omem] 失效的提问：本人已接着说了别的 ${s.message}，交办已结束 ${s.work}，事项已关闭 ${s.item}，太久没回答 ${s.stale}`);
    const { backfillPushed } = await import("./channels/notify-read.ts");
    const n = backfillPushed(app);
    if (n) console.log(`[omem] ${n} 条以前推到飞书的通知记为已推送，网页不再算未读`);
  }
  startWorker(app);
  startSessionCleanup(app, (runId, e) => {
    if (runId) addRunEvent(app, runId, e.type, e);
    else if (e.type === "status") console.log(`[omem] ${e.text}`);
  });
  if (opts.background !== false) {
    startMemoryWatch();
    startLoopMonitor();
    restartScheduler(app);
    // Plan usage limits of the logged-in accounts (agents/quota.ts), for choosing backends.
    void import("./agents/quota.ts").then((m) => m.startQuotaWatch(app));
    // Wiki pages whose originals changed are checked, and loose pages sorted into folders (src/wiki/upkeep.ts).
    void import("./wiki/upkeep.ts").then((m) => m.startWikiUpkeep(app));
    // The owner's commands in one-to-one chats (lark.commands; nothing happens while it is off).
    setInterval(() => {
      if (app.config.lark.commands.enabled)
        import("./channels/lark-commands.ts").then((m) => m.pollOwnerCommands(app)).catch((e) => console.warn("[omem] 读取私聊指令失败：", e.message));
    }, 60_000).unref();
    // Rules set to check every minute (a login code someone asks for): the owner's search, not the capture.
    setInterval(() => {
      import("./rules/fast.ts").then((m) => m.pollFastRules(app)).catch((e) => console.warn("[omem] 规则快速检查失败：", e.message));
    }, 60_000).unref();
    // Documents rules watch that the bot cannot subscribe to: checked on the rule's schedule instead.
    setInterval(() => {
      import("./channels/lark-doc-events.ts").then((m) => m.pollRuleDocs(app)).catch((e) => console.warn("[omem] 定时检查规则盯的文档失败：", e.message));
    }, 60_000).unref();
    // The owner's meetings, for meeting rules (nothing runs while there are none).
    setInterval(() => {
      import("./channels/lark-meetings.ts").then((m) => m.tickMeetings(app)).catch((e) => console.warn("[omem] 跟进会议失败：", e.message));
    }, 15_000).unref();
    import("./channels/lark-messages.ts")
      .then((m) => m.cleanUpLarkIds(app))
      .catch((e) => console.warn("[omem] 整理飞书聊天里的 id 失败：", e.message));
    // Long jobs interrupted by a restart carry on (runs are re-queued by the worker itself).
    import("./channels/lark-docs.ts")
      .then((m) => m.resumeRefresh(app))
      .catch((e) => console.warn("[omem] 继续重新读取飞书文档失败：", e.message));
    // Answers given before citations were counted count too (once).
    import("./sources/cites.ts")
      .then((m) => m.backfillCites(app))
      .catch((e) => console.warn("[omem] 统计原件被引用次数失败：", e.message));
    import("./channels/lark-wiki.ts")
      .then((m) => m.resumeCrawls(app))
      .catch((e) => console.warn("[omem] 继续爬取飞书知识库失败：", e.message));
    // Compressing attachments: a job cut off by the restart carries on; media.auto picks up new files.
    void import("./core/media.ts").then((m) => {
      try {
        if (m.resumeMediaJob(app)) console.log("[omem] 继续上次没做完的附件压缩");
      } catch (e) {
        console.warn("[omem] 继续附件压缩失败：", (e as Error).message);
      }
      setInterval(() => {
        try { m.tickAutoCompress(app); } catch (e) { console.warn("[omem] 自动压缩附件失败：", (e as Error).message); }
      }, 60_000).unref();
    });
    // The vector change log keeps its recent part (search/vectors.ts).
    setInterval(() => {
      void import("./search/vectors.ts").then((m) => m.pruneVectorLog(app)).catch((e) => console.warn("[omem] 清理向量变更记录失败：", (e as Error).message));
    }, 3600_000).unref();
    if (app.config.embeddings.provider !== "none") {
      const loop = async () => {
        try {
          while ((await embedPending(app, 32)) > 0) await new Promise((r) => setTimeout(r, 10));
          while ((await embedPendingMemories(app, 32)) > 0) await new Promise((r) => setTimeout(r, 10));
        } catch (e) {
          console.warn("[omem] 向量化失败：", (e as Error).message);
        }
        setTimeout(loop, 30_000).unref();
      };
      setTimeout(loop, 3000).unref();
      // Load the vector matrices before the first question needs them.
      setTimeout(() => {
        // A first load with no snapshot reads every vector (20+ s for a million); it is not cut short.
        readProcess(app, "vector").request({ op: "prepare" }, 10 * 60_000).catch(() => {});
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
      if (app.config.lark.bots.some((b) => b.enabled)) {
        const { startLarkBots } = await import("./channels/lark-bots.ts");
        void startLarkBots(app);
      }
    }
  }
  return { app, server };
}
