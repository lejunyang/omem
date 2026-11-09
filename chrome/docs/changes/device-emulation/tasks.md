# 设备模拟任务

## 文档

- [x] 调研 CDP 设备模拟能力和扩展可行性。
- [x] 明确 DevTools / PopUp 双入口、按 tab 独立状态、关闭 DevTools 后保持启用的设计。
- [x] 明确触摸点数、`mobile`、方向切换、百分比缩放和自适应窗口的实现边界。

## 数据模型与存储

- [x] 新增 `src/shared/device-emulation.ts`，定义设备预设、运行态、normalizer 和默认设备列表。
- [x] 新增 `advancedNetwork.deviceProfiles` storage key，持久化设备列表。
- [x] 补充 storage 数字键对象、缺失 key 不回写、旧结构迁移测试。

## Background / CDP

- [x] 新增 `tabDeviceEmulations` 按 `tabId` 保存运行态。
- [x] 新增设备模拟 runtime message：查询、启用/更新、关闭、刷新。
- [x] 实现 `Emulation.setDeviceMetricsOverride`、`Emulation.setTouchEmulationEnabled`、`Emulation.setUserAgentOverride` 下发。
- [x] 实现 `Emulation.clearDeviceMetricsOverride` 和触摸关闭。
- [x] 将设备模拟纳入 `maybeDetachDebugger(tabId)` 保活条件。
- [x] `chrome.debugger.onDetach` 时清理设备模拟运行态。
- [x] 对真实 tab 设备模拟增加 `positionX/Y`、`viewport` 等 CDP 高级参数调试能力，但默认不下发实验字段。
- [x] 导航完成、tab 激活和浏览器窗口 bounds 变化后延迟合并重放设备模拟。
- [x] DevTools 面板通过 runtime port 感知面板关闭，并在关闭后分阶段重放设备模拟。
- [x] DevTools 面板轮询 inspected page viewport，覆盖 DevTools 分界线拖动、dock 开关和页面内容区域变化。
- [x] 关闭设备模拟时先清 touch/UA，再清 metrics，并 best-effort 重置 page scale。

## 共享 UI 与上下文

- [x] 新增共享 `DeviceEmulationPanel` 组件，可被 DevTools 和 PopUp 复用。
- [x] 新增共享 `useDeviceEmulationContext`，处理设备列表、当前 tab 状态、启用/关闭和同步。
- [x] 支持内置设备、自定义设备新增/编辑/删除。
- [x] 支持方向切换。
- [x] 真实 tab 设备指标固定使用 `scale: 1`，避免 CDP 图像缩放造成页面滚动区域和 DevTools 停靠区域错位。
- [x] 在设备模拟面板暴露 `Emulation.setDeviceMetricsOverride` 高级参数，每个实验字段必须手动勾选才下发。
- [x] 明确提示与原生 DevTools Device Toolbar 的冲突风险。

## DevTools 入口

- [x] DevTools 左侧功能 tab 新增“设备模拟”。
- [x] 使用 `chrome.devtools.inspectedWindow.tabId` 作为目标 tab。
- [x] DevTools 面板重新显示时同步 background 当前运行态。
- [x] 关闭 DevTools 不关闭设备模拟。

## PopUp 入口

- [x] PopUp tab 新增“设备模拟”。
- [x] 使用当前 active tab 作为目标 tab。
- [x] PopUp 关闭不关闭设备模拟。
- [x] PopUp 与 DevTools 通过 storage 和 background state 保持同步。

## 测试与验证

- [x] 单元测试覆盖 normalizer、CDP 参数转换、方向切换、scale 计算、touch 映射。
- [x] e2e 覆盖 PopUp 设备管理。
- [x] e2e 覆盖 background 对同一 tab 的设备模拟启停状态同步。
- [x] e2e 覆盖真实浏览器 `screen.width`、touch、UA 生效；无 viewport meta 页面 `innerWidth` 会保持移动端默认 layout viewport。
- [x] 单元测试覆盖 CDP 高级参数默认关闭、显式启用和非法值归一。
- [x] 更新 `docs/changes/device-emulation/validation.md`。

## 2026-10-13 居中画布

- [x] 独立真实 iframe 模拟器与 Popup / DevTools 入口。
- [x] 自定义尺寸、方向、显示缩放、UA、DPR 标识、touch 开关与单指滚动。
- [x] Chrome 125+ 子 session 初始化、限定文档嵌入策略和原 tab 隔离。
- [x] 区分原生模拟与属性/事件模拟，不恢复已回退的截图流。
- [x] 浏览器验证首脚本参数、输入、导航、旋转、禁用 touch 和保留非嵌入 CSP。
