# Device Emulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现按 tab 独立的设备模拟能力，并在 DevTools 和 PopUp 中提供同步管理入口。

**Architecture:** 设备预设、CDP 参数转换和 storage normalizer 放在 `src/shared/device-emulation.ts`。后台 `src/background.ts` 维护 `tabDeviceEmulations` 运行态并通过 CDP `Emulation.*` 应用到指定 tab。DevTools 和 PopUp 复用 `DeviceEmulationPanel` 与 `useDeviceEmulationContext`，通过 storage 同步设备列表，通过 background message 查询/修改当前 tab 状态。

**Tech Stack:** Vue 3、TypeScript、Chrome Extension MV3、chrome.debugger、CDP Emulation、chrome.storage.local、Vitest、Vitest Browser Mode。

---

### Task 1: Shared Model And Storage

**Files:**
- Create: `src/shared/device-emulation.ts`
- Create: `src/shared/device-emulation.test.ts`
- Modify: `src/panel/persistent-state.ts`

- [x] **Step 1: Add model and tests**

实现设备预设、运行态、默认设备、normalizer、方向尺寸计算、scale 计算、CDP 参数转换，并覆盖非法输入与 touch 映射。

- [x] **Step 2: Add storage helpers**

新增 `loadDeviceProfilesFromStorage` 和 `persistDeviceProfilesToStorage`，沿用缺失 key 不回写策略。

### Task 2: Background CDP State

**Files:**
- Modify: `src/background.ts`

- [x] **Step 1: Add messages**

新增查询、启用、关闭、刷新设备模拟消息。

- [x] **Step 2: Apply CDP commands**

实现 `Emulation.setDeviceMetricsOverride`、`Emulation.setTouchEmulationEnabled`、`Emulation.setUserAgentOverride` 和关闭时的清理。

- [x] **Step 3: Integrate debugger lifecycle**

`maybeDetachDebugger` 将设备模拟纳入保活，`onDetach` 清理设备模拟状态。

### Task 3: Shared UI And Context

**Files:**
- Create: `src/shared/use-device-emulation-context.ts`
- Create: `src/shared/components/DeviceEmulationPanel.vue`
- Modify: `src/panel/App.vue`
- Modify: `src/popup/PopupApp.vue`
- Modify: `src/panel/panel.css`
- Modify: `src/popup/popup.css`

- [x] **Step 1: Add context**

共享 context 管理设备列表、当前 tab 状态、启用/关闭、方向切换、缩放和设备 CRUD。

- [x] **Step 2: Add panel**

复用组件展示启用开关、设备选择、方向、缩放、自适应窗口和设备管理。

- [x] **Step 3: Add entrances**

DevTools 左侧 tab 与 PopUp tab 均新增“设备模拟”。

### Task 4: E2E And Docs

**Files:**
- Modify: `e2e/browser-commands.ts`
- Modify: `e2e/popup-mock.e2e.test.ts` or create focused e2e if needed
- Modify: `docs/changes/device-emulation/tasks.md`
- Modify: `docs/changes/device-emulation/validation.md`

- [x] **Step 1: Add e2e coverage**

覆盖 PopUp 设备入口、设备状态启用、方向切换、关闭 DevTools 后 background 状态仍可由 PopUp 读取。

- [ ] **Step 2: Run validation**

运行 `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`pnpm build`、`git diff --check`。

- [ ] **Step 3: Commit**

提交 `feat: add device emulation`。
