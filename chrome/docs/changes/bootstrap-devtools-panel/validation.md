# 验证记录

## 环境

- 日期：2026-07-02
- Chrome 版本：待验证
- Node 版本：随本机 `npm` 环境执行
- 扩展版本：0.1.0
- 前端栈：Vue 3 + Vite 8

## 计划

- 运行 `npm run typecheck`，使用 `vue-tsc --noEmit` 检查 TypeScript 与 Vue SFC。
- 运行 `npm run build`。
- 使用 `dist` 目录加载未打包扩展。
- 打开测试页并打开 DevTools。
- 确认出现「高级网络」面板。
- 点击测试页按钮触发请求。
- 确认请求列表、详情和响应体展示正常。

## 结果

- `npm install`：通过，安装 15 个包，0 个漏洞。
- `npm install -D vite@latest @vitejs/plugin-vue@latest && npm install vue@latest`：通过，当前解析版本为 `vite@8.1.3`、`@vitejs/plugin-vue@6.0.7`、`vue@3.5.39`。
- `npm install -D vue-tsc@latest`：通过。
- `npm run typecheck`：通过，使用 `vue-tsc --noEmit`。
- `npm run build`：通过，Vite 8 成功构建 Vue 面板。
- 构建产物：`dist/manifest.json`、`dist/devtools.html`、`dist/panel.html`、`dist/test-page.html` 均已生成。
- 本地测试服务器：`http://127.0.0.1:5173/` 可启动。
- `curl http://127.0.0.1:5173/test-page.html`：可返回测试页 HTML。
- `curl http://127.0.0.1:5173/fixtures/users.json`：可返回测试 JSON。
- `agent-browser`：当前环境未安装，无法使用该 CLI 做浏览器自动化。
- Computer Use MCP：观察 Chrome 窗口时用户授权弹窗超时，未继续重试。
- 2026-07-02 追加验证：用户授权后，Computer Use MCP 可操作 Chrome，测试页可打开，DevTools 可通过 `cmd+alt+i` 打开。
- 追加验证中未看到「高级网络」Tab：`--load-extension=~/chrome-plugin/dist` 被已有 Chrome 单例接管，实际 DevTools 显示的是当前主 Chrome 已加载扩展集合。
- 使用 `open -na "Google Chrome" --args --user-data-dir=/tmp/advanced-network-profile-2 ...` 仍进入同一 Chrome 进程，未隔离出加载 `dist` 的独立实例。
- 已检查 `/Applications` 和 `$HOME` 下未发现 `Chromium.app`、`Google Chrome for Testing.app` 或 `Google Chrome Canary.app`。
- 2026-07-03 追加验证：用户关闭 Chrome 后，使用独立 `--user-data-dir` 启动 Chrome，确认进程命令行包含 `--load-extension=~/chrome-plugin/dist`，测试页和 DevTools 均可打开。
- 2026-07-03 发现构建产物中的 `devtools.html` / `panel.html` 使用 `/assets/...` 绝对路径，已将 Vite `base` 改为 `./`，重构建后资源路径变为 `./assets/...`。
- 2026-07-03 相对路径修复后再次验证，DevTools 仍未出现「高级网络」Tab；检查临时 profile 的 `Default/Preferences`，`extensions.settings` 仍为 0，说明 Chrome 未登记该命令行扩展。
- 2026-07-03 检查 Chrome 管理策略，存在 `ExtensionInstallBlocklist`，但不包含通配 `*`；暂未确认是否仍有策略或运行环境限制影响 `--load-extension`。
- 2026-07-03 尝试加入 `--remote-debugging-port=9222` 通过 CDP 查询 target，但 Chrome 在当前沙箱环境报 `Failed to initialize sandbox` / GPU process fatal 后退出，无法继续 CDP 验证。
- 2026-07-03 用户手动加载扩展后确认「高级网络」Tab 可显示，但发现 `getHAR()` 和 `Request.getContent()` 在当前 Chrome 运行时使用回调式 API，直接 `await` 会得到 `undefined`。
- 2026-07-03 已新增 DevTools API 适配层，兼容 callback / Promise 两种 API 形态，并将空 HAR 兜底为 `{ entries: [] }`。
- 2026-07-03 已补充 Payload 格式化：展示 Query String Parameters、Request Payload 和 Form Data。
- 2026-07-03 新增 Vitest 单元测试：2 个测试文件，11 个用例，覆盖 HAR/content 兼容、空内容兜底、query/post payload 格式化和搜索匹配。
- 2026-07-03 `npm run test`、`npm run typecheck`、`npm run build` 均通过。
- 2026-07-03 已实现首批原生 Network 对齐能力：录制开关、Fetch/XHR/文档/CSS/JS/图片/媒体/字体/WS/其他类型筛选、状态筛选、Headers/Payload/Response/Timing 详情页签、可见响应批量读取和 HAR 导出。
- 2026-07-03 已抽离 `network-filters` 规则并新增测试，当前 Vitest 为 3 个测试文件、15 个用例，覆盖类型筛选、状态筛选、HAR/content 兼容和 Payload 格式化。
- 2026-07-03 首批 Network 对齐后 `npm run test`、`npm run typecheck`、`npm run build` 均通过。
- 2026-07-03 已接入高级筛选 DSL 首版，支持普通关键字、`method:`、`status:`、`type:`、`domain:`、`url:`、`name:`、`mime:`、`payload:`、`response:`、`header:`、`has:` 和 `-` 负向条件。
- 2026-07-03 高级筛选 DSL 首版验证通过：`npm run test` 为 3 个测试文件、17 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已追加响应体读取护栏：超过 1MB 的响应体会跳过读取，图片/媒体/字体等非文本 MIME 会跳过读取并在 Response 中展示原因。
- 2026-07-03 已增加高级筛选帮助入口，面板内可展开查看字段条件、负向条件和 `has:` 示例。
- 2026-07-03 响应体读取护栏与筛选帮助验证通过：`npm run test` 为 3 个测试文件、20 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已升级筛选方案保存结构：新方案保存 DSL 文本、类型筛选和状态筛选；旧方案会自动补齐默认 `all` 类型/状态。
- 2026-07-03 筛选方案升级验证通过：`npm run test` 为 4 个测试文件、23 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已升级高级筛选 DSL：支持 OR 分组，例如 `(method:GET status:2xx) OR (method:POST status:4xx)`；组内条件为 AND。
- 2026-07-03 已增加筛选校验提示：可提示未知字段、非法 `status`、非法 `type`、非法 `has`、未闭合括号、未闭合引号和错误 OR 位置。
- 2026-07-03 已在筛选帮助面板加入可视化条件构建器：支持字段下拉、取反、值输入、AND 追加、OR 分组追加和示例一键填入。
- 2026-07-03 高级筛选分组与可视化构建器验证通过：`npm run test` 为 4 个测试文件、27 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已完善筛选方案管理：下拉选项仅展示名称，`title` 悬浮展示完整筛选条件；支持删除、上移、下移并持久化顺序。
- 2026-07-03 筛选方案管理验证通过：`npm run test` 为 4 个测试文件、30 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已收敛工具栏：筛选方案上移/下移/删除移动到「管理筛选」展开区；导出 HAR、刷新 HAR、清空移动到「更多」展开区。
- 2026-07-03 工具栏收敛验证通过：`npm run test` 为 4 个测试文件、30 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已将「高级 Mock 能力设计与首版实现」加入后续任务。
- 2026-07-03 已实现请求项右键菜单首版：复制 URL、复制为 cURL、复制请求头、复制响应头、复制响应、复制 HAR 条目。
- 2026-07-03 已实现高级 Mock 数据首版：支持当前域名/全部 Mock 管理；可从请求右键生成替换响应头/替换响应体规则；规则包含 matcherQuery、JSON 响应体、响应头和可编辑 JS 脚本字段。
- 2026-07-03 右键复制与 Mock 数据首版验证通过：`npm run test` 为 6 个测试文件、37 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已升级高级筛选 DSL：支持嵌套括号、隐式 AND、OR 优先级，以及 `status>=400`、`duration>500`、`size<=1mb` 等比较表达式；可视化构建器支持耗时和大小字段。
- 2026-07-03 已实现 CDP Mock 拦截首版：Manifest 增加 `debugger` 权限和 background service worker；面板同步启用规则到后台；后台通过 `Fetch.requestPaused`、`Fetch.getResponseBody`、`Fetch.fulfillRequest` 改写响应头和 JSON 响应体。
- 2026-07-03 已实现 Initiator/Stack 展示：面板支持 `Initiator` 详情页签；优先展示 HAR/DevTools request 中的 initiator，后台同时通过 CDP `Network.requestWillBeSent` 采集并按 method+url 回填调用堆栈。
- 2026-07-03 剩余任务验证通过：`npm run test` 为 6 个测试文件、41 个用例；`npm run typecheck` 与 `npm run build` 均通过，`dist/assets/background.js` 已生成。
- 2026-07-03 已修复请求右键菜单越界：菜单坐标会按 DevTools 面板视口夹紧，并通过 `max-height` + 内部滚动保证低高度下仍可点击全部菜单项。
- 2026-07-03 已实现 Mock JS 运行器首版：Manifest 增加 `offscreen` 权限和 sandbox page；background 通过 offscreen document 转发到 sandbox iframe 执行用户脚本，支持读取并返回修改后的 headers/body。
- 2026-07-03 Mock 管理 UI 已支持切换 Mock 动作，右键请求菜单新增“Mock：JS 修改响应”。
- 2026-07-03 Mock JS 运行器验证通过：`npm run test` 为 7 个测试文件、44 个用例；`npm run typecheck` 与 `npm run build` 均通过，构建产物包含 `mock-offscreen.html`、`mock-sandbox.html`、`assets/mockOffscreen.js`、`assets/mockSandbox.js`。
- 2026-07-03 已实现 Network 控制项：保留日志、禁用缓存、网络限速/离线模拟；保留日志由面板本地控制，禁用缓存和限速通过 CDP `Network.setCacheDisabled` / `Network.emulateNetworkConditions` 下发到当前 inspected tab。
- 2026-07-03 已增加状态重同步：面板初始化、重新显示、窗口聚焦和 `pageshow` 时会重新下发当前「高级网络」控制状态，降低与 Chrome 原生 Network 面板互相覆盖后的回显偏差。
- 2026-07-03 Network 控制项验证通过：`npm run test` 为 8 个测试文件、46 个用例；`npm run typecheck` 与 `npm run build` 均通过，构建产物包含 `assets/network-controls.js`。
- 2026-07-07 已修复网络面板记录误清空和过滤范围不一致问题：
  - 空 HAR 快照不再覆盖已有请求列表，避免 `getHAR()` 短暂返回空 entries 时把页面请求清空。
  - 未开启保留日志时，仅在确认主文档导航时清空旧请求；缺少主文档元数据的 HTML/document 类请求不再触发自动清空，避免 iframe 或延迟 HTML 子请求误清空。
  - 请求列表筛选与“读取响应并搜索”共用同一过滤函数，统一应用临时 DSL、类型、状态和启用的保存规则。
  - 已用现有 Edge 观察当前前台窗口，未直接改动用户当前页面。
  - `pnpm exec vitest run src/panel/network-records.test.ts src/shared/filter-presets.test.ts`：通过，2 个测试文件、14 个用例。
  - `pnpm test`：通过，17 个测试文件、108 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。
