# 远程操作与录制技能

本人在网页上打开 omem 所在机器的一个浏览器页面或整个桌面，远程用键鼠操作；需要把一件事教给助手时，先用一句话说要做什么，开始录制，自己做一遍，停下后助手把录到的步骤、页面变化和网络请求整理成技能，在同一页上和本人对话改到满意再保存。看、操作、录制都由 ai-auto-desktop（`aad`）完成，omem 只负责起停进程、转发画面、保存录制和对话。页面只在这台机器装了 `aad` 时出现。

## 用法

1. 导航“远程”。选“浏览器”或“桌面”，打开：
   - 浏览器：填网址，选资料。临时资料关掉就清空；长期资料是数据目录里的一个目录，保留登录，每人一份（本人的在 `remote/profiles/<名>`，别人的在 `remote/profiles/@<用户>/<名>`，看不到也打不开别人的）；本人还可以复制这台机器上 Chrome、Edge、Brave 某份资料的登录（复制到一份临时资料里，平时用的资料不动；资料被占用时可勾选“先关闭占用这份资料的浏览器”：长期资料先结束同一人的旧远程会话，aad 核对占用进程的资料目录、身份与启动时间后关闭进程；本机残留锁先检查主机和 PID，PID 已退出才清理，仍在运行却不属于这份资料的 PID 不会被误杀）。这台机器的浏览器是本人的登录，所以列出和复制本机资料只有本人能用，其他有“操作桌面”权限的人被拒（403）。默认只在远程画面里看和操作；勾选“在运行 omem 的电脑桌面上也显示浏览器窗口”后，那台电脑前的人也能直接操作这个窗口。Linux 后台服务需要连接到 X11 桌面；没有 `DISPLAY` 时网页禁用显示窗口，浏览器仍可无窗口使用。从桌面终端重启服务后会保留该桌面的显示与认证环境。
   - 桌面：整个桌面、某块显示器或某个窗口。
2. 每个会话一个标签页（标签上的 × 或鼠标中键关闭）。画面在左侧，直接点击、右键、打字、拖拽、滚动；输入法组好的字才发出去，组合键（Ctrl+A、Ctrl+C……）原样送过去，Ctrl+V 粘贴的是这边的剪贴板，各种格式和文件原样到远程，远程复制的带回这边（aad 0.0.9 起；做法和浏览器的限制在 aad 仓库的 `docs/plan/clipboard-transfer.md`，旧版只带文字）。上传走查看页的 WebSocket，带回的图片和文件是 `GET /remote/<id>/clipboard/<id>?token=…`，omem 的转发原样转 `Content-Disposition`，不用另开接口。Mac 上 ⌘ 当 Ctrl 用（远程不是 Mac 时）。浏览器会话上方有地址栏（旁边是“刷新画面”），页面按查看页的大小排版。查看页的连接断开时（aad 的查看页显示“已断开”，自己不重连），远程页按 1、2、4…秒（最长 30 秒，最多 8 次）重新加载查看页，画面上方显示“正在重新连接”；会话已经结束就从标签里去掉。地址栏换页先按 aad 的 `control_act navigate`，aad 的页面快照被截断（真实页面一般都是）时它拒绝动作，这时改用浏览器自己的调试端口 `Page.navigate`。右侧是和助手的对话。地址栏右边的“单独打开”在新标签页打开 `#/remote/<会话>`：`App.vue` 对这个路径不画侧栏，`Remote.vue` 只留地址栏和画面（没有标签、设置、录制和助手；正在录制时地址栏显示“录制中”），会话已经结束时说明并给回远程页的链接。“全屏操作”对地址栏和画面这一块调 `requestFullscreen`，再试 `navigator.keyboard.lock()`（只有 Chromium 在安全上下文里有），锁住后 Esc 等系统键也转给远程、按住 Esc 才退出；全屏时同样不显示录制栏。
3. 录制技能：在对话里说要教什么（“在后台给某个商户开通退款权限”），点“开始录制”。共享一个窗口时录这个窗口；共享整个桌面或一块显示器时，开始前选录哪个程序（录制按程序窗口记元素，不按坐标，一次一个程序）。做完点“停止”。
4. 停止后页面把这次录制交给助手：录制编号、做了几步、记下多少请求。助手用 `read_recording` 看步骤、截图和关键请求，在对话里说它理解的流程和要本人确认的地方（哪些值每次不同、成功的标志是什么），本人回答后它用 `save_skill`（`from_recording`）保存技能，录到的可回放步骤和请求摘要随技能保存。
6. “画面设置”（右上角）：格式、画质、帧率、最大宽度、远程鼠标指针、剪贴板、新开浏览器用哪个。保存后之后打开的画面按这个来；有打开的会话时“保存并应用到当前画面”换一个查看页，页面和进行中的录制不受影响。

