# Code Comments And Network E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 强化项目注释与测试规则，并为 Network 面板刷新清空行为补充更接近真实浏览器行为的 e2e 覆盖。

**Architecture:** 先更新 `AGENTS.md` 的长期协作规则，再对 Network、DevTools API、storage、Mock、用户状态、资源搜索等高风险入口补中文意图注释。e2e 使用现有 Vitest Browser + Playwright 命令体系，优先新增 DevTools API harness 场景验证 `onNavigated` 与 `preserveLog` 的交互，而不是依赖不稳定的真实 DevTools 窗口自动化。

**Tech Stack:** Vue 3、TypeScript、Chrome Extension MV3、Vitest、Vitest Browser Mode、Playwright、pnpm。

---

### Task 1: 更新规则文档

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 扩展注释规则**

将 `AGENTS.md` 的代码组织规则改为：

```md
- 代码应尽量添加中文注释，说明“为什么这样做”和“边界是什么”，不要只重复代码表面行为。
- 每个函数应尽量使用中文注释说明用途；简单 getter、测试内联回调、Vue 事件透传等自解释函数可不强制。
- 修复问题时，应在关键判断或兼容层旁补充中文注释，说明问题背景、触发条件和修复方法。
- 复杂逻辑、Chrome/DevTools API 兼容、storage 迁移、CDP/debugger 行为、跨页面同步和异步竞态必须有中文注释说明边界。
```

- [ ] **Step 2: 扩展测试规则**

将 `AGENTS.md` 的验证规则改为：

```md
- 新增功能或修复问题时，必须优先评估是否能补 e2e；涉及 Chrome API、DevTools API、Mock、storage、用户状态、popup/devtools UI、跨页面同步或真实浏览器行为时，应尽量新增或更新 e2e。
- 单元测试用于覆盖纯函数、normalizer、解析器和边界算法；不能用单元测试替代可以稳定自动化的关键用户路径。
- 无法新增 e2e 时，需要在 `validation.md` 说明原因、风险和替代验证方式。
```

- [ ] **Step 3: 运行文档 diff 检查**

Run: `git diff -- AGENTS.md`

Expected: 注释规则和测试规则清晰落地，没有与原规则冲突。

### Task 2: 补充关键模块中文注释

**Files:**
- Modify: `src/panel/network-records.ts`
- Modify: `src/panel/use-panel-context.ts`
- Modify: `src/panel/devtools-api.ts`
- Modify: `src/shared/extension-storage.ts`
- Modify: `src/panel/persistent-state.ts`
- Modify: `src/shared/resource-search.ts`
- Modify: `src/shared/resource-tree.ts`
- Modify: `src/shared/user-state-profiles.ts`
- Modify: `src/shared/mock-rules.ts`
- Modify: `src/shared/mock-script.ts`

- [ ] **Step 1: 给近期 Network 修复路径补注释**

在 `network-records.ts` 和 `use-panel-context.ts` 中解释：

```ts
// DevTools 的 onNavigated 是刷新/导航的权威信号，避免依赖单个请求元数据导致漏清空。
// 仍保留 document 请求兜底，是为了兼容少数没有导航事件但能确认主文档请求的运行时。
```

- [ ] **Step 2: 给 Chrome API 兼容层补注释**

在 `devtools-api.ts` 和 storage 相关文件说明 callback/Promise 兼容、数字键对象、缺失 key 不回写等背景。

- [ ] **Step 3: 给资源搜索、Mock、用户状态核心函数补注释**

为解析器、normalizer、匹配函数、跨页面同步函数补中文注释，重点说明输入输出、兼容边界和为什么不能直接依赖浏览器默认行为。

- [ ] **Step 4: 避免低价值注释**

检查新增注释，不添加如下内容：

```ts
// 设置变量
// 返回结果
// 调用函数
```

### Task 3: 新增 Network 刷新行为 e2e

**Files:**
- Create: `e2e/panel-network.e2e.test.ts`
- Modify: `e2e/browser-commands.ts`

- [ ] **Step 1: 增加 e2e command 类型**

在 `browser-commands.ts` 添加：

```ts
export interface PanelNetworkPreserveLogScenarioResult {
  clearedWithoutPreserveLog: boolean;
  keptWithPreserveLog: boolean;
  recordsAfterClear: number;
  recordsAfterPreserve: number;
}
```

- [ ] **Step 2: 实现 DevTools API harness 场景**

新增 command，打开 `panel.html` 并在页面初始化前注入最小 `chrome.devtools.network` mock，触发 `onRequestFinished` 和 `onNavigated`：

```ts
runPanelNetworkPreserveLogScenario: createPlaywrightCommand(async (context) => {
  const page = await context.newPage();
  try {
    await installDevtoolsPanelHarness(page);
    await page.goto(chrome.runtime.getURL("panel.html"));
    await page.evaluate(() => {
      window.__advancedNetworkHarness.emitRequest("https://example.com/api/a");
      window.__advancedNetworkHarness.emitNavigated("https://example.com/");
    });
    const recordsAfterClear = await page.getByTestId("request-row").count();
    await page.getByLabel("保留日志").check();
    await page.evaluate(() => {
      window.__advancedNetworkHarness.emitRequest("https://example.com/api/b");
      window.__advancedNetworkHarness.emitNavigated("https://example.com/next");
    });
    const recordsAfterPreserve = await page.getByTestId("request-row").count();
    return {
      clearedWithoutPreserveLog: recordsAfterClear === 0,
      keptWithPreserveLog: recordsAfterPreserve > 0,
      recordsAfterClear,
      recordsAfterPreserve
    };
  } finally {
    await page.close();
  }
})
```

- [ ] **Step 3: 新增 e2e 断言文件**

`e2e/panel-network.e2e.test.ts` 应断言：

```ts
expect(result).toMatchObject({
  clearedWithoutPreserveLog: true,
  keptWithPreserveLog: true,
  recordsAfterClear: 0
});
expect(result.recordsAfterPreserve).toBeGreaterThan(0);
```

- [ ] **Step 4: 运行 e2e**

Run: `pnpm test:e2e`

Expected: popup 既有 e2e 与新增 panel network e2e 全部通过。

### Task 4: 验证、记录和提交

**Files:**
- Modify: `docs/changes/bootstrap-devtools-panel/validation.md`

- [ ] **Step 1: 运行完整验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: 全部通过；构建中测试页 fixture 提示仍可接受。

- [ ] **Step 2: 更新验证记录**

在 `validation.md` 记录注释规则、测试规则、e2e 覆盖和命令结果。

- [ ] **Step 3: 提交**

Run:

```bash
git status --short
git add AGENTS.md docs/superpowers/plans/2026-07-07-code-comments-and-network-e2e.md docs/changes/bootstrap-devtools-panel/validation.md src e2e
git commit -m "test: cover network navigation clearing"
```

Expected: 只提交本轮相关文件。