- 2026-07-07 已修复未开启保留日志时刷新页面仍保留旧请求的问题：
  - 面板现在监听 `chrome.devtools.network.onNavigated` 作为页面刷新/导航的权威信号；未开启“保留日志”且已有请求时立即清空请求列表和选中项。
  - 保留上一次的主文档请求兜底判断，避免缺少导航事件时无法清空；缺少主文档元数据的 HTML/document 子请求仍不会触发清空。
  - 已补充 `shouldClearRecordsOnNavigation` 单元测试，覆盖未保留日志清空、保留日志不清空、空列表不重复清空。
  - `pnpm exec vitest run src/panel/network-records.test.ts`：通过，1 个测试文件、7 个用例。
  - `pnpm test`：通过，17 个测试文件、109 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。
- 2026-07-07 已补充注释与 e2e 测试规则：
  - `AGENTS.md` 已明确代码应尽量添加中文注释，每个函数应尽量说明用途；修复问题时应补充背景、触发条件和修复方法。
  - `AGENTS.md` 已明确新增功能或修复问题时优先评估 e2e；涉及 Chrome API、DevTools API、Mock、storage、用户状态、popup/devtools UI、跨页面同步或真实浏览器行为时，应尽量新增或更新 e2e。
  - 已为 Network 记录清空、DevTools API callback/Promise 兼容、storage 持久化修复策略、Mock 规则/脚本、用户状态 cookie/storage 身份、资源搜索和资源树构建补充中文注释。
  - 已新增 `e2e/panel-network-harness.html` 和 `e2e/panel-network.e2e.test.ts`，通过模拟 `chrome.devtools.network.onRequestFinished` 与 `onNavigated` 覆盖未开启“保留日志”刷新清空、开启“保留日志”刷新保留的面板行为。
  - `vitest.e2e.config.ts` 已补充 Vue 插件，使 e2e harness 可直接加载真实 `src/panel/panel.ts` 和 Vue SFC。
  - `pnpm test:e2e -- e2e/panel-network.e2e.test.ts`：通过，1 个 e2e 测试文件、1 个用例。
  - `pnpm test`：通过，17 个测试文件、109 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm test:e2e`：通过，3 个 e2e 测试文件、9 个用例。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。
- 2026-07-07 已为请求详情 Payload 和 Response 增加 JSON 树视图：
  - 新增 `src/shared/json-viewer.ts`，集中处理 JSON 字符串解析、详情面板 `Request Payload\n{...}` 展示格式兼容、树节点建模和基础类型格式化。
  - 新增 `JsonTreeView` 递归组件，支持对象和数组逐层展开；详情面板在 JSON 可解析时显示“查看 JSON 视图”，点击后原位切换为树结构，再次点击可回到原文。
  - Payload 和 Response 的 JSON 视图状态互相独立；切换请求时自动回到原文，避免上一条请求的视图状态污染新请求。
  - 已扩展 panel e2e harness，模拟带 JSON request payload 和 JSON response body 的请求，覆盖 Payload/Response JSON 视图按钮和嵌套数组展开。
  - `pnpm exec vitest run src/shared/json-viewer.test.ts`：通过，1 个测试文件、6 个用例。
  - `pnpm test:e2e -- e2e/panel-network.e2e.test.ts`：通过，1 个 e2e 测试文件、2 个用例。
  - `pnpm test`：通过，18 个测试文件、115 个用例。
  - `pnpm typecheck`：通过。
  - `pnpm test:e2e`：通过，3 个 e2e 测试文件、10 个用例。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。
- 2026-07-07 已修复 Network 工具栏展开面板顺序和保存筛选弹窗关闭问题：
  - `MoreActionsPanel` 已移动到 `PanelToolbar` 后方，位于 `DebuggerWarning`、`FilterManagerPanel`、Mock 面板等业务展开面板之前；模板注释明确后续新增面板不得插到“更多”前方。
  - 保存筛选弹窗确认按钮改为显式 async handler，成功持久化后由 filter manager 关闭弹窗；已补充稳定 `data-testid` 供 e2e 覆盖真实点击路径。
  - 已扩展 panel e2e：同时打开“全部筛选”和“更多”时断言“更多操作”在“全部筛选”之前；保存筛选后断言弹窗被移除且启用规则浮标变为 `1`。
  - `pnpm typecheck`：通过。
  - `pnpm test:e2e -- e2e/panel-network.e2e.test.ts`：通过，1 个 e2e 测试文件、3 个用例。
  - `pnpm test`：通过，18 个测试文件、115 个用例。
  - `pnpm test:e2e`：通过，3 个 e2e 测试文件、11 个用例。
  - `pnpm build`：通过；Vite 对测试页 public fixture 的普通脚本和 CSS 路径提示为构建提示，不影响产物复制和运行时加载。
- 2026-07-03 已增加 debugger 可用性检测：background 将 attach/sendCommand 失败分类为 `debuggerUnavailable`，面板会展示顶部错误提示和重新开启方式。
- 2026-07-03 已优化 Mock 管理面板：Mock 方式是唯一生效入口，替换 JSON 响应体时只展示 JSON 编辑器，JS 修改响应时只展示 JS 编辑器，替换响应头时不展示 JSON/JS 编辑区；规则卡片支持折叠。
- 2026-07-03 Mock 面板优化验证通过：`npm run test` 为 8 个测试文件、46 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已限制 Mock 管理面板宽度：长域名、同步消息、规则名称、规则摘要和匹配条件支持省略展示并通过悬浮 title 查看完整内容；匹配条件输入框增加最大宽度。
- 2026-07-03 已完成 Mock 管理增强：面板宽度改为随 DevTools 自适应；右键添加 Mock 先生成草稿，确认后才保存；新增 Mock 组并按页面 URL 包含文本匹配；被 Mock 请求会在列表中展示 Mock 标记；删除「Mock 当前域名」入口。
- 2026-07-03 已完成筛选帮助迁移：删除独立「筛选帮助」按钮，将语法说明、示例和可视化构建器放入「管理筛选」面板。
- 2026-07-03 已完成调用栈源文件跳转：Initiator Source 和 Call Stack 帧通过 `chrome.devtools.panels.openResource` 打开 DevTools Sources 对应文件位置。
- 2026-07-03 Mock 组和交互增强验证通过：`npm run test` 为 8 个测试文件、47 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已修复 Mock 管理布局：草稿标题行居左，Mock 匹配条件输入框最大宽度为 100%，Mock 组页面 URL 条件输入框更宽。
- 2026-07-03 已验证并增强 FormData Payload：`multipart/form-data` / `x-www-form-urlencoded` 优先结构化展示 Form Data；包含文件或二进制字段时值展示为 `<二进制>`。
- 2026-07-03 FormData 和布局调整验证通过：`npm run test` 为 8 个测试文件、48 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已增强 Mock 面板定位：右键创建 Mock 草稿、确认保存 Mock 规则后，面板会在 `nextTick` 后滚动到顶部，确保最新草稿或最新保存规则优先可见。
- 2026-07-03 已增强持久化可靠性：筛选方案使用 `advancedNetwork.filterPresets`，Mock 规则使用 `advancedNetwork.mockRules`，Mock 组使用 `advancedNetwork.mockGroups`，Network 控制状态使用 `advancedNetwork.networkControls`；面板加载后只会在读取到旧数据且需要修复结构时回写到 `chrome.storage.local`。
- 2026-07-03 Mock 滚动和持久化回写验证通过：`npm run test` 为 8 个测试文件、48 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 复现并修复持久化清空问题：`chrome.storage.local` 中列表数据可能在 DevTools/扩展存储视图里表现为 `{ "0": item }` 数字键对象，旧 normalizer 只接受数组，会在面板初始化时误归一化为空并回写，导致重开 DevTools 后清空筛选方案。
- 2026-07-03 已新增 `stored-list`、`extension-storage` 和 `persistent-state` 测试，覆盖数字键对象读取、缺失 key 不回写空数组、callback/Promise storage API 兼容和 `chrome.runtime.lastError`。
- 2026-07-03 已调整持久化策略：读取缺失 key 时不主动回写空列表；只有读取到旧数据且需要结构修复时才回写；写入后会读回校验 key 存在。
- 2026-07-03 已新增 `AGENTS.md`，明确后续不能继续把功能堆入 `App.vue`，Chrome storage 读写必须走统一适配层并配套回归测试。
- 2026-07-03 已完成 `App.vue` 首轮模块化拆分：新增 `PanelToolbar`、`FilterManagerPanel`、`MockManagerPanel`、`MoreActionsPanel`、`RequestTable`、`RequestDetail`、`RequestContextMenu`、`DebuggerWarning` 等组件，并抽离 `use-filter-manager`、`panel-options`、`panel-types`、`formatters`。
- 2026-07-03 App 拆分验证通过：`App.vue` 从 1466 行降至 828 行；`npm run test` 为 10 个测试文件、55 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-03 已修复「读取响应并搜索」：按钮不再依赖临时文本筛选后的可见列表，而是读取当前类型、状态和已启用筛选规则范围内尚未加载的响应体，避免输入 `response:` 后列表为空导致无目标读取。
- 2026-07-03 已完成筛选管理改造：移除工具栏筛选方案下拉，保存筛选移动到输入框旁并改为自定义弹窗；全部筛选面板展示所有规则，支持启用、编辑名称/DSL/类型/状态、上移、下移和删除；多条启用规则按 AND 生效并在工具栏展示合并结果。
- 2026-07-03 已扩展高级筛选 DSL 和可视化构建器：字段支持 `field~/pattern/i` 正则匹配和 `field!~/pattern/i` 正则不匹配；对比方式按字段动态限制，`keyword` 暂仅支持包含，数值字段支持等于和大小比较。
- 2026-07-03 筛选管理改造验证通过：`npm run test` 为 10 个测试文件、57 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-04 已调整高级筛选默认语义：裸文本等价于 `url:文本`，裸正则等价于 `url~/pattern/i`；全局关键字搜索改为显式 `keyword:文本`，并支持 `keyword~/pattern/i` 与 `keyword!~/pattern/i`。
- 2026-07-04 URL 默认筛选和显式 keyword 验证通过：`npm run test` 为 10 个测试文件、58 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-04 已调整筛选工具栏：输入框右侧新增连接式 `?` 语法帮助按钮和 `+` 条件构建按钮；高级筛选语法迁移到独立弹窗，条件构建器迁移到独立弹窗并将「排除」改为「否定」。
- 2026-07-04 已调整规则生效提示：「全部筛选」显示启用筛选规则数量浮标，「全部 Mock」显示启用 Mock 规则数量浮标，数量为 0 时不展示浮标且不再使用蓝色高亮。
- 2026-07-04 筛选弹窗和浮标 UI 验证通过：`npm run test` 为 10 个测试文件、58 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-04 已完成筛选 UI 微调：条件构建器「否定」放到「对比方式」标题右侧；语法弹窗补充建议优先点击 `+` 可视化添加筛选条件；输入框右侧按钮保持连接式圆角。
- 2026-07-04 已完成面板 context 重构：新增 `use-panel-context` 集中管理状态、computed、初始化流程和操作函数，`App.vue` 只负责 provide context 和组合页面，子组件改为通过 inject context 获取状态与动作。
- 2026-07-04 面板 context 重构验证通过：`npm run test` 为 10 个测试文件、58 个用例；`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-04 已修正筛选工具栏按钮圆角优先级和条件构建器空位：`?` 按钮强制无圆角，`+` 仅保留右侧圆角；「对比方式」移除旧包装占位并压缩列宽。`npm run test`、`npm run typecheck`、`npm run build` 均通过。
- 2026-07-04 已继续修复筛选工具栏和构建器布局：连接按钮改为叠边保留左边框，hover 时边框高亮完整；可视化构建器标题行统一高度，避免「否定」checkbox 撑高单列。
- 2026-07-04 已完善 Mock 展示和替换响应头能力：请求列表仅在存在启用 Mock 规则时显示 Mock 列；替换响应头模式支持在草稿和已保存规则中编辑 `responseHeaders`，后台仍保留原响应体并合并响应头。`npm run test`、`npm run typecheck`、`npm run build` 均通过。
- 2026-07-04 已修复筛选输入框连接按钮 hover 相邻边框遮挡：连接组外框统一负责整体边框，内部按钮只绘制分隔线，悬浮按钮会联动高亮相邻分隔线。
- 2026-07-04 已新增浏览器右上角 popup Mock 管理页：`manifest.json` 增加 `action.default_popup`，Vite 多入口新增 `popup.html`，popup 与 DevTools 均监听 `chrome.storage.onChanged` 以同步 Mock 规则和 Mock 组。
- 2026-07-04 已支持 Mock 组内主动新增规则：新增空白 Mock 规则构造函数，默认启用并使用“替换响应头”模式；`npm run test` 为 10 个测试文件、59 个用例，`npm run typecheck` 与 `npm run build` 均通过。
- 2026-07-04 已修复 popup Mock 管理页布局：popup 作用域内取消 Mock 面板撑满高度，内容靠上自然排列，底部同步状态仅在有消息时展示；`npm run test`、`npm run typecheck`、`npm run build` 均通过。
- 2026-07-04 已优化 Mock 管理面板：左侧改为 Mock 组导航和新增入口，右侧展示当前组启用状态、组名称、页面 URL 条件和组内规则；宽度充足时组列表展示排序/删除，宽度不足时收起为首字头像和启用状态点，并可通过顶部按钮展开完整组菜单。`npm run typecheck`、`npm run test`（10 个测试文件、59 个用例）和 `npm run build` 均通过。
- 2026-07-04 已微调 Mock 组导航：组排序和删除按钮从“上/下/删”改为 `↑`、`↓`、`×` 图标并保留 title/aria-label；窄宽度下 Mock 组头像缩小，顶部按钮改为 `←` / `→`，点击后在左侧栏内展开或折叠完整组列表，不再使用悬浮面板。`npm run typecheck`、`npm run test`（10 个测试文件、59 个用例）和 `npm run build` 均通过。
- 2026-07-04 已修复 popup 底部提示条间距：popup 根布局从固定最小高度的三行 grid 改为内容自然排列的 flex 布局，Mock 面板不再通过 `1fr` 撑开 footer 前的空白，底部提示条在高度变化后仍紧跟内容。`npm run typecheck`、`npm run test`（10 个测试文件、59 个用例）和 `npm run build` 均通过。
- 2026-07-04 已修复 Mock 组导航窄宽度删除按钮显示异常：组行禁止换行，组行内图标按钮固定为 28px 方形并居中显示，避免 `×` 被压缩或换到下一行。`npm run typecheck`、`npm run test`（10 个测试文件、59 个用例）和 `npm run build` 均通过。
- 2026-07-04 已新增 Chrome 插件图标：生成灰色未生效和蓝色生效两套圆形网络 + `+` 图标，包含 `16/32/48/128` PNG 和 SVG 源图；`manifest.json` 默认引用灰色图标，background 会监听 `advancedNetwork.filterPresets`、`advancedNetwork.mockRules`、`advancedNetwork.mockGroups` 并在存在启用筛选规则或启用 Mock 规则且所属组启用时通过 `chrome.action.setIcon()` 切换为蓝色。`npm run typecheck`、`npm run test`（10 个测试文件、59 个用例）和 `npm run build` 均通过，`dist/icons` 已包含全部图标资源。
- 2026-07-04 已改造为 Vitest Browser Mode + Playwright provider e2e harness：`pnpm test:e2e` 会构建扩展，通过 Browser Mode 的 `chromium` browser project 启动持久化浏览器 profile，加载 `dist` 扩展，并通过 `browser.commands` 打开真实 `chrome-extension://<id>/popup.html`。
- 2026-07-04 e2e 浏览器选择已改为环境配置：仓库配置不再固定本机 Edge 路径；本机可在不提交的 `.env.local` 中配置 `E2E_BROWSER_EXECUTABLE_PATH` 或 `E2E_BROWSER_CHANNEL`，未指定时使用 Playwright/Vitest Chromium，缺少浏览器二进制时运行 `pnpm test:e2e:install-browser` 安装。
- 2026-07-04 已新增 popup Mock e2e：清空 `chrome.storage.local` 后创建 Mock 组、编辑组名称和页面 URL 条件、新建 Mock 规则草稿、编辑规则名称和匹配条件、确认保存，并验证 `advancedNetwork.mockGroups` / `advancedNetwork.mockRules` 在刷新后仍可恢复。
- 2026-07-04 已扩展 popup Mock e2e 覆盖三种 Mock 方式持久化：默认替换响应头、替换 JSON 响应体、JS 修改响应。
- 2026-07-04 已扩展 popup Mock e2e 覆盖取消草稿不应写入 Mock 规则。`pnpm test:e2e` 通过，6 个 e2e 用例。
- 2026-07-04 e2e 过程中已为 popup Mock 自身写入增加串行队列和忽略自身 `chrome.storage.onChanged` 回调保护，避免本页保存后被旧 storage 变更回灌打断当前选中组或草稿流程。
- 2026-07-04 已修复 `vitest.e2e.config.ts` env 类型问题：配置文件阶段使用 Vite `loadEnv(mode, root, "E2E_")` 读取 `.env.local`，同时合并可选 `import.meta.env`；仓库仍不固定本机浏览器路径，可通过未提交的 `E2E_BROWSER_EXECUTABLE_PATH` / `E2E_BROWSER_CHANNEL` 配置。
- 2026-07-04 已扩展 e2e 覆盖 CDP Mock 真实响应改写：Browser Mode command 打开真实测试页，向 background 发送 `advanced-network:sync-mock-rules`，触发 `/fixtures/users.json` fetch，并断言页面输出被 `Fetch.fulfillRequest` 替换为 `{ "e2eMocked": true }`。
- 2026-07-04 针对性验证：`pnpm exec vitest list --config vitest.e2e.config.ts` 通过，收集 7 个 e2e 用例；`pnpm exec tsc --noEmit --pretty false --target ESNext --lib ESNext,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --types vite/client,node,chrome --skipLibCheck vitest.e2e.config.ts e2e/browser-commands.ts e2e/popup-mock.e2e.test.ts` 通过。
- 2026-07-04 最终验证：`pnpm test` 通过，12 个测试文件、68 个用例；`pnpm typecheck` 通过；`pnpm build` 通过；`pnpm test:e2e` 通过，2 个 e2e 文件、7 个用例；`git diff --check` 通过。
- 2026-07-04 已新增 e2e 专用 manifest patch：`pnpm test:e2e` 在构建后临时给 `dist/manifest.json` 注入测试页 `host_permissions`，用于自动验证需要 host 权限的 Cookie、Storage、scripting 流程；源码 `public/manifest.json` 不增加默认 host 权限。
- 2026-07-04 e2e 扩展后验证：`pnpm test:e2e` 通过，2 个 e2e 文件、8 个用例。
- 2026-07-04 已将 e2e manifest patch 改为可还原流程：`pnpm test:e2e` 执行 `node scripts/run-e2e.mjs`，脚本先构建扩展，保存原始 `dist/manifest.json`，临时注入测试页 `host_permissions`，并在 Vitest 成功或失败后通过 `finally` 写回原始 manifest。
- 2026-07-04 已破坏性升级 Mock JS 脚本接口：脚本入参改为 `{ request, response }`，其中 `request` 包含请求方法、URL 拆解、query、请求头和请求体，`response` 包含原响应 `status`、`headers`、`body`；返回对象改为 `{ status, headers, body }`，CDP `Fetch.fulfillRequest` 会使用脚本返回的 status。
- 2026-07-04 已在 Mock 规则面板 “JS 脚本” 标题旁新增问号说明弹窗，解释入参、返回对象和示例脚本；`pnpm exec vitest run src/shared/mock-script.test.ts src/shared/mock-rules.test.ts` 通过，覆盖 query/header/status 归一化。
- 2026-07-04 最终验证：`pnpm test` 通过，12 个测试文件、69 个用例；`pnpm typecheck` 通过；`pnpm build` 通过；`pnpm test:e2e` 通过，2 个 e2e 文件、8 个用例；`dist/manifest.json` 在 e2e 后已还原为仅包含 `optional_host_permissions`；`git diff --check` 通过。