## 把会话交给成员

会话主人或本人可以把本机浏览器的当前页面交给已登录的成员。授权不会开放整台桌面、长期资料、录制、画面设置或关闭会话的入口。接手的成员需要对应的全局能力和这一个会话的有效授权。`view` 对应 `remote.view`，`operate` 对应 `remote.operate`。普通预设都不包含这两项。

| 请求（相对于 `/api/remote/sessions/:id`） | 参数与结果 |
| --- | --- |
| `POST /grants` | `{"userId":"member-a","mode":"view","hours":2}`。返回 `id、sessionId、userId、mode、expiresAt`。成员需有未过期的完整登录会话。已有授权返回 409。 |
| `PATCH /grants/:grantId` | 传 `mode` 或 `hours`，也可同时传。小时从修改时刻起算。改模式后重新打开画面。 |
| `DELETE /grants/:grantId` | 撤销指定授权。已开的画面随即断开。 |
| `POST /navigate` | 操作模式或主人可提交 `{"url":"https://example.test/"}` 给当前页面换地址。 |
| `POST /view` | 返回 `src` 并设置 HttpOnly Cookie。浏览器在同源 iframe 打开该地址。 |

`GET /api/remote` 的 `sessions` 同时列出自己的会话和获准查看的会话。以下是成员看到的列表项节选：

```json
{"id":"rsDemo","ownerId":"owner","ownerName":"本人","mine":false,
 "grant":{"id":"rgDemo","sessionId":"rsDemo","userId":"member-a","userName":"成员 A","mode":"view","expiresAt":"2026-11-21T12:00:00.000Z"},
 "runId":"runDemo","spaceId":"project-a","viewers":2}
```

主人另见 `grants[]` 的 `connected`，以及 `connections[]` 中每条查看连接的 `userId、mode`。网页可按 `mine` 和本人身份显示授权管理，按 `grant.mode` 显示操作入口。`remoteGrants.defaultHours` 默认 2 小时，`remoteGrants.maxHours` 默认 24 小时。授权记录仅存本机；授权、修改及撤销在审计里分别记作 `remote.grant`、`remote.grant`、`remote.revoke`。

只看连接可协商自己的画面编码（`hello`）和请求关键帧（`keyframe`）。代理丢弃其它客户端消息，包括接管、改变视口、键鼠、粘贴、文件块和未知消息。主人和获得操作授权的成员可以同时打开同一页并交替输入。每份操作授权使用独立的 aad 画面进程连接同一标签页，沿用会话的画面设置，最后一条操作连接断开时释放进程。每次转发都重查授权，空闲连接也会在到期、撤销、成员停用或页面结束时断开。

本机运行用 `desktop-control/scripts/browser.mjs open` 打开的页面自动登记。宿主依据运行令牌取成员、空间和资料目录，从 Chrome 的 `DevToolsActivePort` 读取端口，并核对目标页面所在浏览器的启动参数。运行事件带 `sessionId` 和 `link`（`#/remote/<会话>`）。页面关闭即结束授权。运行结束、停止查看或 omem 退出时，浏览器仍按原启动方式管理。使用独立 aad MCP 的流程按技能中的 `register` 步骤登记；录制仍由启动浏览器的一方管理。

## 画面设置

每个人一份，存在这台机器的 kv（`remote_settings:<用户>`，不随 `omem pull` 走）。接口 `GET/PUT /api/remote/settings`，打开会话时换成 `aad assist` 的参数：

