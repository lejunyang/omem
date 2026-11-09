# 资源树 UI 改造计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将资源搜索页左侧从卡片列表改为接近 Chrome Sources 的可展开资源树，并支持点击资源定位到源代码。

**Architecture:** 新增 shared 纯函数负责把 `Frame -> Origin -> Path -> File` 归并成树，Vue 组件只负责渲染和点击事件。Panel context 增加打开 generated/source mapped 资源的方法，并保留忽略资源操作。

**Tech Stack:** Vue 3、TypeScript、Vitest、Chrome DevTools `openResource`。

---

### Task 1: 资源树模型

**Files:**
- Create: `src/shared/resource-tree.ts`
- Test: `src/shared/resource-tree.test.ts`

- [x] 新增 `buildResourceTree()`，输入 frame、generated resources、source mapped resources，输出 `top -> frame/origin/path/file` 树。
- [x] 默认过滤 `contentState === "skipped"` 的资源，避免 png/font/media 污染主树。
- [x] 支持 `showSkippedResources` 开关把跳过资源放回树。
- [x] 将 source mapped 文件放到 `Source Map 源文件` 分组下，保留 original path。

### Task 2: 点击定位

**Files:**
- Modify: `src/panel/use-resource-search-context.ts`

- [x] 新增 `openGeneratedResource(resource)`。
- [x] 新增 `openSourceMappedResource(resource)`。
- [x] 解析前资源打开 `resource.url`。
- [x] 解析后资源优先打开 `resource.url`，为空时回退到关联 generated resource。

### Task 3: 左侧资源树 UI

**Files:**
- Modify: `src/panel/components/ResourceSearchPanel.vue`
- Modify: `src/panel/panel.css`

- [x] 将左侧卡片列表替换成紧凑树。
- [x] 文件节点可点击打开源代码。
- [x] 文件节点保留右侧忽略按钮。
- [x] 顶部统计改为 `可搜索 / 总计`，并提供“显示已跳过资源”开关。

### Task 4: 验证与文档

**Files:**
- Modify: `docs/changes/resource-search/tasks.md`
- Modify: `docs/changes/resource-search/validation.md`

- [x] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`。
- [x] 更新资源搜索验证记录。
