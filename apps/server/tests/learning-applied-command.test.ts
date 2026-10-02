import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { Store } from "../src/store.js";
import { MemoryService, FeedbackService } from "../src/memory/service.js";
import { LearningPipeline } from "../src/learning/pipeline.js";

it("retains an applied owner command for learning without recreating its task after completion", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "omem-learning-applied-command-"),
  );
  const store = new Store(directory);
  const memory = new MemoryService(store);
  const pipeline = new LearningPipeline({
    store,
    memory,
    feedback: new FeedbackService(store),
    profile: profileSchema.parse({
      id: "traex",
      name: "Protocol fixture, not real model acceptance",
      transport: "acp",
      command: process.execPath,
      args: [resolve("apps/server/tests/fixtures/role-acp-agent.mjs")],
      timeoutMs: 3000,
    }),
    workspaceRoot: join(directory, "agent"),
  });
  const provenance = (eventId: string) => ({
    collectorId: "assistant",
    actorId: "owner",
    actorType: "owner" as const,
    actorVerifiedBy: "runtime",
    sourceUri: null,
    eventId,
    eventAt: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    quoted: false,
    forwarded: false,
    producerKind: "original" as const,
  });
  try {
    const command = store.capture({
      source: "manual",
      externalId: "task-command",
      title: "Owner tracking request",
      parts: [{ type: "text", text: "PIPELINE_TASK 请记录这次跟进" }],
      provenance: provenance("task-command"),
    });
    const receipt = store.applications.applyTask({
      metadata: {
        workspaceId: "personal",
        applicationId: "immediate-owner-task",
        generation: 1,
        proposalDigest: createHash("sha256")
          .update("immediate-owner-task")
          .digest("hex"),
        title: "已记录跟进",
        details: "当前原始委托已经由即时路径处理",
        delivery: {
          channelBindingVersion: 1,
          channel: "in_app",
          target: "notification-center",
        },
      },
      task: {
        title: "即时应用的名称与后台候选不同",
        ownerId: "owner",
        detail: "等待回复",
        nextStep: "检查回复",
        evidenceId: command.revision.fragments[0]!.id,
        dueAt: null,
        dueExpression: null,
      },
    });
    const completion = store.capture({
      source: "manual",
      externalId: "task-complete",
      title: "Owner confirms completion",
      parts: [{ type: "text", text: "这件事已经完成，不用再跟进" }],
      provenance: provenance("task-complete"),
    });
    memory.commandTask({
      taskId: receipt.entityId,
      expectedVersion: 1,
      action: "complete",
      requestId: "complete-1",
      evidenceId: completion.revision.fragments[0]!.id,
      dueAt: null,
      dueExpression: null,
    });
    await pipeline.drain(5);
    expect(store.tasks()).toHaveLength(1);
    expect(store.tasks()[0]).toMatchObject({
      id: receipt.entityId,
      status: "done",
      version: 2,
    });
    const job = store.jobs.get(command.job!.id)!;
    expect(job.state).toBe("succeeded");
    const output = store.jobs.roleOutput(job.resultRef!)!;
    expect(output.output).toMatchObject({
      proposals: [{ kind: "task", operation: "create" }],
    });
    expect(store.jobs.attempts(job.id)[0]!.usage).toMatchObject({
      alreadyHandledTaskActions: 1,
    });
    expect(
      store.jobs.list().filter((job) => job.kind === "verify_proposals"),
    ).toHaveLength(0);
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM application_receipts")
        .get(),
    ).toMatchObject({ count: 2 });
    expect(store.revision(command.revision.id)!.parts[0]).toMatchObject({
      text: "PIPELINE_TASK 请记录这次跟进",
    });
  } finally {
    await pipeline.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
