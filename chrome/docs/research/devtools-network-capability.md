# DevTools Network 能力调研

更新时间：2026-07-02

## 目标

在 Chrome DevTools 中新增「高级网络」面板，尽量覆盖原生 Network 的核心能力，并扩展高级筛选、搜索和 mock。

## 可用技术面

| 技术 | 主要用途 | 优点 | 关键限制 | 当前判断 |
| --- | --- | --- | --- | --- |
| `chrome.devtools.panels` | 创建 DevTools 自定义面板 | 官方 DevTools 扩展能力，适合做独立 Tab | 只在 DevTools 打开时工作 | 必选 |
| `chrome.devtools.network` | 获取 HAR、监听请求完成、读取请求内容 | 与 DevTools 当前 inspected window 绑定，适合复刻 Network 观测 | 主要是观测能力，不负责拦截和改写 | MVP 主路线 |
| `chrome.debugger` + CDP `Network` | 更底层网络事件、响应体读取、缓存控制 | 事件更细，能力接近 CDP | 需要 `debugger` 权限，可能有用户提示、连接冲突、性能风险 | PoC 后决定 |
| `chrome.debugger` + CDP `Fetch` | 暂停、继续、失败、替换请求/响应 | 可实现高级 mock、响应体替换 | 请求会被暂停，必须正确 continue/fulfill；对重定向、流式响应有边界 | 高级 mock 主路线候选 |
| `declarativeNetRequest` | 阻断、重定向、改请求头/响应头 | MV3 推荐，性能好，规则化稳定 | 不能直接读取或修改响应体 | 轻量 mock 路线 |
| `webRequest` | 观察请求生命周期 | 易理解，适合补充日志 | MV3 下阻塞能力受限，拿不到 response body | 不作为核心 |
| 页面注入脚本 | monkey patch `fetch` / `XMLHttpRequest` | 可捕获业务接口响应体，适合搜索和 mock 兜底 | 覆盖不全，无法处理图片/CSS/导航/Worker/Service Worker 等全部请求 | 辅助路线 |
| 外部代理 | 全量抓包、改包、弱网、复杂 mock | 能力最完整 | 需要额外安装/配置证书/代理 | 增强路线 |

## 原生 Network 功能覆盖评估

| 原生能力 | 插件实现可行性 | 建议实现方式 | 备注 |
| --- | --- | --- | --- |
| 请求列表 | 高 | `chrome.devtools.network.onRequestFinished` 或 CDP `Network.requestWillBeSent/responseReceived/loadingFinished` | MVP 可先用 DevTools API |
| 状态码、方法、URL、类型、大小、耗时 | 高 | HAR entry + CDP event 补充 | 大小/缓存命中需要验证精度 |
| Waterfall 时间轴 | 中高 | HAR timings 或 CDP timestamps 自绘 | 需要自绘虚拟表格与时间轴 |
| 请求详情 Headers | 高 | HAR request/response headers | Set-Cookie、伪头、extra info 可能需 CDP |
| Payload/Form Data | 中高 | HAR postData + CDP request data | 大 POST body 有大小限制，需要验证 |
| Preview/Response | 中高 | `request.getContent` 或 `Network.getResponseBody` | 大响应、二进制、流式响应要做限制 |
| Cookies | 中 | HAR cookies + `chrome.cookies` 可选 | 需要 host 权限 |
| Timing | 高 | HAR timings | 与原生 Network 展示可能有差异 |
| Initiator | 中 | HAR initiator/CDP stack trace | 需要 CDP PoC 验证完整性 |
| Search in response | 高 | 响应体索引 + worker 搜索 | 大响应应懒加载和限流 |
| Preserve log | 高 | 面板侧存储请求记录 | DevTools 关闭后是否保留取决于存储策略 |
| Disable cache | 中 | CDP `Network.setCacheDisabled` | `chrome.devtools.network` 本身不负责 |
| Throttling | 低中 | CDP `Network.emulateNetworkConditions` 或外部代理 | 插件内稳定性和权限需验证 |
| Import/Export HAR | 高 | `getHAR` + 本地导出 | 导入 HAR 可作为离线视图 |
| Blocking requests | 中高 | DNR 或 CDP Fetch | DNR 更稳定，CDP 更动态 |
| Mock response | 中 | CDP Fetch `fulfillRequest` 或 DNR redirect | 复杂响应改写要 PoC |
| WebSocket/SSE 详情 | 中低 | CDP Network WebSocket/SSE 事件 | DevTools API 覆盖有限 |

## 用户自定义需求评估

### 高级筛选

可行。建议设计统一查询 DSL，支持：