| 设置 | 选项 | `aad assist` |
| --- | --- | --- |
| 格式 | 自动（默认）/ 只传变化的部分 / 视频 H.264、VP9、AV1 / 整张图片 WebP、JPEG | 自动：图片和 tiles 加上能用的视频编码（查看页先选 tiles，大片变化时换视频）；只传变化：`--codecs tiles,webp,jpeg`；视频：`--codecs <编码>,webp,jpeg`；整张图片：`--codecs webp` / `jpeg` |
| 画质 | 省流量 40 / 标准 70（默认）/ 清晰 85 / 无损 100 | `--quality`（tiles 在 100 时无损；视频不设码率时换算成恒定量化） |
| 最高帧率 | 自动（整张图片 5、其余 30）/ 10 / 15 / 30 / 60 | `--fps` |
| 最大宽度 | 1280 / 1600（默认）/ 1920 / 2560 / 不缩小 | `--max-width`（0 不缩小） |
| 远程鼠标指针 | 默认显示（只对桌面） | 不显示时 `--hide-cursor` |
| 剪贴板 | 默认两个方向互通 | 关掉时 `--no-clipboard` |
| 文件上限 | 默认 100 MB（aad 自己的默认），0 只传文字、富文本和图片 | 不是 100 时 `--clipboard-max-mb <N>`，只给 0.0.9 及以后的 aad（`clipboardFiles`），旧版不认这个选项会起不来 |
| 新开浏览器用 | 自动（Chrome、Edge、Brave 里第一个有的）/ 指定一个 | `browser_open` 的 `browser` |

- 哪些视频编码能用：第一次打开设置时跑一次 `aad assist --probe-video`（每个编码器试编几帧；这台 Windows 上一个硬件编码器卡住，约 20 秒），结果存在 kv `remote_video_probe`，aad 版本变了才重测，设置里可以“重新检测”。有结果后格式列表只让选能用的视频编码，打开会话时给每个编码带上 `--encoder <检测到的编码器>`：`--codecs auto` 每次启动都会把所有编码器再试一遍（这台机器上每次多十几秒），指定编码器后只试那一个。保存的视频编码在这台机器上不能用时按“自动”开。
- `POST /api/remote/sessions/:id/viewer`：用现在的设置给会话另起一个 `aad assist`（同一个浏览器页面或同一块屏幕），起来后关掉旧的，返回新的查看地址；旧进程退出不结束会话（只有当前的查看进程退出才算画面没了）。浏览器、`aad mcp` 和进行中的录制都不动。

## 进程与转发

| 会话 | 进程 | 说明 |
| --- | --- | --- |
| 浏览器 | `aad mcp --allow-input`（每个会话一个，stdio JSON-RPC；复制本机资料时加 `--allow-profile-copy`）+ `aad assist --browser-port <port> --page <id>`（再加画面设置的参数，下同） | `browser_open` 起浏览器（临时资料，数据目录 `remote/profiles/<名>`，或 `copy_profile` 复制本机某份资料、`close_running` 先关掉用这份资料的浏览器（长期资料也传入）），返回调试端口和页面；`assist` 用同一个端口出画面、收键鼠。本机有哪些资料：`GET /api/remote/browser-profiles`（`browser_profiles`）。录制用同一个 MCP 进程的 `browser_record_start/stop`。 |
| 桌面 | `aad assist --desktop [--monitor N \| --window W]` | 录制时另起 `aad record <窗口> --until-stdin-closes`，停止时关它的标准输入。共享一个窗口时，录制对象按窗口句柄（不行就按进程和标题）在 `aad apps` 里找到这个窗口；共享整个屏幕时由本人在 `aad apps` 列出的程序里选。 |

- `assist` 只监听本机回环地址，带一次性 token。omem 在 `/remote/<会话>/` 下转发它的查看页（HTTP）和 `/remote/<会话>/ws`（WebSocket）。查看页按自己的地址连 WebSocket（ai-auto-desktop#12 之后的版本），经 https 和路径前缀都能用。开发时 Vite 也代理 `/remote`。
- `POST /api/remote/sessions/:id/view` 给有权查看的人签发仅用于 `/remote/<会话>` 的 Cookie，升级请求检查 Origin；带本人令牌的转发（`omem peer open <设备>`）也放行。`/remote` 加进 `tunneled`，所以经别的设备转发打开时画面也能过去。
- 会话不入库，进程随 omem 退出、本人关闭或 30 分钟没人看（没有查看连接）结束；关闭时先等待 `browser_close` 返回，让 aad 关闭浏览器并释放资料，再结束 `aad mcp`；不会在浏览器清理过程中按旧的 3 秒超时强制结束。录制入库；omem 启动时把还标着录制中的改成中断（会话已经随进程没了）。
- 开发 aad 时可以用 `OMEM_TOOL_AAD=<本地构建的 aad>` 指定程序（一般形式 `OMEM_TOOL_<名>`），omem 和它启动的 Agent 都用这个；后台服务启动 / 重启也显式传入 `OMEM_TOOL_*`，避免被早已启动的 PM2 丢掉。

