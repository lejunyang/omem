import { expect, it } from "vitest";
import { createRun, getRun, registerHandler, startWorker, waitForRun } from "../src/agents/runs.ts";
import { testApp } from "./helpers.ts";

it("starts conversations beyond 100 waiting background jobs and background jobs beyond busy conversations", async () => {
  const app = testApp();
  app.config.concurrency = 1;
  app.config.interactiveConcurrency = 1;
  let releaseBackground!: () => void;
  let releaseInteractive!: () => void;
  const backgroundGate = new Promise<void>(resolve => { releaseBackground = resolve; });
  const interactiveGate = new Promise<void>(resolve => { releaseInteractive = resolve; });
  registerHandler("ingest", async ctx => { if (ctx.run.input.block) await backgroundGate; });
  registerHandler("ask", async ctx => { if (ctx.run.input.block) await interactiveGate; });
  const first = createRun(app, { kind: "ingest", title: "后台占位", input: { block: true } });
  const backlog = Array.from({ length: 150 }, () => createRun(app, { kind: "ingest", title: "等待整理" }));
  const ask = createRun(app, { kind: "ask", title: "用户提问", input: { block: true } });
  startWorker(app);
  try {
    expect(getRun(app, first.id).status).toBe("running");
    expect(getRun(app, ask.id).status).toBe("running");
    const waiting = Array.from({ length: 150 }, () => createRun(app, { kind: "ask", title: "其他对话" }));
    const last = createRun(app, { kind: "ingest", title: "后来的后台任务" });
    releaseBackground();
    expect((await waitForRun(app, last.id)).status).toBe("done");
    expect(backlog.every(r => getRun(app, r.id).status === "done")).toBe(true);
    expect(waiting.every(r => getRun(app, r.id).status === "queued")).toBe(true);
    releaseInteractive();
    for (const r of waiting) await waitForRun(app, r.id);
  } finally {
    releaseBackground(); releaseInteractive();
    // Worker owns a process-local interval; Vitest disposes this isolated worker's database.
  }
});
