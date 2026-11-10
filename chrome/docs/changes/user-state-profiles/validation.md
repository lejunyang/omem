# 用户状态管理验证记录

## 2026-07-04 设计验证

- 已完成 Chrome 官方文档调研：
  - `chrome.cookies` 可用于 Cookie 读写与监听。
  - `chrome.permissions` 可用于运行时动态请求 host 权限。
  - `chrome.scripting` 可用于向匹配页面注入 content bridge 和 MAIN world hook。
  - `chrome.storage.onChanged` 只能监听插件自身存储，不能监听网页 WebStorage。
  - `window.storage` 事件不会在发起修改的当前窗口触发，不能单独作为 WebStorage 实时同步方案。
  - MV3 普通扩展不适合依赖 `webRequestBlocking` 作为 Cookie/WebStorage 管理主路径。
- 已确认首版范围：
  - Cookie + localStorage + sessionStorage。
  - Cookie 新建配置默认开启。
  - Storage 新建配置默认关闭。
  - Storage 勾选后采用注入脚本拦截 WebStorage 操作，不采用快照式作为主路径。
  - 域名匹配支持通配符规则。
  - 同一时间只允许一套用户配置开启。
  - 切换配置时应用到所有匹配标签页。
  - Cookie 模型需要保留 `partitionKey`，按 `storeId + partitionKey + name + domain + path` 唯一定位分区和未分区 Cookie。
  - WebStorage 模型使用 `storageScopeKey`，首版默认处理顶层 frame；第三方 iframe storage partition 只能在 frame 实际存在且可注入时处理。
- 已将防循环要求纳入设计：
  - 插件主动覆盖 Cookie/WebStorage 时必须携带 `operationId`。
  - Cookie 监听和 WebStorage 消息处理必须识别并忽略插件自身写入。
  - 写入 profile 的同步事件必须区分 `browser` 与 `extension` 来源。

## 待实现后验证

- 2026-07-04 首版实现已完成：
  - popup 新增 `Mock` / `用户状态` tab。
  - 用户状态支持创建、编辑、删除、开启、停用和捕获配置。
  - 新建配置默认接管 Cookie，不默认接管 Storage。
  - manifest 新增 `cookies`、`scripting`、`tabs` 权限和 `http/https` 可选 host 权限。
  - background 新增用户状态服务，支持应用配置到所有匹配标签页。
  - Cookie 同步保留 `partitionKey`，并按 `storeId + partitionKey + name + domain + path` 唯一定位。
  - Storage 勾选后注入 isolated bridge 与 MAIN world hook，拦截 `localStorage/sessionStorage` 的 `setItem/removeItem/clear`。
  - 覆盖 Cookie/WebStorage 时使用 `operationId` 与 runtime guard，避免插件自身写入触发回写循环。
  - WebStorage 使用 `storageScopeKey` 保存 scope，避免 storage partitioning 下合并不同 top-level site。
- `npm run typecheck`：通过。
- `npm run test`：通过，11 个测试文件、65 个用例。
- `npm run build`：通过。
- 浏览器加载 `dist/` 后验证动态权限申请。
- 使用本地测试页验证 Cookie 切换、Storage 注入、Storage 操作拦截和防循环。
- 验证 partitioned cookie 的保存、回放和删除不会与未分区 Cookie 混淆。
- 验证不同 top-level site 下的 WebStorage 分区不会被合并到同一个 scope。

## 2026-07-04 真实浏览器验证

- 已通过 Microsoft Edge 真实扩展页面验证：
  - 工具栏中可打开「高级网络」扩展 popup。
  - popup 可作为独立扩展页面打开：`chrome-extension://boeoplehlfmfhicianpjnbkplgdlenmg/popup.html`。
  - popup 展示 `Mock` / `用户状态` tab，且可切换到「用户状态」。
  - 「新建配置」可创建用户配置。
  - 新建配置默认勾选「接管 Cookie」。
  - 新建配置默认不勾选「接管 Storage」，并可手动勾选。