浏览器启动错误：只在找不到可执行程序时尝试下一个浏览器；已找到的浏览器提前退出，保留它的 stderr，不再统一归咎于资料占用。无桌面环境的窗口启动在创建资料、关闭占用进程前拒绝；本次启动失败后的锁按本次子进程的 PID 核对并释放。残留锁恢复依赖包含此修复的 aad。

## 录制

表 `remote_recordings`：`id`、`kind`（browser / desktop）、`goal`（开始时本人说的要做的事）、`target`（网址或窗口）、`status`（recording / done / failed）、`dir`、`summary`（JSON：步数、请求数、截图数、可回放步骤数、跳过的动作）、`conversation_id`、`skill`、时间。

文件在数据目录 `remote/recordings/<id>/`：

- 浏览器：`aad` 写的 `steps.jsonl`（动作和它引起的页面变化）、`evidence/network.jsonl`（请求与响应，敏感字段已遮盖）、`evidence/network-streams.jsonl`、截图，以及 `workflow.yaml`（`aad` 按控制会话的定位规则转出的可回放步骤）。
- 桌面：`aad record` 的输出 `record.json`（步骤与跳过的动作）和 `workflow.yaml`。

录制和画面是同一份输入：浏览器的点击经 CDP 送到页面，页面里的记录脚本照常看到；Windows 录制听 UIA 事件，Linux 听 AT-SPI 信号和 XTest 输入，远程送进去的键鼠同样被记下。

### 在自己的 Chrome 里录（omem 扩展）

要教的事常常在本人自己的浏览器里做（已经登录、开着很多页面），不必先开一个远程会话。Chrome 扩展（`chrome/`）的侧栏有「录制」一页：写一句要教什么，选一个标签页，开始录制，自己做一遍，停止后选「整理成技能」或「只保存」。录制期间工具栏图标上显示 REC，侧栏里一步一步列出记下的内容，可以删掉试错的步骤。

- 记什么：打开的页面（地址变了才算，前端路由 `#/…` 也算）、点击、填写（同一个输入框连续打字合成一步）、提交表单、在输入框里按 Enter，每步带元素的名字、角色、CSS 路径和所在的标题（和「拾取」同一套取法，`chrome/src/shared/element-context.ts`），点击和换页后截一张可视区（只截正在显示的标签页，最多每 1.1 秒一张、一次 200 张）。从被录的页面打开的新标签页一起录，也可以中途把当前标签页加进来；iframe 里的操作不记。
- 标记：录的时候点「加标记」写一句“这里看的是……”，可以先在页面上指一个元素（高亮框，点一下记下，这一下不传给页面）。标记是录制里 `kind: "mark"` 的一步，助手读到的是“备注（指着「…」）：…”，不用事后再问本人那里看的是什么。
- 不记值的输入框：aad 的规则（`password`、`file`、`hidden`）之外，`autocomplete` 是密码、一次性验证码、银行卡的，名字（name、id、label、placeholder）像密码、令牌、验证码、卡号的，只记“填了”（`protected`）。omem 收到后按标签再挡一次。
- 请求：不用调试器（扩展默认不连 `chrome.debugger`），用 `chrome.webRequest` 只观察：方法、地址、类型、状态、耗时、请求头和请求体（JSON 和表单）。响应体只有 DevTools 开着这个标签页时才有：扩展的 DevTools 页面（不用切到 omem 面板）把 `onRequestFinished` 的 HAR 连同接口和文档的文字响应体（每个最多 32K）送给后台，和 webRequest 记的同一个请求合并。cookie、令牌、密码按 aad 的 `redact_network` 规则在扩展里就换成占位（`chrome/src/shared/recording.ts`），omem 收到后再遮一次（`src/remote/redact.ts`，两边规则相同，遮两次不变）；另外 `pwd` 也算密钥名，片段只留前端路由。
- 存在哪：录制中的数据在扩展的 IndexedDB `omem-record`（service worker 随时会被回收，每个事件直接写库，醒来读回）；上传成功或放弃后清空。

