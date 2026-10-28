# 插件：带页面、档案和工具的一整套能力

有些场景要的不是一问一答，而是一组题、一张表、一块屏幕：出一批题、本人一次提交、AI 看结果再出下一批，过程里记下水平和薄弱点。机器人只适合一条一条地说，这类强交互放在网页里做，由插件提供。

插件把一个场景需要的东西打成一个包：Agent 档案、技能、工具、数据和独立页面。宿主负责加载、权限、存储和转发；理解和出题交给插件里的档案。第一个内置插件是英语学习（`plugins/english`）。

## 目录

```
plugins/<id>/
  plugin.yaml          清单
  agents/<名>.md        Agent 档案（格式同 library/_agents），对外名字是 <id>-<名>
  skills/<名>/SKILL.md  技能，首次启动播种到 library/_skills（已有的不覆盖）
  server.ts            服务端代码：工具、内容块、判分（数据目录里也可以是 server.js / server.mjs）
  web/                 页面：内置插件放源码，构建到 web/dist/plugins/<id>/；数据目录里的插件放构建好的文件（或手写的 HTML）
  其他文件              服务的程序（清单 services 里的命令在插件目录里运行）
```

内置插件在仓库的 `plugins/`。本人自己的插件（包括接内部系统的）放数据目录 `<数据目录>/plugins/<id>/`，不进仓库。没有自己页面的插件用外壳的默认页（会话、回复、通用内容块）。和内置插件同 id 的不加载。

### 信任

数据目录里的插件带代码（`server.*` 或 `services`）时，代码以本人的身份运行，所以**本人确认之前一行都不运行**：清单、档案、技能和页面照常可用，工具、内容块和服务不注册、不启动。设置 → 插件列出每个插件的来源、状态、目录、服务的命令；“信任并运行”后立即加载，不用重启。

确认的是代码此刻的样子：清单加上插件目录里除 `web/`、`agents/`、`skills/`、`node_modules/` 以外的所有文件的哈希（超过 50 MB 的文件按大小和修改时间算），存在本机的 `secrets/plugin-trust.json`（不随多设备同步，每台机器各自确认）。代码改过，状态变成“代码改过，需要重新确认”，重启后不再加载。撤销信任时它的工具马上注销、服务停止。

数据目录里的代码不能 `import` 包：`api.z` 是宿主的 zod，服务用 `OMEM_SERVICE_SDK` 指向的帮助模块。

## 清单

```yaml
id: english
name: 英语学习
description: 按场景出题、批量提交、AI 点评，记录水平和薄弱点
space: { id: english, name: 英语学习, kind: learning }   # 不存在就建
icon: cap
agents: [tutor]                                         # → english-tutor
skills: [english-item-writing]
tools: [recall, remember, supersede, notify, create_card, learning_progress]   # 插件档案可用的宿主工具
page: { title: 英语练习 }                                # 出现在导航；没有 web/ 时用默认页
settings:                                               # 本人的设置，外壳统一渲染
  - { key: quizSize, label: 每组题数, type: select, options: ["6", "8", "10", "12"], default: "8" }
  - { key: dailyGoal, label: 每天目标题数, type: number, min: 5, max: 300, default: 30 }
```

- 插件档案能用的工具 = 清单 `tools` + 插件自己注册的工具 + 通用插件工具（`plugin_query`、`plugin_put`、`plugin_form`、`plugin_chart`）。档案 frontmatter 里写的 `tools` 只能在这个范围内选，超出的忽略并警告。
- 插件档案和普通档案一样出现在 Agent 页，可以 `/as english-tutor`、`run_agent`、挂技能、有专属记忆、由 coach 复盘。本人在 Agent 页改它，就在 `library/_agents/` 存一份自定义版本（带 `plugin` 字段）；删掉自定义版本回到插件自带的版本。
- 名字带插件前缀：档案 `english-tutor`，工具 `english_quiz`，避免与内置角色、本人的档案和别的插件撞名。宿主不按插件名特判任何逻辑。

