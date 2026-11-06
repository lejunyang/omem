# 远程操作与录制技能

本人在网页上打开 omem 所在机器的一个浏览器页面或整个桌面，远程用键鼠操作；需要把一件事教给助手时，先用一句话说要做什么，开始录制，自己做一遍，停下后助手把录到的步骤、页面变化和网络请求整理成技能，在同一页上和本人对话改到满意再保存。看、操作、录制、回放都由 ai-auto-desktop（`aad`）完成，omem 只负责起停进程、转发画面、保存录制和对话。页面只在这台机器装了 `aad` 时出现。

## 用法

1. 导航“远程”。选“浏览器”或“桌面”，打开：
   - 浏览器：填网址，选资料。临时资料关掉就清空；长期资料是数据目录里的一个目录，保留登录，每人一份（本人的在 `remote/profiles/<名>`，别人的在 `remote/profiles/@<用户>/<名>`，看不到也打不开别人的）；本人还可以复制这台机器上 Chrome、Edge、Brave 某份资料的登录（复制到一份临时资料里，平时用的资料不动；那个浏览器正开着时要勾选“先关掉”，否则报 409）。这台机器的浏览器是本人的登录，所以列出和复制本机资料只有本人能用，其他有“操作桌面”权限的人被拒（403）。默认无窗口，可以勾选在这台机器上也显示。
   - 桌面：整个桌面、某块显示器或某个窗口。
2. 每个会话一个标签页（标签上的 × 或鼠标中键关闭）。画面在左侧，直接点击、右键、打字、拖拽、滚动；输入法组好的字才发出去，组合键（Ctrl+A、Ctrl+C……）原样送过去，Ctrl+V 粘贴的是这边的剪贴板，在画面里复制的文字带回这边。Mac 上 ⌘ 当 Ctrl 用（远程不是 Mac 时）。浏览器会话上方有地址栏，页面按查看页的大小排版。右侧是和助手的对话。
3. 录制技能：在对话里说要教什么（“在后台给某个商户开通退款权限”），点“开始录制”。共享一个窗口时录这个窗口；共享整个桌面或一块显示器时，开始前选录哪个程序（录制按程序窗口记元素，不按坐标，一次一个程序）。做完点“停止”。
4. 停止后页面把这次录制交给助手：录制编号、做了几步、记下多少请求。助手用 `read_recording` 看步骤、截图和关键请求，在对话里说它理解的流程和要本人确认的地方（哪些值每次不同、成功的标志是什么），本人回答后它用 `save_skill`（`from_recording`）保存技能，录到的可回放步骤和请求摘要随技能保存。
5. “回放”：在当前远程会话上重放一次录制（或技能附带的步骤），画面里能看到它在做什么，结果显示在录制卡片上。
6. “画面设置”（右上角）：格式、画质、帧率、最大宽度、远程鼠标指针、剪贴板、新开浏览器用哪个。保存后之后打开的画面按这个来；有打开的会话时“保存并应用到当前画面”换一个查看页，页面和进行中的录制不受影响。

## 画面设置

每个人一份，存在这台机器的 kv（`remote_settings:<用户>`，不随 `omem pull` 走）。接口 `GET/PUT /api/remote/settings`，打开会话时换成 `aad assist` 的参数：

| 设置 | 选项 | `aad assist` |
| --- | --- | --- |
| 格式 | 自动（默认）/ 只传变化的部分 / 视频 H.264、VP9、AV1 / 整张图片 WebP、JPEG | 自动：图片和 tiles 加上能用的视频编码（查看页先选 tiles，大片变化时换视频）；只传变化：`--codecs tiles,webp,jpeg`；视频：`--codecs <编码>,webp,jpeg`；整张图片：`--codecs webp` / `jpeg` |
| 画质 | 省流量 40 / 标准 70（默认）/ 清晰 85 / 无损 100 | `--quality`（tiles 在 100 时无损；视频不设码率时换算成恒定量化） |
| 最高帧率 | 自动（整张图片 5、其余 30）/ 10 / 15 / 30 / 60 | `--fps` |
| 最大宽度 | 1280 / 1600（默认）/ 1920 / 2560 / 不缩小 | `--max-width`（0 不缩小） |
| 远程鼠标指针 | 默认显示（只对桌面） | 不显示时 `--hide-cursor` |
| 剪贴板 | 默认把画面里复制的文字带回 | 关掉时 `--no-clipboard` |
| 新开浏览器用 | 自动（Chrome、Edge、Brave 里第一个有的）/ 指定一个 | `browser_open` 的 `browser` |

- 哪些视频编码能用：第一次打开设置时跑一次 `aad assist --probe-video`（每个编码器试编几帧；这台 Windows 上一个硬件编码器卡住，约 20 秒），结果存在 kv `remote_video_probe`，aad 版本变了才重测，设置里可以“重新检测”。有结果后格式列表只让选能用的视频编码，打开会话时给每个编码带上 `--encoder <检测到的编码器>`：`--codecs auto` 每次启动都会把所有编码器再试一遍（这台机器上每次多十几秒），指定编码器后只试那一个。保存的视频编码在这台机器上不能用时按“自动”开。
- `POST /api/remote/sessions/:id/viewer`：用现在的设置给会话另起一个 `aad assist`（同一个浏览器页面或同一块屏幕），起来后关掉旧的，返回新的查看地址；旧进程退出不结束会话（只有当前的查看进程退出才算画面没了）。浏览器、`aad mcp` 和进行中的录制都不动。

## 进程与转发