- 真实交互中发现并修复：
  - 「配置名称」和「域名通配符规则」原先使用 `change` 保存，若未触发 blur 就发生其他响应式重渲染，输入可能被旧 storage 值覆盖。
  - 已改为 `input` 实时保存，降低重渲染导致输入丢失的风险。
- 当前验证限制：
  - Computer Use 后台键盘事件对 Edge 内嵌 Web textarea 的 `cmd+a` 全选不稳定，AX `set_value` 也未可靠触发页面 DOM 输入。
  - 因上述工具限制，本轮尚未完成 `http://127.0.0.1:5173/test-page.html` 下的 Cookie/Storage 全链路覆盖验证。
  - 后续应优先补充可重复运行的浏览器 e2e harness，减少对人工 UI/系统辅助功能输入的依赖。
- 修复后验证命令：
  - `npm run test`：通过，11 个测试文件、65 个用例。
  - `npm run typecheck`：通过。
  - `npm run build`：通过。
  - `git diff --check`：通过。

## 2026-07-04 e2e 验证

- 已改造为 Vitest Browser Mode + Playwright provider e2e harness：
  - `pnpm test:e2e` 会先执行 `vite build`，再通过 Vitest Browser Mode 的 `chromium` browser project 运行 e2e。
  - Browser Mode provider 使用持久化浏览器 profile，并通过 `--load-extension` 加载 `dist` 扩展。
  - 扩展 popup 操作通过 Vitest Browser Mode `browser.commands` 在 Playwright provider context 中执行，会从 background service worker URL 解析真实 extension id，并打开 `chrome-extension://<id>/popup.html`。
  - 浏览器不在配置文件中固定本机路径；本机可在不提交的 `.env.local` 中通过 `E2E_BROWSER_EXECUTABLE_PATH` 或 `E2E_BROWSER_CHANNEL` 指定浏览器。
  - 未指定本机浏览器时使用 Playwright/Vitest 的 Chromium；缺少浏览器二进制时运行 `pnpm test:e2e:install-browser` 安装。
- 已新增用户状态 popup e2e：
  - 清空 `chrome.storage.local` 后打开 popup。
  - 切换到「用户状态」tab。
  - 新建配置并验证 Cookie 默认勾选、Storage 默认不勾选。
  - 编辑配置名称、域名规则并勾选 Storage。
  - 断言 `advancedNetwork.userStateProfiles` 写入成功，刷新 popup 后配置仍可恢复。
  - 删除用户状态配置后，断言 storage 中不残留 profile，并回到空状态 UI。
- e2e 发现并修复：
  - `matchPatterns` 在真实 `chrome.storage.local` 中也可能表现为 `{ "0": "pattern" }` 数字键对象；已让 `normalizeMatchPatterns()` 复用 `normalizeStoredList()`。
  - popup 自身写入 `chrome.storage.local` 时会触发 `chrome.storage.onChanged`，可能把较旧的写入回灌到本地状态；已为用户状态 popup 写入增加串行队列和自身写入忽略保护。
- 验证命令：
  - `pnpm test:e2e`：通过，6 个 e2e 用例。
  - `pnpm test`：通过，11 个测试文件、65 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过。

## 2026-07-04 防循环单测与测试页全链路 e2e

- 已新增 background 用户状态服务单元测试：
  - 覆盖应用 profile 后由插件自身 `chrome.cookies.set()` 触发的 Cookie change 会被 guard 忽略，不会再次回写 profile。
  - 覆盖 WebStorage `source: "extension"` 消息会被忽略，不会把插件自身覆盖操作写回 profile。
  - 覆盖 WebStorage `source: "browser"` 消息仍会写入 active profile 的 `storageByScope`，避免防循环逻辑误杀真实页面操作。
- 针对性验证：
  - `pnpm exec vitest run src/background/user-state-service.test.ts`：通过，3 个用例。
  - `pnpm exec tsc --noEmit --pretty false --target ESNext --lib ESNext,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --types vite/client,node,chrome --skipLibCheck vitest.e2e.config.ts e2e/browser-commands.ts e2e/popup-user-state.e2e.test.ts e2e/popup-mock.e2e.test.ts`：通过。
