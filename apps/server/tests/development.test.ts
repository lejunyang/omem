import { RoleBundleRegistry } from "../src/agent-runtime/bundles.js";
import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { developmentProjectSchema } from "../../../packages/contracts/src/development.js";
import {
  codeTools,
  fingerprint,
  git,
  runCommand,
  saveJson,
  snapshotCommit,
} from "../src/development/workspace.js";
import { DevelopmentRunner } from "../src/development/runner.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { requirementBrief } from "../src/knowledge/requirements.js";
import { RequirementTasks } from "../src/knowledge/requirement-tasks.js";
import { stableDigest } from "../src/storage/digest.js";
import {
  captureDevelopmentResult,
  developmentResult,
} from "../src/development/results.js";
import { assertRequirementBasis } from "../src/development/requirement-basis.js";
import { ProjectChecks } from "../src/development/checks.js";
import { configureProjectChecks } from "../src/development/project-configuration.js";
import { inspectRequirementChange } from "../src/development/replanning.js";
const directories: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of directories.splice(0))
    rmSync(d, { recursive: true, force: true });
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-dev-test-"));
  directories.push(dir);
  const root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "Follow project conventions");
  writeFileSync(join(root, "src/AGENTS.md"), "Do not mutate arguments");
  writeFileSync(join(root, "src/a.js"), "export const value = 1;\n");
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  const project = developmentProjectSchema.parse({
    name: "Test",
    repository: root,
    commands: [
      {
        name: "check",
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        purpose: "test",
      },
    ],
  });
  const store = new Store(join(dir, "data"));
  stores.push(store);
  const repository = new KnowledgeRepository(store);
  const captured = store.capture(
    {
      source: "manual",
      externalId: "r",
      title: "Requirement",
      parts: [
        {
          type: "text",
          text: "Ming will implement the new function. No due date agreed.",
        },
      ],
      context: {},
    },
    { learning: false, notify: false },
  );
  const material = repository.materials()[0]!;
  const publish = (
    title = "Implement function",
    status: "open" | "done" = "open",
  ) =>
    repository.publish({
      version: 1,
      document: {
        key: "requirement:test",
        title: "Test",
        summary: "Goal",
        category: "Test",
        sections: [
          {
            key: "goal",
            title: "Goal",
            body: "Implementation is required.[[c1]]",
          },
        ],
        questions: [],
        citations: [
          {
            key: "c1",
            label: "Requirement",
            reason: "Goal",
            relation: "supports",
            target: {
              kind: "material",
              key: material.key,
              startLine: 1,
              endLine: 1,
            },
            quote: material.text,
          },
        ],
        requirement: {
          objective: "Implement function",
          nonGoals: [],
          criteria: [
            {
              id: "function",
              description: "Return new value",
              status: "missing",
              evidence: ["c1"],
            },
          ],
          actions: [
            {
              id: "implement",
              title,
              detail: "Read the project rules",
              owner: "Ming",
              waitingOn: null,
              dueAt: null,
              dueExpression: null,
              status,
              certainty: "confirmed",
              evidence: ["c1"],
            },
          ],
        },
      },
      dependencies: [
        { kind: "material", key: material.key, digest: material.digest },
      ],
      generation: {
        model: "fixture",
        effort: null,
        at: new Date().toISOString(),
        trace: {},
      },
      review: {
        model: "fixture",
        at: new Date().toISOString(),
        trace: {},
        verdict: "accepted",
      },
      reading: requirementBrief({
        key: "requirement:test",
        title: "Test",
        goal: "Implement function",
        contextIds: undefined,
      }),
    });
  const article = publish();
  return { dir, root, project, store, repository, publish, article };
}
it("requires applicable nested rules before edits and provides read-only review tools", async () => {
  const { dir, root, project } = await setup(),
    base = (await git(root, "rev-parse", "HEAD")).trim();
  const tools = codeTools({
    root,
    base,
    project,
    readOnly: false,
    logs: join(dir, "logs"),
    onCheck: () => {},
  });
  const call = (name: string, args: any) =>
    tools.find((t) => t.name === name)!.run(args, {} as any);
  const hash = stableDigest(readFileSync(join(root, "src/a.js"), "utf8"));
  expect(() =>
    call("write_code", {
      path: "src/a.js",
      expectedHash: hash,
      text: "export const value = 2;",
    }),
  ).toThrow("project_rules");
  await call("project_rules", { path: "src/a.js" });
  await call("write_code", {
    path: "src/a.js",
    expectedHash: hash,
    text: "export const value = 2;",
  });
  expect(() =>
    call("write_code", { path: "src/a.js", expectedHash: hash, text: "old" }),
  ).toThrow("文件已变化");
  expect(
    codeTools({
      root,
      base,
      project,
      readOnly: true,
      logs: join(dir, "logs"),
      onCheck: () => {},
    }).some((t) => t.name === "write_code"),
  ).toBe(false);
  symlinkSync(dir, join(root, "escape"));
  expect(() =>
    call("read_code", { path: "escape/repo/AGENTS.md", startLine: 1 }),
  ).toThrow("符号链接");
  symlinkSync(join(dir, "missing-target"), join(root, "broken"));
  expect(() =>
    call("write_code", {
      path: "broken",
      expectedHash: null,
      text: "must stay inside",
    }),
  ).toThrow("符号链接");
  const result = await runCommand(root, project, "check", join(dir, "logs"));
  expect(result.exitCode).toBe(3);
});
it("applies only the reviewed isolated checkout and protects a changed source worktree", async () => {
  const { dir, root, project, store } = await setup(),
    runner = new DevelopmentRunner(join(dir, "data"));
  await runner.register("test", project);
  const run = await runner.create("test", "requirement:test", store);
  writeFileSync(join(run.checkout, "src/a.js"), "export const value = 2;\n");
  run.head = await snapshotCommit(run.checkout, "implementation");
  run.state = "ready";
  run.reviewedFingerprint = await fingerprint(run.checkout);
  runner.save(run);
  writeFileSync(
    join(run.directory, "changes.patch"),
    "malicious or stale exported patch",
  );
  await runner.apply(run.id);
  expect(readFileSync(join(root, "src/a.js"), "utf8")).toContain("2");
  expect(await git(root, "log", "-1", "--format=%s")).toContain("initial");
  await expect(
    runner.create("test", "requirement:test", store),
  ).rejects.toThrow("未提交");
});
it("captures execution once, keeps its history and allows progress-only requirement updates without accepting changed criteria", async () => {
  const { dir, root, project, store, repository, article } = await setup();
  const runner = new DevelopmentRunner(join(dir, "data"));
  await runner.register("outcome", project);
  const run = await runner.create("outcome", article.document.key, store);
  writeFileSync(join(run.checkout, "src/a.js"), "export const value = 2;\n");
  run.head = await snapshotCommit(run.checkout, "implementation");
  run.state = "ready";
  run.reviewedFingerprint = await fingerprint(run.checkout);
  writeFileSync(
    join(run.directory, "changes.patch"),
    await git(run.checkout, "diff", run.base, "HEAD"),
  );
  run.checks.push(
    await runCommand(
      run.checkout,
      project,
      "check",
      join(run.directory, "logs"),
    ),
  );
  runner.save(run);
  const first = captureDevelopmentResult(store, run, {
    id: "job-1",
    state: "succeeded",
  });
  expect(
    captureDevelopmentResult(store, run, { id: "job-1", state: "succeeded" })
      .revisionId,
  ).toBe(first.revisionId);
  expect(first.learningJob?.kind).toBe("extract_claims");
  expect(first.citedByRequirement).toBe(false);
  const text = repository.resolveMaterial(first.materialKey)!.material.text;
  expect(text).toContain("退出码：3");
  expect(text).toContain("尚未应用到登记仓库");
  expect(text).toContain("+export const value = 2");
  expect(
    repository
      .materialsForPlan(article.reading!)
      .some((m) => m.key === first.materialKey),
  ).toBe(true);
  const progress = structuredClone(article);
  progress.document.requirement!.criteria[0]!.status = "implemented";
  repository.publish(progress);
  expect(repository.get(article.document.key)!.revision).not.toBe(
    run.requirementRevision,
  );
  expect(() => assertRequirementBasis(repository, run)).not.toThrow();
  const changed = structuredClone(progress);
  changed.document.requirement!.criteria[0]!.description =
    "Return different API and value";
  repository.publish(changed);
  await expect(runner.apply(run.id)).rejects.toThrow("验收条件已变化");
  expect(await git(root, "status", "--porcelain")).toBe("");
  repository.publish(progress);
  const applied = await runner.apply(run.id);
  const second = captureDevelopmentResult(store, applied, {
    id: "job-2",
    state: "succeeded",
  });
  expect(second.sourceId).toBe(first.sourceId);
  expect(second.revisionId).not.toBe(first.revisionId);
  expect(store.revision(first.revisionId)).not.toBeNull();
  expect(developmentResult(store, run.id)?.revisionId).toBe(second.revisionId);
  expect(store.tasks()).toHaveLength(0);
  // An original source changing, even before the requirement is rewritten, is
  // not progress and cannot use the old acceptance basis.
  store.capture(
    {
      source: "manual",
      externalId: "r",
      title: "Requirement",
      parts: [{ type: "text", text: "New contract" }],
      context: {},
    },
    { learning: false },
  );
  expect(() => assertRequirementBasis(repository, run)).toThrow(
    "验收条件已变化",
  );
});
it("maintains one linked task across accepted requirement updates and preserves manual correction", async () => {
  const { store, article, publish } = await setup(),
    service = new RequirementTasks(store);
  service.follow(article.document.key, "implement", article.revision);
  service.sync(article);
  expect(store.tasks()).toHaveLength(1);
  expect(store.tasks()[0]!.ownerId).toBe("owner");
  expect(store.tasks()[0]!.detail).toContain("Ming");
  service.sync(publish("Implement the new API"));
  expect(store.tasks()).toHaveLength(1);
  expect(store.tasks()[0]!.title).toContain("new API");
  const task = store.tasks()[0]!;
  store.setTaskStatus(String(task.id), "cancelled", Number(task.version));
  service.sync(publish("Implement the API", "done"));
  expect(store.tasks()[0]!.status).toBe("cancelled");
  expect(service.board(article.document.key).links[0]!.error).toContain("修改");
});

