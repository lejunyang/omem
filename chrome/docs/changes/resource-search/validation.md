# 资源搜索验证记录

## 2026-07-05 设计阶段

- 已确认首版采用完整方案：
  - `Page.getResourceTree` 建立 frame/resource 树。
  - `Network` 补请求元信息和响应体读取。
  - `Debugger.scriptParsed` 补 JS 脚本、inline/eval/blob 和 JS source map。
  - `CSS.styleSheetAdded` 补 stylesheet 和 CSS source map。
- 已将手动忽略资源纳入首版：
  - 支持 generated URL 和 source mapped original path。
  - 支持 contains/exact/regex 匹配方式。
  - 忽略规则计划持久化到 `chrome.storage.local`。
- 当前阶段仅完成调研和设计，尚未进行代码实现。

## 2026-07-05 首版实现

- 已新增 shared 资源搜索模型和消息协议：
  - 资源模型覆盖 generated resource、source mapped resource、frame tree、搜索结果和忽略规则。
  - 忽略规则支持 `contains`、`exact`、`regex`，目标支持 generated URL、source path 和 both。
- 已新增 background 资源搜索服务：
  - 启动时启用 `Page`、`Network`、`Debugger`、`CSS` 域。
  - 通过 `Page.getResourceTree` 初始化 frame/resource 树。
  - 通过 `Network.responseReceived` / `Network.loadingFinished` 记录 requestId 和响应元信息。
  - 通过 `Debugger.scriptParsed` 记录 JS 脚本和 source map。
  - 通过 `CSS.styleSheetAdded` 记录 stylesheet 和 source map。
  - 读取内容时按资源来源优先使用 `Debugger.getScriptSource`、`CSS.getStyleSheetText`、`Page.getResourceContent`、`Network.getResponseBody`，最后尝试 fetch。
- 已实现 source map 解析：
  - 支持 `sourcesContent` 直接索引。
  - 支持无 `sourcesContent` 时按 `sourceRoot + sources` 推导原始源码 URL 并尝试拉取。
- 已新增 DevTools「资源搜索」Tab：
  - 支持解析前、解析后、全部搜索范围。
  - 支持文本、正则和区分大小写。
  - 支持资源树展示、结果打开、从资源或搜索结果一键忽略。
  - 支持手动管理忽略规则并持久化到 `chrome.storage.local`。
- 已扩展测试页 fixture：
  - `resource-search-fixture.js` / `.js.map`
  - `resource-search-fixture.css` / `.css.map`
- 当前验证：
  - `pnpm test`：通过，13 个测试文件、77 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。
  - `pnpm test:e2e`：通过，2 个 e2e 文件、8 个用例。

## 2026-07-05 补充测试

- 已补充 shared 层测试：
  - `createIgnoreRule` 默认值和时间戳。
  - `searchResourceIndex` 直接传入 `options.ignoredRules` 时应过滤资源。
  - source map 缺失 `sourcesContent`、无效 JSON、缺失 `sources` 字段。
  - `extractSourceMapUrl`、`resolveSourceMapUrl`、`isSearchableResource` 边界。
- 已补充 background 资源索引服务测试：
  - `Page.getResourceTree` 初始化 frame/resource 树，并跳过非文本资源。
  - 解析 Page 资源中的 source map 并索引 original source。
  - `Debugger.scriptParsed`、`CSS.styleSheetAdded`、`Network.responseReceived` 事件生成可搜索资源。
  - 搜索消息在尚未索引时自动刷新索引。
  - `clearTab` 清理 tab 状态。
- 测试暴露并修复两个问题：
  - `searchResourceIndex` 接收 `ignoredRules` 但未直接应用，已改为在函数内叠加忽略规则。
  - background 搜索消息在 tab 尚未 active 时不会初始化索引，已改为搜索前自动刷新。
- 当前验证：
  - 聚焦测试：`vitest run src/shared/resource-search.test.ts src/background/resource-search-service.test.ts` 通过，2 个测试文件、18 个用例。
  - `pnpm test`：通过，14 个测试文件、87 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。
  - `pnpm test:e2e`：通过，2 个 e2e 文件、8 个用例。

## 2026-07-05 资源树 UI 改造

- 已将资源搜索左侧从卡片式资源列表改为 Sources 风格树：
  - 结构为 `top/frame -> origin -> path folder -> file`。
  - 文件节点支持点击，通过 `chrome.devtools.panels.openResource` 定位到源代码。
  - Source Map 源文件合并进左侧 `Source Map 源文件` 树分组，不再占用右侧搜索结果区域。
  - 默认隐藏 `contentState=skipped` 的资源，避免 png/font/media 污染主树；提供“显示已跳过资源”开关。
  - 统计文案改为 `可搜索 / 总计`，区分可搜索资源和索引总数。
- 已补充 `resource-tree` 单测：
  - 覆盖 frame/origin/path/file 树归并。
  - 覆盖已跳过资源默认隐藏和开关显示。
  - 覆盖 Source Map 已加载源文件分组。
- 当前验证：
  - `pnpm exec vitest run src/shared/resource-tree.test.ts`：通过，1 个测试文件、3 个用例。
  - `pnpm test`：通过，15 个测试文件、90 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。

## 2026-07-05 资源树行为修正

- 已按用户反馈修正资源树默认行为：
  - 新增“跳过 chrome-extension 资源”开关，默认选中，默认过滤扩展自身资源。
  - 关联到被过滤 generated resource 的 Source Map 源文件同步过滤，避免 Source Map 分组继续展示扩展源码。
  - 未关联 frame 的资源分组显示为 `Top`。
  - 单子目录链压缩为一个路径节点，例如 `assets/src/js/service`。
  - 树节点默认折叠，不再刷新后自动展开所有层级。
  - Source Map 文件节点点击时优先打开 original URL，打开失败时回退到关联 generated resource。