- 字段：`method`、`status`、`type`、`domain`、`path`、`query`、`requestHeader`、`responseHeader`、`requestBody`、`responseBody`、`duration`、`size`、`initiator`。
- 操作符：`=`、`!=`、`~`、`!~`、`in`、`between`、`exists`。
- 组合：`AND`、`OR`、`NOT`、括号。

### 筛选条件保存和选择

可行。建议存储为版本化 JSON：

```json
{
  "version": 1,
  "name": "失败接口 + JSON",
  "query": "status >= 400 AND type = fetch",
  "tags": ["debug", "api"],
  "createdAt": 1783000000000,
  "updatedAt": 1783000000000
}
```

优先使用 `chrome.storage.local`；如果需要多端同步，再评估 `chrome.storage.sync` 的容量限制。

### 高级搜索

可行，但要分层：

- 元数据搜索：直接搜索请求列表字段，实时性高。
- 响应体搜索：请求完成后懒加载内容，建立轻量索引。
- 大响应搜索：限制大小，按需读取，避免面板卡顿。
- 二进制搜索：默认不索引，只展示 base64/下载入口。

### 高级 mock

建议分四档：

| 档位 | 方案 | 能力 | 风险 |
| --- | --- | --- | --- |
| L1 | DNR block/redirect/headers | 阻断、重定向、头改写 | 不能改响应体 |
| L2 | DNR redirect 到扩展资源或本地服务 | 静态 mock | 动态模板能力弱 |
| L3 | CDP Fetch `fulfillRequest` | 动态 mock、响应体替换 | 权限、性能、兼容性需验证 |
| L4 | 外部代理 | 全量 mock、录制回放、弱网 | 部署和信任成本高 |

## 已确认的 CDP 关键能力

- `Network.getResponseBody`：按 `requestId` 返回响应体和 `base64Encoded` 标记。
- `Network.setCacheDisabled`：可切换忽略缓存。
- `Fetch.enable`：命中 pattern 的请求会暂停，直到调用 `failRequest`、`fulfillRequest` 或 `continueRequest/continueWithAuth`。
- `Fetch.fulfillRequest`：可提供 `responseCode`、`responseHeaders`、`body` 等响应。
- `Fetch.getResponseBody`：只能对 Response 阶段暂停的请求读取响应体，重定向响应体不可用。
- `Fetch.takeResponseBodyAsStream`：可拿流式响应，但拿到流后不能原样继续，必须取消或提供响应体。

## 官方文档补充确认

- DevTools 扩展必须在 `manifest.json` 中声明 `devtools_page`，该页面会在 DevTools 打开时创建，并在 DevTools 窗口打开期间持续存在。
- DevTools 页面可以访问 DevTools 专用 API，也可以通过扩展消息机制与 Service Worker 通信。
- 面板或侧边栏页面中的 JavaScript 可以访问与 DevTools 页面相同的 API，因此 MVP 阶段可在面板内直接调用 `chrome.devtools.network`。
- `chrome.devtools.network.getHAR()` 返回 HAR log；`onRequestFinished` 回调收到 HAR entry。
- 出于效率考虑，请求内容不包含在 HAR 中，需要额外调用 `Request.getContent()` 获取响应正文。
- 如果页面加载后才打开 DevTools，`getHAR()` 可能缺少部分请求；需要刷新页面才能获得完整请求列表。
- `chrome.debugger` 明确支持 `Network` 和 `Fetch` 受限域，适合作为 CDP 能力的扩展传输层。
- DNR 动态规则可通过 `updateDynamicRules()` / `updateSessionRules()` 更新，规则动作覆盖 `block`、`redirect`、`modifyHeaders`、`allow` 等；这进一步确认 DNR 适合轻量规则，不适合作为响应体动态改写核心。

参考：

- Chrome DevTools Protocol Network：https://chromedevtools.github.io/devtools-protocol/tot/Network/
- Chrome DevTools Protocol Fetch：https://chromedevtools.github.io/devtools-protocol/tot/Fetch/
- Chrome Extension DevTools Network API：https://developer.chrome.com/docs/extensions/reference/api/devtools/network
- Chrome Extension Debugger API：https://developer.chrome.com/docs/extensions/reference/api/debugger
- Chrome Extension Declarative Net Request API：https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest

## 必须做 PoC 的问题

- DevTools 页面能否稳定通过 background/service worker 对 inspected tab 附加 `chrome.debugger`。
- 打开原生 DevTools 时，扩展 `chrome.debugger` attach 是否与 DevTools 自身冲突。
- `request.getContent` 对大响应、二进制、压缩响应、跨域响应的表现。
- CDP `Fetch.fulfillRequest` 对 fetch、XHR、document、script、image、SSE、WebSocket 的覆盖差异。
- Service Worker 缓存、浏览器缓存、禁用缓存三者对结果的影响。
- 长时间打开 DevTools 后，请求记录量、响应体缓存和索引的内存占用。