## 服务端代码

`server.ts` 默认导出 `register(api)`：

```ts
export default function register(api: PluginApi) {
  api.tool({ name: "english_snapshot", description, schema, handler: (ctx, args) => … });
  api.block({ kind: "quiz", description, schema, prepare, publicView, grade });
}
```

- `api.tool`：注册工具，名字必须以 `<id>_` 开头；`page: true` 的工具页面也能调。`ctx` 里有本次运行的用户、空间、运行 id，限定在本插件、本用户的存储 `ctx.store`，本人的设置 `ctx.settings()`，以及 `ctx.present(kind, data, 会话)`：不经 Agent 直接往本人的某个插件会话里放一个块（题库出题就是这样）。
- `api.block`：注册一种内容块，宿主自动生成同名工具 `<id>_<kind>` 让 Agent 交出这种块（见下）。`display: true` 的块只展示、不用提交；否则要有 `grade`。
- `api.tool` 的 `approval: true`：Agent 每次调用都先等本人批准（问本人的卡片 / 今天页，和 `approvals.tools` 同一套），用于点击、输入这类在机器上动手的工具。
- `api.service(name).ensure()`：启动（如果没在运行）清单里声明的服务，返回 `{ url, token }`；请求带 `authorization: Bearer <token>`。
- 内置插件的 `server.ts` 随 `tsc` 编译到 `dist/plugins/<id>/server.js`，类型只从 `src/plugins/types.ts` 引入。

## 服务与流

清单声明插件的常驻进程和它对页面开放的 WebSocket：

```yaml
services:
  - { name: probe, command: node, args: [probe.mjs], idleMinutes: 10, description: 每秒采一次 CPU 和内存 }
streams:
  - { name: live, service: probe, path: /live }
```

- **服务**（`src/plugins/services.ts`）：第一次用到时启动（工具里 `api.service().ensure()`、页面打开流、设置里点“启动”），在插件目录里运行，`command: node` 用 omem 自己的 Node。拿到的环境变量：`OMEM_SERVICE_PORT`（只在 127.0.0.1 上监听）、`OMEM_SERVICE_TOKEN`（只认带这个令牌的请求）、`OMEM_PLUGIN_DIR`、`OMEM_PLUGIN_DATA`（`<数据目录>/plugin-data/<id>/`，它自己的数据）、`OMEM_SERVICE_SDK`。omem 的令牌、密钥类环境变量不传给它。没有打开的流且超过 `idleMinutes` 没用就停；omem 退出时停；上次没停掉的（被杀、开发时重启）下次启动前按记下的进程号清掉。最近 200 行输出在设置 → 插件里看。
- **服务的帮助模块** `plugins/sdk/service.mjs`（不依赖任何包）：`serve({ http(req, res), socket(ws) })`，检查令牌、处理 WebSocket 握手和帧（文本、二进制、ping、关闭，单条最多 16 MB）。
- **流**：页面 `omem.stream("live")` → 外壳打开 `ws(s)://…/api/plugins/<id>/streams/<name>`（带本人的令牌，和事件流一样）→ omem 检查是本人、插件的代码已被信任、流已声明 → 启动服务 → 把连接原样转到服务的 `path`，请求头里换成服务的令牌。外壳和页面之间用 postMessage 中继，二进制帧转移所有权、不复制（截屏这类每秒几帧的数据可以直接走）。有流打开时服务不会被当成空闲。
- 页面写成普通 HTML 时，`<script type="module">import { connect } from "/plugins/_sdk/omem.js"</script>` 就能用 SDK（同一份 `plugins/sdk/client.ts`，构建时打包成一个模块，含表单和图表的渲染）。

### 例子：看机器状态