| 会话 | 进程 | 说明 |
| --- | --- | --- |
| 浏览器 | `aad mcp --allow-input`（每个会话一个，stdio JSON-RPC；复制本机资料时加 `--allow-profile-copy`）+ `aad assist --browser-port <port> --page <id>`（再加画面设置的参数，下同） | `browser_open` 起浏览器（临时资料，数据目录 `remote/profiles/<名>`，或 `copy_profile` 复制本机某份资料、`close_running` 先关掉用它的浏览器），返回调试端口和页面；`assist` 用同一个端口出画面、收键鼠。本机有哪些资料：`GET /api/remote/browser-profiles`（`browser_profiles`）。录制用同一个 MCP 进程的 `browser_record_start/stop`。 |
| 桌面 | `aad assist --desktop [--monitor N \| --window W]` | 录制时另起 `aad record <窗口> --until-stdin-closes`，停止时关它的标准输入。共享一个窗口时，录制对象按窗口句柄（不行就按进程和标题）在 `aad apps` 里找到这个窗口；共享整个屏幕时由本人在 `aad apps` 列出的程序里选。 |

- `assist` 只监听本机回环地址，带一次性 token。omem 在 `/remote/<会话>/` 下转发它的查看页（HTTP）和 `/remote/<会话>/ws`（WebSocket）。查看页按自己的地址连 WebSocket（ai-auto-desktop#12 之后的版本），经 https 和路径前缀都能用。开发时 Vite 也代理 `/remote`。
- 只有本人能打开：`POST /api/remote/sessions/:id/open` 发一个只对 `/remote` 有效的会话 cookie（同 `/ide`），升级请求再查 Origin；带本人令牌的转发（`omem peer open <设备>`）也放行。`/remote` 加进 `tunneled`，所以经别的设备转发打开时画面也能过去。
- 会话不入库，进程随 omem 退出、本人关闭或 30 分钟没人看（没有查看连接）结束；关闭 `aad mcp` 时它打开的浏览器一起关掉。录制入库；omem 启动时把还标着录制中的改成中断（会话已经随进程没了）。
- 开发 aad 时可以用 `OMEM_TOOL_AAD=<本地构建的 aad>` 指定程序（一般形式 `OMEM_TOOL_<名>`），omem 和它启动的 Agent 都用这个。

## 录制

表 `remote_recordings`：`id`、`kind`（browser / desktop）、`goal`（开始时本人说的要做的事）、`target`（网址或窗口）、`status`（recording / done / failed）、`dir`、`summary`（JSON：步数、请求数、截图数、可回放步骤数、跳过的动作）、`conversation_id`、`skill`、时间。

文件在数据目录 `remote/recordings/<id>/`：

- 浏览器：`aad` 写的 `steps.jsonl`（动作和它引起的页面变化）、`evidence/network.jsonl`（请求与响应，敏感字段已遮盖）、`evidence/network-streams.jsonl`、截图，以及 `workflow.yaml`（`aad` 按控制会话的定位规则转出的可回放步骤）。
- 桌面：`aad record` 的输出 `record.json`（步骤与跳过的动作）和 `workflow.yaml`。

录制和画面是同一份输入：浏览器的点击经 CDP 送到页面，页面里的记录脚本照常看到；Windows 录制听 UIA 事件，Linux 听 AT-SPI 信号和 XTest 输入，远程送进去的键鼠同样被记下。

## 交给助手

停止后 omem 以本人的名义在页面的对话里发一条消息（录制编号和摘要），助手照常回答。助手可用的工具在分组 `remote`（说明 `skills/omem/references/remote.md`）：

- `list_recordings`：最近的录制。
- `read_recording`：摘要、步骤（分页，每步带动作、元素、引起的变化）、某一步的截图、请求（按网址或方法筛选，带状态和精简的请求体、响应体）。
- `save_skill` 的 `from_recording`：把录制的 `workflow.yaml` 和请求摘要 `requests.md` 复制进技能目录的 `recording/`，正文由助手写。

写技能的要求在内置技能 `skill-from-recording`：先复述流程和每一步的目的，标出每次会变的值（作为输入），写清成功的标志（页面上出现什么、哪个请求返回什么），说明回放怎么跑（先打开网址，再 `aad run recording/workflow.yaml`），能用接口完成的步骤附上请求的写法作为备选，不保存密码、令牌和 cookie。

## 回放

`POST /api/remote/recordings/:id/replay`：在当前远程会话上跑录制的 `workflow.yaml`。浏览器会话经同一个 MCP 进程的 `run_workflow`（用会话已经接上的浏览器），桌面会话起 `aad run <workflow> --permission desktop.input --permission desktop.observe`。结果（每步成败、失败原因）写回录制卡片。Agent 回放技能里的步骤照常走 `desktop-control` 技能，需要本人同意才动手。

## 边界

- 远程画面是给人用的通道，按屏幕位置操作，不经 MCP 提供给 Agent；Agent 只读录制文件。
- 录制里的密码框内容不保存，回放时作为运行时输入；请求里的 cookie、Authorization 和常见敏感字段由 `aad` 遮盖。
- 桌面录制按窗口记元素：录制期间切到别的窗口做的操作不会记下（列在“跳过”里）。
- Linux 只支持 X11 会话；macOS 需要屏幕录制和辅助功能权限。
- omem 被强制结束（不是正常退出）时，Windows 上 aad 起的无窗口浏览器会留下来，要手动关；正常退出和常驻服务（systemd 按控制组结束）不受影响。
- 录制里填的值写死在可回放步骤里（密码框除外）：技能里会变的值目前写在正文里，由做的人替换，`aad run` 还不能把它们当输入。
