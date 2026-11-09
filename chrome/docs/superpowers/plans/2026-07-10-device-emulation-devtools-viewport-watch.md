# Device Emulation DevTools Viewport Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 DevTools 面板侧 viewport 变化探测和 port 断开信号，覆盖 DevTools 开关、分界线拖动和页面内容区域变化后的设备模拟重放。

**Architecture:** `src/panel/use-inspected-viewport-watcher.ts` 在 DevTools 面板生命周期内轮询 inspected page 的 viewport 快照，变化稳定后通知 background；`src/background.ts` 通过 runtime message/port 对已启用设备模拟的 tab 做延迟重放。窗口 bounds 监听保留为外层浏览器 resize 兜底。

**Tech Stack:** Chrome Extension MV3、DevTools `inspectedWindow.eval`、runtime Port、CDP `Emulation.setDeviceMetricsOverride`、Vue 3、TypeScript、Vitest Browser Mode。

---

### Task 1: Messages And Background

**Files:**
- Modify: `src/shared/device-emulation-messages.ts`
- Modify: `src/background.ts`

- [x] **Step 1: Add viewport-change message**

Add `advanced-network:device-viewport-changed` with `tabId` and viewport snapshot.

- [x] **Step 2: Handle viewport-change in background**

If the tab has active device emulation, debounce replay; otherwise ignore.

- [x] **Step 3: Handle DevTools port lifecycle**

Register `chrome.runtime.onConnect`; when a DevTools panel port disconnects for a tab, schedule multiple delayed replays.

### Task 2: DevTools Watcher

**Files:**
- Create: `src/panel/use-inspected-viewport-watcher.ts`
- Modify: `src/panel/App.vue`

- [x] **Step 1: Create watcher composable**

Poll `window.innerWidth/innerHeight` and `visualViewport` from inspected page via `chrome.devtools.inspectedWindow.eval`.

- [x] **Step 2: Debounce stable viewport notifications**

When snapshot changes, wait for changes to settle before sending `device-viewport-changed`.

- [x] **Step 3: Connect port**

Open runtime port named `advanced-network-devtools-panel` and post the inspected tab id; disconnect on unmount.

### Task 3: Docs And Validation

**Files:**
- Modify: `docs/changes/device-emulation/tasks.md`
- Modify: `docs/changes/device-emulation/validation.md`

- [x] **Step 1: Document why bounds is insufficient**

Record that `windows.onBoundsChanged` does not fire during resize and does not cover DevTools divider changes.

- [x] **Step 2: Run validation**

Run `pnpm typecheck`, `pnpm test`, `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`, `pnpm build`, and `git diff --check`.