一个只有四个文件的数据目录插件（开发时的验收用例）：`plugin.yaml` 声明服务 `probe` 和流 `live`；`probe.mjs` 用 `service.mjs` 每秒把 CPU、内存推给所有连接，HTTP `/now` 返回当前值；`server.ts` 注册工具 `pulse_read`（`api.service("probe").ensure()` 后请求 `/now`）；`web/index.html` 打开流画两条进度条。信任之后，页面每秒更新；`/as pulse-watcher 机器现在负载怎么样？` 时档案调用 `pulse_read` 回答。

远程看屏幕、一起操作的插件照同样的结构：服务截屏推二进制帧、接收页面发来的点击；Agent 用的“点击”“输入”工具标 `approval: true`，每次本人批准后才执行。截屏和输入依赖系统（Windows、macOS、Linux 各不相同），由插件自己实现，不进宿主。

## 交互协议：内容块

Agent 不靠输出 JSON 文本和页面交互，而是调用工具交出**内容块**，和 `submit_review`、`submit_plan` 是同一种做法：参数由插件声明的 zod schema 校验，不合格的错误直接回给 Agent 修。

```
本人在页面里说“来一组餐厅点餐的题”
  → 插件会话（channel plugin:<id>，绑定 <id>-<档案>）开一轮
  → Agent 调 english_snapshot 看水平，再调 english_quiz({ title, items:[…] })
  → 宿主 prepare（补题号）→ 存 plugin_blocks（含答案）→ 事件 plugin → 页面取 publicView（去掉答案）渲染
本人做完点“提交”
  → POST /api/plugins/english/blocks/:id/submit { answers }
  → 插件 grade：能确定判分的直接判（选择、填空、听写），写作答记录、更新掌握度；主观题标成待评
  → 块记下答案和结果；结果整理成一条消息（meta.submission）进入同一会话，开下一轮
  → Agent 看到“8 题对 6，q4 待你评分”，english_grade 评主观题、点评、按画像出下一组
```

- 答案只在服务端；页面拿到的是 `publicView` 的结果，提交后结果里才带正确答案。
- 一个块只能提交一次。Agent 还在运行时提交，消息照常排进会话（运行中的追加消息机制，`steer.ts`）。
- 页面显示会话的消息和块；Agent 的文字是 Markdown。一轮的回复在这一轮结束时才存下，所以块排在交出它的那一轮回复之后。

### 宿主的通用块

每个插件的档案都能用，没写代码和页面的插件也能交互：

| 工具 | 内容 | 提交后 |
| --- | --- | --- |
| `plugin_form` | 表单：文字、多行、数字、单选、多选、1–5 打分；可标必填 | 宿主检查必填（缺了退回，块重新可填），整理成“【提交】标题 / - 字段：值”交给 Agent |
| `plugin_chart` | 柱状图或折线图，最多 4 组数据，一条纵轴 | 只展示 |

渲染在 `plugins/sdk/blocks.ts`，不依赖框架：外壳的默认页和插件自己的页面都用它（英语练习页里陪练交的表单和图表也是它画的）。图表的颜色是验证过色觉和对比度的 4 个分类色，深浅色各一套；两组以上有图例，每根柱子悬停有数值，“看数据”展开成表格。

### 不在插件页里的时候

插件档案在别的会话里（比如飞书里 `/as english-tutor`）交出内容块时，宿主替本人新开一个这个插件的会话，把块放进去，工具结果里给 Agent 一个链接 `#/plugin/<id>?session=<会话>`，让它发给本人。配置了网页地址（`config.webUrl`，设置 → 渠道）时链接是完整地址，飞书里能直接打开；页面打开时停在那个会话上。同一个地址也让通知卡片里的页面链接能从飞书打开。

## 存储

表 `plugin_records`：`(plugin, user_id, collection, key)` 唯一，`data` 是 JSON，带 `space_id`、创建和更新时间，参与多设备合并。插件的服务端代码用 `ctx.store`，Agent 用 `plugin_query` / `plugin_put`（只能读写本次运行所属插件的数据）。不需要为插件写迁移。

