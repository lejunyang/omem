# 设备模拟调研

## 目标

- 新增“设备模拟”能力，效果接近 Chrome DevTools 自带 Device Toolbar。
- 设备模拟必须按页面独立启用：A tab 开启移动端模拟，不应让 B tab 自动变成移动端。
- DevTools 面板和插件 PopUp 都需要提供入口，两个入口状态同步。
- 关闭 DevTools 后模拟仍保持启用，只有用户手动关闭或 tab 结束才停用。

## 可行性结论

- 可行，推荐使用 `chrome.debugger` 按 `tabId` 发送 Chrome DevTools Protocol（CDP）命令。
- `chrome.debugger.attach({ tabId })` 绑定的是指定标签页目标，不是浏览器全局开关；后台可用 `Map<tabId, DeviceEmulationState>` 维护每个 tab 的运行态。
- 当前项目已经有 `attachedTabs`、`tabNetworkControls`、Mock、Initiator、Resource Search 等 CDP 生命周期管理，设备模拟可以复用同一套 attach/sendCommand/detach 能力。
- 与原生 DevTools Device Toolbar 不同，扩展侧不会使用 DevTools 的全局 Device Mode 状态，因此可以避免“某页打开后其他页面 DevTools 也自动移动端”的问题。

## 官方能力映射

### 尺寸、DPR、移动端布局

- 使用 `Emulation.setDeviceMetricsOverride`。
- 关键参数：
  - `width` / `height`：覆盖 `window.innerWidth`、`window.innerHeight`、`device-width` / `device-height` 相关 CSS media query。
  - `deviceScaleFactor`：覆盖 `window.devicePixelRatio`。
  - `mobile`：是否模拟移动设备；官方说明包括 viewport meta tag、overlay scrollbars、text autosizing 等行为。
  - `screenOrientation`：覆盖屏幕方向。
  - `scale`：对最终视图图像应用缩放；该能力不等同于 DevTools 设备画布缩放，真实 tab 中应固定为 `1`。
- 关闭时使用 `Emulation.clearDeviceMetricsOverride`。

### 方向切换

- 使用 `screenOrientation` 实现。
- 竖屏建议：
  - `type: "portraitPrimary"`
  - `angle: 0`
- 横屏建议：
  - `type: "landscapePrimary"`
  - `angle: 90`
- 切换方向时同时交换 `width` / `height`，再重新下发 `setDeviceMetricsOverride`。

### 触摸模拟和触摸点数

- 使用 `Emulation.setTouchEmulationEnabled`。
- `enabled` 决定是否开启触摸事件模拟。
- `maxTouchPoints` 表示开启触摸后页面看到的最大触点数，默认是 1。
- 因此“触摸点数为 0”不应理解为“启用 0 个触点”，而应当在产品模型中转换为 `enabled: false`，并不传或忽略 `maxTouchPoints`。
- `mobile` 不等价于触摸开关：
  - `mobile: true` 影响 viewport meta、滚动条、文本自适应等移动端布局行为。
  - `setTouchEmulationEnabled.enabled` 才决定页面是否模拟 touch。
- 产品上建议拆成两个字段：
  - `mobile`：移动端布局模拟。
  - `touchEnabled` / `maxTouchPoints`：触摸输入模拟。若 `touchEnabled=false`，页面应继续走鼠标输入路径。
- 扩展在真实 tab 中只能通过 CDP 尝试 `Emulation.setEmitTouchEventsForMouse` 将鼠标输入转换为 touch 输入；普通页面仍可能收到浏览器原生 mouse/hover 路径。
- 原生 DevTools Device Toolbar 的“鼠标像手指一样操作且不触发 mouse hover”依赖 DevTools 前端预览画布和输入代理层，不能仅靠真实 tab 的 `Emulation.*` 完全复刻。

### User-Agent 和 Client Hints

- 使用 `Emulation.setUserAgentOverride`。
- 关键参数：
  - `userAgent`
  - `acceptLanguage`
  - `platform`
  - `userAgentMetadata`
- 官方说明：如果要发送 Client Hint headers，需要设置 `userAgentMetadata`。
- 现代站点可能读取 `navigator.userAgentData`，只改 UA 字符串不够；首版应支持保存 UA 字符串和可选 UA-CH metadata，metadata 解析失败时降级为只设置 UA。

