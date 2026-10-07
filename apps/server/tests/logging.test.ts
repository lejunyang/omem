import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import {
  createLogger,
  getLogger,
  installDefaultLogger,
  withLogContext,
} from "../src/logging/logger.js";
import { createHttpLogController } from "../src/logging/http.js";
import { readServiceLogs, serviceLogPaths } from "../src/logging/files.js";
import { parseConfig } from "../src/config.js";
import { assessPassages } from "../src/decision/passages.js";
import { passageQuestions } from "../src/decision/questions.js";
import type {
  DecisionResult,
  DecisionService,
} from "../src/decision/service.js";
import type { RetrievalHit } from "../src/retrieval/port.js";

const releases: (() => void)[] = [];
const directories: string[] = [];
afterEach(async () => {
  releases
    .splice(0)
    .reverse()
    .forEach((release) => release());
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
function recording(level: "debug" | "info" = "info") {
  let content = "";
  const logger = createLogger(
    { level },
    {
      write: (value) => {
        content += value;
      },
    },
  );
  return {
    logger,
    records: () =>
      content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    text: () => content,
  };
}

it("uses a real severity threshold while removing private payloads and credentials", () => {
  const output = recording();
  output.logger.debug({ event: "hidden" }, "hidden");
  output.logger.child({ sourceId: "source-1", token: "private-token" }).info(
    {
      event: "capture.saved",
      parts: [{ text: "private document" }],
      metadata: { password: "private-password", body: "private body" },
      detail: "Bearer private-bearer",
      inputTokens: 30,
    },
    "capture.saved",
  );
  expect(output.records()).toHaveLength(1);
  expect(output.records()[0]).toMatchObject({
    level: "info",
    sourceId: "source-1",
    inputTokens: 30,
    token: "[REDACTED]",
  });
  expect(output.text()).not.toContain("private-");
  expect(output.text()).not.toContain("private document");
  expect(output.text()).not.toContain("private body");
});

it("records Fastify errors without exposing the exception body or request headers", async () => {
  const output = recording();
  const app = Fastify({
    loggerInstance: output.logger,
    logController: createHttpLogController(),
  });
  app.get("/failed", async () => {
    throw Error("ROLE_OUTPUT_INVALID: private document Bearer secret-value");
  });
  const response = await app.inject({
    url: "/failed?private=query",
    headers: { authorization: "Bearer secret-value" },
  });
  await app.close();
  expect(response.statusCode).toBe(500);
  expect(
    output
      .records()
      .some((record) => record.err?.code === "ROLE_OUTPUT_INVALID"),
  ).toBe(true);
  expect(output.text()).not.toContain("private document");
  expect(output.text()).not.toContain("secret-value");
  expect(output.text()).not.toContain("private=query");
});

it("keeps job, source and message correlation across independent async operations", async () => {
  const output = recording();
  releases.push(installDefaultLogger(output.logger));
  await Promise.all(
    ["a", "b"].map((jobId) =>
      withLogContext(
        { jobId, sourceId: `source-${jobId}`, messageId: `message-${jobId}` },
        async () => {
          await Promise.resolve();
          getLogger({ component: "worker" }).info(
            { event: "job.completed" },
            "job.completed",
          );
        },
      ),
    ),
  );
  expect(
    output
      .records()
      .map((record) => [record.jobId, record.sourceId, record.messageId]),
  ).toEqual([
    ["a", "source-a", "message-a"],
    ["b", "source-b", "message-b"],
  ]);
});

it("validates logging configuration and environment overrides", () => {
  const base = {
    profiles: [{ id: "test", name: "test", transport: "acp", command: "test" }],
  };
  expect(
    parseConfig({ ...base, logging: { level: "debug", retain: 3 } }).logging,
  ).toEqual({ level: "debug", retain: 3, maxSizeMB: 10 });
  expect(() =>
    parseConfig({ ...base, logging: { level: "verbose" } }),
  ).toThrow();
  vi.stubEnv("OMEM_LOG_LEVEL", "error");
  const output = recording("debug");
  output.logger.info("suppressed");
  expect(output.records()).toEqual([]);
  vi.stubEnv("OMEM_LOG_LEVEL", "invalid");
  expect(() => createLogger()).toThrow("OMEM_LOG_LEVEL");
});

it("tails only current structured service logs, with severity and identity filters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omem-logs-"));
  directories.push(directory);
  vi.stubEnv("OMEM_DATA_DIR", directory);
  vi.stubEnv("OMEM_CONFIG", join(directory, "absent.json"));
  const paths = serviceLogPaths(directory);
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.files[0]!,
    [
      JSON.stringify({
        name: "omem",
        level: "info",
        time: "2026-10-07T01:00:00Z",
        jobId: "a",
        event: "job.completed",
      }),
      "legacy private material",
      JSON.stringify({
        name: "omem",
        level: "error",
        time: "2026-10-07T02:00:00Z",
        jobId: "a",
        event: "job.failed",
        token: "secret",
      }),
    ].join("\n"),
  );
  const result = await readServiceLogs({ lines: 1, level: "warn", jobId: "a" });
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    event: "job.failed",
    token: "[REDACTED]",
  });
  expect(result.legacyLines).toBe(1);
  expect(await readServiceLogs({ jobId: "absent" })).toMatchObject({
    entries: [],
  });
});

it("explains per-passage filtering and abstention without writing the question or materials", async () => {
  const output = recording("debug");
  releases.push(installDefaultLogger(output.logger));
  const answers: DecisionResult["answers"] = Object.fromEntries(
    Object.entries(passageQuestions).map(([key, question]) => [
      key,
      {
        choice: "none",
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((option) => [option, 0]),
        ),
      },
    ]),
  );
  answers.relevance = {
    choice: "unrelated",
    confidence: 1,
    probabilities: { answer: 0, background: 0, unrelated: 1, uncertain: 0 },
  };
  answers.answer_coverage!.probabilities.none = 1;
  answers.evidence!.probabilities.none = 1;
  const result: DecisionResult = {
    answers,
    elapsedMs: 1,
    model: {
      alias: "test-model",
      size: "2b",
      revision: "test",
      switched: false,
      availableGiB: 16,
      loadPerCpu: 0.1,
    },
    peakModelBytes: 1,
  };
  const service = {
    status: () => ({ status: "ready" }),
    decide: async () => result,
  } as unknown as DecisionService;
  const hit = {
    id: "hit-1",
    kind: "source",
    text: "private document",
    context: "",
    title: "private title",
    headingPath: [],
    target: { kind: "source", revisionId: "revision-1" },
  } as unknown as RetrievalHit;
  expect(
    (
      await assessPassages(service, "private question", [hit], {
        sourceIdFor: () => "source-1",
      })
    ).hits,
  ).toEqual([hit]);
  expect(
    output
      .records()
      .find((record) => record.event === "retrieval.passage_decision"),
  ).toMatchObject({
    sourceId: "source-1",
    outcome: "kept",
    reason: "all_omitted_abstention",
    dimensions: { relevance: { scores: expect.arrayContaining([
      { label: "answer", probability: 0 },
      { label: "unrelated", probability: 1 },
    ]) } },
  });
  expect(output.text()).not.toContain("private question");
  expect(output.text()).not.toContain("private document");
  expect(output.text()).not.toContain("private title");
});
