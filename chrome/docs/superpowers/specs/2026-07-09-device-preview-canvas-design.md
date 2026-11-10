# Device Preview Canvas Design

> 状态：已放弃。2026-07-10 实测发现 `Page.startScreencast` 预览画质过糊，无法满足设备模拟预览体验要求；相关实现已回退。本文件仅保留为历史调研记录，不再作为待实现方案。

## 背景

真实 tab 设备模拟基于 `Emulation.setDeviceMetricsOverride` 可以修改页面可感知的宽高、DPR、UA 和 touch 能力，但无法稳定复刻 Chrome DevTools Device Toolbar 的外层设备画布。实际在 `https://shop.example.com/enterprise/index` 验证时，真实 tab 路线出现空白区域、滚动条错位、页面内容覆盖 DevTools 等问题。

方案 B 改为在「高级网络」DevTools 面板内渲染设备预览画布。业务页面不注入 DOM、不包裹 wrapper、不改写页面 CSS；设备预览、居中、缩放和输入代理都发生在扩展 DevTools 面板中。

## 目标

- 在 DevTools「设备模拟」面板内展示居中的设备预览画布。
- 预览画布支持按设备宽高、方向和面板可用空间自适应缩放。
- 首版支持键盘输入、文本输入、touch、mouse 和 pointer 相关交互转发。
- 保留 PopUp 的设备管理和启停入口，但 PopUp 不承载预览画布。
- e2e 默认静默后台运行，不再弹出浏览器打断用户操作。

## 非目标

- 不在业务页面中注入预览 DOM、CSS wrapper 或 overlay。
- 不首版实现多点触控手势编辑器、设备外壳皮肤、截图录屏导出。
- 不保证完全复刻原生 DevTools Device Toolbar 的全部边缘行为，例如复杂 IME 组合输入或系统级手势。

## 架构

### Background

Background 继续作为 CDP 调度中心，新增设备预览会话表：

```ts
const tabDevicePreviews = new Map<number, DevicePreviewSession>();
```

`DevicePreviewSession` 记录：

```ts
interface DevicePreviewSession {
  tabId: number;
  startedAt: number;
  frameSeq: number;
  lastFrameAt: number;
}
```

Background 新增消息：

- `advanced-network:start-device-preview`
  - 输入：`tabId`
  - 行为：attach debugger、`Page.enable`、`Runtime.enable`、`Page.startScreencast`
- `advanced-network:stop-device-preview`
  - 输入：`tabId`
  - 行为：`Page.stopScreencast`，清理预览会话，并调用 `maybeDetachDebugger`
- `advanced-network:dispatch-device-preview-input`
  - 输入：`tabId`、输入事件 payload
  - 行为：转发到 CDP `Input.dispatchMouseEvent`、`Input.dispatchTouchEvent`、`Input.dispatchKeyEvent` 或 `Input.insertText`

Background 监听 `chrome.debugger.onEvent`：

- `Page.screencastFrame`
  - 读取 `data`、`metadata`、`sessionId`
  - 立即调用 `Page.screencastFrameAck`
  - 通过 `chrome.runtime.sendMessage` 广播给 DevTools 面板
- `chrome.debugger.onDetach`
  - 清理对应 tab 的 preview session

### DevTools Panel

新增共享或 panel 专属组件：

- `src/panel/components/DevicePreviewCanvas.vue`
  - 负责展示画面、设备外壳、缩放、居中和输入捕获。
- `src/panel/use-device-preview-context.ts`
  - 负责 start/stop preview、接收 screencast frame、计算画布坐标到设备坐标的映射、发送输入事件。

设备模拟面板接入：

- `DeviceEmulationPanel.vue` 接收可选 `previewContext`。
- DevTools 入口传入 preview context。
- PopUp 不传 preview context，只显示设备管理和开关。

## 画面流

1. 用户进入 DevTools「设备模拟」。
2. 点击“启动预览画布”。
3. DevTools 面板发送 `advanced-network:start-device-preview`。
4. Background 下发：
   - `Page.enable`
   - `Page.startScreencast({ format: "jpeg", quality: 80, everyNthFrame: 1 })`
5. Background 收到 `Page.screencastFrame` 后：
   - ack 当前帧
   - 广播 `advanced-network:device-preview-frame`
6. DevTools 面板使用 `data:image/jpeg;base64,...` 渲染画面。
7. 面板根据设备尺寸和容器尺寸计算 CSS scale，让设备画布居中显示。