it("links an existing personal task without creating a duplicate or rewriting it", async () => {
  const { store, article } = await setup(), service = new RequirementTasks(store);
  service.follow(article.document.key, "implement", article.revision);
  const existing = store.tasks()[0]!;
  store.db.prepare("DELETE FROM requirement_tasks WHERE page_key=?").run(article.document.key);
  const before = store.tasks()[0]!;
  const board = service.follow(article.document.key, "implement", article.revision, String(existing.id));
  expect(board.links[0]?.task_id).toBe(existing.id);
  expect(store.tasks()).toHaveLength(1);
  expect(store.tasks()[0]).toEqual(before);
});

it("loads executable coding and independent review roles with their actual schemas", () => {
  const registry = new RoleBundleRegistry();
  expect(registry.load("coding-agent").manifest.output_schema).toBe(
    "ImplementationResult.v1",
  );
  expect(registry.load("code-reviewer").manifest.output_schema).toBe(
    "ImplementationReview.v1",
  );
});

it("sends failures back for repair and gives the independent reviewer no developer self-assessment", async () => {
  const { dir, root, store, project } = await setup();
  const { RoleRuntimeGateway } = await import(
    "../src/agent-runtime/gateway.js"
  );
  const { profileSchema } = await import(
    "../../../packages/contracts/src/index.js"
  );
  const { vi } = await import("vitest");
  project.commands = [
    {
      name: "behavior",
      command: process.execPath,
      args: [
        "-e",
        "import('./src/a.js').then(m=>process.exit(m.value===2?0:1))",
      ],
      cwd: ".",
      purpose: "test",
      required: true,
      timeoutMs: 10000,
    },
  ];
  const runner = new DevelopmentRunner(join(dir, "data"));
  await runner.register("repair", project);
  const run = await runner.create("repair", "requirement:test", store);
  let writes = 0,
    reviews = 0;
  const spy = vi
    .spyOn(RoleRuntimeGateway.prototype, "run")
    .mockImplementation(async (input) => {
      let result: unknown;
      if (input.roleId === "coding-agent") {
        writes++;
        if (writes === 2)
          writeFileSync(
            join(run.checkout, "src/a.js"),
            "export const value=2;\n",
          );
        if (writes === 2)
          expect(input.context.task?.review).toHaveProperty(
            "verdict",
            "changes_requested",
          );
        result = {
          schema_version: 1,
          summary: "AUTHOR CLAIM SHOULD NOT BIAS REVIEW",
          criteria: [
            { id: "function", status: "implemented", note: "Implemented" },
          ],
          blockers: [],
        };
      } else {
        reviews++;
        expect(JSON.stringify(input.context)).not.toContain("AUTHOR CLAIM");
        result = {
          schema_version: 1,
          verdict: reviews === 1 ? "changes_requested" : "accepted",
          summary: reviews === 1 ? "Behavior is wrong" : "Behavior matches",
          criteria: [
            {
              id: "function",
              status: reviews === 1 ? "failed" : "passed",
              detail: "Ran the registered behavior check",
            },
          ],
          findings:
            reviews === 1
              ? [
                  {
                    priority: "high",
                    path: "src/a.js",
                    line: 1,
                    issue: "Returns old value",
                    change: "Return 2",
                  },
                ]
              : [],
        };
      }
      return {
        result: input.validateOutput?.(result) ?? result,
        trace: { roleId: input.roleId },
      } as any;
    });
  try {
    const result = await runner.execute(
      run.id,
      store,
      profileSchema.parse({
        id: "traex",
        name: "Fixture",
        transport: "acp",
        command: "traex",
        args: [],
      }),
    );
    expect(result.state).toBe("ready");
    expect(writes).toBe(2);
    expect(reviews).toBe(2);
    expect(result.checks.map((c) => c.exitCode)).toEqual([1, 0]);
    expect(readFileSync(join(root, "src/a.js"), "utf8")).toContain("1");
  } finally {
    spy.mockRestore();
  }
});

