# Device Emulation CDP Advanced Params Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复设备模拟默认稳定行为，并在设备模拟面板暴露 `Emulation.setDeviceMetricsOverride` 官方高级参数供手动调试。

**Architecture:** `src/shared/device-emulation.ts` 继续负责设备配置模型、normalizer 和 CDP 参数转换；高级参数作为 `DeviceProfile` 的可选调试配置持久化到 `advancedNetwork.deviceProfiles`。`DeviceEmulationPanel.vue` 增加折叠式“CDP 高级参数”区，所有实验参数都必须显式启用才会下发。

**Tech Stack:** Chrome Extension MV3、Chrome DevTools Protocol `Emulation.setDeviceMetricsOverride`、Vue 3、TypeScript、Vitest、Vitest Browser Mode。

---

### Task 1: Model And Defaults

**Files:**
- Modify: `src/shared/device-emulation.ts`
- Modify: `src/shared/device-emulation.test.ts`

- [x] **Step 1: Add advanced params model**

Add `DeviceMetricsAdvancedSettings` to represent optional CDP params: `scale`, `screenWidth`, `screenHeight`, `positionX`, `positionY`, `dontSetVisibleSize`, `viewport`, and `displayFeature`.

- [x] **Step 2: Restore stable defaults**

Ensure default `toDeviceMetricsOverrideParams` does not emit `positionX/Y` or `viewport`; advanced values are emitted only when their `enabled` flags are true.

- [x] **Step 3: Add tests**

Cover stable default params, enabled advanced params, and invalid advanced params normalization.

### Task 2: Shared UI

**Files:**
- Modify: `src/shared/components/DeviceEmulationPanel.vue`
- Modify: `src/shared/use-device-emulation-context.ts`

- [x] **Step 1: Extend patch type**

Allow profile updates to patch `metricsAdvanced`.

- [x] **Step 2: Add collapsed debug panel**

Add a `<details>` block named “CDP 高级参数”，with per-field enable checkboxes and numeric/select inputs.

- [x] **Step 3: Immediate apply**

Keep the existing `updateProfile -> enable()` behavior so advanced changes are immediately replayed when emulation is enabled.

### Task 3: Docs And Validation

**Files:**
- Modify: `docs/changes/device-emulation/tasks.md`
- Modify: `docs/changes/device-emulation/validation.md`

- [x] **Step 1: Document rollback of default experiment**

Record that viewport/position experiments are no longer enabled by default due to height/scroll flicker.

- [x] **Step 2: Run validation**

Run `pnpm typecheck`, `pnpm test`, `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`, `pnpm build`, and `git diff --check`.