## 发现问题

- `@types/chrome` 中 `chrome.devtools.network.getHAR()` 仍表现为旧回调签名，官方文档已显示 Promise 形式；当前实现使用局部类型适配。
- Vite 默认多页面输出会保留 `src/` 路径，已通过配置 `root: "src"` 和 `outDir: "../dist"` 修正，确保 `manifest.json` 能找到 `devtools.html`。
- 当前验证尚未覆盖真实 Chrome DevTools 面板加载和 `Request.getContent()` 运行时返回结构。
- 当前机器已有 Chrome 进程会拦截新的 `--load-extension` 启动参数；在不关闭主 Chrome 的情况下，无法确认 `dist` 扩展被真实加载。
- 当前机器在 Chrome 关闭后可启动独立 profile，但 `--load-extension` 未写入 profile 扩展设置，真实 DevTools 面板仍不可见；需要下一步手动在 `chrome://extensions` 加载未打包扩展或使用 Chrome for Testing/Chromium 复验。
- 当前 Chrome DevTools API 类型定义和运行时行为存在差异，面板必须使用兼容层而不能直接假设 Promise API。
- Response 正文读取仍需要按需触发；当前已具备大小和 MIME 护栏，后续需要继续细化加载失败原因和可配置阈值。
- Mock JS 脚本运行器已接入 sandbox/offscreen，但仍需要用户重新加载扩展后在真实 Chrome DevTools 面板内复验；新权限包括 `debugger` 和 `offscreen`。
- CDP Mock、JS Mock、Initiator、禁用缓存和网络限速需要用户重新加载扩展并接受 `debugger` 权限提示后，在真实 Chrome DevTools 面板内复验。
- 如果用户关闭/拒绝 `debugger` 权限提示，面板可继续展示 HAR 请求和本地筛选，但依赖 CDP 的功能会不可用；当前实现会在 footer 和顶部警告区展示 `调用堆栈观察启动失败`、`Network 控制不可用` 或 `Mock 同步失败`，并提示重新加载扩展、刷新页面、重新打开 DevTools 后在 Chrome 提示中选择「允许」。
- Chrome 扩展无法可靠读取原生 Network 面板的 Preserve log / Disable cache 勾选状态；高级网络继续保存自己的控制状态，并在面板重新显示时按自身状态重新下发。
- Mock 组的页面 URL 条件当前按“包含文本”匹配；面板同步 Mock 规则时会通过 `chrome.devtools.inspectedWindow.eval("location.href")` 把当前页面 URL 传给 background，后续主文档导航也会通过 CDP Network 事件刷新页面 URL。
- 筛选方案和 Mock 数据持久化依赖当前 Chrome profile 下的扩展 `chrome.storage.local`；关闭 DevTools、关闭页面或关闭浏览器不会清除，卸载扩展、切换扩展 ID/profile 或清除扩展数据会导致数据不可用。
- 已知修复点：如果 `chrome.storage.local.get(null)` 看到 `advancedNetwork.filterPresets`、`advancedNetwork.mockRules` 或 `advancedNetwork.mockGroups` 是 `{ "0": ... }` 形态，面板必须正常恢复为列表，不能在初始化时写回空对象或空数组。
- 当前 e2e 已覆盖 popup Mock 管理持久化和 CDP Fetch 拦截后的真实网络响应改写；后续仍可继续补充 JS Mock 真实执行、替换响应头真实响应和 debugger 拒绝场景。

