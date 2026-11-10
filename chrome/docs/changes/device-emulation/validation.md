# 设备模拟验证记录

## 2026-07-07 调研验证

- 已确认 `chrome.debugger` API 可按 `tabId` 附加到指定标签页，并通过 `sendCommand` 调用 Chrome DevTools Protocol。
- 已确认 `Emulation.setDeviceMetricsOverride` 可覆盖页面视口、DPR、移动端布局、方向和视图缩放。
- 已确认 `Emulation.setTouchEmulationEnabled` 中 `enabled` 决定是否启用触摸模拟，`maxTouchPoints` 表示启用触摸后的最大触点数。
- 已确认 `mobile` 与触摸模拟不是同一个开关；`mobile` 影响 viewport meta、滚动条、文本自适应等移动端布局行为，触摸由 `setTouchEmulationEnabled.enabled` 控制。
- 已确认 `Emulation.setUserAgentOverride` 可覆盖 UA、platform、acceptLanguage 和 UA Client Hints metadata；现代站点如需 Client Hints 需要传 `userAgentMetadata`。
- 已确认 `setDeviceMetricsOverride.scale` 是最终视图图像缩放，不是原生 Device Toolbar 的外层设备画布缩放；真实 tab 固定 `scale: 1`。
- 已检查当前项目已有 `attachedTabs`、`tabNetworkControls`、Mock、Resource Search 等按 tab CDP 生命周期管理，设备模拟可复用现有 background 架构。

## 后续验证计划

- `pnpm test`：覆盖设备配置 normalizer、CDP 参数转换、方向切换、scale 计算和 touch 映射。
- `pnpm typecheck`：检查新增 DevTools/PopUp 共享上下文类型。
- `pnpm test:e2e`：覆盖 PopUp/DevTools 双入口设备管理和同 tab 状态同步。
- `pnpm build`：确认 Manifest V3 扩展构建产物正常。
- 真实浏览器验证：
  - 设备模拟开启后测试页 `window.innerWidth` / `window.innerHeight` 符合设备配置。
  - `window.devicePixelRatio` 符合 DPR。
  - `navigator.userAgent` / `navigator.platform` 符合设备配置。
  - 方向切换后宽高交换并重放。
  - 关闭 DevTools 后 PopUp 仍显示当前 tab 模拟启用，页面仍保持模拟。
  - 手动关闭后清除模拟，刷新页面恢复默认环境。

## 2026-07-09 首版实现验证

- `pnpm exec vitest run src/shared/device-emulation.test.ts`：通过，1 个测试文件、5 个用例，覆盖设备 normalizer、方向宽高交换、fit-window scale、touch 点数 0 关闭。
- `pnpm exec vitest run src/shared/device-emulation.test.ts src/panel/persistent-state.test.ts`：通过，2 个测试文件、9 个用例，覆盖设备 profile 数字键对象迁移和缺失 key 不回写。
- `pnpm typecheck`：通过。
- `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`：通过，1 个 e2e 文件、2 个用例。
- `pnpm test`：通过，19 个测试文件、122 个用例。
- `pnpm test:e2e`：通过，4 个 e2e 文件、13 个用例。
- `pnpm build`：通过。
- `git diff --check`：通过。
- e2e 覆盖内容：
  - PopUp “设备模拟”入口可新增自定义设备，`advancedNetwork.deviceProfiles` 持久化后刷新 PopUp 仍可读取。
  - background 可按指定 tab 启用设备模拟，并通过 `get-device-emulation-state` 读回启用状态。
  - 真实测试页中 `navigator.userAgent`、`navigator.maxTouchPoints`、`screen.width` 符合设备配置。
  - 关闭设备模拟后 background state 清理，debugger 可被后续 `maybeDetachDebugger` 释放。
- e2e 边界说明：
  - `test-page.html` 没有 `<meta name="viewport">`，移动端模拟下 `window.innerWidth` 会保持 Chromium 移动端默认 layout viewport（约 980px），因此 e2e 使用 `screen.width` 验证设备宽度。
  - e2e 默认浏览器 profile 改为按进程隔离，避免 MV3 service worker 复用旧扩展代码；如需复用登录态，可显式设置 `E2E_BROWSER_USER_DATA_DIR`。

## 2026-07-09 稳定性修复验证

- 修复内容：
  - 移除 `Emulation.setVisibleSize`，避免真实页面出现额外可滚动空白区域。
  - 启用 touch 时尝试下发 `Emulation.setEmitTouchEventsForMouse`，尽量将鼠标输入转换为 touch 输入。
  - 页面导航完成后对已启用 tab 重放设备模拟，避免刷新后 UA、touch 或 viewport 半失效。
  - 关闭模拟后延后一拍释放 debugger，降低 DevTools 正在打开时的 debugger 竞争。