表 `plugin_blocks`：内容块（含答案）、提交的答案、判分结果、状态（open / submitted / shown）。

本人的设置存在插件记录的保留集合 `_settings` 里，按清单 `settings` 校验（单选只能是列出的值，数字在范围内），插件代码用 `ctx.settings()` 读，Agent 和 `plugin_query` 读不到这个集合。

逐题的作答、统计这类数据放插件存储，不写进记忆；偏好（“想多练听力”“喜欢商务场景”）由档案写成专属记忆。

## 页面

插件页面放在 `#/plugin/<id>`，外壳用 iframe 载入 `/plugins/<id>/`：

- iframe 带 `sandbox="allow-scripts allow-forms allow-popups"`、不给同源，页面拿不到本人的 Cookie、令牌和 localStorage，也不能直接调 `/api`。
- 页面经 `plugins/sdk/client.ts`（postMessage）请求外壳，外壳只转发到 `/api/plugins/<id>/…`，其他路径拒绝。
- 外壳把主题 token（`--bg`、`--ink`、`--accent`……）和深浅色发给页面，主题切换时再发一次；页面字体、颜色与主站一致。
- 外壳把服务端事件里和本插件有关的（`plugin`、`run`）转给页面，页面据此刷新；初始化时还带上路由的查询参数（`params.session` 指定打开哪个会话）。
- 页面调 `openSettings()` 让外壳打开设置弹窗；保存后页面收到 `settings: true` 的事件。
- 插件页面的静态文件带 `access-control-allow-origin: *`（沙箱里的 module script 要求跨源许可），只是公开的构建产物。

### 插件接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/plugins` | 已加载的插件（导航用） |
| `GET /api/plugins/:id/sessions` | 本人在这个插件里的会话 |
| `POST /api/plugins/:id/sessions` | 新会话（可指定插件里的档案，默认第一个） |
| `GET /api/plugins/:id/sessions/:cid` | 会话的消息、内容块（publicView + 结果）、是否在运行 |
| `POST /api/plugins/:id/sessions/:cid/messages` | 本人说一句话 |
| `POST /api/plugins/:id/blocks/:bid/submit` | 提交一个块 |
| `GET /api/plugins/:id/data/:collection` | 页面读插件存储（只读） |
| `POST /api/plugins/:id/call/:tool` | 页面调用插件自己的工具（以本人身份，限本插件标了 `page` 的工具） |
| `GET` / `PUT /api/plugins/:id/settings` | 设置项和当前值；保存一项或几项 |
| `POST` / `DELETE /api/plugins/:id/trust` | 信任数据目录插件的代码 / 撤销 |
| `GET /api/plugins/:id/services`、`POST …/services/:name/start`、`…/stop` | 服务状态与最近输出；启动、停止（代码未被信任时拒绝） |
| `GET /api/plugins/:id/streams/:name`（WebSocket） | 流，只给本人，转到插件的服务 |

## 英语学习插件

档案 `english-tutor` 按学习者画像出题、看提交结果点评、调整下一组。

**题型**（`english_quiz` 的 `items[].type`）：

| 类型 | 页面 | 判分 |
| --- | --- | --- |
| `choice`：中选英、英选中、听音选意 | 单选，可带 `audio` | 宿主 |
| `cloze`：句子填空 | 输入，可多个可接受答案 | 宿主（忽略大小写、首尾标点、多余空格） |
| `dictation`：听写 | 播放 `audio` 后输入 | 宿主：按词比对，正确率 ≥ 0.9 算对 |
| `translate`：中译英、英译中 | 多行输入 | Agent（`english_grade`，0–1 分 + 点评 + 错误类型） |

每题带 `skill`（vocab / grammar / listening / translation / reading）、`level`（A1–C2）和 `points`（考的知识点，如 `word:bill`、`phrase:to-go`、`grammar:present-perfect`）。

