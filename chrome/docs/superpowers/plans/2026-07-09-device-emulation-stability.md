# Device Emulation Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复设备模拟在真实页面、刷新、关闭和打开 DevTools 后出现的 viewport 异常，并增强 touch 输入模拟能力说明。

**Architecture:** 修复集中在 `src/background.ts` 的 CDP 生命周期：移除真实页面不稳定的 `Emulation.setVisibleSize`，导航后对已启用 tab 重放设备模拟，关闭时按稳定顺序清理并延迟释放 debugger。UI 只更新 touch 文案，文档明确普通 tab 与原生 Device Toolbar 输入代理的能力差异。

**Tech Stack:** Chrome Extension MV3、chrome.debugger、CDP Emulation、Vue 3、Vitest、Vitest Browser Mode。

---

### Task 1: Background CDP Stability

**Files:**
- Modify: `src/background.ts`

- [x] **Step 1: Remove visible size override**

删除 `Emulation.setVisibleSize` 调用，只保留 `Emulation.setDeviceMetricsOverride`，避免真实页面出现额外可滚动空白区域。

- [x] **Step 2: Add touch input conversion**

在启用 touch 时额外调用 `Emulation.setEmitTouchEventsForMouse`，关闭时恢复为 `enabled: false`。该命令失败时忽略并保留 `setTouchEmulationEnabled` 主路径。

- [x] **Step 3: Replay after navigation**

监听 `chrome.tabs.onUpdated` 的 `status === "complete"`，如果 tab 已启用设备模拟，则重放 `applyDeviceEmulation`。

- [x] **Step 4: Stabilize disable flow**

关闭时先删除运行态，再清理 metrics/touch/mouse-to-touch/UA，最后延迟调用 `maybeDetachDebugger`，降低 DevTools 正在打开时的 debugger 竞争。

### Task 2: UI And Docs

**Files:**
- Modify: `src/shared/components/DeviceEmulationPanel.vue`
- Modify: `docs/changes/device-emulation/research.md`
- Modify: `docs/changes/device-emulation/design.md`
- Modify: `docs/changes/device-emulation/validation.md`

- [x] **Step 1: Clarify touch label**

将 “启用 touch 事件” 调整为 “启用 touch 输入模拟”，并补充说明普通 tab 中会尝试转换鼠标输入，但不保证完全屏蔽 CSS hover。

- [x] **Step 2: Document limitations**

记录普通 tab CDP 模拟无法提供原生 Device Toolbar 的居中设备画布；完全居中预览需要独立 DevTools 内预览画布能力。

### Task 3: E2E And Validation

**Files:**
- Modify: `e2e/browser-commands.ts`
- Modify: `e2e/popup-device-emulation.e2e.test.ts`

- [x] **Step 1: Extend e2e**

覆盖启用设备模拟后刷新页面，确认 `screen.width`、touch、UA 仍然生效，并确认关闭后 background state 清理。

- [x] **Step 2: Run validation**

运行 `pnpm typecheck`、`pnpm test`、`pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`、`pnpm test:e2e`、`pnpm build`、`git diff --check`。

- [ ] **Step 3: Commit**

提交 `fix: stabilize device emulation`。
