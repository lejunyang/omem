/** Real Sol delegates preparation to the production worker; synthetic auth-only Git HTTP server. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitRemoteFixture } from "../apps/server/tests/fixtures/git-remote.js";
import { buildApp } from "../apps/server/src/app.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
delete process.env.OMEM_REPO_ROOT;
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "Repository preparation acceptance",
  transport: model.transport,
  command: model.command,
  args: model.args,
  model: model.model,
  effort: model.effort,
  idleTimeoutMs: model.idleTimeoutMs,
  timeoutMs: model.timeoutMs,
  maxDurationMs: model.maxDurationMs,
});
assert.equal(profile.model, "gpt-5.6-sol");
const remote = await gitRemoteFixture(),
  restoreAuthentication = remote.authentication();
const output = resolve(".repo-review/runtime/research/repositories.json");
mkdirSync(join(output, ".."), { recursive: true });
const system = await buildApp({
  profiles: [profile],
  assistant: { profileId: "traex" },
  notifications: { mode: "instant" },
  learning: { enabled: false, profileId: "traex", pollMs: 1000 },
  lark: { enabled: false, pollMs: 1000 },
  retrieval: { enabled: false, osdkModel: "memory-zh" },
  decisions: { mode: "off" },
  captureRoots: [],
  dataDir: join(remote.root, "data"),
  agentCwd: remote.root,
  host: "127.0.0.1",
  port: 0,
});
const conversation = system.assistant.conversations.open({
  principalId: "owner",
  channel: "web",
  chatId: "prepare",
  visibility: "private",
});
const turns: unknown[] = [],
  started = Date.now();
let passed = false;
async function ask(userText: string) {
  const reply = await system.assistant.turn({
    conversationId: conversation.id,
    userText,
  });
  const turn = system.assistant.conversations.turn(reply.turn.id)!;
  const workspace = (turn.toolActions as any[]).find(
    (t) => t.tool === "research",
  )?.trace?.workspace;
  const read = (name: string) =>
    workspace && existsSync(join(workspace, name))
      ? readFileSync(join(workspace, name), "utf8")
      : null;
  turns.push({
    question: userText,
    answer: turn.result,
    status: turn.inputMessageRefs,
    actions: turn.toolActions,
    trace: read("trace.json"),
    research: read("research.jsonl"),
  });
  console.log(turn.result);
  assert.equal(
    turn.inputMessageRefs.status,
    "done",
    JSON.stringify(turn.inputMessageRefs),
  );
  return turn;
}
try {
  // Do not start the web worker automatically: process the same production queue
  // between turns so the observed failure and retry are deterministic.
  writeFileSync(remote.password, "wrong\n");
  await ask(
    `请准备这个 Git 仓库 ${remote.url} 的 main 分支，项目别名用 workshop。只准备本地项目，暂不编码，不安装依赖，不推送。`,
  );
  const first = system.work.repositories.list()[0];
  assert.ok(first, "主助手没有派发准备任务");
  await system.work.repositories.processOne();
  assert.equal(system.work.repositories.read(first.id).job.state, "failed");
  await ask(
    "刚才 workshop 仓库准备得怎样？请读实际状态，告诉我缺少什么，不要自动改分支或地址。",
  );
  writeFileSync(remote.password, "synthetic-password\n");
  await ask(
    "服务机器的 Git 登录已经修好，请重试刚才 workshop 仓库，仍用 main 分支。继续只准备仓库，不编码或推送。",
  );
  const second = system.work.repositories.list()[0]!;
  assert.notEqual(second.id, first.id);
  await system.work.repositories.processOne();
  const ready = system.work.repositories.read(second.id);
  assert.equal(ready.job.state, "succeeded", JSON.stringify(ready));
  assert.equal(ready.preparation.commit, remote.initial);
  assert.equal(system.work.repositories.read(first.id).job.state, "failed");
  assert.equal(
    system.work.repositories.read(first.id).preparation.phase,
    "failed",
  );
  await ask(
    "现在 workshop 的准备结果是什么？给我实际提交和本地位置，说明能否直接开始检查。只查询，不启动新任务。",
  );
  assert.equal(system.work.repositories.list().length, 2);
  assert.equal(system.work.development.list().length, 0);
  assert.equal(remote.counts.writes, 0);
  passed = true;
} finally {
  writeFileSync(
    output,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed,
        seconds: (Date.now() - started) / 1000,
        model: profile.model,
        turns,
        tasks: system.work.repositories.list(),
        projects: system.work.development.runner.projects(),
        transport: remote.counts,
        scope:
          "Real Traex/Sol conversations and durable worker; synthetic authenticated read-only HTTP Git remote. No real private hosting, SSH, Figma, coding or quick-model accuracy acceptance.",
      },
      null,
      2,
    ),
  );
  await system.app.close();
  restoreAuthentication();
  await remote.close();
  console.log(
    JSON.stringify({ passed, output, seconds: (Date.now() - started) / 1000 }),
  );
}