## 输入转发

### 坐标映射

预览组件记录：

- 设备逻辑宽高：`profile.width` / `profile.height`，横屏时交换。
- 画布展示矩形：`getBoundingClientRect()`。
- 当前展示缩放：`displayScale`。

将 DOM 坐标转换为设备坐标：

```ts
const x = (event.clientX - rect.left) / displayScale;
const y = (event.clientY - rect.top) / displayScale;
```

坐标必须 clamp 到 `[0, deviceWidth]` 和 `[0, deviceHeight]`，避免拖拽越界导致 CDP 报错。

### Pointer / Mouse

首版捕获 `pointerdown`、`pointermove`、`pointerup`、`pointercancel`、`wheel`：

- `pointerType === "touch"` 或设备启用 touch 时：
  - 转为 `Input.dispatchTouchEvent`
  - `pointerdown` -> `touchStart`
  - `pointermove` -> `touchMove`
  - `pointerup` / `pointercancel` -> `touchEnd`
- `pointerType === "mouse"` 且未启用 touch 时：
  - 转为 `Input.dispatchMouseEvent`
  - `pointerdown` -> `mousePressed`
  - `pointermove` -> `mouseMoved`
  - `pointerup` -> `mouseReleased`
- `wheel`：
  - 转为 `Input.dispatchMouseEvent({ type: "mouseWheel" })`

预览画布必须 `touch-action: none`，避免浏览器自身滚动面板吞掉触摸或 pointer 事件。

### Keyboard

预览容器设置 `tabindex="0"`，点击画布后聚焦。

首版捕获：

- `keydown`
- `keyup`

转发为 `Input.dispatchKeyEvent`：

- `type: "keyDown"` / `"keyUp"`
- `key`
- `code`
- `windowsVirtualKeyCode`
- `nativeVirtualKeyCode`
- `modifiers`

对常见控制键（Enter、Backspace、Tab、Escape、Arrow keys）使用 key event。普通文本输入优先使用 `Input.insertText`，减少不同键盘布局导致的字符错误。

### 文本输入

首版在预览画布旁提供一个小型“文本输入代理”：

- 输入框仅用于把文本发送到目标页面，不保存业务内容。
- 用户输入文本后点击“发送文本”或按 Enter。
- DevTools 面板发送 `advanced-network:dispatch-device-preview-input`，background 调用 `Input.insertText({ text })`。

这样可以覆盖普通文本输入路径，也避免复杂 IME composition 直接映射到 `dispatchKeyEvent` 的不稳定问题。

## CDP 生命周期

预览画布会复用现有 debugger attach：

- 如果 Mock、资源搜索、网络控制或设备模拟已经 attach，不重复 attach。
- `maybeDetachDebugger(tabId)` 新增 `tabDevicePreviews.has(tabId)` 保活条件。
- 关闭预览只停止 screencast，不强制关闭设备模拟。
- 关闭设备模拟不强制关闭预览；但如果预览仍打开，会继续显示真实页面当前状态。

## E2E 静默运行

`vitest.e2e.config.ts` 调整：

- 默认 `browser.headless = true`。
- 支持 `E2E_BROWSER_HEADLESS=false` 时显式弹出浏览器，用于本地调试。
- 保持 `E2E_BROWSER_CHANNEL`、`E2E_BROWSER_EXECUTABLE_PATH`、`E2E_BROWSER_USER_DATA_DIR` 兼容。

E2E 新增覆盖：

- 启动设备预览后收到至少一帧 screencast。
- 点击预览画布会发送 input message，并在测试页产生可观测变化。
- 文本输入代理可将文本插入当前 focused input。
- 默认 e2e 配置为 headless，避免弹窗打断用户操作。

## 风险与边界

- `Page.startScreencast` 是 CDP 实验能力，不同 Chromium 版本可能存在帧率、格式或后台节流差异。
- DevTools 面板收到帧后应只保留最新帧，避免 base64 图片堆积造成内存增长。
- 键盘输入对 IME composition 的直接模拟不稳定，首版通过文本输入代理覆盖中文等组合输入场景。
- touch/pointer 转发首版支持单指基础交互，多点手势后续再做。
- 预览画布和真实 tab 会同时存在；用户应以 DevTools 内预览作为交互入口，避免真实 tab 和预览输入交错造成状态混乱。

## 验证

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e -- e2e/popup-device-emulation.e2e.test.ts`
- `pnpm test:e2e`
- `pnpm build`
- `git diff --check`
