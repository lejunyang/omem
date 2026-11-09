# 资源搜索设计

## 范围

首版选择完整方案：通过 `Page.getResourceTree + Debugger.scriptParsed + CSS.styleSheetAdded + Network` 建立当前 inspected tab 的资源索引，并支持解析前和 source map 解析后的内容搜索。UI 放在 DevTools 左侧垂直导航新增的「资源搜索」Tab 中。

首版同时支持手动忽略资源。用户可以从资源树或搜索结果忽略某个资源，也可以手动新增忽略规则。忽略规则会在搜索时过滤解析前 URL 和解析后 original source path。

## 用户体验

- 左侧功能导航新增 `资源搜索`。
- 资源搜索页顶部提供：
  - 搜索输入框。
  - 范围切换：`解析前`、`解析后`、`全部`。
  - 匹配选项：区分大小写、正则。
  - 操作按钮：刷新索引、管理忽略资源。
- 页面主体分为两块：
  - 资源树：按 `Frame -> Origin -> Resource` 展示，标记资源类型、内容状态、是否被忽略。
  - 搜索结果：展示文件、来源类型、命中行列、命中片段、所属 frame/origin。
- 资源树和搜索结果都提供「忽略」操作。
- 管理忽略资源面板支持：
  - 新增规则。
  - 删除规则。
  - 查看规则类型和命中数量。

## 忽略规则

存储 key：`advancedNetwork.resourceSearchIgnoredResources`。

规则模型：

```ts
interface ResourceIgnoreRule {
  id: string;
  enabled: boolean;
  pattern: string;
  matchType: "contains" | "exact" | "regex";
  target: "generated-url" | "source-path" | "both";
  createdAt: number;
  updatedAt: number;
}
```

默认从 UI 一键忽略时使用：

- 解析前资源：`target = "generated-url"`，`matchType = "exact"`，`pattern = resource.url`。
- 解析后源码：`target = "source-path"`，`matchType = "exact"`，`pattern = source.path`。

搜索时先判断资源是否命中启用的忽略规则，命中则不进入搜索结果。资源树仍展示被忽略状态，方便恢复。

## 数据模型

```ts
interface ResourceFrameNode {
  frameId: string;
  parentFrameId: string | null;
  url: string;
  name: string;
  securityOrigin: string;
  children: ResourceFrameNode[];
}

interface IndexedResource {
  id: string;
  frameId: string;
  url: string;
  origin: string;
  type: "document" | "script" | "stylesheet" | "source-map" | "json" | "text" | "other";
  source: "page" | "network" | "debugger" | "css";
  mimeType: string;
  contentState: "unloaded" | "loading" | "loaded" | "failed" | "skipped";
  content: string;
  sourceMapUrl: string;
  generatedResourceId: string | null;
  ignored: boolean;
  error: string;
}

interface SourceMappedResource {
  id: string;
  generatedResourceId: string;
  sourceMapUrl: string;
  path: string;
  url: string;
  contentState: "loaded" | "failed" | "missing";
  content: string;
  ignored: boolean;
  error: string;
}

interface ResourceSearchResult {
  id: string;
  scope: "generated" | "source-mapped";
  resourceId: string;
  title: string;
  url: string;
  frameId: string;
  origin: string;
  lineNumber: number;
  columnNumber: number;
  snippet: string;
}
```

## Background 采集服务

新增 `src/background/resource-search-service.ts`，由 `background.ts` 分发消息和 CDP 事件。

服务职责：

- 维护 `tabId -> ResourceSearchIndex`。
- 启动时执行：
  - `Page.enable`
  - `Network.enable`
  - `Debugger.enable`
  - `CSS.enable`
  - `Page.getResourceTree`
- 监听事件：
  - `Page.frameNavigated`、`Page.frameAttached`、`Page.frameDetached`
  - `Network.responseReceived`、`Network.loadingFinished`
  - `Debugger.scriptParsed`
  - `CSS.styleSheetAdded`
- 读取内容：
  - document/text：优先 `Page.getResourceContent`，失败后尝试 `Network.getResponseBody`。
  - script：优先 `Debugger.getScriptSource`。
  - stylesheet：优先 `CSS.getStyleSheetText`。
  - source map：先从已索引资源读取，再按 URL 拉取。
- 解析 source map：
  - 解析 `.map` JSON。
  - 建立 `generated -> original sources`。
  - 优先使用 `sourcesContent`。
  - 缺失 `sourcesContent` 时尝试根据 `sourceRoot + sources` 解析 URL 并读取原始源码。

## Panel 状态

新增 `src/panel/use-resource-search-context.ts`。

状态包括：

- `resourceFrames`
- `resources`
- `sourceMappedResources`
- `ignoredRules`
- `query`
- `scope`
- `caseSensitive`
- `regexEnabled`
- `results`
- `message`
- `isIndexing`

操作包括：

- `refreshResourceIndex()`
- `searchResources()`
- `openResourceResult(result)`
- `ignoreGeneratedResource(resource)`
- `ignoreSourceMappedResource(source)`
- `addIgnoreRule(rule)`
- `deleteIgnoreRule(ruleId)`
- `toggleIgnoreRule(ruleId)`

## 消息协议

新增 `src/shared/resource-search-messages.ts`。

Panel -> Background：

- `advanced-network:resource-search-start`
- `advanced-network:resource-search-refresh`
- `advanced-network:resource-search-get-index`
- `advanced-network:resource-search-search`
- `advanced-network:resource-search-open`

Background -> Panel 响应：

- 资源树。
- 资源列表。
- source mapped 列表。
- 搜索结果。
- debugger 不可用错误和恢复提示。

忽略规则读写由 panel 直接通过 `chrome.storage.local` 和 shared storage 适配层完成，background 只接收搜索请求时传入的启用规则快照，避免 background 与 panel 同时写入规则造成同步复杂度。

## 搜索

搜索在 background 中执行，避免大内容传回 panel 后阻塞 UI。Panel 只接收结果摘要。

规则：

- 空查询不搜索，只展示资源树。
- 正则无效时返回校验错误。
- 默认限制前 500 条命中。
- 单资源默认限制前 50 条命中。
- 被忽略资源不参与结果。
- 二进制和超过大小限制的资源不参与搜索，展示 skipped 状态。

## 打开结果

- 解析前资源：调用 `chrome.devtools.panels.openResource(url, lineNumber)`。
- 解析后资源：
  - 如果可推导 original source URL，优先 `openResource(originalUrl, lineNumber)`。
  - 否则打开 generated resource，并在结果中展示 original path 和 generated resource 的关联。
- 后续增强可以基于 source map mappings 实现 generated/original 行列精确互跳。

## 测试

- 单元测试：
  - 资源类型识别。
  - frame/origin 树归并。
  - 忽略规则匹配。
  - 文本/正则搜索。
  - source map `sourcesContent` 解析。
  - sourceRoot + sources URL 推导。
- e2e 测试：
  - 测试页加载 JS/CSS/HTML 和 source map fixture。
  - 打开 popup/DevTools 可用时验证资源搜索 Tab 能搜索解析前内容。
  - 验证 source map 原始源码内容可被搜索。
  - 验证忽略某个资源后搜索结果消失。

## 验证命令

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test:e2e`

## 已知限制

- 首版不覆盖跨 target worker / service worker 的完整资源树；后续可引入 `Target.*`。
- 无 `sourcesContent` 的 source map 解析依赖原始源码 URL 可访问性。
- 资源索引依赖 debugger 权限；用户拒绝 debugger 时只能降级提示，无法完整实现 Sources 级资源搜索。
