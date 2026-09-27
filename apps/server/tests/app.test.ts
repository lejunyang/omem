import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../src/app.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { hookInput } from "../src/connectors.js";
async function setup(token?: string) {
  const dir = mkdtempSync(join(tmpdir(), "omem-api-"));
  const result = await buildApp({
    dataDir: dir,
    agentCwd: join(dir, "agent"),
    token,
    host: "127.0.0.1",
    port: 4317,
    captureRoots: [],
    notifications: { mode: "instant" },
    profiles: [
      profileSchema.parse({
        id: "fixture",
        name: "fixture",
        transport: "acp",
        command: process.execPath,
        args: [resolve("apps/server/tests/fixtures/acp-agent.mjs")],
      }),
    ],
  });
  return {
    ...result,
    close: async () => {
      await result.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
it("authenticates all private endpoints and rejects cross-origin anonymous requests", async () => {
  const a = await setup("secret");
  try {
    expect((await a.app.inject("/api/sources")).statusCode).toBe(401);
    expect(
      (
        await a.app.inject({
          url: "/api/sources",
          headers: { authorization: "Bearer secret" },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await a.close();
  }
  const b = await setup();
  try {
    expect(
      (
        await b.app.inject({
          url: "/api/sources",
          headers: { host: "localhost", origin: "https://evil.invalid" },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await b.close();
  }
});
it("persists a generated answer and its explicit evidence links", async () => {
  const x = await setup();
  try {
    const captured = x.store.capture({
      source: "manual",
      externalId: "x",
      title: "Evidence",
      parts: [{ type: "text", text: "Some evidence" }],
      context: {},
    });
    const response = await x.app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        profileId: "fixture",
        focusId: captured.revision.fragments[0]!.id,
        question: "Explain",
      },
    });
    expect(response.statusCode).toBe(202);
    const runId = response.json().id;
    for (let i = 0; i < 100; i++) {
      const r = x.runs.get(runId)!;
      if (r.state !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const run = x.runs.get(runId)!;
    expect(run.state).toBe("done");
    const answer = x.store.revision(run.answerId!)!;
    expect(x.store.evidence(answer.fragments[0]!.id)?.outgoing).toHaveLength(1);
    expect(x.store.list()).toHaveLength(2);
  } finally {
    await x.close();
  }
});
it("validates selected text and restricts filesystem imports", async () => {
  const x = await setup();
  try {
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/api/connectors/file",
          payload: { path: "/etc/passwd" },
        })
      ).statusCode,
    ).toBe(400);
    expect(x.store.list()).toHaveLength(0);
    const c = x.store.capture({
      source: "manual",
      externalId: "selection",
      title: "Selection",
      parts: [{ type: "text", text: "Original evidence" }],
      context: {},
    });
    const rejected = await x.app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        profileId: "fixture",
        focusId: c.revision.fragments[0]!.id,
        question: "explain",
        selection: "fabricated quote",
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("Selection does not match");
  } finally {
    await x.close();
  }
});
it("preserves image bytes and includes images in an ACP prompt", async () => {
  const x = await setup();
  try {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vO8AAAAASUVORK5CYII=";
    const c = x.store.capture({
      source: "screen",
      externalId: "screenshot",
      title: "Screen capture",
      parts: [
        { type: "text", text: "A screenshot" },
        {
          type: "image",
          mimeType: "image/png",
          data: png,
          label: "Screenshot",
        },
      ],
      context: { application: "Browser" },
    });
    const image = c.revision.parts.find((p) => p.type === "image");
    if (image?.type !== "image") throw Error("Missing image");
    expect(
      x.store.asset(image.assetId)?.equals(Buffer.from(png, "base64")),
    ).toBe(true);
    const started = x.runs.start({
      question: "Describe",
      profileId: "fixture",
      focusId: c.revision.fragments[0]!.id,
      contextIds: [],
    });
    for (let i = 0; i < 100 && x.runs.get(started.id)?.state === "running"; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(x.runs.get(started.id)?.state).toBe("done");
    expect(
      x.runs
        .get(started.id)
        ?.events.map((e) => e.text)
        .join(""),
    ).toContain("images=1");
  } finally {
    await x.close();
  }
});
it("normalizes hook events without persisting unknown hidden payloads", () => {
  const v = hookInput({
    hook_event_name: "PostToolUse",
    session_id: "s",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    thoughts: "private",
    secret: "never",
  });
  expect(v.context.event).toBe("PostToolUse");
  expect(JSON.stringify(v)).not.toContain("private");
  expect(JSON.stringify(v)).not.toContain("never");
});

it("exposes durable capture jobs with idempotent generation-checked controls", async () => {
  const x = await setup();
  try {
    const captured = await x.app.inject({
      method: "POST",
      url: "/api/captures",
      payload: {
        source: "manual",
        externalId: "job-api",
        title: "Queued input",
        parts: [{ type: "text", text: "queue this durably" }],
      },
    });
    expect(captured.statusCode).toBe(200);
    const jobId = captured.json().job.id as string;
    const detail = await x.app.inject(`/api/jobs/${jobId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: jobId,
      state: "queued",
      generation: 1,
      attempts: [],
    });
    const cancelPayload = {
      expectedGeneration: 1,
      requestId: "api-cancel-1",
    };
    const cancelled = await x.app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
      payload: cancelPayload,
    });
    expect(cancelled.json()).toEqual({ mode: "cancelled", state: "cancelled" });
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: `/api/jobs/${jobId}/cancel`,
          payload: cancelPayload,
        })
      ).json(),
    ).toEqual(cancelled.json());
    const retried = await x.app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/retry`,
      payload: { expectedGeneration: 1, requestId: "api-retry-1" },
    });
    expect(retried.json()).toEqual({ state: "queued", generation: 2 });
  } finally {
    await x.close();
  }
});

it("evaluates and atomically applies a supported owner task through HTTP", async () => {
  const x = await setup();
  try {
    const text = "我负责在周五前提交验证报告。";
    const captured = (
      await x.app.inject({
        method: "POST",
        url: "/api/captures",
        payload: {
          source: "manual",
          externalId: "policy-api",
          title: "Owner commitment",
          parts: [{ type: "text", text }],
          provenance: {
            collectorId: "owner-ui",
            actorId: "owner",
            actorType: "owner",
            actorVerifiedBy: "authenticated-test",
            sourceUri: null,
            eventId: null,
            eventAt: "2026-09-22T08:00:00Z",
            timezone: "Asia/Shanghai",
            quoted: false,
            forwarded: false,
            producerKind: "original",
          },
        },
      })
    ).json();
    const revision = captured.revision;
    const evaluated = await x.app.inject({
      method: "POST",
      url: "/api/proposals/evaluate",
      payload: {
        proposal: {
          schema_version: 1,
          proposal_id: "api-proposal-1",
          kind: "task",
          operation: "create",
          scope: {
            workspace_id: "personal",
            project_id: "api-test",
            subject_id: "owner",
          },
          body: {
            title: "提交验证报告",
            owner_id: "owner",
            due_at: null,
            due_expression: null,
            next_step: "整理结果",
          },
          evidence: [
            {
              fragment_revision_id: revision.fragments[0].id,
              source_revision_id: revision.id,
              exact_quote: text,
              selector: {
                start: 0,
                end: Array.from(text).length,
                unit: "unicode_codepoint",
              },
            },
          ],
          uncertainties: [],
          reason: "explicit owner task",
          expected_versions: {},
          origin: {
            job_id: "api-policy-job",
            role_bundle: "extractor@1",
            producer_kind: "derived",
          },
        },
        assessment: {
          semantic_verdict: "supported",
          reviewer_version: "reviewer@1",
          role_version: "verifier@1",
          reason_code: "direct_support",
          details: "Direct owner commitment.",
        },
      },
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json()).toMatchObject({
      policy: "auto_apply",
      receipt: { entityType: "task", entityVersion: 1 },
    });
    expect((await x.app.inject("/api/tasks")).json()).toMatchObject([
      { title: "提交验证报告", ownerId: "owner", version: 1 },
    ]);
    const proposals = (await x.app.inject("/api/proposals")).json();
    expect(proposals).toMatchObject([
      {
        id: "api-proposal-1",
        state: "applied",
        body: { title: "提交验证报告" },
        policyResult: { outcome: "auto_apply", reasons: [] },
        assessments: [
          {
            semanticVerdict: "supported",
            reviewerVersion: "reviewer@1",
          },
        ],
      },
    ]);
    const notifications = (await x.app.inject("/api/notifications")).json();
    const detail = await x.app.inject(
      `/api/notifications/${notifications[0].id}`,
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      receipt: {
        proposalId: "api-proposal-1",
        entityType: "task",
        entityVersion: 1,
      },
      evidenceIds: [revision.fragments[0].id],
      deliveries: [{ channel: "in_app", state: "pending" }],
    });
  } finally {
    await x.close();
  }
});