it("reports missing external setup as blocked before starting a model", async () => {
  const { dir, store, project } = await setup();
  const { profileSchema } = await import(
    "../../../packages/contracts/src/index.js"
  );
  const runner = new DevelopmentRunner(join(dir, "data"));
  runner.capabilities.register({
    version: 1,
    id: "design",
    name: "Design",
    description: "Read design",
    cli: [
      {
        name: "read",
        description: "Read",
        readOnly: true,
        command: "omem-missing-capability-binary",
      },
    ],
  });
  await runner.register("blocked", { ...project, capabilities: ["design"] });
  const run = await runner.create("blocked", "requirement:test", store);
  const result = await runner.execute(
    run.id,
    store,
    profileSchema.parse({
      id: "traex",
      name: "Not invoked",
      transport: "acp",
      command: "traex",
      args: [],
    }),
  );
  expect(result.state).toBe("blocked");
  expect(result.error).toContain("missingExecutables");
  expect(result.attempt).toBe(0);
  expect(result.pid).toBeNull();
});

it("shares real checks across coding/host/review and invalidates changed code, commands and restarted environments", async () => {
  const { dir, root, project } = await setup();
  writeFileSync(join(root, ".gitignore"), ".cache/\n");
  const execute =
    "const fs=require('fs');fs.mkdirSync('.cache',{recursive:true});fs.appendFileSync('.cache/executions','run\\n');if(fs.existsSync('.cache/should-fail'))process.exit(4)";
  const configured = configureProjectChecks(
    { ...project, instructions: "Keep public API" },
    {
      commands: [
        {
          name: "behavior",
          command: process.execPath,
          args: ["-e", execute],
          purpose: "test",
        },
      ],
      sources: [
        {
          path: "AGENTS.md",
          hash: stableDigest(readFileSync(join(root, "AGENTS.md"), "utf8")),
        },
      ],
      summary: "Local behavior",
      gaps: [],
    },
  );
  expect(configured.instructions).toBe("Keep public API");
  const results: import("../src/development/workspace.js").CommandResult[] = [];
  const checks = new ProjectChecks(
    root,
    () => configured,
    results,
    join(dir, "checks"),
    () => {},
  );
  expect((await checks.run("behavior")).reused).toBeUndefined();
  expect((await checks.run("behavior")).reused).toBe(true);
  expect((await checks.run("behavior")).reused).toBe(true);
  expect(results).toHaveLength(1);
  writeFileSync(join(root, "src/a.js"), "export const value=2;\n");
  await checks.run("behavior");
  configured.commands[0]!.args[1] += ";process.exit(3)";
  expect((await checks.run("behavior")).exitCode).toBe(3);
  expect((await checks.run("behavior")).reused).toBeUndefined();
  configured.commands[0]!.args[1] = execute;
  expect((await checks.run("behavior")).reused).toBe(true);
  await new ProjectChecks(
    root,
    () => configured,
    results,
    join(dir, "checks"),
    () => {},
  ).run("behavior");
  expect(results).toHaveLength(5);
  writeFileSync(join(root, ".cache/should-fail"), "environment problem");
  expect(
    (await checks.run("behavior", "Reproduce environment failure")).exitCode,
  ).toBe(4);
  expect((await checks.status()).results.some((r) => r.reusable)).toBe(false);
  rmSync(join(root, ".cache/should-fail"));
  expect((await checks.run("behavior")).reused).toBeUndefined();
  expect(results).toHaveLength(7);
  expect(
    readFileSync(join(root, ".cache/executions"), "utf8").trim().split("\n"),
  ).toHaveLength(7);
});