上传走 `POST /api/remote/recordings/import`（只有本人，`src/remote/import.ts`）：目标、起始页、步骤、请求和截图（base64，最多 80 张、每张 3 MB；请求最多 5000 个，体合计 16M 字，超出时扩展先丢静态资源）。omem 照 aad 浏览器录制的样子写文件：`steps.jsonl`（第 0 步是起始页，之后每步带 `action`、`control`、`locator.css`、`screenshots`、关联的 `network`）、`evidence/network.jsonl`（`request`、`response`、`body`、`step_id` 按时间归到同一个标签页里之前最近的一步）、`images/`，`remote_recordings` 记一行（`kind` 为 browser，`summary.source` 为 `chrome-extension`，另有标记数、带响应体的请求数）。没有 aad 写的操作说明和可回放步骤，`read_recording` 的概要直接列步骤（带截图的文件路径）。之后和远程页的录制一样：选「整理成技能」时以本人名义发整理的消息；`contextId` 给了一个关注时发到它的对话，`itemId` 给了一个事项时消息里写明是这个事项里的事；「只保存」不发消息，之后可以 `POST /api/remote/recordings/:id/organize`。没有响应体时 `requests.ts` 不再把同一个 GET 调了五次当成轮询（没有响应可比，翻页和轮询看起来一样）。

## 交给助手

停止后 omem 以本人的名义在页面的对话里发一条消息（录制编号和摘要），助手照常回答。助手可用的工具在分组 `remote`（说明 `skills/omem/references/remote.md`）：

- `list_recordings`：最近的录制。
- `read_recording`：摘要、步骤（分页，每步带动作、元素、引起的变化）、某一步的截图、请求（按网址或方法筛选，带状态和精简的请求体、响应体）。
- `save_skill` 的 `from_recording`：把录制调用的接口写成技能目录的 `recording/requests.md`（每个接口一条，带一次调用的参数、请求体和响应体开头），`recording_requests` 让助手只留完成这件事用到的接口；正文由助手写。可回放步骤和 aad 的完整操作说明留在录制里：本人录的多是每次内容不同的操作，录制时也常有试错，照搬没有用，要的是助手看懂做了什么。

### 请求里的噪音（`src/remote/requests.ts`）

真实页面一次录制有上千个请求，大多和要做的事无关。按形态分出来，不按网站：浏览器标的资源类型（Script、Image、Stylesheet、Font… 是静态资源，Ping 是埋点，Preflight 和 OPTIONS 是预检）；请求体是事件批次（`{"events": …}`）或路径段是 collect、track、beacon、monitor、metrics 一类且在监控样子的主机上或反复 POST 的，算埋点；同一个 GET 调了 5 次以上且响应几乎不变的算轮询。剩下的按“方法 + 主机 + 路径”合并（路径里的数字、长 id 换成 `:id`），写操作在前。`read_recording` 的概要列前 25 个接口，`part=requests` 默认不列噪音，`noise=true` 全部列出并标原因。

写技能的要求在内置技能 `skill-from-recording`：录制不是剧本，先从试错和多余操作里找出真正完成这件事的那几步和接口，复述流程和每一步的目的，标出每次会变的值（作为输入），写清成功的标志（页面上出现什么、哪个请求返回什么），写清用到的接口和字段来源，不保存密码、令牌和 cookie。

## 演示

录制教的是一段固定的操作；很多事本人更想“做一遍给助手看”：在浏览器里查一查、把页面上要看的地方指出来（“就是这个”）、在飞书里回个人。演示（`src/remote/demos.ts`）把这一段收在一起，结束时交给助手整理成技能（固定步骤）或一个关注、一件事项处理这类情况的经验。

