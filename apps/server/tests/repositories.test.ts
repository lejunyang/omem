import { afterEach, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gitRemoteFixture } from "./fixtures/git-remote.js";
import { DevelopmentRunner } from "../src/development/runner.js";
import { git } from "../src/development/workspace.js";
import { repositoryLocation } from "../src/development/repositories.js";
import { RepositoryQueue } from "../src/development/repository-queue.js";
import { Store } from "../src/store.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it("fetches an authenticated remote, pins commits, and preserves older dirty worktrees across refresh", async () => {
  const f = await gitRemoteFixture();
  cleanup.push(() => f.close());
  cleanup.push(f.authentication());
  const runner = new DevelopmentRunner(join(f.root, "data"));
  writeFileSync(f.password, "wrong\n");
  await expect(
    runner.prepareRepository("workshop", f.url, "main"),
  ).rejects.toThrow();
  expect(runner.repositories.status("workshop")?.phase).toBe("failed");
  expect(runner.projects()).toHaveLength(0);
  writeFileSync(f.password, "synthetic-password\n");
  const first = await runner.prepareRepository("workshop", f.url, "main", {
    configuration: {
      name: "Workshop",
      commands: [
        {
          name: "check",
          command: process.execPath,
          args: ["--check", "value.mjs"],
          purpose: "test",
        },
      ],
    },
  });
  expect(first.origin.commit).toBe(f.initial);
  expect(f.counts.authorized).toBeGreaterThan(0);
  const clone = join(f.root, "coding-copy");
  await git(f.root, "clone", "--no-hardlinks", first.repository, clone);
  expect((await git(clone, "rev-parse", "HEAD")).trim()).toBe(f.initial);
  writeFileSync(
    join(first.repository, "value.mjs"),
    "export const value = 'local change';\n",
  );
  const commit = await f.update();
  const next = await runner.prepareRepository("workshop", f.url, "main");
  expect(next.origin.commit).toBe(commit);
  expect(next.repository).not.toBe(first.repository);
  expect(readFileSync(join(first.repository, "value.mjs"), "utf8")).toContain(
    "local change",
  );
  expect(readFileSync(join(next.repository, "value.mjs"), "utf8")).toContain(
    "2",
  );
  expect(next.commands).toEqual(first.commands);
  await expect(
    runner.prepareRepository("workshop", f.url, "missing-ref"),
  ).rejects.toThrow();
  expect(runner.repositories.status("workshop")?.phase).toBe("failed");
  expect(runner.projects()[0].origin.commit).toBe(commit);
  await runner.prepareRepository("workshop", f.url, "main");
  expect(f.counts.writes).toBe(0);
  expect(() =>
    repositoryLocation("https://user:secret@example.test/repo.git"),
  ).toThrow("凭据");
});
it("resumes a persisted preparation queue using a new host and reports a single terminal notice", async () => {
  const f = await gitRemoteFixture();
  cleanup.push(() => f.close());
  cleanup.push(f.authentication());
  const path = join(f.root, "data"),
    runner = new DevelopmentRunner(path);
  let store = new Store(path);
  const actor = {
    requestId: randomUUID(),
    principalId: "owner",
    conversationId: "one",
    visibility: "private" as const,
    userText: `准备 ${f.url} 的 main 分支`,
  };
  const queued = new RepositoryQueue(store, runner).enqueue(
    "workshop",
    f.url,
    "main",
    actor,
  );
  store.close();
  store = new Store(path);
  cleanup.push(() => store.close());
  const restored = new RepositoryQueue(store, new DevelopmentRunner(path));
  cleanup.push(() => restored.stop());
  expect(restored.enqueue("workshop", f.url, "main", actor).id).toBe(queued.id);
  await restored.processOne();
  expect(restored.read(queued.id).job.state).toBe("succeeded");
  expect(restored.read(queued.id).preparation?.commit).toBe(f.initial);
  await restored.processOne();
  expect(
    store.db.prepare("SELECT notified FROM assistant_repositories").get()
      ?.notified,
  ).toBe(1);
});
