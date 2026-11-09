# More Panel And Save Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Network 工具栏“更多”面板被其他展开面板挤下去的问题，并确保保存筛选成功后弹窗关闭。

**Architecture:** “更多”是全局低频操作面板，应在 `App.vue` 中紧跟 `PanelToolbar` 渲染，位于所有业务展开面板之前。保存筛选弹窗保留现有 filter manager 状态来源，但组件内使用显式 async handler 调用确认逻辑，并通过 panel e2e 覆盖真实点击路径。

**Tech Stack:** Vue 3、TypeScript、Vitest Browser Mode、Playwright、Chrome DevTools panel harness。

---

### Task 1: 调整“更多”面板顺序

**Files:**
- Modify: `src/panel/App.vue`

- [ ] **Step 1: 移动 `MoreActionsPanel`**

将 `<MoreActionsPanel />` 移到 `<PanelToolbar />` 后面、`<DebuggerWarning />` 和 `<FilterManagerPanel />` 前面。

- [ ] **Step 2: 补中文注释**

在模板附近说明“更多”面板必须优先展示，后续新增业务面板不要插到它前面。

### Task 2: 修复保存弹窗确认路径

**Files:**
- Modify: `src/panel/components/SavePresetDialog.vue`

- [ ] **Step 1: 新增显式确认函数**

新增 `handleConfirmSavePreset`，内部 `await confirmSavePreset()`。

- [ ] **Step 2: 添加测试标识**

给保存弹窗、名称输入框和确认按钮添加 `data-testid`，供 e2e 覆盖真实交互路径。

### Task 3: e2e 覆盖

**Files:**
- Modify: `e2e/browser-commands.ts`
- Modify: `e2e/panel-network.e2e.test.ts`

- [ ] **Step 1: 新增面板顺序场景**

打开“全部筛选”和“更多”，断言“更多操作”的 DOM 位置在“全部筛选”之前。

- [ ] **Step 2: 新增保存弹窗场景**

填写临时筛选，点击“保存筛选”，输入唯一名称，点击“确认保存”，断言弹窗隐藏且启用规则数增加。

- [ ] **Step 3: 运行聚焦 e2e**

Run: `pnpm test:e2e -- e2e/panel-network.e2e.test.ts`

Expected: panel e2e 全部通过。

### Task 4: 完整验证和提交

**Files:**
- Modify: `docs/changes/bootstrap-devtools-panel/tasks.md`
- Modify: `docs/changes/bootstrap-devtools-panel/validation.md`

- [ ] **Step 1: 运行验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm test:e2e
pnpm build
git diff --check
```

Expected: 全部通过。

- [ ] **Step 2: 更新文档**

记录“更多”面板顺序修复、保存弹窗关闭验证和 e2e 结果。

- [ ] **Step 3: 提交**

Run:

```bash
git add docs src e2e
git commit -m "fix: keep more actions panel on top"
```
