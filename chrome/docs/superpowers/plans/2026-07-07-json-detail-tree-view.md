# Json Detail Tree View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在请求详情 Payload 和 Response 中为 JSON 字符串提供可展开的树状视图，并支持原位切换回原文。

**Architecture:** JSON 解析与树节点建模放在 `src/shared/json-viewer.ts`，保持 UI 与解析边界解耦。递归展示由 `src/panel/components/JsonTreeView.vue` 承担，`RequestDetail.vue` 只负责判断当前文本是否可展示 JSON 视图和切换状态。e2e 复用现有 panel harness，模拟带 JSON payload/response 的请求后验证树节点展开行为。

**Tech Stack:** Vue 3、TypeScript、Vitest、Vitest Browser Mode、Playwright、Chrome DevTools extension harness。

---

### Task 1: JSON 解析模型

**Files:**
- Create: `src/shared/json-viewer.ts`
- Create: `src/shared/json-viewer.test.ts`

- [ ] **Step 1: 写解析和节点测试**

覆盖对象、数组、基础类型、非法 JSON 和空内容。

- [ ] **Step 2: 实现 JSON 解析模型**

导出 `parseJsonView(text)`、`createJsonTreeNode(value, key, path)` 和 `formatJsonPrimitive(value)`。

- [ ] **Step 3: 运行聚焦单测**

Run: `pnpm exec vitest run src/shared/json-viewer.test.ts`

Expected: 新增测试通过。

### Task 2: JSON 树组件和详情接入

**Files:**
- Create: `src/panel/components/JsonTreeView.vue`
- Modify: `src/panel/components/RequestDetail.vue`
- Modify: `src/panel/panel.css`

- [ ] **Step 1: 新增递归树组件**

组件接收 `node` 和 `defaultExpandedDepth`，支持对象/数组节点展开折叠，基础类型展示类型和值。

- [ ] **Step 2: 接入 Payload/Response 原位切换**

在 `RequestDetail.vue` 中为可解析 JSON 的 Payload/Response 显示按钮，按钮文案在“查看 JSON 视图”和“查看原文”之间切换。

- [ ] **Step 3: 补详情样式**

新增 `.json-viewer-*` 样式，保持按钮不压缩、树结构紧凑、长字符串可换行。

### Task 3: e2e 覆盖

**Files:**
- Modify: `e2e/panel-network-harness.html`
- Modify: `e2e/browser-commands.ts`
- Modify: `e2e/panel-network.e2e.test.ts`

- [ ] **Step 1: 扩展 harness 请求**

让 `emitRequest` 可接收 `requestBody`、`responseBody` 和 `url`。

- [ ] **Step 2: 新增 browser command**

新增 `runPanelJsonDetailScenario`，模拟 JSON 请求，选择请求，分别进入 Payload 和 Response，切换 JSON 视图并展开节点。

- [ ] **Step 3: 新增 e2e 断言**

断言 Payload 和 Response 的 JSON 树按钮可见，节点可展开，嵌套字段可见。

- [ ] **Step 4: 运行聚焦 e2e**

Run: `pnpm test:e2e -- e2e/panel-network.e2e.test.ts`

Expected: panel e2e 全部通过。

### Task 4: 完整验证和提交

**Files:**
- Modify: `docs/changes/bootstrap-devtools-panel/validation.md`

- [ ] **Step 1: 运行完整验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm test:e2e
pnpm build
git diff --check
```

Expected: 全部通过。

- [ ] **Step 2: 更新验证记录**

记录 JSON 树视图能力、e2e 覆盖和命令结果。

- [ ] **Step 3: 提交**

Run:

```bash
git status --short
git add docs src e2e
git commit -m "feat: add json detail tree view"
```

Expected: 工作区干净，只提交本轮相关文件。
