/** Real ACP execution against a disposable, hand-authored acceptance requirement.
 * The fixture is not AI knowledge generation or a real business project. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../apps/server/src/store.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
import { requirementBrief } from "../apps/server/src/knowledge/requirements.js";
import { DevelopmentRunner } from "../apps/server/src/development/runner.js";
import { git } from "../apps/server/src/development/workspace.js";
import { freezeDevelopmentProfiles } from "../apps/server/src/agent-providers.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";

const model = loadReviewCodeModelConfig();
const configured = {
  transport: model.transport,
  command: model.command,
  args: model.args,
  model: model.model,
  effort: model.effort,
  idleTimeoutMs: model.idleTimeoutMs,
  timeoutMs: model.timeoutMs,
  maxDurationMs: model.maxDurationMs,
};
const supplied = process.env.OMEM_PROVIDER_CONFIG
  ? JSON.parse(readFileSync(process.env.OMEM_PROVIDER_CONFIG, "utf8"))
  : {
      coding: { ...configured, id: "coding-sol", name: "Coding Sol" },
      review: { ...configured, id: "review-sol", name: "Review Sol" },
    };
const profiles = freezeDevelopmentProfiles(
  profileSchema.parse(supplied.coding),
  profileSchema.parse(supplied.review),
);
const root = mkdtempSync(join(tmpdir(), "omem-providers-")),
  source = join(root, "project");
mkdirSync(source);
const original = "export const openTicket = id => ({ id, state: 'open' });\n";
writeFileSync(join(source, "tickets.mjs"), original);
writeFileSync(
  join(source, "AGENTS.md"),
  "Use ESM. Preserve openTicket. No dependencies. Do not change check.mjs. Run the configured acceptance check.\n",
);
writeFileSync(
  join(source, "check.mjs"),
  `import assert from 'node:assert/strict';
import {openTicket, completeTicket} from './tickets.mjs';
assert.deepEqual(openTicket('one'),{id:'one',state:'open'});
const input=Object.freeze({id:'two',state:'open',note:'keep'});
const result=completeTicket(input,'2026-10-06T00:00:00Z');
assert.deepEqual(result,{id:'two',state:'done',note:'keep',completedAt:'2026-10-06T00:00:00Z'});
assert.notEqual(result,input); assert.equal(input.state,'open'); console.log('Acceptance passed');
`,
);
await git(source, "init", "-q");
await git(source, "add", ".");
await git(
  source,
  "-c",
  "user.name=omem",
  "-c",
  "user.email=local@omem.invalid",
  "commit",
  "-qm",
  "acceptance fixture",
);
const store = new Store(join(root, "data")),
  repository = new KnowledgeRepository(store);
const text =
  "新增 completeTicket(ticket, completedAt)，返回新对象，状态为 done，保留所有其他字段，completedAt 原样使用传入值；不得修改输入。保留 openTicket 行为，check.mjs 必须通过。非目标：通知、上线。";
store.capture(
  {
    source: "manual",
    externalId: "acceptance",
    title: "受控验收需求",
    parts: [{ type: "text", text }],
    context: {},
  },
  { learning: false, notify: false },
);
const material = repository.materials()[0]!;
const key = "requirement:provider-acceptance";
repository.publish({
  version: 1,
  document: {
    key,
    title: "受控验收需求",
    summary: text,
    category: "acceptance",
    sections: [{ key: "goal", title: "目标", body: text + "[[c1]]" }],
    questions: [],
    citations: [
      {
        key: "c1",
        label: "验收原文",
        reason: "验收要求",
        relation: "supports",
        target: {
          kind: "material",
          key: material.key,
          startLine: 1,
          endLine: 1,
        },
        quote: text,
      },
    ],
    requirement: {
      objective: text,
      nonGoals: ["通知、上线"],
      criteria: [
        {
          id: "complete",
          description: text,
          status: "missing",
          evidence: ["c1"],
        },
      ],
      actions: [],
    },
  },
  dependencies: [
    { kind: "material", key: material.key, digest: material.digest },
  ],
  generation: {
    model: "hand-authored-fixture",
    effort: null,
    at: new Date().toISOString(),
    trace: {},
  },
  review: {
    model: "hand-authored-fixture",
    at: new Date().toISOString(),
    trace: {},
    verdict: "accepted",
  },
  reading: requirementBrief({ key, title: "受控验收需求", goal: text }),
});
const runner = new DevelopmentRunner(store.dataDir);
await runner.register("acceptance", {
  name: "受控项目",
  repository: source,
  commands: [
    {
      name: "acceptance",
      command: process.execPath,
      args: ["check.mjs"],
      purpose: "test",
      required: true,
    },
  ],
});
const run = await runner.create("acceptance", key, store, { profiles });
const started = Date.now();
let report: Record<string, unknown>;
try {
  // A changed caller default must not replace the profiles saved in the task.
  const result = await runner.execute(
    run.id,
    store,
    { ...profiles.coding, model: "must-not-replace-frozen-profile" },
    { reviewProfile: profiles.review, log: console.error },
  );
  const traces = readdirSync(run.directory)
    .filter((name) => /^(coding-agent|code-reviewer)-\d+\.json$/.test(name))
    .map((name) => ({
      name,
      ...JSON.parse(readFileSync(join(run.directory, name), "utf8")),
    }));
  report = {
    at: new Date().toISOString(),
    seconds: (Date.now() - started) / 1000,
    state: result.state,
    error: result.error,
    review: result.review,
    checks: result.checks,
    traces,
  };
  assert.equal(readFileSync(join(source, "tickets.mjs"), "utf8"), original);
  assert.equal(result.state, "ready", result.error);
  assert.equal(result.review?.verdict, "accepted");
  assert.ok(
    result.checks.length && result.checks.every((c) => c.exitCode === 0),
  );
} catch (error) {
  report ??= {
    at: new Date().toISOString(),
    seconds: (Date.now() - started) / 1000,
    error: String(error),
  };
  process.exitCode = 1;
} finally {
  const file = resolve(
    process.env.OMEM_PROVIDER_REPORT ??
      ".repo-review/runtime/research/provider-execution.json",
  );
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(report!, null, 2));
  console.log(
    JSON.stringify({
      report: file,
      seconds: report!.seconds,
      state: report!.state,
      error: report!.error,
    }),
  );
  store.close();
  rmSync(root, { recursive: true, force: true });
}