- `pnpm typecheck`：通过。
- `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`：通过，1 个 e2e 文件、2 个用例；覆盖刷新后 `screen.width`、touch 点数、UA 仍保持模拟配置。
- `pnpm test`：通过，19 个测试文件、122 个用例。
- `pnpm test:e2e`：通过，4 个 e2e 文件、13 个用例。
- `pnpm build`：通过。
- `git diff --check`：通过。
- 已知边界：
  - 普通 tab 中 CDP touch 模拟无法保证完全屏蔽 CSS `:hover`；原生 DevTools Device Toolbar 依赖 DevTools 预览画布和输入代理层。
  - 当前功能直接作用于真实 tab，不提供原生 Device Toolbar 的居中设备画布；如需居中预览，需要后续独立设计 DevTools 内预览画布。

## 2026-07-09 真实 tab 禁用缩放验证

- 修复背景：
  - 在 `https://shop.example.com/enterprise/index` 真实页面开启模拟后，页面出现大面积空白、滚动条错位和内容覆盖 DevTools 区域。
  - 官方 CDP 文档中 `Emulation.setDeviceMetricsOverride.scale` 是最终图像缩放，不是 DevTools Device Toolbar 的外层设备画布缩放；真实 tab 使用 `scale < 1` 容易让图像、layout viewport、滚动区域和 DevTools 停靠区域错位。
- 修复内容：
  - `toDeviceMetricsOverrideParams` 对真实 tab 固定输出 `scale: 1`。
  - 设备模拟面板移除缩放数值和“自适应窗口/固定百分比”入口。
  - 文档明确百分比缩放、窗口自适应和居中设备画布归入后续 DevTools 内预览画布方案。
  - e2e 增加 `Page.getLayoutMetrics` sanity check，防止再次出现明显异常的大空白布局。
- `pnpm exec vitest run src/shared/device-emulation.test.ts`：通过，1 个测试文件、5 个用例。
- `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`：通过，1 个 e2e 文件、2 个用例。
- `pnpm typecheck`：通过。
- `pnpm test`：通过，19 个测试文件、122 个用例。
- `pnpm test:e2e`：通过，4 个 e2e 文件、13 个用例。
- `pnpm build`：通过。
- `git diff --check`：通过。
- 已知边界：
  - 真实 tab 方案只保证页面可感知设备指标稳定生效，不提供居中设备预览。
  - `Page.startScreencast` 预览画布方案因画质过糊已放弃，当前不再作为设备模拟后续实现方向。

## 2026-07-10 预览画布回退记录

- 回退背景：
  - `Page.startScreencast` 方案在 DevTools 面板内可展示页面画面，但实测画面过糊，无法满足设备模拟预览体验。
  - 用户确认不再需要设备预览功能，因此移除已实现的 preview message、background screencast/input 会话、DevTools 预览画布组件和对应 e2e。
- 保留内容：
  - e2e 默认 headless 静默运行仍保留，避免自动化验证弹出浏览器打断当前操作。
  - 真实 tab 设备模拟、PopUp/DevTools 双入口、方向切换、UA/touch/viewport 指标模拟仍保留。
- 文档处理：
  - `docs/superpowers/specs/2026-07-09-device-preview-canvas-design.md` 标记为“已放弃”，仅保留历史调研记录。
- 已完成验证：
  - `pnpm typecheck`：通过。
  - `pnpm test`：通过，19 个测试文件、122 个用例。
  - `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`：通过，1 个 e2e 文件、2 个用例。
  - `pnpm test:e2e`：通过，4 个 e2e 文件、13 个用例，默认 headless 静默执行。
  - `pnpm build`：通过。

## 2026-07-10 真实 tab 稳定性实验

- 实验背景：
  - 用户在真实站点观察到：开启模拟后关闭 DevTools，页面渲染内容可能超出之前区域，但滚动条仍在模拟宽高内。
  - 官方 CDP 没有稳定的“设置真实 tab 内渲染位置/居中”的能力，因此本轮只尝试真实 tab 的 metrics 重放、清理顺序和实验参数。
- 实现内容：
  - 基础 `Emulation.setDeviceMetricsOverride` 仍先下发稳定参数，保证 `width`、`height`、DPR、`mobile`、方向和 `scale: 1` 生效。
  - 曾默认下发带 `positionX: 0`、`positionY: 0` 和匹配设备尺寸 `viewport` 的实验参数，但实测会导致模拟高度变高、滚动闪烁和疑似渲染位置重置。
  - 当前已恢复默认稳定行为：`positionX/Y`、`viewport`、`screenWidth/screenHeight`、`dontSetVisibleSize`、`displayFeature` 等实验字段默认不下发。
  - 设备模拟面板新增“CDP 高级参数”折叠区，用户可按字段单独勾选并手动调试官方 `Emulation.setDeviceMetricsOverride` 参数。
  - 导航完成、tab 激活、浏览器窗口 bounds 变化后，延迟合并重放当前 tab 的设备模拟，尝试修正 DevTools dock/关闭后的 compositor/viewport 状态不同步。
  - 关闭模拟时先清 touch、mouse-to-touch 和 UA，再清 `clearDeviceMetricsOverride`，最后 best-effort `resetPageScaleFactor`，避免短暂混合状态。
