# 用户状态管理调研

## 目标

- 在插件 popup 中新增“用户状态”功能，用于建立多套用户配置。
- 每套配置按域名通配符规则生效，并独立保存 Cookie 与可选 WebStorage 状态。
- 切换配置时，将配置内状态覆盖到所有已打开且匹配的页面。
- 配置开启后，指定域名发生的 Cookie 或 WebStorage 变更同步回插件存储。

## Chrome API 能力

### Cookie

- `chrome.cookies` 可以读取、写入、删除 Cookie，并通过 `chrome.cookies.onChanged` 监听 Cookie 变更。
- 使用 Cookie API 需要声明 `"cookies"` 权限，并拥有目标域名的 host 权限。
- Cookie API 支持 `partitionKey`，遇到 CHIPS 或第三方分区 Cookie 时，必须随 Cookie 一起保存、写入和删除。
- 官方文档：https://developer.chrome.com/docs/extensions/reference/api/cookies

结论：Cookie 应直接使用 `chrome.cookies` 管理，不需要拦截网络请求。

### Partitioned Cookie

- 分区 Cookie 不能只按 `name + domain + path` 唯一定位。
- 保存 Cookie 时需要保留 `storeId`、`partitionKey`、`name`、`domain`、`path`。
- 回放 Cookie 时需要把 `partitionKey` 传给 `chrome.cookies.set()`。
- 删除 Cookie 时也需要带上 `partitionKey`，否则可能只删除未分区 Cookie 或删除失败。

结论：Cookie 模型必须将 `partitionKey` 纳入唯一键。若浏览器/API 不返回 `partitionKey`，按未分区 Cookie 兼容处理。

### 动态域名权限

- `chrome.permissions.request()` 可以在用户手势中请求可选权限。
- 对运行时发现的域名，manifest 需要预先声明 `optional_host_permissions`，例如 `http://*/*` 与 `https://*/*`。
- 请求 origin 时路径会被忽略，因此 UI 的通配符规则需要单独用于匹配判断，权限请求只映射到可授权 origin。
- 官方文档：https://developer.chrome.com/docs/extensions/reference/api/permissions

结论：配置创建或开启时按域名规则推导 origin，并动态请求权限。

### WebStorage

- `localStorage` 和 `sessionStorage` 属于网页上下文数据，不属于插件的 `chrome.storage`。
- `chrome.storage.onChanged` 只能监听插件自身存储，不能监听网页 `window.localStorage` 或 `window.sessionStorage`。
- Content script 调用 Web Storage API 时，访问的是宿主页面的数据。
- Extension service worker 无法直接访问网页的 `localStorage/sessionStorage`。
- Storage partitioning 下，同一 frame origin 在不同 top-level site 中可能对应不同 storage 分区。
- 扩展没有类似 `chrome.cookies.getAll()` 的 API 全局枚举所有 WebStorage 分区，只能在实际打开且可注入的页面/frame 上下文中读写当前分区。
- 官方文档：
  - https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies
  - https://developer.mozilla.org/en-US/docs/Web/API/Storage

结论：WebStorage 需要注入页面或 content script 参与读写；不能只依赖 background。

### Storage Partitioning

- 顶层页面的一方 WebStorage 可以按 origin 管理。
- 第三方 iframe 的 WebStorage 需要按 `origin + topLevelSite + frameUrl` 等 scope 信息管理。
- 首版默认注入顶层 frame；若后续开启 `allFrames` 支持，只能恢复当前实际存在且可注入的 frame 分区，不能离线恢复未打开的 storage partition。

结论：WebStorage 模型不应只使用 `origin` 作为 key，应使用 `storageScopeKey` 记录当前分区范围。

### `storage` 事件

- `window` 的 `storage` 事件只在其它同源 browsing context 更新同一 storage area 时触发。
- 发起修改的当前窗口不会收到自己的 `storage` 事件。
- `sessionStorage` 的 `storage` 事件只在同一顶层 browsing context 下的同源 iframe 间传播，不跨 tab。
- 官方文档：https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event

结论：只监听 `storage` 事件不可靠，无法捕获当前页面自身的 `setItem/removeItem/clear` 操作。

### 脚本注入

- `chrome.scripting.executeScript()` 可以向匹配页面注入脚本。
- 需要 `"scripting"` 权限和目标页面 host 权限。
- 若要捕获页面自身对 `localStorage/sessionStorage` 的调用，需要在 `MAIN` world 中注入，patch `Storage.prototype`。
- 页面脚本不能直接访问扩展 API，需要通过 `window.postMessage` 或 DOM 自定义事件转发给 content script，再由 content script 发送消息给 background。
- 官方文档：https://developer.chrome.com/docs/extensions/reference/api/scripting

结论：WebStorage 实时同步只能在用户显式启用 Storage 接管后，通过页面注入脚本实现。

### 网络请求拦截

- MV3 普通扩展不适合作为主方案依赖 `webRequestBlocking` 修改请求/响应。
- 网络请求拦截不能覆盖 `localStorage/sessionStorage`。
- Cookie 即使可在 header 层观察，也不如 `chrome.cookies` 明确、可控。
- 官方文档：https://developer.chrome.com/docs/extensions/reference/api/webRequest

结论：不采用“拦截请求并修改”作为主方案。

## 功能边界

- 首版覆盖 Cookie、localStorage、sessionStorage。
- Cookie 默认开启接管。
- Storage 默认不接管，只有用户显式勾选后才注入脚本并拦截 WebStorage 操作。
- 同一时间只允许一套用户配置开启。
- 切换配置时应用到所有已打开且匹配域名通配符规则的标签页。
- 每套配置可选择“清空后覆盖”或“只覆盖配置键”。

## 风险

- Patch `Storage.prototype` 可能与网站自身 monkey patch 或检测原生函数的逻辑冲突。
- 特殊页面、Chrome 内置页面、扩展页面、无 host 权限页面无法注入脚本。
- `sessionStorage` 按 tab/window 生命周期存在，切换和同步必须按 tab 维度记录。
- Cookie 分区、SameSite、Secure、HttpOnly 等属性需要完整保留，否则覆盖后可能改变登录行为。
- 第三方 iframe 的 storage partition 只能在 frame 实际存在且可注入时处理。
- 插件自身覆盖浏览器数据时会触发监听器，必须通过事务标记和来源标记避免死循环和数据错乱。