- 已补充 `resource-tree` 单测：
  - 覆盖 `chrome-extension://` 资源过滤及关闭过滤后的展示。
  - 覆盖关联 generated resource 被过滤时 source mapped resource 同步隐藏。
  - 覆盖 `Top` 命名和单子目录链压缩。
- 当前验证：
  - `pnpm exec vitest run src/shared/resource-tree.test.ts`：通过，1 个测试文件、6 个用例。
  - `pnpm test`：通过，15 个测试文件、93 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。

## 2026-07-05 资源树重复 Top 和 null 修复

- 已用现有 Edge 打开 `https://shop.example.com/enterprise/index`，确认页面可在登录态下访问。
- 根据页面截图和资源树构建逻辑定位：
  - `Page.getResourceTree` 中的主 frame 被展示为 `top`。
  - `Debugger.scriptParsed` / `CSS.styleSheetAdded` / 部分 `Network` 资源可能没有 `frameId`，此前会被额外放入 `Top`，因此出现双顶层分组。
  - 某些匿名、内联、`data:`、`blob:` 或无标准 origin 的资源会得到字符串 `"null"`，此前直接作为 origin 分组展示。
- 已修正资源树构建：
  - 当存在主 frame 时，无 `frameId` 资源合并进主 frame。
  - 同一 frame 下相同 URL 的资源按内容状态和来源优先级去重，避免 Page/Debugger 同 URL 重复展示。
  - 字符串 `"null"` origin 归一化为 `(no origin)`。
- 已补充 `resource-tree` 单测：
  - 覆盖无 `frameId` 资源合并进主 frame 后不再出现第二个 `Top`。
  - 覆盖同 URL Page/Debugger 资源在树中只显示一次。
  - 覆盖 `"null"` origin 不直接展示。
- 当前验证：
  - `pnpm exec vitest run src/shared/resource-tree.test.ts`：通过，1 个测试文件、8 个用例。
  - `pnpm test`：通过，15 个测试文件、95 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。

## 2026-07-05 匿名脚本源码预览

- 已优化无真实 URL 的 Debugger 数字脚本：
  - 资源树和搜索结果标题从纯数字改为 `匿名脚本 #<scriptId>`。
  - 仍通过 `Debugger.getScriptSource` 读取内容并参与 generated 搜索。
  - 点击资源树匿名脚本或对应搜索结果时，不再调用 `openResource`，改为在资源搜索面板内展示源码预览。
  - 源码预览展示命中行附近片段，并标记命中行号。
- 已补充测试：
  - 覆盖纯数字 Debugger 脚本识别为虚拟脚本。
  - 覆盖匿名脚本搜索结果标题和资源树标题。
  - 覆盖无真实 URL 时不被视为可直接 `openResource` 打开的资源。
- 当前验证：
  - `pnpm exec vitest run src/shared/resource-search.test.ts src/shared/resource-tree.test.ts`：通过，2 个测试文件、23 个用例。
  - `pnpm test`：通过，15 个测试文件、96 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。

## 2026-07-05 匿名脚本过滤和 Source Map 预览兜底

- 已新增资源树开关“跳过匿名脚本”：
  - 默认不勾选，保持现有匿名脚本展示和搜索行为。
  - 勾选后，资源树过滤 `Debugger.scriptParsed` 中无真实 URL 的匿名脚本。
  - 勾选后，generated 搜索也过滤匿名脚本，不返回对应命中。
- 已修复 Source Map 源文件点击：
  - 相对路径、空 URL 或不可直接打开的 original URL 直接走插件内源码预览。
  - 可打开 URL 仍优先调用 `chrome.devtools.panels.openResource`。
  - `openResource` 回调出现 `chrome.runtime.lastError` 时回退源码预览。
  - 如果 Source Map 未内联 `sourcesContent`，则回退打开 generated resource，并展示提示。
- 已补充测试：
  - 覆盖跳过匿名脚本后的资源树过滤。
  - 覆盖跳过匿名脚本后的搜索过滤。
- 当前验证：
  - `pnpm exec vitest run src/shared/resource-search.test.ts src/shared/resource-tree.test.ts`：通过，2 个测试文件、25 个用例。
  - `pnpm test`：通过，15 个测试文件、98 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。

## 2026-07-05 Source Map 点击预览优先

- 已用现有 Edge 打开 `https://shop.example.com/enterprise/index` 并查看资源搜索树：
  - Source Map 源文件树中存在大量 `../../../../../node_modules/.pnpm/.../dist/index.js` 路径。
  - 这些路径来自 `.map` 文件的 `sources` 字段，属于 original source path，不是页面真实请求 URL。
  - 树节点显示“已加载”，说明对应 `SourceMappedResource.contentState=loaded`，内容来自 `.map` 的 `sourcesContent`。
- 定位当前点击无效果的原因：
  - 旧逻辑对 Source Map 条目优先调用 `chrome.devtools.panels.openResource(originalUrl)`。
  - 相对路径会被 `sourceMapUrl + sourceRoot + sources` 解析为一个看似可打开的 URL。
  - Edge DevTools 可能 callback 不返回 `lastError`，但 UI 也没有实际切换到该 original source，因此不会触发 fallback 预览。
- 已调整：
  - Source Map 条目只要已有 `sourcesContent` 内容，点击就优先在插件内源码预览。
  - 预览中展示数据源：`Source Map sourcesContent`。
  - 预览中展示 Source Map URL 和关联 generated 资源 URL，便于判断每项来源。
  - “跳过匿名脚本”默认勾选。
  - “显示已跳过资源”文案改为“显示已跳过二进制资源”。
- 当前验证：
  - `pnpm test`：通过，15 个测试文件、98 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。
