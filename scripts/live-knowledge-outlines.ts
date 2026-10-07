/** Real ACP acceptance on small, clearly labelled synthetic source material.
 * With --api and --data-dir, retain the result in an owned development preview;
 * otherwise the whole test library is removed after writing the current report. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { Store } from "../apps/server/src/store.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
import { registerKnowledgeRoutes } from "../apps/server/src/knowledge/api.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import type {
  KnowledgeOutlineInput,
  KnowledgeOutlineView,
} from "../packages/contracts/src/knowledge-outline.js";

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return (
    process.env[`osdk_arg_${name.replaceAll("-", "_")}`] ||
    process.env[`osdk_arg_${name}`] ||
    (index < 0 ? undefined : process.argv[index + 1])
  );
};
const apiBase = option("api"),
  previewData = option("data-dir");
const external = !!apiBase;
if (external !== !!previewData)
  throw Error("Preview requires both --api and --data-dir");
if (
  external &&
  relative(resolve(".repo-review/runtime"), resolve(previewData!)).startsWith(
    "..",
  )
)
  throw Error("Only an owned .repo-review/runtime preview is allowed");
const directory = external
  ? resolve(previewData!)
  : mkdtempSync(join(tmpdir(), "omem-outline-"));
const model = loadReviewCodeModelConfig();
const profile = profileSchema.parse({
  id: "traex",
  name: "Outline acceptance",
  transport: model.transport,
  command: model.command,
  args: model.args,
  model: model.model,
  effort: model.effort,
  timeoutMs: model.timeoutMs,
  idleTimeoutMs: model.idleTimeoutMs,
  maxDurationMs: model.maxDurationMs,
});
assert.equal(profile.transport, "acp");
assert.equal(profile.model, "gpt-5.6-sol");
const store = new Store(directory),
  repository = new KnowledgeRepository(store);
const contextName = "[演示] 学会维护工单分派";
const context =
  store.contexts.list().find((c) => c.name === contextName) ??
  store.contexts.create({
    name: contextName,
    kind: "project",
    description:
      "合成的小型代码与说明，用于检查知识目录建议和文章写作；无私人材料。",
  });
for (const [path, text] of [
  [
    "src/route.ts",
    "import { regions } from './regions';\nexport function routeTicket(topic: string) {\n  const queue = regions[topic] ?? 'general';\n  return { queue, state: 'waiting' };\n}\n",
  ],
  [
    "src/regions.ts",
    "export const regions: Record<string, string> = { billing: 'finance', outage: 'operations' };\n",
  ],
  [
    "docs/routing.md",
    "# 工单分派（合成演示）\n\n这是学习用的小项目，不是真实业务。分派只决定负责队列，处理状态仍是 waiting。\n\n## 一次提交\n\nbilling 交 finance，outage 交 operations；未知主题交 general，由值班人员继续分类，避免丢单。\n\n## 修改约定\n\n新增主题只需修改 regions 映射，routeTicket 负责查表和通用回退；例如新增 refund 交 finance。部署之前还需在目标项目执行实际检查。\n\n## 当前范围\n\n未实现自由文字分类、自动提醒或去重。本示例没有真实生产环境或发布命令。\n",
  ],
] as const)
  store.capture(
    {
      source: "file",
      externalId: `outline-demo/${path}`,
      title: `[演示] ${path}`,
      parts: [{ type: "text", text }],
      context: { filePath: path, captureFormat: "verbatim-v1" },
    },
    { contextIds: [context.id], learning: false, notify: false },
  );
const keys = repository
  .materials()
  .filter((m) => store.contexts.forSource(m.sourceId).includes(context.id))
  .map((m) => m.key);
const app = external ? null : Fastify();
if (app)
  registerKnowledgeRoutes(app, {
    store,
    repository,
    prefix: "/api/knowledge",
    workspace: join(directory, "agents"),
    profile,
  });
if (external) store.close();
async function request<T = any>(
  path: string,
  payload?: unknown,
  method = payload === undefined ? "GET" : "POST",
): Promise<T> {
  if (app) {
    const result = await app.inject({
      url: "/api/knowledge" + path,
      method: method as "GET" | "POST" | "PUT" | "DELETE",
      ...(payload === undefined ? {} : { payload }),
    });
    if (result.statusCode >= 400) throw Error(result.body);
    return result.json();
  }
  const response = await fetch(new URL("/api/knowledge" + path, apiBase), {
    method,
    headers: {
      "content-type": "application/json",
      ...(process.env.OMEM_TOKEN
        ? { Authorization: `Bearer ${process.env.OMEM_TOKEN}` }
        : {}),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(JSON.stringify(result));
  return result as T;
}
const input: KnowledgeOutlineInput = {
  title: "[演示] 工单分派阅读目录",
  reader: "会编程，但第一次接手这个小项目的人",
  goal: "计划两篇互补的短文章：先用 billing 与未知主题解释分派和处理的区别，再说明如何新增 refund 主题以及修改后检查什么。不要逐文件列文章；案例是合成教学示例，不要宣称存在生产部署流程。",
  topicPath: ["演示", "工单分派"],
  materialKeys: [],
  contextIds: [context.id],
  pages: [],
};
const output = resolve(
  ".repo-review/runtime/research/knowledge-outlines/current.json",
);
mkdirSync(join(output, ".."), { recursive: true });
let draft: KnowledgeOutlineView | undefined;
try {
  draft = await request("/outlines", input);
  const before = (await request("/articles")).pages.length;
  draft = await request(`/outlines/${draft!.id}/propose`, {
    version: draft!.version,
  });
  const deadline = Date.now() + 45 * 60_000;
  let last = "";
  async function waitFor(predicate: (value: KnowledgeOutlineView) => boolean) {
    for (;;) {
      const value = await request<KnowledgeOutlineView>(
        `/outlines/${draft!.id}`,
      );
      const state =
        value.state + ":" + value.pageStatuses.map((p) => p.state).join(",");
      if (state !== last) {
        console.log(new Date().toISOString(), state, value.error ?? "");
        last = state;
      }
      if (
        value.state === "failed" ||
        value.pageStatuses.some((p) => p.state === "failed")
      )
        throw Error(
          value.error ??
            value.pageStatuses.find((p) => p.error)?.error ??
            "Article failed",
        );
      if (predicate(value)) return value;
      if (Date.now() > deadline)
        throw Error(
          "Acceptance observation limit reached; model idle timeout is unchanged",
        );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  draft = await waitFor((value) => value.state === "ready");
  assert.ok(draft.pages.length >= 1);
  assert.equal(
    (await request("/articles")).pages.length,
    before,
    "An AI proposal must not publish or save formal pages",
  );
  const proposal = structuredClone(draft);
  const edited: KnowledgeOutlineInput = {
    ...input,
    pages: [...draft.pages]
      .reverse()
      .map((page, i) => ({
        ...page,
        title: i === 0 ? page.title + "（已调整）" : page.title,
        topicPath: [...input.topicPath, i === 0 ? "修改与验证" : "先认识系统"],
      })),
  };
  draft = await request(
    `/outlines/${draft.id}`,
    { version: draft.version, draft: edited },
    "PUT",
  );
  const restored = await request<KnowledgeOutlineView>(`/outlines/${draft.id}`);
  assert.deepEqual(restored.pages, edited.pages);
  draft = await request(`/outlines/${draft.id}/apply`, {
    version: draft.version,
  });
  const confirmed = structuredClone(draft);
  const again = await request<KnowledgeOutlineView>(
    `/outlines/${draft!.id}/apply`,
    { version: draft!.version },
  );
  assert.deepEqual(
    again.appliedPages,
    draft.appliedPages,
    "Repeated confirmation must not queue duplicate work",
  );
  draft = await waitFor(
    (value) =>
      value.pageStatuses.length > 0 &&
      value.pageStatuses.every((p) => p.state === "published"),
  );
  const articles = await Promise.all(
    draft.appliedPages.map((p) =>
      request(`/articles/${encodeURIComponent(p.key)}`),
    ),
  );
  const traceStore = external ? new Store(directory) : store;
  const traces = traceStore.db
    .prepare(
      "SELECT o.output_json,o.trace_json,j.kind FROM role_outputs o JOIN jobs j ON j.id=o.job_id WHERE j.created_at>=? AND j.kind LIKE 'knowledge:%' ORDER BY j.created_at,o.attempt",
    )
    .all(proposal.createdAt)
    .map((row) => ({
      kind: row.kind,
      output: JSON.parse(String(row.output_json)),
      trace: JSON.parse(String(row.trace_json)),
    }));
  assert.ok(
    traces.some(
      (t) =>
        t.kind === "knowledge:knowledge-outliner" &&
        ((t.trace.usage?.activity ?? []) as any[]).some(
          (a) => a.kind === "mcp" || a.kind === "native",
        ),
    ),
    "Planner must actually investigate through tools",
  );
  assert.ok(
    articles.every((a) => a.citations.length > 0 && a.current),
    "Published pages retain fixed citations",
  );
  if (external) traceStore.close();
  // Retain one editable proposal for the user alongside the actual completed
  // example; subsequent edits have not been confirmed or queued.
  const editable = await request("/outlines", {
    ...edited,
    title: "[演示] 可继续编辑的工单知识目录",
  });
  writeFileSync(
    output,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        model: profile.model,
        externalPreview: external,
        materialKeys: keys,
        proposal,
        confirmed,
        completed: draft,
        editable,
        articles,
        traces,
        readerAcceptance: "待人工抽读；模型复核不是读者验收。",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: true,
      articleTitles: articles.map((a) => a.title),
      editableDraftId: editable.id,
      currentReport: output,
    }),
  );
} catch (error) {
  writeFileSync(
    output,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: false,
        draft,
        error: String(error),
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await app?.close();
  if (!external) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
