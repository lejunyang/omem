# omem 助手（Chrome 扩展）

omem 仓库里的浏览器扩展（workspace 包 `omem-chrome`）。DevTools 里的「网络」面板（请求列表、高级筛选、筛选方案、Mock、资源搜索）、popup 里的 Mock / 用户状态 / 设备模拟，截图和 UI 走查用的「拾取」，以及把一件事做给 omem 的助手看的「录制」。

## 安装

```bash
pnpm install --filter omem-chrome
pnpm --filter omem-chrome run build
```

在 `chrome://extensions` 打开开发者模式，「加载已解压的扩展程序」选 `chrome/dist`。改了代码重新 build 后点扩展卡片上的刷新。

## 默认不连调试接口（CDP）

扩展一调用 `chrome.debugger`，Chrome 就会在所有窗口顶部显示「已开始调试此浏览器」。这条提示扩展自己去不掉，唯一的办法是启动 Chrome 时加 `--silent-debugger-extension-api`。所以默认**不连接调试接口**，需要时在 popup 或面板工具栏打开「CDP 增强」。关掉时立刻断开。

| 功能 | 不开 CDP（默认） | 开 CDP |
| --- | --- | --- |
| 请求列表、详情、HAR、响应体 | 可用 | 可用 |
| 调用栈 | 只有 fetch / XHR 的（页面钩子记录） | 所有请求 |
| Mock | 页面钩子改 fetch / XHR 的结果；「JS 修改响应」需要授权站点 | 所有请求类型 |
| 禁用缓存、网络限速 | 不可用（用 DevTools 自带 Network 面板的同名开关） | 可用 |
| 原页面设备模拟 | 不可用 | 可用 |
| 居中模拟器 | 可用；授权站点后内页拿到模拟的 UA、屏幕和触摸 | 可用 |
| 资源搜索 | DevTools 能读到的资源 | 全部脚本和样式表 |
| 拾取整页截图 | 逐屏滚动拼接 | 一次截完 |

不开 CDP 时 Mock 靠页面钩子：给站点授权后（面板里「授权此站点」），钩子在页面最开始注入，不打开 DevTools 也生效；没授权时由面板在打开后注入，页面最早的几个请求赶不上。设计和取舍见 [docs/changes/no-cdp-and-pick/design.md](docs/changes/no-cdp-and-pick/design.md)。

## 拾取

截图、看元素样式、量间距，记进「拾取篮」，之后在侧栏里引用、补充说明、整理成 Markdown。

- 开始：popup 的「拾取」一栏（元素 / 区域 / 可视区 / 整页），或 `Alt+Shift+X`。拾取篮：popup 的「拾取篮」或 `Alt+Shift+S`。快捷键可在 `chrome://extensions/shortcuts` 改。
- 元素：悬停看盒模型，单击选中主元素，右侧显示文本、盒子、背景与效果的样式；`Shift` + 单击加次元素，显示和主元素的距离；按住 `Alt` 可以操作页面本身（比如先展开菜单）。
- `Enter` 记下（截图默认带高亮和距离线），`Esc` 先清选中、再退出。快捷键：`E` 元素、`R` 区域、`V` 可视区、`P` 整页。
- 拾取篮：点卡片看大图、样式、间距、写说明；「引用」或在输入框里输入 `#` 把记录插进去，前后写描述；「复制为 Markdown」，或「问 omem」「存为原件」（见下）。

截图和记录存在扩展自己的 IndexedDB，发给 omem 之前不出浏览器。

## 录制

侧栏切到「录制」：写一句要教助手什么，选标签页，「开始录制」，照平常做一遍，「停止」后删掉多余的步骤，点「整理成技能」（交给 omem 的助手整理）或「只保存」。录制中工具栏图标显示 REC。

