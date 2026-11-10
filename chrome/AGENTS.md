# AGENTS.md

## 项目目标

- omem 仓库里的 Chrome 扩展（pnpm workspace 包 `omem-chrome`，目录 `chrome/`）。仓库根目录的 AGENTS.md 同样适用（公开仓库、不写真实信息、提交约定）；这里只写扩展自己的约定。
- 核心能力：DevTools「网络」面板（请求观测、高级筛选、筛选方案、响应搜索、Mock、Initiator、Network 控制项）、资源搜索、用户状态、设备模拟，以及「拾取」（截图、元素样式、间距，侧栏拾取篮）。
- 需求、设计、任务和验证记录维护在 `docs/` 下；「不用 CDP 的默认模式」和「拾取」的设计在 `docs/changes/no-cdp-and-pick/`。

## 开发命令

在仓库根目录执行（一份 `pnpm-lock.yaml`，不在 `chrome/` 里单独装依赖）：

- 安装依赖：`pnpm install --filter omem-chrome`
- 类型、单元测试、构建：`pnpm --filter omem-chrome run check`
- e2e 测试：`pnpm --filter omem-chrome run test:e2e`（无头 Chromium 加载真实构建；首次 `test:e2e:install-browser`）
- 截图检查：`pnpm --filter omem-chrome run build && node chrome/scripts/shots.mjs <目录> [--dark]`
- 本地测试页：`pnpm --filter omem-chrome run preview:test` 后打开 `http://127.0.0.1:5173/test-page.html`

## 代码组织规则

- `src/panel/App.vue` 只负责组合页面、绑定顶层状态和协调子模块，不允许继续把新功能完整堆进单文件。
- 新增功能优先拆分到独立文件：
  - 可复用业务模型放入 `src/shared/`。
  - 面板状态和副作用放入 `src/panel/` 的 composable 或服务模块。
  - 纯 UI 区块优先拆成 Vue 组件。
  - Chrome API 兼容层、storage 适配层、CDP 消息封装必须与 UI 解耦。
- 当单文件超过约 400 行，继续新增功能前应优先评估拆分；复杂逻辑必须配套测试。
- 代码应尽量添加中文注释，说明“为什么这样做”和“边界是什么”，不要只重复代码表面行为。
- 每个函数应尽量使用中文注释说明用途；简单 getter、测试内联回调、Vue 事件透传等自解释函数可不强制。
- 修复问题时，应在关键判断或兼容层旁补充中文注释，说明问题背景、触发条件和修复方法。
- 复杂逻辑、Chrome/DevTools API 兼容、storage 迁移、CDP/debugger 行为、跨页面同步和异步竞态必须有中文注释说明边界。
- 不要写“赋值给变量”“返回结果”“调用函数”这类低价值注释。

## 样式规则

- 除非明确允许或按钮文本过多，否则按钮宽度不得被压缩；普通文本按钮应保持完整可读，图标按钮需显式使用对应的紧凑样式。

## CDP（chrome.debugger）

- 默认不连接：一连接 Chrome 就在所有窗口顶部显示调试提示条，扩展无法隐藏。开关是 `advancedNetwork.cdpMode`（`src/shared/cdp-mode.ts`），默认 `off`。
- `background.ts` 的 `attachDebugger` 是唯一的连接入口，关闭时抛 `CdpDisabledError`，回复带 `cdpDisabled: true`；界面据此显示「需要开启 CDP 增强」，不当成故障、不弹调试器警告。不要绕过它直接调 `chrome.debugger.attach`。
- 新功能先想不用 CDP 怎么做：页面里的事交给页面钩子（`src/inject/page-hook.ts`）或内容脚本，请求头交给 declarativeNetRequest，资源读 `chrome.devtools.inspectedWindow`；确实只能靠 CDP 的，关闭时置灰并说明，CDP 开启后才可用。
- 开启时也要用完就断：没有功能需要时由 `maybeDetachDebugger` 断开；DevTools 关闭（面板 port 断开）时停掉调用栈观察。
- 注入页面的脚本放 `src/inject/`，由 `scripts/build-inject.mjs` 各自打包成 IIFE；钩子和桥之间只传 JSON 字符串，桥只转发规则 id，不信任页面传来的脚本内容。

