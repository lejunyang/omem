# 资源搜索调研

## 目标

在 DevTools「高级网络」中新增资源搜索能力，用于查找当前 tab 已加载静态资源中的特定内容。资源范围覆盖 HTML、JS、CSS、JSON、XML、source map 和其它文本资源，并支持解析前 bundle 内容与 source map 解析后的原始源码内容搜索。

## Chrome 能力来源

- `Page.getResourceTree`：返回当前 inspected tab 的 frame 树和 frame 下资源列表，是建立 `Frame -> Origin -> Resource` 资源树的主要入口。
- `Page.getResourceContent`：按 `frameId + url` 读取 Page 资源内容，适合 HTML、CSS、普通文本资源。
- `Network.enable` / `Network.responseReceived` / `Network.loadingFinished`：记录请求的 `requestId`、URL、mimeType、frameId 和完成状态。
- `Network.getResponseBody`：按 `requestId` 读取响应体，用于补齐 Network 已知资源内容。
- `Debugger.enable` / `Debugger.scriptParsed`：采集 JS 脚本、inline/eval/blob 脚本、`scriptId`、`sourceMapURL` 和执行上下文。
- `Debugger.getScriptSource`：按 `scriptId` 读取 JS 解析前源码。
- `CSS.enable` / `CSS.styleSheetAdded`：采集 CSS stylesheet、`styleSheetId`、`sourceURL`、`sourceMapURL` 和 `frameId`。
- `CSS.getStyleSheetText`：按 `styleSheetId` 读取 CSS 文本。

## 与现有实现的关系

- 项目已具备 `debugger` 权限和 background 侧 CDP 通道，可复用现有 `attachDebugger`、`sendDebuggerCommand`、debugger 不可用提示和 detach 策略。
- 当前 Network 面板只通过 HAR 和 `Request.getContent()` 读取请求响应，不足以覆盖 inline/eval/blob、frame 资源树、CSS stylesheet 和 source map 解析后源码。
- 新功能应作为独立 DevTools 功能 Tab，不和现有请求列表筛选混用，避免扩大 `use-panel-context.ts` 的职责。

## 资源覆盖边界

- 支持：document、script、stylesheet、fetch/xhr 中的文本资源、JSON、XML、source map、inline script、inline style、eval、blob/data URL 的可读取脚本。
- 默认跳过：图片、字体、音视频、wasm 字节码、大体积二进制响应。
- DevTools 打开前已加载资源：`Page.getResourceTree` 可恢复资源树；内容读取依赖 `Page.getResourceContent`、`Debugger.getScriptSource`、`CSS.getStyleSheetText` 或 `Network.getResponseBody` 是否仍可用。
- 多 frame：以 `frameId` 为一等字段，资源树按 frame 和 origin 分组。
- worker / service worker / OOPIF：首版只覆盖当前 inspected tab target 内能通过现有 `chrome.debugger` 收到的事件；跨 target worker 后续可通过 `Target.*` 扩展。

## Source Map 能力边界

- JS source map 来源：`Debugger.scriptParsed.sourceMapURL`，也可从脚本文本末尾 `sourceMappingURL` 注释兜底解析。
- CSS source map 来源：`CSS.styleSheetAdded.sourceMapURL`，也可从 stylesheet 文本末尾 `sourceMappingURL` 注释兜底解析。
- `.map` 获取策略：
  - 先查询资源索引中是否已存在对应 `.map`。
  - 再通过 `Page.getResourceContent` 或 `Network.getResponseBody` 尝试读取。
  - 最后在具备 host 权限时由 background fetch 尝试拉取。
- 若 source map 含 `sourcesContent`，直接建立解析后源码索引。
- 若 source map 不含 `sourcesContent`，按 `sourceRoot + sources` 相对 `.map` URL 推导原始源码 URL 并尝试拉取；失败时保留缺失状态。
- 搜索解析后内容不要求首版完成精确断点级映射，但搜索结果应记录来自哪个 generated 资源、source map URL 和 original source path。

## 忽略资源

- 用户需要在搜索时手动忽略资源，避免 vendor bundle、框架运行时代码、source map 或大型第三方文件污染结果。
- 忽略规则应作用于解析前 URL 和解析后 original source path。
- 忽略规则建议持久化在 `chrome.storage.local`，保证关闭 DevTools 后仍然生效。
- 忽略方式支持从资源树、搜索结果一键加入，也支持手动新增规则。

## 风险

- `debugger` 被用户拒绝或被其它调试器占用时，资源搜索需要明确降级并提示恢复方式。
- `Network.getResponseBody` 对已过期请求可能失败，需要回退到 Page / Debugger / CSS 内容读取能力。
- 大资源全量索引可能造成 DevTools 卡顿，需要限制单文件大小、总索引大小和搜索结果数量。
- source map 文件体积可能很大，应异步解析并展示加载状态。
