# 设备模拟设计

## 范围

首版实现基于 CDP 的按 tab 独立设备模拟，并提供 DevTools 与 PopUp 双入口。

包含：

- 内置设备预设。
- 自定义设备管理。
- 当前 tab 启用/关闭设备模拟。
- 方向切换。
- 真实 tab 固定 100% 应用设备指标。
- 关闭 DevTools 后继续保持模拟，直到用户手动关闭。
- DevTools 与 PopUp 状态同步。

不包含：

- 原生 DevTools Device Toolbar 的完整 UI 复刻。
- 折叠屏 display feature / device posture。
- GPS、时区、语言、CPU 等传感器或环境模拟。
- 跨浏览器重启自动恢复运行态模拟。
- 真实 tab 百分比缩放、自适应窗口和居中设备画布；这些能力需要后续 DevTools 内预览画布方案。

## 数据模型

### DeviceProfile

```ts
export interface DeviceProfile {
  id: string;
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
  platform: string;
  touchEnabled: boolean;
  maxTouchPoints: number;
}
```

### DeviceEmulationSettings

```ts
export interface DeviceEmulationSettings {
  enabled: boolean;
  profileId: string;
  orientation: "portrait" | "landscape";
  scaleMode: "fixed" | "fit-window";
  scale: number;
}
```

### DeviceEmulationState

```ts
export interface DeviceEmulationState {
  tabId: number;
  settings: DeviceEmulationSettings;
  profile: DeviceProfile;
  appliedAt: number;
  source: "devtools" | "popup";
}
```

## Storage

- `advancedNetwork.deviceProfiles`
  - 持久化设备列表。
  - DevTools 和 PopUp 都监听 `chrome.storage.onChanged`。
- 当前 tab 是否启用不写入全局 storage，避免其他页面自动继承。
- 后台运行态保存在内存 `Map<number, DeviceEmulationState>` 中。

## 后台消息

新增消息：

- `advanced-network:get-device-emulation-state`
  - 输入：`tabId`
  - 输出：当前 tab 运行态和设备列表摘要。
- `advanced-network:set-device-emulation`
  - 输入：`tabId`、`settings`、`profile`、`source`
  - 行为：attach debugger 并应用 CDP 覆盖。
- `advanced-network:disable-device-emulation`
  - 输入：`tabId`
  - 行为：清除 Emulation 覆盖并更新运行态。
- `advanced-network:refresh-device-emulation`
  - 输入：`tabId`、可选 `availableSize`
  - 行为：在方向、缩放、自适应窗口变化后重放 CDP 覆盖。

## CDP 应用流程

### 开启或更新

1. `attachDebugger(tabId)`。
2. `sendDebuggerCommand(tabId, "Network.enable")`。
3. 计算方向后的宽高：
   - 竖屏：`width = profile.width`，`height = profile.height`。
   - 横屏：`width = profile.height`，`height = profile.width`。
4. 固定 `scale = 1`：
   - CDP `scale` 是最终图像缩放，不是 DevTools 设备画布缩放。
   - 真实 tab 中使用 `scale < 1` 会造成滚动条、内容图像和 DevTools 停靠区域错位。
5. 下发 `Emulation.setDeviceMetricsOverride`：
   - `width`
   - `height`
   - `deviceScaleFactor`
   - `mobile`
  - `scale: 1`
   - `screenOrientation`
6. 下发 `Emulation.setTouchEmulationEnabled`：
   - `enabled = profile.touchEnabled && profile.maxTouchPoints > 0`
   - `maxTouchPoints = profile.maxTouchPoints`
7. 尝试下发 `Emulation.setEmitTouchEventsForMouse`：
   - `enabled = profile.touchEnabled && profile.maxTouchPoints > 0`
   - `configuration = "mobile"`
   - 该能力用于尽量将鼠标输入转换为 touch 输入；失败时不影响主模拟流程。
8. 下发 `Emulation.setUserAgentOverride`：
   - `userAgent`
   - `platform`
   - 后续可扩展 `userAgentMetadata`。
9. 更新 `tabDeviceEmulations`。

### 关闭

1. `Emulation.clearDeviceMetricsOverride`。
2. `Emulation.setTouchEmulationEnabled({ enabled: false })`。
3. `Emulation.setEmitTouchEventsForMouse({ enabled: false })`。
4. 尝试恢复 UA：
   - 首版需要验证空 `userAgent` 或浏览器原始 UA 重放的行为。
   - 如果无法可靠恢复，则 UI 提示“关闭后刷新页面可恢复 UA 请求头”。
5. 删除 `tabDeviceEmulations[tabId]`。
6. 延后一拍执行 `maybeDetachDebugger(tabId)`，但若 Mock、Resource Search、Network Controls 等仍在使用 debugger，不应 detach。