## Chrome Extension 约束

- Manifest V3 配置位于 `public/manifest.json`，构建产物加载目录是 `dist/`。
- DevTools 面板通过 `devtools_page` 和 `chrome.devtools.panels.create` 注册。
- DevTools API 在运行时可能仍是 callback 风格，不要直接假设 Promise；必须使用兼容封装。
- `debugger`、`offscreen` 等权限变更后，需要重新加载扩展，并在 Chrome 权限提示中允许。
- 依赖 CDP 的 Mock、Initiator、禁用缓存和限速功能，都必须处理 debugger 不可用和 CDP 未开启两种回复。
- 拾取的截图走 `chrome.tabs.captureVisibleTab`（只认 activeTab 或 `<all_urls>`，单个站点权限不够；每秒最多 2 次），记录存 IndexedDB `omem-pick`（`src/shared/pick-store.ts`），不放 `chrome.storage.local`。

## Storage 规则

- 持久化数据使用 `chrome.storage.local`，不要使用 `window.localStorage`。
- 重要 key：
  - `advancedNetwork.filterPresets`
  - `advancedNetwork.mockRules`
  - `advancedNetwork.mockGroups`
  - `advancedNetwork.networkControls`
- 读写 `chrome.storage.local` 必须走 `src/shared/extension-storage.ts`，不得在 UI 逻辑中裸调。
- 初始化读取时不得把缺失 key 无条件回写为空数组或空对象，避免关闭并重开 DevTools 后清空用户数据。
- Chrome storage 或 DevTools 展示中可能出现 `{ "0": item }` 这种数字键对象，列表 normalizer 必须兼容。
- 每次修改 storage 结构，必须新增或更新单元测试，覆盖旧结构迁移、数字键对象、空 key 不覆盖三类场景。

## 验证规则

- 每次代码变更后至少运行 `pnpm --filter omem-chrome run check`；动了界面用 `scripts/shots.mjs` 截浅色和深色看一遍。
- 新增功能或修复问题时，必须优先评估是否能补 e2e；涉及 Chrome API、DevTools API、Mock、storage、用户状态、popup/devtools UI、跨页面同步或真实浏览器行为时，应尽量新增或更新 e2e。
- 单元测试用于覆盖纯函数、normalizer、解析器和边界算法；不能用单元测试替代可以稳定自动化的关键用户路径。
- 无法新增 e2e 时，需要在 `validation.md` 说明原因、风险和替代验证方式。
- 修改 Chrome API、DevTools API、Mock 或 storage 行为时，还要更新 `docs/changes/bootstrap-devtools-panel/validation.md`。
- 浏览器验证建议：
  - 在 `chrome://extensions` 加载或重新加载 `dist/`。
  - 打开测试页并打开 DevTools。
  - 进入「omem」面板复验 UI、storage、CDP 开关和请求列表；默认（CDP 关闭）时 Chrome 顶部不应出现调试提示条。
- 查看扩展 storage：
  - 打开 `chrome://extensions`。
  - 找到「omem 助手」扩展，点击 Service Worker 或扩展页面的“检查视图”。
  - 在扩展上下文 Console 执行 `await chrome.storage.local.get(null)`。

## Git 和文档

- 按仓库根目录的约定：功能切片检查通过后在本地提交，不 push。
- 提交前先运行验证命令，并用 `git status --short` 确认只提交本轮相关文件。
- 不要回滚用户未授权的变更；遇到非本轮意外改动必须先询问。
- 文档与代码同改：新增能力要更新 `tasks.md`，重要验证和已知边界要更新 `validation.md`。