**听力**用浏览器的 `speechSynthesis` 朗读，页面需要拿到朗读的原文，所以听写的原文会到达页面（不显示）；以后接服务端语音合成后可以只给音频。

**学习者画像**（宿主确定性维护，Agent 只读）：

- 作答记录 `attempts`：题目、类型、技能、等级、知识点、本人答案、对错、得分、错误类型、时间。
- 技能水平 `skills`：每项一个类 Elo 分（初始 1000）。题目等级换成难度（A1=700 … C2=1450），`期望 = 1 / (1 + 10^((难度 − 分数)/400))`，`分数 += 32 × (得分 − 期望)`；分数折算回 CEFR 等级。
- 知识点 `points`：见过几次、答对几次、连对次数、上次得分、上次对错和时间、错误类型计数。对错按题目自己的标准（听写 ≥ 0.9，其余 ≥ 0.7）。
- `english_snapshot` 汇总：各技能分数与等级、近 7 天与之前的正确率、薄弱知识点（见过 ≥ 2 次且正确率 < 60% 或最近一次答错）、该复习的知识点（上次答对、连对 n 次后超过 2^(n−1) 天没见，最多 30 天）、常见错误类型、最近 14 天每天的题数和正确率（页面画学习曲线也用它）。

出题方向由 Agent 决定（场景、题型比例、难度略高于当前水平、薄弱点占一部分），宿主只给数据。

**出题方式**（设置“出题方式”，默认题库）：

- **题库**：陪练用 `english_bank_add` 提前往题库（插件记录 `bank`，最多 300 题）里补题，标好场景、技能、等级和知识点。本人点“下一组”时，页面调 `english_next`，宿主当场按画像挑题放进会话，不用等模型：薄弱知识点 +3、该复习的 +2、同场景 +2、等级与本人相同或高一级 +1、低于本人 −1；同一类题不超过一半（翻译不超过四分之一，它要等陪练评分），同一知识点尽量不重复；挑走的题从题库删掉。题库里这个场景的题不到半组、或总数不够一组时不出，页面改请陪练现出。提交后的消息告诉陪练“不要出下一组，题库剩多少，补到约三组的量”，陪练这一轮只点评和补题。选了“侧重”的新练习也交给陪练现出。
- **陪练现出**：每组由陪练用 `english_quiz` 出，最贴合刚才的结果，但每组要等一两分钟。

其余设置：每组题数、朗读口音（美式 / 英式）和语速、每天目标题数（学习情况里显示今天完成了多少）。

## 分期

1. **第一期**（2026-10-28）：清单与加载、插件档案进 Agent 列表、插件存储、内容块协议、插件页 iframe 与 SDK、英语插件（四种题型、宿主判分、Agent 评翻译、画像与学习曲线）。
2. **第二期**（2026-10-28）：插件设置；宿主通用块（`plugin_form`、`plugin_chart`）和默认插件页；数据目录里的声明式插件；英语题库（陪练补题、宿主按画像选题）；插件会话链接与网页地址（飞书里交出的块转成练习页链接）。
   还没做：内容块在问答页和运行详情里显示、“每日练习”规则模板、服务端语音合成（听写原文就不用发到页面）。
3. **第三期**（2026-10-28）：数据目录里带代码的插件与信任确认（代码哈希，改了重新确认，撤销立即卸载）；`services`（按需启动、空闲停止、清理遗留进程、输出可看）与 `streams`（本人鉴权后转发 WebSocket，外壳中继给沙箱页面）；`approval: true` 的插件工具每次等本人批准；`plugins/sdk/service.mjs` 和 `/plugins/_sdk/omem.js` 让数据目录插件不装包也能写服务和页面；设置 → 插件。
   还没做：`omem peer open` 经中间设备转发流；服务作为 MCP 服务器直接给 Agent 提供工具（现在经 `server.ts` 的工具转一层）；截屏、输入这类系统相关的现成插件。