it("keeps the checkout and original implementation when adopting reviewed changed requirements", async () => {
  const { dir, store, repository, article, project } = await setup();
  const runner = new DevelopmentRunner(join(dir, "data"));
  await runner.register("continuation", project);
  const run = await runner.create("continuation", article.document.key, store);
  writeFileSync(join(run.checkout, "src/a.js"), "export const value=2;\n");
  run.head = await snapshotCommit(run.checkout, "first implementation");
  run.state = "ready";
  run.reviewedFingerprint = await fingerprint(run.checkout);
  runner.save(run);
  const progress = structuredClone(article);
  progress.document.requirement!.criteria[0]!.status = "verified";
  repository.publish(progress);
  expect(inspectRequirementChange(repository, run)).toBeNull();
  const changed = structuredClone(progress);
  changed.document.requirement!.criteria[0]!.description =
    "Return 3 while preserving the API";
  const latest = repository.publish(changed);
  expect(
    inspectRequirementChange(repository, run)?.change.criteria.changed,
  ).toEqual(["function"]);
  const { RoleRuntimeGateway } = await import(
    "../src/agent-runtime/gateway.js"
  );
  const { profileSchema } = await import(
    "../../../packages/contracts/src/index.js"
  );
  const { vi } = await import("vitest");
  const spy = vi
    .spyOn(RoleRuntimeGateway.prototype, "run")
    .mockImplementation(async (input) => {
      expect(input.context.task?.requirementChanges).toHaveProperty(
        "fromRevision",
        article.revision,
      );
      expect(readFileSync(join(run.checkout, "src/a.js"), "utf8")).toContain(
        "value=2",
      );
      return {
        result: {
          schema_version: 1,
          summary: "Needs business detail",
          criteria: [
            { id: "function", status: "blocked", note: "Await clarification" },
          ],
          blockers: ["Which compatibility behavior?"],
        },
        trace: {},
      } as any;
    });
  try {
    const updated = await runner.execute(
      run.id,
      store,
      profileSchema.parse({
        id: "traex",
        name: "Fixture",
        transport: "acp",
        command: "traex",
        args: [],
      }),
      { replan: true },
    );
    expect(updated.requirementRevision).toBe(latest.revision);
    expect(updated.base).toBe(run.base);
    expect(updated.checkout).toBe(run.checkout);
    expect(updated.changes).toHaveLength(1);
    expect(updated.reviewedFingerprint).toBeUndefined();
    expect(updated.state).toBe("blocked");
    expect(runner.list()).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});
