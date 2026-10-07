import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { ReprocessingService } from "../src/reprocessing.js";
import { DurableJobWorker } from "../src/jobs/worker.js";
const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((d) => rmSync(d, { recursive: true, force: true })),
);
const directory = () => {
  const d = mkdtempSync(join(tmpdir(), "omem-reprocess-"));
  directories.push(d);
  return d;
};
const fingerprint = () => ({
  model: null,
  effort: null,
  promptHash: "check",
  skillHash: "",
  toolHash: "",
});
it("persists a request and reports downstream review failure rather than dispatch success", async () => {
  const dir = directory();
  let store = new Store(dir),
    calls = 0;
  const operations = {
    validate: () => {},
    run: async () => {
      calls++;
      const child = store.jobs.enqueue({
        kind: "extract",
        inputRefs: [{}],
        roleVersion: "test@1",
        policyVersion: "test@1",
      }).job;
      return { jobIds: [child.id] };
    },
  };
  let service = new ReprocessingService(store, operations);
  const input = {
    requestId: randomUUID(),
    target: "source",
    targetId: "source",
    action: "understand",
    replace: true,
  };
  const first = service.submit(input);
  expect(service.submit(input).id).toBe(first.id);
  await service.processOnce();
  expect(calls).toBe(1);
  expect(service.get(first.id)?.state).toBe("running");
  const extraction = new DurableJobWorker(
    store.jobs,
    "extract",
    {
      extract: async (job) => {
        store.jobs.enqueue({
          kind: "review",
          inputRefs: [{}],
          roleVersion: "test@1",
          policyVersion: "test@1",
          parentJobId: job.id,
        });
        return {};
      },
    },
    { kinds: ["extract"], fingerprint },
  );
  await extraction.processOne();
  expect(service.get(first.id)?.state).toBe("running");
  const review = new DurableJobWorker(
    store.jobs,
    "review",
    {
      review: async () => {
        throw Error("review unavailable");
      },
    },
    { kinds: ["review"], fingerprint },
  );
  await review.processOne();
  expect(service.get(first.id)?.state).toBe("failed");
  await service.stop();
  store.close();
  store = new Store(dir);
  service = new ReprocessingService(store, operations);
  expect(service.get(first.id)?.state).toBe("failed");
  expect(service.get(first.id)?.jobs).toHaveLength(2);
  expect(() => service.submit({ ...input, action: "delete" })).toThrow(
    "同一请求",
  );
  service.retry(first.id);
  expect(service.get(first.id)?.state).toBe("running");
  const recovered = new DurableJobWorker(
    store.jobs,
    "review-2",
    { review: async () => ({}) },
    { kinds: ["review"], fingerprint },
  );
  await recovered.processOne();
  expect(service.get(first.id)?.state).toBe("succeeded");
  await service.stop();
  store.close();
});
it("validates before queuing or clearing any result", async () => {
  const store = new Store(directory());
  let calls = 0;
  const service = new ReprocessingService(store, {
    validate: () => {
      throw Error("agent unavailable");
    },
    run: async () => {
      calls++;
      return {};
    },
  });
  expect(() =>
    service.submit({
      requestId: randomUUID(),
      target: "article",
      targetId: "article",
      action: "write",
      replace: true,
    }),
  ).toThrow("agent unavailable");
  expect(service.list()).toEqual([]);
  expect(calls).toBe(0);
  await service.stop();
  store.close();
});
