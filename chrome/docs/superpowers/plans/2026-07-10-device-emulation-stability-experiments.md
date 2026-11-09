# Device Emulation Stability Experiments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不恢复 DevTools 预览画布、不修改浏览器窗口尺寸的前提下，为真实 tab 设备模拟增加重放时机、清理顺序和 CDP `positionX/Y`、`viewport` 实验参数。

**Architecture:** 继续由 `src/shared/device-emulation.ts` 负责纯参数转换和可测试模型，`src/background.ts` 负责 CDP 下发、重放和清理时序。实验参数默认启用为保守值，失败时不阻塞基础设备模拟；文档记录官方能力边界和验证结果。

**Tech Stack:** Chrome Extension MV3、chrome.debugger、CDP Emulation/Page、TypeScript、Vitest、Vitest Browser Mode。

---

### Task 1: Metrics Params

**Files:**
- Modify: `src/shared/device-emulation.ts`
- Modify: `src/shared/device-emulation.test.ts`

- [x] **Step 1: Extend metrics type**

Add optional `positionX`, `positionY`, and `viewport` fields to `DeviceMetricsOverrideParams`.

- [x] **Step 2: Generate experimental params**

Update `toDeviceMetricsOverrideParams` to emit `positionX: 0`, `positionY: 0`, and a matching `viewport` when an experimental option is enabled.

- [x] **Step 3: Cover params with unit tests**

Add tests proving default metrics remain stable and experimental metrics include viewport/position values without changing `scale: 1`.

### Task 2: Replay And Cleanup

**Files:**
- Modify: `src/background.ts`

- [x] **Step 1: Add replay triggers**

Replay active device emulation when tab load completes, tab is activated, or browser window bounds change.

- [x] **Step 2: Improve cleanup order**

On disable, clear touch/mouse-to-touch/UA first, then clear metrics, then reset page scale factor best-effort, and finally detach after a small delay.

- [x] **Step 3: Keep failures non-fatal**

Treat experimental `viewport`, `positionX/Y`, `resetPageScaleFactor`, and new replay triggers as best-effort so unsupported Chromium versions do not break core emulation.

### Task 3: Docs And Validation

**Files:**
- Modify: `docs/changes/device-emulation/tasks.md`
- Modify: `docs/changes/device-emulation/validation.md`

- [x] **Step 1: Document experiment**

Record that `positionX/Y` and `viewport` are experimental, and that this is only for real tab stability, not full Device Toolbar parity.

- [x] **Step 2: Run validation**

Run `pnpm typecheck`, `pnpm test`, `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`, `pnpm build`, and `git diff --check`.
