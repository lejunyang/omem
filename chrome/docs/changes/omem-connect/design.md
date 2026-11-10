# 连接 omem 与把拾取发给 omem

日期：2026-11-10。接着 [不用 CDP 的默认模式与拾取](../no-cdp-and-pick/design.md)：扩展能存多条 omem 连接并切换，拾取篮里的内容可以「问 omem」或「存为原件」，带上页面和元素的上下文。

## 1. 连接

三种，都存在 `chrome.storage.local` 的 `omem.connections`，当前用哪条在 `omem.connection.active`（`src/shared/connections.ts`）：

| 方式 | 地址 | 凭据 |
| --- | --- | --- |
| 本机 | 默认 `http://127.0.0.1:4317`，可改端口 | 登录换来的 `om_` 令牌 |
| 远程地址 | 任意 omem 网页地址（局域网、服务器） | 同上 |
| 配对的设备 | 经一条本机或远程连接的 `/api/peers/<设备>/…` 转发 | 用那条连接的令牌，不单独登录 |

### 能不能直接用浏览器里已登录的 cookie

读可以，写不行：扩展对已授权的主机发请求时浏览器会带上 cookie，`GET /api/me` 能认出是谁；但 omem 对带 cookie 的写请求要求 Origin 和自己同源（防 CSRF，`src/auth/http.ts` 的 `resolveAuth`），扩展的 Origin 是 `chrome-extension://…`，提问和存原件都会被拒绝。为扩展放开这条检查，等于让任何拿到主机权限的扩展都能借用户的登录态写 omem，不放开。

所以用 omem 已有的命令行登录（`omem login`，docs/v2/remote-clients.md §4.2）换一个只给扩展用的 `om_` 令牌：

1. 扩展 `POST /api/auth/cli/start`（客户端名「omem 浏览器扩展（Chrome）」），打开返回的确认页。
2. 浏览器里已经登录了这个 omem：确认页直接显示「允许它使用 omem？」，点「允许」就行；cookie 只用来在扩展里提示「浏览器里已登录为 X」。没登录：先照常登录（飞书等），再允许。本机的 omem（没开多人登录）把本机网页当本人，同样一键允许。
3. 扩展每 2 秒 `POST /api/auth/cli/poll`，拿到令牌和用户存进这条连接。令牌在 账号 → 命令行与 MCP 里可以逐个撤销。

令牌只存在扩展自己的 storage 里；401 时连接显示「登录已失效」，点「登录」重来一遍。

### 状态与空间

切换连接或登录后读 `/api/me` 和 `/api/spaces`，侧栏顶部显示连上的是谁、发到哪个空间（只列可写的，默认个人空间；按连接记住上次选的）。没有令牌的直连一律显示「还没有登录」：本机的 omem 会把扩展不带 Origin 的读请求当成本机网页放行，读得到不代表写得进去。

配对的设备没有可以直接打开的网页地址（转发路径下的页面请求会落到中转的 omem 上），所以「在 omem 中查看」只对本机和远程连接显示；问答的回答在侧栏里显示。

## 2. 发什么

拾取「记下」时在页面里多取一份上下文（`src/inject/dom-context.ts`、`src/shared/element-context.ts`），元素可能很大，每一项都有上限：

| 项 | 怎么取 | 上限 |
| --- | --- | --- |
| 位置 | CSS 路径：id、`data-testid`、稳定的类名（去掉 `css-1x2y3z` 这类构建生成的）、同类序号；自己有 id 也往上带几层，看得出在哪一块 | 7 层，更深的写 `… >` |
| 属性 | id、class、`data-*`、`aria-*`、role、href、src、alt、title、placeholder 等；去掉事件处理器和 style；密码框不记值，名字像 token / secret 的不记 | 30 个，值 160 字，data: URI 只留类型 |
| 文字 | innerText，空白合并 | 600 字，超出留头尾并写明总字数 |
| HTML | 精简的 outerHTML：展开 3 层、每层 6 个子节点、文本 80 字，去掉 script / style，svg 只留开头标签 | 3000 字 |
| 子元素 | 直接子元素数、后代数、按「标签.类名」计数（`li.item ×24`） | 列 8 种，后代数到 5000 |
| 所在区块 | 元素前面最近的 h1–h4 | 80 字 |
| 页面 | 地址、标题、描述、语言、视口和 DPR、滚动位置、当时选中的文字 | 描述 200 字、选中 400 字 |

发送时（`src/shared/pick-clip.ts`）：输入框的正文在前（引用写成 `[#3 标题]`），后面「引用的记录」逐条列页面、说明、截图占位 `{{image:r3}}`、主元素和次元素的上述上下文、样式、间距。截图超过 6 MB 时转 WebP，仍然太大就缩小（`src/sidepanel/image-data.ts`）。

## 3. omem 这边：`POST /api/clips`

`src/sources/clips.ts`，权限是目标空间的 `source.write`：

- 每张截图校验是 PNG / JPEG / WebP、不超过 15 MB，存进 `files/`，建成图片原件（`kind: image`、`meta.original`、`meta.pageUrl`）。Agent 用 read_source 读到的是图片路径，能用自己的图片工具看；之后也能 describe_source 补描述、被检索和引用。
- 正文里的 `{{image:key}}` 换成 `![标题](omem-file:<文件>)` 和「截图原件 src:<id>」；网页照常把它显示成图片。
- `mode: "source"`：存成一篇笔记原件（`uri: clip/<id>`），和截图一起排进整理。
- `mode: "ask"`：作为一条消息走问答（和网页上提问同一个入口），返回对话 id；扩展每 3 秒看一次，5 分钟内把助手的回答显示在侧栏里。

## 4. 没做的

- 发到已有的对话（接口支持 `conversationId`，界面先只开新对话）。
- 配对设备的网页链接；跨 iframe 的元素；读页面框架（React / Vue）的组件名（页面脚本挂在元素上的属性，内容脚本所在的隔离环境里读不到）。