- 最终验证：
  - `pnpm test`：通过，12 个测试文件、68 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过。
  - `pnpm test:e2e`：通过，2 个 e2e 文件、7 个用例。
  - `git diff --check`：通过。

## 2026-07-04 e2e host 权限与测试页状态同步

- 已新增 e2e 专用构建后处理脚本：
  - `pnpm test:e2e` 执行 `node scripts/run-e2e.mjs`，脚本构建扩展后保存原始 `dist/manifest.json`。
  - 脚本只临时 patch `dist/manifest.json`，为 e2e 加入 `host_permissions`：`http://127.0.0.1/*`、`http://localhost/*`。
  - 无论 Vitest e2e 成功或失败，脚本都会在 `finally` 中还原原始 `dist/manifest.json`。
  - 源码 `public/manifest.json` 不增加默认 host 权限，正式扩展仍通过 `optional_host_permissions` 和运行时权限申请控制授权范围。
- 已恢复并通过测试页 Cookie/Storage 全链路 e2e：
  - Cookie-only profile：开启只接管 Cookie 的用户配置，测试页写入 `document.cookie` 后，background `cookies.onChanged` 将 Cookie 同步进 profile。
  - Storage profile：开启显式接管 Storage 的用户配置，background 注入 isolated bridge 与 MAIN world hook，测试页 `localStorage.setItem()` 会同步到 profile 的 `storageByScope`。
  - 切换配置覆盖多标签页：构造带 `localStorage` 数据的 profile 并应用，断言两个匹配测试页 tab 的 `localStorage` 都被覆盖为 profile 值。
- e2e 发现并修复：
  - `applyWebStorageState` 作为 `chrome.scripting.executeScript({ func })` 注入 MAIN world 时不能引用外层 helper；打包后外层 helper 在页面环境中不可见，会触发 `ReferenceError` 并导致 Storage 覆盖不生效。
  - 已将注入函数改为自包含实现，避免依赖 Rollup/Vite 打包后的闭包符号。
- 验证命令：
  - `pnpm test:e2e`：通过，2 个 e2e 文件、8 个用例。
  - `pnpm test`：通过，12 个测试文件、68 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过。

## 2026-07-04 多域名用户配置

- 已将用户状态新建入口从单个域名输入增强为 tag 输入：
  - 支持在新建配置时添加多个域名规则，例如 `sso.example.com` 与 `app.example.com` 共用同一套用户配置。
  - 创建 profile 时会把所有 tag 和当前输入框值一起归一化到 `matchPatterns`。
  - 详情页保留多行 textarea，可继续直接编辑完整规则列表。
- 已扩展 popup 用户状态 e2e：
  - 创建配置时先添加 `http://127.0.0.1:*/*` tag，再输入 `https://sso.example.com/*` 并创建同一 profile。
  - 验证持久化 profile 的 `matchPatterns` 同时包含两个域名规则。
- 最终验证：
  - `pnpm test`：通过，12 个测试文件、69 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过。
  - `pnpm test:e2e`：通过，2 个 e2e 文件、8 个用例。
  - e2e 后 `dist/manifest.json` 已还原为仅包含 `optional_host_permissions`。

## 2026-07-05 DevTools 用户状态面板

- 已将用户状态管理组件和 context 从 popup 目录抽到 `src/shared/`，由 popup 与 DevTools 面板复用同一套业务逻辑和 UI。
- DevTools 面板新增左侧垂直功能导航：
  - `网络` 保持原有高级网络请求、筛选、Mock 和 Network 控制能力。
  - `用户状态` 展示用户状态管理面板，支持复用现有配置创建、编辑、开启、停用、捕获和删除能力。
- DevTools 用户状态页补齐独立样式，右侧内容区域内部滚动，不影响左侧功能导航固定展示。
- 最终验证：
  - `pnpm test`：通过，12 个测试文件、69 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过。
  - `pnpm test:e2e`：通过，2 个 e2e 文件、8 个用例。