### 百分比缩放和自适应窗口

- CDP `Emulation.setDeviceMetricsOverride.scale` 的官方含义是缩放最终视图图像，而不是页面布局缩放或 DevTools 设备画布缩放。
- 真实 tab 中使用 `scale < 1` 会让图像、布局 viewport、滚动区域和 DevTools 停靠区域出现坐标体系错位，因此当前实现固定下发 `scale: 1`。
- `viewport` 参数只改变可见区域且页面不可感知，不适合用来实现真实页面的设备预览缩放。
- `Emulation.setVisibleSize` 已标记 deprecated，且在真实页面中可能造成额外滚动空白，不作为稳定方案使用。
- 百分比缩放、自适应窗口和居中设备画布需要后续独立的 DevTools 内预览画布方案，例如基于 `Page.startScreencast` 渲染页面并转发输入事件。
- PopUp 本身尺寸较小，只作为配置和开关入口，不承载真实设备预览。

## 状态独立与同步

- 设备预设列表应持久化到 `chrome.storage.local`：
  - `advancedNetwork.deviceProfiles`
- 当前 tab 的设备模拟运行态不建议全局持久化为“所有页面自动恢复”，避免再次引入全局污染。
- 关闭 DevTools 后仍保持启用，需要后台保存运行态：
  - `tabDeviceEmulations: Map<number, DeviceEmulationState>`
  - PopUp 和 DevTools 打开时通过 message 查询当前 active tab 或 inspected tab 的运行态。
- PopUp 与 DevTools 同步方式：
  - 设备预设通过 `chrome.storage.onChanged` 同步。
  - 当前 tab 运行态通过 background message 查询和订阅式刷新。
  - PopUp 作用于当前 active tab，DevTools 作用于 `chrome.devtools.inspectedWindow.tabId`。

## 生命周期

- 开启设备模拟：
  - attach debugger。
  - `Network.enable`。
  - `Emulation.setDeviceMetricsOverride`。
  - `Emulation.setTouchEmulationEnabled`。
  - `Emulation.setUserAgentOverride`。
  - 保存运行态到 `tabDeviceEmulations`。
- 关闭设备模拟：
  - `Emulation.clearDeviceMetricsOverride`。
  - `Emulation.setTouchEmulationEnabled({ enabled: false })`。
  - UA override 没有独立 clear 命令，需使用默认 UA 重新下发或在关闭后提示需要刷新恢复；实现时应优先调研现有 Chrome 对空 UA override 的表现。
  - 从 `tabDeviceEmulations` 删除。
  - 调用 `maybeDetachDebugger(tabId)`。
- 面板关闭：
  - 不关闭设备模拟。
  - 后台继续保持 debugger 附加，直到用户关闭设备模拟、tab 关闭或 debugger 被外部 detach。
- tab 关闭 / debugger detach：
  - 清理对应 `tabId` 运行态。
  - UI 下次打开时显示“未启用”或“debugger 已断开”。

## 风险与限制

- debugger 权限会触发 Chrome 权限提示，用户拒绝时必须提示恢复方式。
- 原生 DevTools Device Toolbar 和本功能会互相覆盖最后一次 CDP Emulation 状态，UI 中应提示不要同时开启。
- UA-CH metadata 兼容性需要兜底，不同 Chrome 版本字段支持可能不同。
- 真实 tab 设备模拟固定 `scale: 1`；百分比缩放和自适应窗口留给后续预览画布方案。
- PopUp 关闭后不适合持续监听尺寸变化，PopUp 只作为开关和设备管理入口。
- 跨浏览器重启后不建议自动恢复某个 tab 的模拟运行态。
- `Emulation.setVisibleSize` 在真实页面中可能造成滚动区域异常，首版稳定性修复后不再使用它，只保留 `setDeviceMetricsOverride` 主路径。

## 参考

- Chrome Extensions `chrome.debugger` API：可按 `tabId` 附加目标并发送 CDP 命令。
- CDP `Emulation.setDeviceMetricsOverride`：覆盖 viewport、DPR、mobile、screen orientation、scale。
- CDP `Emulation.setTouchEmulationEnabled`：开启或关闭触摸模拟，并设置最大触点数。
- CDP `Emulation.setUserAgentOverride`：覆盖 UA、platform、acceptLanguage 和 UA Client Hints metadata。
