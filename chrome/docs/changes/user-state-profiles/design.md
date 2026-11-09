# 用户状态管理设计

## 概览

用户状态管理在 popup 中作为独立 tab 提供，不与现有 Mock 管理状态耦合。它管理多套用户配置，每套配置声明域名通配符规则、接管的数据类型和覆盖策略。用户开启配置后，插件会将该配置内的数据应用到所有匹配标签页，并将后续 Cookie 与可选 WebStorage 变更同步回当前开启配置。

## Popup 结构

- popup 顶部新增 tab：
  - `Mock`
  - `用户状态`
- `Mock` tab 保持现有 Mock 管理功能。
- `用户状态` tab 使用独立组件和 composable：
  - `src/popup/components/UserStatePanel.vue`
  - `src/popup/use-user-state-context.ts`
- 共享模型与工具放在 `src/shared/user-state-profiles.ts`。
- 后台权限、Cookie、标签页、脚本注入逻辑放在独立服务模块，避免继续膨胀 `background.ts`。

## 数据模型

```ts
export interface UserStateProfile {
  id: string;
  name: string;
  enabled: boolean;
  matchPatterns: string[];
  controls: {
    cookie: boolean;
    webStorage: boolean;
  };
  applyMode: "clear-then-apply" | "patch-only";
  cookieJar: StoredCookie[];
  storageByScope: Record<string, StoredWebStorage>;
  createdAt: number;
  updatedAt: number;
}

export interface StoredCookie {
  storeId?: string;
  partitionKey?: unknown;
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
}

export interface StoredWebStorage {
  scope: {
    origin: string;
    topLevelSite: string;
    frameUrl: string;
  };
  localStorage: Record<string, string>;
  sessionStorageByTab: Record<string, Record<string, string>>;
}
```

说明：

- `cookie` 新建配置时默认 `true`。
- `webStorage` 新建配置时默认 `false`。
- 同一时间只允许一个 `enabled: true` 的配置。
- `matchPatterns` 支持多个通配符规则，规则会用于标签页匹配和权限 origin 推导；同一配置可同时覆盖 SSO 域名和目标站点域名，便于保存完整登录态。
- Cookie 唯一键必须包含 `storeId + partitionKey + name + domain + path`，避免分区 Cookie 与未分区 Cookie 混淆。
- WebStorage 使用 `storageByScope`，scope 至少包含 `origin`、`topLevelSite` 和 `frameUrl`，避免 storage partitioning 下把不同分区合并。
- `sessionStorageByTab` 使用插件内部 tab 维度 key，避免把不同标签页的 sessionStorage 混在一起。

## 存储 Key

- `advancedNetwork.userStateProfiles`
- `advancedNetwork.activeUserStateProfileId`
- `advancedNetwork.userStateRuntime`

`userStateRuntime` 用于保存短期同步状态、事务标记和注入状态，不用于长期保存敏感快照。长期数据保存在 profile 内。

## 权限策略

manifest 新增：

- `permissions`: `cookies`、`scripting`、`tabs`
- `optional_host_permissions`: `http://*/*`、`https://*/*`

权限申请流程：

1. 用户创建或开启配置。
2. 根据 `matchPatterns` 推导所需 origin。
3. 若 `controls.cookie` 或 `controls.webStorage` 为 true，则检查 host 权限。
4. 缺权限时在用户手势内调用 `chrome.permissions.request()`。
5. 用户拒绝时，配置保持未开启，并在 UI 展示授权失败原因。

## 域名通配符

首版支持：

- `example.com`
- `*.example.com`
- `https://example.com/*`
- `https://*.example.com/*`
- `http://localhost:*/*`

规则处理：

- 保存前做 normalize 和校验。
- 用规则匹配 tab URL。
- 用规则推导权限 origin。
- popup 新建入口使用 tag 输入，支持一次创建包含多个域名规则的 profile。
- 因为同一时间只允许一套配置开启，重叠规则首版只提示，不需要优先级。

## Cookie 同步

开启配置时：

1. 找到所有匹配标签页。
2. 若 `applyMode` 为 `clear-then-apply`，删除匹配域名范围内配置管理的 Cookie。
3. 将 `cookieJar` 写入浏览器 Cookie store，分区 Cookie 必须带回原始 `partitionKey`。
4. 标记本次写入事务，避免监听器把插件自身写入再次同步回配置。

监听变更：

- background 注册 `chrome.cookies.onChanged`。
- 只在存在 active profile 且 `controls.cookie = true` 时处理。
- 判断 Cookie domain 是否匹配 active profile。
- 以 `storeId + partitionKey + name + domain + path` 定位 Cookie。
- 若变更来源属于当前插件写入事务，则忽略。
- 否则同步到 active profile 的 `cookieJar`。

## Partitioned Cookie

