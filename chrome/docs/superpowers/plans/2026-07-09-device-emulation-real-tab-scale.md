# Device Emulation Real Tab Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让真实 tab 设备模拟只改变页面可感知设备指标，不再使用 CDP 图像缩放导致滚动条和 DevTools 区域错位。

**Architecture:** 设备模拟继续通过 background 按 tabId 下发 `Emulation.setDeviceMetricsOverride`，但真实 tab 场景固定 `scale: 1`，不再暴露自适应窗口和百分比缩放入口。文档明确缩放/居中预览属于后续 DevTools 内预览画布方案。

**Tech Stack:** Chrome Extension MV3、chrome.debugger、CDP Emulation、Vue 3、Vitest、Vitest Browser Mode。

---

### Task 1: Model And CDP Params

**Files:**
- Modify: `src/shared/device-emulation.ts`
- Test: `src/shared/device-emulation.test.ts`

- [x] **Step 1: Add regression test**

在 `toDeviceMetricsOverrideParams` 测试中覆盖 `scaleMode: "fit-window"` 且 `availableSize` 小于设备尺寸时，真实 tab 参数仍返回 `scale: 1`。

- [x] **Step 2: Force scale 1**

修改 `toDeviceMetricsOverrideParams`，保留 `settings.scaleMode` 数据结构但真实 tab CDP 参数始终输出 `scale: 1`，并用中文注释说明 CDP `scale` 是图像缩放，不适合真实 tab。

### Task 2: UI And Docs

**Files:**
- Modify: `src/shared/components/DeviceEmulationPanel.vue`
- Modify: `docs/changes/device-emulation/research.md`
- Modify: `docs/changes/device-emulation/design.md`
- Modify: `docs/changes/device-emulation/validation.md`

- [x] **Step 1: Disable scale controls**

从设备模拟面板隐藏“缩放/自适应窗口”控件，改为说明真实 tab 当前固定 100% 渲染。

- [x] **Step 2: Document CDP boundary**

在调研和设计文档说明：`scale`、`viewport`、`setVisibleSize` 都不适合作为真实 tab 的 Device Toolbar 预览缩放能力；居中预览需后续方案 B。

### Task 3: E2E And Validation

**Files:**
- Modify: `e2e/browser-commands.ts`
- Modify: `e2e/popup-device-emulation.e2e.test.ts`

- [x] **Step 1: Extend e2e result**

在设备模拟 CDP e2e 中读取 `Page.getLayoutMetrics`，确认启用后 content width 不会因为缩放小于 1 出现明显超过设备宽度的异常空白。

- [x] **Step 2: Run validation**

运行 `pnpm typecheck`、`pnpm test`、`pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`、`pnpm test:e2e`、`pnpm build`、`git diff --check`。

- [ ] **Step 3: Commit**

提交 `fix: avoid real tab device scale`。