- 记下打开的页面、点击、填写、提交、Enter（元素的名字、角色、CSS 路径、所在标题），点击和换页后截可视区；从被录页打开的新标签页一起录。「加标记」写一句“这里看的是……”，可先在页面上指一个元素。
- 密码、验证码、卡号一类的输入框只记“填了”。请求用 `chrome.webRequest` 只观察（不连调试器）：方法、地址、状态、耗时、请求头和请求体；同时开着这个页面的 DevTools 时，devtools 页面补上响应体。cookie、令牌、密码在扩展里就换成占位，规则同 omem 远程录制（aad 的 `redact_network`）。
- 录制中的数据在 IndexedDB `omem-record`，上传成功或放弃后清空。上传接口 `POST /api/remote/recordings/import`（只有 omem 的本人），omem 写成和远程页浏览器录制一样的文件。设计和边界见仓库的 `docs/v2/remote.md`「在自己的 Chrome 里录」。

代码：`src/background/recording-service.ts`（注入、步骤、webRequest、截图、REC）、`src/inject/recorder.ts`（页面里的记录脚本和指出元素）、`src/panel/recording-bridge.ts`（DevTools 开着时补响应体）、`src/shared/recording.ts`（遮盖、敏感输入框、合并、上传内容，单元测试 `recording.test.ts`）、`src/sidepanel/RecordPanel.vue`；e2e `e2e/record.e2e.test.ts`。

## 连接 omem

拾取篮顶部点「连接 omem」，可以存多条连接、随时切换：

- **本机**：这台电脑上的 omem（默认 `http://127.0.0.1:4317`）。
- **远程地址**：局域网或服务器上的 omem 网页地址。
- **配对的设备**：经一条已登录的连接转到它配对的设备（omem peer），不用单独登录。

连接时扩展打开 omem 的确认页（和 `omem login` 同一套），浏览器里已经登录的话点一下「允许」，扩展就拿到一个只给它用的令牌（在 omem 的 账号 → 命令行与 MCP 里可以撤销）。为什么不直接用浏览器的登录 cookie：omem 对带 cookie 的写请求要求同源，扩展过不了这一关，放开它会让别的扩展也能借你的登录态写 omem。

连上以后选一个空间，写好描述、引用记录，点：

- **问 omem**：作为一条问题发到问答（新对话），侧栏里显示助手的回答，也可以去 omem 里接着聊。
- **存为原件**：存成一篇笔记，omem 接着整理。

两种都会带上页面信息（地址、标题、描述、视口、选中的文字）和元素信息（CSS 路径、id / class / `data-*` / `aria-*` 等属性、文字、精简的 HTML、子元素概况、所在的标题），大元素只取头尾和前几层；截图存成图片原件，助手能直接看。细节见 [docs/changes/omem-connect/design.md](docs/changes/omem-connect/design.md)。

## 开发

```bash
pnpm --filter omem-chrome run check        # 类型检查、单元测试、构建
pnpm --filter omem-chrome run test:e2e     # 真实 Chromium 加载扩展跑 e2e（首次先 test:e2e:install-browser）
pnpm --filter omem-chrome run build && node chrome/scripts/shots.mjs <目录> [--dark]   # popup、侧栏、面板截图
```

注入页面的脚本（`src/inject/*`）单独打包成 IIFE（`scripts/build-inject.mjs`），不能 import 扩展页面的模块闭包以外的东西。开发约定见 [AGENTS.md](AGENTS.md)，历次设计与验证记录在 `docs/changes/`。

### 居中设备模拟器

Chrome 125+。在 popup 或面板的「设备模拟」里点「打开居中模拟器」，用真实网页画布调整尺寸、横竖屏、缩放、UA、DPR 和鼠标转单指触摸，原标签页保留。DPR / screen 是页面属性模拟，触摸是合成事件，不等于原生移动 viewport；需要原生行为时开 CDP 用「在原页面启用」。登录、分区 Cookie、顶层跳转和拒绝嵌入的网站可能不兼容，见 [实现、检查与边界](docs/changes/bootstrap-devtools-panel/mobile-simulator-review.md)。
