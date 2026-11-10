# 资源搜索任务

## 文档

- [x] 调研 `Page.getResourceTree`、`Debugger.scriptParsed`、`CSS.styleSheetAdded` 和 `Network` 的资源采集边界。
- [x] 设计资源树、解析前搜索、source map 解析后搜索和忽略资源规则。
- [x] 实现完成后持续更新验证记录。

## 实现拆分

- [x] 新增 shared 资源搜索模型、消息协议、搜索函数和忽略规则 normalizer。
- [x] 新增 background 资源搜索服务，维护 tab 级资源索引。
- [x] 接入 CDP `Page` 域，初始化 frame tree 和 frame resources。
- [x] 接入 CDP `Network` 域，记录 requestId、mimeType、frameId 和响应体读取能力。
- [x] 接入 CDP `Debugger` 域，记录 scriptParsed、scriptId、sourceMapURL 并读取 JS source。
- [x] 接入 CDP `CSS` 域，记录 styleSheetAdded、styleSheetId、sourceMapURL 并读取 CSS text。
- [x] 实现 source map 读取、解析、`sourcesContent` 索引和无 `sourcesContent` 时的源码 URL 推导。
- [x] 新增忽略资源 storage key，支持 contains/exact/regex 与 generated/source/both 范围。
- [x] 新增 panel resource search context，管理查询状态、索引刷新、搜索和忽略规则。
- [x] 新增 DevTools「资源搜索」Tab 和资源搜索面板 UI。
- [x] 将资源树从卡片列表改为类似 Sources 的 `Frame -> Origin -> Path -> File` 可展开树。
- [x] 资源树文件节点支持点击定位到 DevTools 源代码。
- [x] 资源树默认隐藏 png/font 等已跳过资源，并提供显示开关。
- [x] 资源树默认跳过 `chrome-extension://` 资源，并提供开关恢复展示。
- [x] 将未关联 frame 的资源归入 `Top`，减少和原生 Sources 的命名差异。
- [x] 压缩单子目录链，将 `/assets/src/js/service` 这类路径折叠为一个树节点。
- [x] 资源树默认折叠，仅在用户点击后展开子级。
- [x] Source Map 源文件点击优先打开 original URL，失败时回退到 generated 资源。
- [x] 将无 `frameId` 但属于页面的 Debugger/CSS/Network 资源合并进主 frame，避免资源树出现重复 `top`/`Top`。
- [x] 归一化无标准 origin 的资源分组，避免直接显示字符串 `null`。
- [x] 将无真实 URL 的 Debugger 数字脚本展示为 `匿名脚本 #<scriptId>`。
- [x] 支持点击匿名脚本和对应搜索结果时在插件内预览源码片段。
- [x] 资源树增加“跳过匿名脚本”开关，勾选后资源树和搜索结果都过滤匿名脚本。
- [x] Source Map 源文件点击在 original URL 不可打开或打开失败时，回退到插件内源码预览。
- [x] “跳过匿名脚本”默认勾选，减少匿名 Debugger 脚本对主资源树的干扰。
- [x] 将“显示已跳过资源”文案改为“显示已跳过二进制资源”，避免和匿名脚本、chrome-extension 过滤混淆。
- [x] Source Map 源文件已加载内容时点击优先插件内预览，并展示 `sourcesContent`、Source Map URL 和 generated 资源来源。
- [x] 支持从资源树和搜索结果一键忽略资源，并支持管理忽略规则。
- [x] 搜索结果支持打开资源，解析前结果打开 generated URL，解析后结果优先打开 original URL。
- [x] 接入 debugger 不可用提示和降级状态。
- [x] 控制大文件、二进制和结果数量，避免 DevTools 卡顿。

## 测试

- [x] 覆盖资源类型识别和文本资源过滤。
- [x] 覆盖 frame/origin/resource 树归并。
- [x] 覆盖忽略规则匹配、启停和 invalid regex 处理。
- [x] 覆盖普通文本、区分大小写和正则搜索。
- [x] 覆盖 source map `sourcesContent` 解析。
- [x] 覆盖 sourceRoot + sources 的源码 URL 推导。
- [x] 覆盖资源搜索消息 normalizer。
- [x] 覆盖 background 资源索引服务的 Page/Debugger/CSS/Network 聚合、source map 解析和 tab 生命周期。
- [x] 覆盖 Sources 风格资源树归并、跳过资源过滤、`chrome-extension://` 过滤、路径压缩、无 frame 资源合并、`null` origin 归一化和 Source Map 源文件分组。
- [x] 覆盖匿名 Debugger 脚本展示名、可搜索性和资源树展示。
- [x] 覆盖跳过匿名脚本的资源树过滤和搜索过滤。
- [x] 扩展测试页，增加 JS/CSS/source map fixture。
- [ ] 扩展 e2e，覆盖解析前搜索、解析后搜索和忽略资源。

## 验证

- [x] `pnpm test`
- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm test:e2e`
- [ ] 浏览器验证 DevTools「资源搜索」Tab 可见。
- [ ] 浏览器验证 frame/origin 资源树展示正确。
- [ ] 浏览器验证 source map 解析后搜索结果正确。
- [ ] 浏览器验证忽略资源后搜索结果被过滤。