- **一个演示是一个对话**：渠道 `demo`，会话的 `settings.demo` 记着目标（要教什么）、连着的关注或事项、开始和结束时间、结束时选的整理方式；演示的 id 就是对话的 id，对话在问答页能打开。同一时间只有一个进行中的演示，只有本人能演示。空间跟着关注或事项，都没有时是个人空间。
- **开始和结束**：Chrome 扩展侧栏顶部的「演示」（写要教什么，可选一个关注或事项；演示中显示一条横幅：计时、记下了什么、结束）；网页上关注页和事项页的「开始演示」（连着这一页的关注或事项）；聊天命令 `/演示 <要教什么>`（在关注的群里或关注的处理对话里发会连上那个关注；不带内容看现在的演示）和 `/演示结束 [技能|经验|不整理]`（不写时连着关注或事项的整理成经验，否则整理成技能）。接口 `POST /api/demos`（`goal`、可选 `contextId` / `itemId`）、`POST /api/demos/:id/stop`（`organize`：`skill` / `lessons` / `none`）、`GET /api/demos`（`current` 和最近十个）、`GET /api/demos/:id`，都只有本人。
- **演示期间记进来的**（对话里一条一条本人的消息，`meta.demo.kind` 标明是什么，不起一轮）：扩展的录制上传时带 `demoId`（`POST /api/remote/recordings/import`），录制的 `conversation_id` 是演示的对话，不再单独发整理的消息；扩展的拾取发 `POST /api/clips` 时带演示的对话和 `turn: false`（只记进对话、不起一轮，截图照常变成图片原件，回答 `mode: "note"`），扩展演示中只有「记进演示」一个发送按钮。每条按发生的时间排（录制按开始的时间，早于演示开始的算在开始那一刻）。
- **结束时才收的**：本人在这段时间里自己发的飞书消息（`lark_messages` 里 `sender_kind = 'owner'`，连着关注时只看它的群，连着事项时看事项的关注的群，都没有时看所有采集到的会话；同一个群里间隔不到十分钟的连成一条；`/演示` 命令本身不算）和这段时间里结束的远程页录制（还没记进来的）。
- **整理**：选了技能或经验时，omem 以本人名义在演示的对话里发一条消息（`meta.demo.kind = organize`），开始助手的一轮：目标、连着的关注或事项、时间线一行一条（全文用 `read_conversation` 读这个对话），按内置技能 `skill-from-demo` 整理。技能用 `save_skill`（有录制时带 `from_recording`）；关注的经验写到工作文件 `关注/<名>/演示/<目标>.md`（和 listen-coach 的 `经验.md` 同一个目录），宿主读关注的经验时（`playbookOf`）把这个目录下的文件接在后面，处理群消息、分诊和会议的助手都看得到；listen-coach 整理经验时单独看到它们，不改写也不删（`roles/listen-coach.md`）；事项的做法写成挂在事项上的工作文件 `演示/<目标>`。「只结束」时对话里留一条“演示结束，先不整理”，之后可以在对话里让助手整理。

## 回放

页面上没有回放按钮，技能也不再带 `workflow.yaml`（2026-11-14 去掉）：录的多是每次内容不同的操作，回放意义不大。录制目录里仍有 aad 转出的 `workflow.yaml`，`read_recording(part="replay")` 能看。

## 边界

- 远程画面是给人用的通道，按屏幕位置操作，不经 MCP 提供给 Agent；Agent 只读录制文件。
- 演示：扩展不存演示的状态，开着侧栏时每 15 秒读一次（读失败时保留上一次的，不当成没有演示）；网页和飞书上开始的演示，扩展最多晚 15 秒才显示。忘了结束的演示一直开着，会把之后的拾取都记进去，开始新的演示前要先结束它。飞书消息只收本人自己发的，对方问了什么由助手按群和时间去查。
- 扩展的录制：没开 DevTools 时没有响应体；webRequest 分不出 fetch 和 XHR（都记成 XHR）；只截正在显示的标签页；被录的页面在扩展里没有权限（没授权所有网站）时开始不了；service worker 被回收再醒来时，刚醒那一刻的请求先排队，合并输入框和 DevTools 记录用的最近状态只在内存里，回收后同一个请求可能各记一条。
- 录制里的密码框内容不保存，回放时作为运行时输入；请求里的 cookie、Authorization 和常见敏感字段由 `aad` 遮盖。
- 桌面录制按窗口记元素：录制期间切到别的窗口做的操作不会记下（列在“跳过”里）。
- Linux 只支持 X11 会话；macOS 需要屏幕录制和辅助功能权限。
- omem 被强制结束（不是正常退出）时，Windows 上 aad 起的无窗口浏览器会留下来，要手动关；正常退出和常驻服务（systemd 按控制组结束）不受影响。