## 后续动作

- 加载 `dist` 为未打包扩展。
- 打开 `http://127.0.0.1:5173/test-page.html`。
- 打开 DevTools 并确认「高级网络」Tab 可见。
- 点击 `Run all`，确认请求列表和详情展示正常。
- 点击 JSON 请求，确认 Response 可读取并可被筛选命中。
- 如果要全自动验证扩展加载，建议安装 Chrome for Testing/Chromium，或允许临时关闭当前 Chrome 后用独立 `--user-data-dir` 启动。
- 如果命令行加载继续失效，改走 `chrome://extensions` 手动加载未打包扩展，并检查扩展错误详情。

## 2026-10-13：功能检查、UI 与独立居中模拟器

详细设计和发现清单见 [mobile-simulator-review.md](mobile-simulator-review.md)。

### 自动化范围

- 单元测试：23 文件、132 条。新增：tab 操作队列的重放/关闭竞态、失败后的继续执行、嵌入策略按 tab/frame/resource type 隔离、URL 协议限制、CSP 指令保留、两个配置 context 的过期初始化读取。
- 类型检查：`pnpm typecheck`。
- 生产构建：`pnpm build` 通过，`git diff --check` 通过。构建仍有两条既有测试 fixture 路径警告，对应 js/css 均存在于 dist，真实资源测试继续通过。没有新增依赖或权限；最低 Chrome 版本调整为 125。
- 浏览器：Chrome for Testing **149.0.7827.55**，完整 **5 文件 / 15 条**通过；Edge **155.0.4283.45** 的完整 **5 文件 / 15 条**也通过。真实加载构建扩展与 MV3 worker；使用独立 profile、无头模式，没有操作用户已打开的浏览器。
- 原 DevTools 面板由 API harness 驱动；popup、后台消息、storage、CDP、真实网页和 iframe 是实际浏览器路径。不能把 harness 等同于手动停靠 DevTools 的验收。