## DevTools 入口

- 左侧功能 tab 新增“设备模拟”。
- 面板展示：
  - 当前 tab 状态。
  - 启用/关闭开关。
  - 设备选择。
  - 方向切换。
  - 真实页面固定 100% 应用设备指标的说明。
  - 设备管理列表。
- DevTools 面板重新显示时查询 background 当前 tab 运行态，不以本地组件状态为准。

## PopUp 入口

- PopUp tab 新增“设备模拟”。
- 作用于当前 active tab。
- 展示与 DevTools 同一套设备列表和当前 active tab 状态。
- 支持开启/关闭、选择设备、方向切换和设备管理。
- PopUp 关闭不影响模拟状态。

## 双入口同步

- 设备列表通过 storage 同步。
- 当前 tab 运行态通过 background 查询同步。
- DevTools 与 PopUp 任一入口修改状态后：
  - background 应用新状态。
  - 写入内存运行态。
  - 另一个入口再次打开或触发刷新时读取同一运行态。
- 如果两个入口同时打开，首版可通过轮询/可见性刷新同步；后续可扩展 runtime port 推送。
- 页面刷新或主文档导航完成后，background 对已启用设备模拟的 tab 重放一次 CDP 覆盖，避免站点初始化阶段读到半失效的 viewport/UA/touch 状态。

## 关闭 DevTools 后保持启用

- 设备模拟属于 background 管理的 tab 运行态，不绑定 DevTools 组件生命周期。
- DevTools `onBeforeUnmount` 不发送关闭消息。
- 用户必须点击关闭开关才清除模拟。
- tab 关闭或 debugger 被外部 detach 时清理运行态。

## 与现有 CDP 生命周期集成

- `maybeDetachDebugger(tabId)` 增加条件：
  - 如果 `tabDeviceEmulations.has(tabId)`，不得 detach。
- `chrome.debugger.onDetach`：
  - 删除 `tabDeviceEmulations` 对应状态。
  - 清理 UI 下次展示时的状态。
- 错误提示复用现有 debugger 不可用文案能力。

## 原生 Device Toolbar 差异

- 本功能直接作用于真实 tab，不创建 DevTools 自带的设备预览画布。
- 因此页面默认仍位于浏览器内容区域左上角；居中设备外壳需要另做 DevTools 内预览画布，不应通过注入 CSS 改写业务页面布局。
- `setEmitTouchEventsForMouse` 可尝试把鼠标输入转换成 touch 输入，但普通 tab 中 CSS `:hover` 或部分 mouse 事件仍可能由浏览器触发，无法保证与原生 Device Toolbar 完全一致。
- `scale`、`viewport`、`setVisibleSize` 都不作为真实 tab 缩放方案使用；百分比缩放、自适应窗口和居中预览归入后续方案 B。

## 测试策略

- 单元测试：
  - 设备配置 normalizer。
  - 方向切换后的宽高计算。
  - 真实 tab CDP metrics 固定 `scale: 1`。
  - touchEnabled 与 maxTouchPoints 映射。
  - maybeDetachDebugger 保活条件。
- e2e：
  - PopUp 设备模拟 tab 可以管理设备。
  - DevTools 设备模拟 tab 可以启用当前 inspected tab。
  - DevTools 和 PopUp 修改同一 tab 状态后可互相读取。
  - 关闭 DevTools 后 PopUp 仍显示当前 tab 已启用。
- 真实浏览器验证：
  - 测试页读取 `innerWidth`、`innerHeight`、`devicePixelRatio`。
  - 读取 `navigator.userAgent`、`navigator.platform`。
  - 用 `matchMedia("(pointer: coarse)")` 和 touch event 能力辅助确认触摸模拟。
  - 验证横竖屏切换。
  - 验证启用后刷新页面，`screen.width`、touch 点数和 UA 仍保持模拟配置。
  - 验证启用后页面不会因图像缩放出现大面积空白和滚动条错位。

## 2026-10-13 更新：独立居中模拟器

新增 `simulator.html`，采用真实 iframe + 外壳缩放 + 限定作用域的 CDP 子 session 和属性/事件模拟。上文“居中只能通过 DevTools 预览画布实现”的结论已被本方案替代；原截图流方案继续保持放弃。

原页面模式保持原生 CDP；新画布的 DPR/screen/方向为 JS 属性模拟，触摸为鼠标转单指事件，不等价于原生 mobile viewport、CSS resolution 或可信硬件触摸。完整设计、同类扩展证据和边界见 [本轮检查记录](../bootstrap-devtools-panel/mobile-simulator-review.md)。