- 读取 Cookie 时完整保留 `partitionKey`。
- 写入 Cookie 时，如果原 Cookie 带 `partitionKey`，必须传回 `chrome.cookies.set()`。
- 删除 Cookie 时，如果目标 Cookie 带 `partitionKey`，必须传给 `chrome.cookies.remove()`。
- 如果浏览器版本或 API 不支持 `partitionKey`，对应字段为空，按未分区 Cookie 处理。
- UI 中不要求首版直接编辑 `partitionKey`，但数据预览可以显示“分区 Cookie”标记。

## WebStorage 同步

开启配置时：

1. 找到所有匹配标签页。
2. 若 `controls.webStorage = false`，不注入脚本、不读取、不覆盖 WebStorage。
3. 若 `controls.webStorage = true`，向所有匹配标签页的顶层 frame 注入 content bridge 和 MAIN world hook。
4. 根据 `applyMode` 对页面 `localStorage/sessionStorage` 执行清空后覆盖或只覆盖配置键。
5. 注入脚本 patch `Storage.prototype.setItem/removeItem/clear`，捕获页面自身操作。
6. 同时监听 `storage` 事件，补充捕获其它同源页面触发的变更。

消息链路：

1. MAIN world hook 捕获操作。
2. 页面内通过 `window.postMessage` 或 DOM 自定义事件发给 isolated content bridge。
3. content bridge 校验消息来源和扩展注入标记后调用 `chrome.runtime.sendMessage()`。
4. background 判断 active profile、match pattern、事务标记后写入 `chrome.storage.local`。

## Storage Partitioning

- WebStorage 不存在可供扩展全局枚举所有分区的 API。
- 顶层页面首版按 `origin + topLevelSite + frameUrl` 生成 `storageScopeKey`。
- 首版默认只注入顶层 frame，覆盖一方站点状态。
- 第三方 iframe storage partition 作为受限增强：只有 frame 实际存在、匹配规则且可注入时才能读写。
- 若后续支持 iframe，需要使用 `allFrames: true`，并将 iframe 数据按 `origin + topLevelSite + frameUrl` 分开保存。
- 恢复时只能恢复当前已打开且可注入的分区，不能恢复未打开 frame 的 WebStorage 分区。

## 防循环与一致性

这是核心约束，所有实现必须遵守：

- 每次“切换配置、覆盖 Cookie、覆盖 WebStorage”都创建 `operationId`。
- 插件主动写入浏览器数据前，将 `operationId`、profileId、目标 tab/origin、数据类型写入 runtime guard。
- Cookie 监听器收到 `chrome.cookies.onChanged` 时，若命中 runtime guard，忽略并消耗或延迟清理 guard。
- WebStorage hook 在执行插件下发的覆盖命令时设置页面内 `applyingOperationId`，patch 到的写入如果属于当前覆盖命令，不回传为用户变更。
- background 收到 WebStorage 消息时再次校验 `operationId` 和来源；插件自身覆盖写入不写回 profile。
- 对同一 profile 的 storage 写入串行化，避免并发消息乱序覆盖。
- 每个同步事件保存 `source: "browser" | "extension"`；只有 `browser` 来源可更新 profile 快照。

## 错误处理

- 权限拒绝：配置不开启，UI 显示“缺少域名权限”。
- Cookie 写入失败：保留错误详情，允许重试。
- 脚本注入失败：该 tab 标记为“注入失败”，不影响其它匹配 tab。
- 特殊页面不可操作：显示“当前页面不支持用户状态管理”。
- 通配符无效：阻止保存配置并展示校验错误。
- Storage patch 冲突：记录错误并允许用户关闭 Storage 接管。

## UI 设计

用户状态 tab 包含：

- 顶部状态：当前开启配置、匹配 tab 数、最近同步时间。
- 配置列表：名称、域名规则、能力标签、开启状态、错误状态。
- 配置详情：
  - 名称
  - 域名通配符规则
  - 接管 Cookie checkbox，默认开启
  - 接管 Storage checkbox，默认关闭
  - 覆盖策略：清空后覆盖 / 只覆盖配置键
  - 开启 / 停用 / 应用到匹配页面 / 捕获当前匹配页面状态
- 数据预览：
  - Cookie 数量
  - localStorage key 数量
  - sessionStorage tab 数量

## 验证策略

- 单元测试：
  - 配置 normalizer。
  - 通配符匹配与权限 origin 推导。
  - active profile 单例约束。
  - Cookie 变更同步和 runtime guard 防循环。
  - WebStorage 消息归一化和 operationId 过滤。
- 集成构建：
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `pnpm test:e2e`
- 浏览器验证：
  - 新建 Cookie-only 配置并切换。
  - 新建 Cookie + Storage 配置并确认 Storage 默认不勾选、勾选后才注入。
- 验证分区 Cookie 的 `partitionKey` 可保存、写入和删除。
- 验证顶层页面 storage 使用 `storageScopeKey` 保存，不与其它 top-level site 分区混淆。
  - 在测试页执行 `localStorage.setItem/removeItem/clear`，确认同步到插件。
  - 插件切换配置覆盖 storage 时，不产生重复同步或死循环。
  - 多个匹配标签页同时打开时，覆盖和同步都只作用于 active profile。