- 已完成验证：
  - `pnpm typecheck`：通过。
  - `pnpm test -- src/shared/device-emulation.test.ts`：通过，19 个测试文件、123 个用例。
  - `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`：通过，1 个 e2e 文件、2 个用例。
  - `pnpm test`：通过，19 个测试文件、123 个用例。
  - `pnpm build`：通过。
  - `git diff --check`：通过。
- 已知边界：
  - `positionX/Y` 和 `viewport` 均为 CDP 实验参数，其中 `viewport` 官方说明不会被页面感知；这些参数仅适合手动调试，不再默认启用。
  - 该方案仍不提供原生 Device Toolbar 的居中设备画布，也不会修改浏览器窗口大小。

## 2026-07-10 CDP 高级参数面板验证

- 修复背景：
  - 默认启用 `viewport` 实验参数后，真实页面出现模拟高度变高、无法滚动、滚动闪烁和疑似渲染位置重置。
  - 需要恢复默认稳定行为，同时把官方 `Emulation.setDeviceMetricsOverride` 高级参数暴露给用户手动调试。
- 实现内容：
  - 默认只下发基础稳定参数：`width`、`height`、`deviceScaleFactor`、`mobile`、`scale: 1`、`screenOrientation`。
  - `scale`、`screenWidth`、`screenHeight`、`positionX`、`positionY`、`dontSetVisibleSize`、`viewport`、`displayFeature` 都放入“CDP 高级参数”折叠区。
  - 每个高级字段都有独立启用开关，未勾选时不会出现在 CDP 参数里。
  - 高级参数随设备配置持久化，DevTools 和 PopUp 共享；模拟启用中修改会立即重放。
- 已完成验证：
  - `pnpm typecheck`：通过。
  - `pnpm test`：通过，19 个测试文件、124 个用例。
  - `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`：通过，1 个 e2e 文件、2 个用例。
  - `pnpm test:e2e`：通过，4 个 e2e 文件、13 个用例，默认 headless 静默执行。
  - `pnpm build`：通过。
  - `git diff --check`：通过。
- 已知边界：
  - `viewport` 官方说明不会被页面感知，仍可能造成滚动/渲染区域异常，因此只适合作为手动调试参数。
  - `displayFeature` 仅暴露当前官方参数 `orientation`、`offset`、`maskLength`，未额外引入其他 Emulation 方法。

## 2026-07-10 DevTools viewport 监听验证

- 修复背景：
  - 用户观察到：关闭/打开 DevTools 后模拟页面仍可能出现渲染宽度溢出；手动修改 CDP 高级参数触发重放后能恢复。
  - 用户拖动 DevTools 与页面的内部分界线时，`chrome.windows.onBoundsChanged` 不会触发；手动调整浏览器外层窗口时，只有松手后才会触发。
  - 官方 `chrome.windows.onBoundsChanged` 文档说明该事件只在窗口大小调整完毕后触发，不适用于正在进行的更改，也不能覆盖 DevTools 内部分界线。
- 实现内容：
  - DevTools 面板启动时通过 `chrome.runtime.connect({ name: "advanced-network-devtools-panel" })` 建立 port，并把 inspected `tabId` 发给 background。
  - background 在 port disconnect 时认为该 DevTools 面板关闭，对已启用设备模拟的 tab 执行 `120ms / 400ms / 900ms` 分阶段重放。
  - 新增 `use-inspected-viewport-watcher.ts`，通过 `chrome.devtools.inspectedWindow.eval` 轮询 `window.innerWidth/innerHeight` 和 `visualViewport`。
  - viewport 快照变化后等待 350ms 稳定再通知 background，避免拖动过程中频繁重放导致闪烁。
  - background 收到 `advanced-network:device-viewport-changed` 后，仅当目标 tab 已启用设备模拟时延迟重放。
- 已知边界：
  - Chrome 扩展没有通用的“某 tab DevTools 已打开/关闭”事件；port disconnect 只能代表本扩展 DevTools 面板生命周期。
  - viewport watcher 只在本扩展 DevTools 面板页面存在时运行；如果用户打开 DevTools 但从未加载本扩展面板，则无法建立 watcher。
- 已完成验证：
  - `pnpm typecheck`：通过。
  - `pnpm test`：通过，19 个测试文件、124 个用例。
  - `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`：通过，1 个 e2e 文件、2 个用例。
  - `pnpm test:e2e`：通过，4 个 e2e 文件、13 个用例，默认 headless 静默执行。
  - `pnpm build`：通过。
  - `git diff --check`：通过。

## 2026-10-13 独立居中模拟器

新增真实 iframe 路线，旧截图流仍不启用。Chrome for Testing 149 的完整 15 条浏览器回归通过，覆盖第一段页面脚本读取的设备属性、真实输入、合成单指点击/拖动、关闭 touch、横竖屏、页面导航、原标签页隔离、CSP 保留和暗色窄窗口。

这不是原生 Device Toolbar 的完整替代：DPR 等为 JS 属性标识，touch 事件不可信，CSS pointer/hover/resolution 和 mobile meta 行为不等价。详细断言和未覆盖项见 [主验证记录](../bootstrap-devtools-panel/validation.md)。