### 新模拟器的实际断言

1. HTTP 测试服务器返回 `X-Frame-Options: DENY` 和 `frame-ancestors 'none'`，页面仍能在指定业务 iframe 中加载。
2. 其他 CSP 保留：测试页的无 nonce 内联脚本被浏览器拒绝，同源外部脚本可以执行。
3. 业务页面首次脚本读取的 DPR 标识为 3；真实 iframe CSS 视口是 393 × 852；UA 含 iPhone、maxTouchPoints 为 5。
4. 原生输入框可输入中英文；实际鼠标点击生成单指 touch，明确断言 `isTrusted === false`；拖动能滚动超过 100px。
5. 页面内链接可导航。切换横屏并关闭 touch 后，宽高为 852 × 393、maxTouchPoints 为 0、鼠标点击不再生成 touch 事件。
6. 原标签页的宽度、DPR、UA、touch 点数不变。
7. 画布水平居中；暗色 640px 窗口仍在可用区域内；560px 面板无横向整体溢出；760 × 600 popup 高度不超出原生上限。
8. 新 UI 路径不能出现 pageerror。原面板测试桩缺少 runtime.connect 的异常已修复。
9. 原页面模式增加并发 refresh/disable 路径，等待旧计时器后状态仍为关闭。

截图位于自动化输出 `e2e/__screenshots__/`：`simulator-desktop.png`、`simulator-dark-narrow.png`、`panel-network.png`、`panel-device-narrow.png`、`popup-device.png`。已逐张检查；截图需等待原生浏览器窗口 resize 稳定，立即截取会捕获过渡合成帧。截图目录按现有规则忽略，不提交临时产物。

### 证据边界

- 居中画布的 DPR / screen / orientation 是 JS 属性模拟；浏览器 CSS resolution、pointer/hover 媒体查询、引擎和真实硬件保持原值。测试也明确断言 coarse=false，不能称作原生 mobile 模式等价实现。
- 未完成所有真实业务站点、支付/登录流程、所有最低支持版本、长期运行、多点触控或真机对照验收。
- 本轮没有宣称此前原页面缩放/DevTools dock 问题全部消失；新画布避免依赖该缩放路线，原模式边界仍保留。
- 初次全量回归曾出现“storage 已创建配置，UI 删除按钮消失”的时序失败；新增延迟读取测试并修复 stale read，不能用一次重跑通过掩盖竞态。
