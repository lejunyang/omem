# 用户状态管理任务

## 文档

- [x] 调研 Cookie、WebStorage、权限、脚本注入和请求拦截能力边界。
- [x] 设计用户配置数据模型、权限流程、同步流程和防循环策略。
- [x] 实现完成后持续更新验证记录。

## 实现拆分

- [x] 新增 shared 用户状态模型、normalizer、通配符匹配和权限 origin 推导工具。
- [x] 新增 popup tab 框架，将现有 Mock 管理放入 `Mock` tab。
- [x] 新增用户状态管理 popup 面板。
- [x] 新增用户状态持久化服务，使用 `chrome.storage.local`。
- [x] 新增 background 用户状态消息协议和服务模块。
- [x] 实现动态 host 权限申请。
- [x] 实现 Cookie 读取、覆盖、监听和同步。
- [x] Cookie 模型支持 `partitionKey`，按 `storeId + partitionKey + name + domain + path` 唯一定位。
- [x] 实现 WebStorage content bridge 与 MAIN world hook 注入。
- [x] 实现 WebStorage 覆盖、操作拦截、消息同步和注入状态展示。
- [x] WebStorage 模型支持 `storageScopeKey`，避免 storage partitioning 下合并不同分区。
- [x] 实现切换配置时应用到所有匹配标签页。
- [x] 实现 operationId/runtime guard，避免插件监听自身写入导致死循环或数据错乱。

## 测试

- [x] 覆盖用户状态模型和旧值归一化。
- [x] 覆盖通配符匹配和权限 origin 推导。
- [x] 覆盖 active profile 单例约束。
- [x] 覆盖 `matchPatterns` 数字键对象归一化，兼容 Chrome storage 展示/返回形态。
- [x] 覆盖 Cookie 同步防循环。
- [x] 覆盖 partitioned cookie 的保存、写入与删除 key 生成。
- [x] 覆盖 WebStorage 消息防循环。
- [x] 覆盖 WebStorage storageScopeKey 生成。
- [x] 浏览器验证 popup 用户状态 tab、新建配置、Cookie 默认勾选和 Storage 默认不勾选。
- [x] 补充可重复运行的浏览器 e2e harness，覆盖扩展加载和 popup 用户状态配置持久化。
- [x] 扩展 e2e 覆盖用户状态配置删除后不残留 storage 数据。
- [x] 浏览器验证 Cookie-only 配置。
- [x] 浏览器验证 Storage 显式开启后的注入与同步。
- [x] 浏览器验证切换配置时所有匹配标签页被覆盖。
- [x] 扩展 e2e 覆盖测试页 Cookie/Storage 状态同步。
- [x] 新建用户配置入口支持多个域名规则，便于同一配置保存 SSO 与目标站点登录态。
- [x] DevTools 面板新增左侧垂直功能导航，并接入用户状态管理面板。
