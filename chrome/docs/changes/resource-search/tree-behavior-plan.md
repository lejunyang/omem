# 资源树行为修正计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正资源搜索树的默认过滤、命名、折叠、路径压缩和 Source Map 点击回退行为。

**Architecture:** 继续把树构建逻辑放在 `src/shared/resource-tree.ts`，通过纯函数实现过滤和路径压缩。Vue 组件只负责状态、默认折叠和点击交互，Panel context 负责 `openResource` 失败回退。

**Tech Stack:** Vue 3、TypeScript、Vitest、Chrome DevTools `openResource`。

---

### Task 1: 树构建规则

**Files:**
- Modify: `src/shared/resource-tree.ts`
- Test: `src/shared/resource-tree.test.ts`

- [x] 增加 `skipChromeExtensionResources` 输入选项。
- [x] 默认过滤 `chrome-extension://` generated 资源。
- [x] 如果 Source Map 源文件关联的 generated 资源被过滤，则源文件也过滤。
- [x] 将 unframed 分组显示为 `Top`。
- [x] 压缩只有单个子目录且没有文件兄弟的目录链，例如 `assets/src/js/service`。

### Task 2: UI 状态和默认折叠

**Files:**
- Modify: `src/panel/components/ResourceSearchPanel.vue`
- Modify: `src/panel/use-resource-search-context.ts`

- [x] 增加 `跳过 chrome-extension 资源` checkbox，默认选中。
- [x] 默认折叠非文件节点，只显示顶层节点。
- [x] 树展开状态在构建结果变化时不强制展开。

### Task 3: Source Map 点击回退

**Files:**
- Modify: `src/panel/use-resource-search-context.ts`

- [x] 打开 source mapped resource 时优先打开 original URL。
- [x] original URL 打开失败时回退到关联 generated resource。
- [x] 没有可打开 URL 时展示错误提示。

### Task 4: 验证和文档

**Files:**
- Modify: `docs/changes/resource-search/tasks.md`
- Modify: `docs/changes/resource-search/validation.md`

- [x] 运行资源树聚焦测试。
- [x] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`。
- [x] 更新验证记录。
