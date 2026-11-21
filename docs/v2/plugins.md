# 插件：带页面、档案和工具的一整套能力

有些场景要的不是一问一答，而是一组题、一张表、一块屏幕：出一批题、本人一次提交、AI 看结果再出下一批，过程里记下水平和薄弱点。机器人只适合一条一条地说，这类强交互放在网页里做，由插件提供。

插件把一个场景需要的东西打成一个包：空间结构、Agent 档案、技能、规则、MCP 服务、工具、数据和独立页面，也可以接入聊天渠道。宿主负责加载、权限、存储和转发；理解和出题交给插件里的档案。第一个内置插件是英语学习（`plugins/english`）。

## 目录

```
plugins/<id>/
  plugin.yaml          清单
  agents/<名>.md        Agent 档案（格式同 library/_agents），对外名字是 <id>-<名>
  skills/<名>/SKILL.md  技能，首次启动播种到 library/_skills（已有的不覆盖）
  rules/<名>.yaml       任务规则（首次启用时导入，默认停用）
  server.ts            服务端代码：工具、内容块、判分（数据目录里也可以是 server.js / server.mjs，或清单 server 指定的构建产物）
  web/                 页面：内置插件放源码，构建到 web/dist/plugins/<id>/；数据目录里的插件放构建好的文件（或手写的 HTML）
  其他文件              服务的程序（清单 services 里的命令在插件目录里运行）
```

插件 SDK 不在 `plugins/` 里，它不是插件：`packages/plugin-sdk`（`@omem-ai/plugin-sdk`，pnpm workspace 里的一个包）。`client.ts` 是页面和外壳之间的桥，`blocks.ts` 画表单和图表，`service.mjs` 是服务端的 HTTP / WebSocket 帮助模块。内置插件的页面 `import { connect } from "@omem-ai/plugin-sdk"`（仓库里是指向源码的 Vite 别名；npm 上发布同名的包，带构建好的 `dist/` 和类型，给在 omem 仓库之外写插件页面的人用），数据目录里手写 HTML 的页面用构建好的 `/plugins/_sdk/omem.js`。

内置插件在仓库的 `plugins/`。本人自己的插件（包括接内部系统的）放数据目录 `<数据目录>/plugins/<id>/`，不进仓库。没有自己页面的插件用外壳的默认页（会话、回复、通用内容块）。和内置插件同 id 的不加载。

### 信任

数据目录里的插件带代码（`server.*` 或 `services`）或命令 MCP 时，代码以本人的身份运行，所以**本人确认之前一行都不运行**：清单、档案、技能和页面照常可用，工具、内容块和服务不注册、不启动。设置 → 插件列出每个插件的来源、状态、目录、服务的命令；“信任并运行”后立即加载，不用重启。

确认的是代码此刻的样子：清单加上插件目录里除 `web/`、`agents/`、`skills/`、`node_modules/` 以外的所有文件的哈希（超过 50 MB 的文件按大小和修改时间算），存在本机的 `secrets/plugin-trust.json`（不随多设备同步，每台机器各自确认）。代码改过，状态变成“代码改过，需要重新确认”，重启后不再加载。撤销信任时它的工具马上注销、服务停止。`omem plugin link` 链接的开发目录例外：信任按目录记，见“开发中的插件”。

数据目录里的代码用 `api.z`（宿主的 zod），服务用 `OMEM_SERVICE_SDK` 指向的帮助模块。装进来的插件可以带自己的依赖（安装时装进它目录的 `node_modules`），本人手放的插件不能 `import` 宿主没有的包。

### 隔离运行

信任时选运行方式，默认**隔离运行**（`src/plugins/sandbox.ts`、`sandbox-runner.ts`）：

- **进程与权限**：插件代码在单独的 Node 进程里运行，启用 Node 的权限模型。它只能读自己的目录和 omem 的包、读写 `<数据目录>/plugin-data/<id>/`，读不到 `secrets/`、配置、数据库和本人的其他文件，也不能启动子进程。网络不受限制，进程的环境变量里也没有 omem 的令牌和密钥。
- **工具与平台包**：它的工具和平台包的读取器在 omem 里注册成代理，调用时转给它的进程。参数由插件自己的 zod 定义检查，宿主列工具时用它给出的 JSON Schema。
- **宿主代办的事**：要读平台（`ctx.connection(...).fetch`）、读写插件记录（`ctx.store`）、存原件（`ctx.saveSource`）、设盯着（`ctx.watches`）、启动服务时，进程向 omem 发请求。omem 按**正在进行的那次调用**的人和空间回答，不认插件自己报的身份。令牌由 omem 加在请求上，插件拿不到。
- **写法要求**：`ctx.store`、`ctx.saveSource`、`ctx.watches` 在隔离运行时返回 Promise，所以要写 `await`；写了 `await` 在 omem 进程里运行时也照样能用。
- **不能做的**：内容块（`api.block`）和放块的插槽（`api.slot`）、新的连接器（`api.connector`、`api.appConfig`）、鉴权方式（`api.authenticator`）、AI 账号的登录方式（`api.agentLogin`）、聊天渠道（`api.channel`）都需要代码在 omem 里运行。用到它们的插件在设置页选“在 omem 里运行…”，确认框会说明后果。

**在 omem 里运行**：代码以 omem 的全部权限运行，只适合你自己写的或逐行看过的插件。运行方式记在 `secrets/plugin-trust.json` 的 `mode` 里；以前信任过的插件按原来的方式在 omem 里运行。代码注册了清单没声明的东西，或者没能启动，信任会被撤回。

### 启用与停用

设置 → 插件里每个插件都有“启用”开关（内置的也有），配置记在 `plugins.disabled`。停用后它的代码不加载，工具、内容块、连接器、平台包都注销，档案、页面和侧栏入口也不出现；再启用马上加载，不用重启。命令行 `omem plugin enable|disable <id>` 改的是配置，运行中的 omem 要重启才生效。

### 第三方插件

**来源**：

- npm 包：`npm:包名@版本`，或直接写包名。npm 包有版本号和完整性校验，也能带依赖，是推荐的发布方式。
- 本地目录：`omem plugin install ./plugins-out/example`，安装时复制整个目录，不建立链接；带符号链接的本地包会被拒绝。
- GitHub：`github:owner/repo#tag`，也可以写提交 hash。必须指定 tag 或提交，因为分支会在信任之后改变。

在设置 → 插件 → 安装插件里填写，或者用命令行 `omem plugin install <来源>`。安装器（`src/plugins/install.ts`）的做法：

1. 下载并解包，npm 包用 `npm pack`，GitHub 来源从 codeload 下载 tar.gz。
2. 检查包里的 `plugin.yaml`。
3. 拒绝和内置插件重名的 id；数据目录里有同名的、你自己放的插件，或这个 id 正链接着开发目录（见下一节）时，也拒绝，不覆盖。
4. 包是源码时先构建，见下面的“从源码构建”。
5. 有依赖、但包里没带 `node_modules` 时，执行 `npm install --omit=dev --ignore-scripts`。
6. 放进 `<数据目录>/plugins/<id>/`，来源和版本记在 `.omem-install.json`。

**安全**：没有本人确认，安装过程不运行包里的任何脚本。装好后，带代码的插件和手放的一样，要本人确认信任才运行。

**从源码构建**（2026-11-16）：包的 `package.json` 有 `build` 脚本，而清单指向的入口文件还不存在时，算作源码。入口文件包括清单的 `server`（例如 `server: dist/server.js`，构建产物不在顶层时用它指定服务端文件）和服务命令里的脚本（`args` 里第一个 `.js` / `.mjs` / `.cjs` / `.ts` 相对路径）。安装器先不运行任何东西，只列出要运行的命令：

- 有 `dependencies` 或 `devDependencies`、包里没带 `node_modules` 时装依赖：有 `package-lock.json` 用 `npm ci --ignore-scripts --no-audit --no-fund`，没有用 `npm install --ignore-scripts --no-audit --no-fund --no-package-lock`。依赖自己的安装脚本不运行。
- `npm run build`，同时列出它会运行的包脚本（`prebuild`、`build`、`postbuild` 的原文）。

命令行 `omem plugin install` 打出这些命令，在终端里问“运行这些命令并安装？”，默认否；没有终端时不运行也不安装。设置页的安装和更新先收到 `{ build: 计划 }`，弹窗列出同样的内容，本人点“构建并安装”后带上计划的 `key` 再请求一次。`key` 由来源、命令和 `package.json` 原文算出：包在两次请求之间变了（比如 npm 上出了新版本、脚本改了），`key` 对不上，要重新确认。

确认后，命令在解开的临时目录里逐条运行（不是本人的源码目录）：独立的子进程，工作目录就是这个临时目录，环境变量去掉 omem 的令牌、密钥和 `OMEM_` 开头的变量，全部命令共十分钟，超时连同子进程一起停掉。输出写进 `<数据目录>/logs/plugin-builds/<id>.log`（每次覆盖），失败时报出退出码、最后几行和日志位置，什么都不装。构建完再检查入口文件，还缺就报错。之后照常放进 `plugins/<id>/`，带代码的等本人在设置 → 插件里信任；开发依赖留在它的 `node_modules` 里（信任的哈希不算 `node_modules`）。

### 开发中的插件（plugin link）

写插件时用 `omem plugin link <目录>`（`src/plugins/links.ts`）：omem 直接读这个目录，不复制。

- **只链接本机目录**：只有命令行能链接，没有链接的 HTTP 接口；网络共享路径（`\\服务器\…`、`//服务器/…`）和网址拒绝；目录里要有 `plugin.yaml`。和内置插件、数据目录 `plugins/` 里已有的插件同 id 时拒绝；同一个 id 改链到另一个目录时，旧目录的信任作废。
- **信任按目录记**：带代码的照样要在设置 → 插件里信任一次，`secrets/plugin-trust.json` 里记的是这个目录（`dir`），不是代码哈希，所以之后改代码不用再确认。换了目录或复制到别处的同样代码不算已信任。
- **改了就生效**：运行中的服务盯着链接的目录（`links.ts` 的 `watchTree`：Linux 上每个子目录一个 `fs.watch`，新建的随时补上，因为 Node 在 Linux 上的递归监听在机器忙时会漏掉改动；其他系统用系统自带的递归监听；系统给不了监听时，比如 inotify 实例被别的程序用完，改为每秒看一遍文件的大小和修改时间），文件变了停 0.3 秒再按已安装插件更新时的方式重新加载：卸下旧的工具、块、插槽和服务，重新读清单、档案和代码，发一个 `plugin` 事件让页面刷新插槽。`web/`、`node_modules/`、`.git/` 的变化不触发（页面每次请求都从目录里读）。技能和其他插件一样只在第一次补进技能库。在 omem 里运行时，Node 只重新加载服务端入口文件本身，它引用的其他文件改了要重启 omem；隔离运行每次是新进程，没有这个限制。
- **链接和取消**：服务也盯着链接清单（`<数据目录>/plugins/.links.json`），命令行的 `link` / `unlink` 不用重启就生效；服务没在运行时下次启动加载。`omem plugin unlink <id>`、`omem plugin remove <id>` 或设置页的“去掉链接”只去掉链接和对应的信任，不动目录里的文件。设置页给链接的插件标“开发中”，来源处写目录。
- **不随设备同步**：链接清单在本机的 `plugins/` 下，信任在 `secrets/` 下。拉取只替换数据库、知识库、附件、运行记录和代码仓库，不带走也不覆盖这两处，所以别的设备看不到这台的链接，拉取别的设备的数据也不会去掉这台的链接。插件自己的记录（`plugin_records` 等）和其他插件一样随数据同步。

**更新和删除**：“更新”对 npm 来源取最新版本；GitHub 来源要填新的 tag。代码变了就要重新信任。“删除”只删安装器放进来的目录，插件存下的原件、记忆和插件记录都保留。

**对第三方插件的要求**：

- 包根目录有 `plugin.yaml`，`id` 不和内置插件重名。版本取 `package.json` 的 `version`，没有就取清单的 `version`。
- 带代码的发布编译好的 JS（`server.js` / `server.mjs`），类型只从 `@omem-ai/plugin-sdk` 引入，不 import omem 的源码。
- 在清单的 `permissions` 里声明代码会做的事，信任之前设置页只能显示这些：
  - `write: true`：有会写入的工具；
  - `connectors: [...]`：注册的连接器 id；
  - `platforms: [...]`：平台包挂在哪些连接器上。

  这些声明对数据目录里的插件是强制的：代码注册了没声明的东西，加载时报错，不运行。

```yaml
id: notes
name: 笔记平台
version: 1.0.0
permissions: { write: true, connectors: [notes-api], platforms: [notes-api] }
```

## 清单

```yaml
id: english
name: 英语学习
description: 按场景出题、批量提交、AI 点评，记录水平和薄弱点
space: { id: english, name: 英语学习, kind: learning }   # 不存在就建
spaces:                                                # 可带多个空间，与旧 space 合并
  - { id: english-notes, name: 学习笔记, kind: topic, description: 练习后的笔记, skills: [english-item-writing] }
icon: languages                                         # 导航图标：图标名（web/src/lib/icons.ts），或页面目录里的 .svg
agents: [tutor]                                         # → english-tutor
skills: [english-item-writing]
rules: [oncall-first-look]                              # rules/oncall-first-look.yaml
mcp:
  web-search:
    description: 通用网页搜索
    url: https://search.example/mcp
    headers: [Authorization]                            # 只声明名字；本人在 Agent 页填值
    readOnly: true
  local-tool:
    description: 本机的一个命令
    command: npx
    args: ["-y", "some-mcp-server"]
    env: [API_KEY]
tools: [recall, remember, supersede, notify, create_card, learning_progress]   # 插件档案可用的宿主工具
page: { title: 英语练习 }                                # 出现在导航；没有 web/ 时用默认页
voice: true                                             # 页面可以开语音对话（见“语音”）
settings:                                               # 本人的设置，外壳统一渲染
  - { key: quizSize, label: 每组题数, type: select, options: ["6", "8", "10", "12"], default: "8" }
  - { key: dailyGoal, label: 每天目标题数, type: number, min: 5, max: 300, default: 30 }
```

- `spaces` 每项含 `id`、`name`、`kind`、`description`，`kind` 可用 `project` / `learning` / `topic`（默认 `topic`），`description` 默认空。可选 `skills` 指向本包 `skills` 列出的技能，挂载在空间的 `settings.skills`。原有 `space` 仍可用，也计入本包；它仍是档案没有写 `space` 时的默认空间，`spaces` 列表不隐式指定默认空间。
- 两种空间声明共用 id 检查：须是规范化后的 id（最长 80 字符，不以下划线开头、不用路径）；重复 id、包外技能都在读清单时拒绝。空间声明与相邻的清单对象一样忽略未知字段，未声明字段不会参与创建。启用时按清单顺序创建（旧 `space` 在 `spaces` 列表之前），按 id 判断是否已存在；已有空间的全部字段均不改动，详情显示“已有同名空间，没有改动”，新建的显示“已创建”。空间本身没有插件来源字段，创建结果保存在插件的安装记录中；停用和卸载都不删除空间。
- 插件档案能用的工具 = 清单 `tools` + 插件自己注册的工具 + 通用插件工具（`plugin_query`、`plugin_put`，以及提问和展示用的 `ask_user`、`wait_answer`、`show`）。档案 frontmatter 里写的 `tools` 只能在这个范围内选，超出的忽略并警告。
- 插件档案和普通档案一样出现在 Agent 页，可以 `/as english-tutor`、`run_agent`、挂技能、有专属记忆、由 coach 复盘。本人在 Agent 页改它，就在 `library/_agents/` 存一份自定义版本（带 `plugin` 字段）；删掉自定义版本回到插件自带的版本。
- 导航图标：`icon` 写图标名（`web/src/lib/icons.ts`，设置 → 插件的图标选择里列出的那些），或页面目录里的一个 `.svg`（内置插件放 `web/public/`，数据目录插件放 `web/`），按当前文字颜色画出。本人可以在设置 → 插件里点图标换一个，存在配置的 `plugins.icons`，“用插件自己的图标”恢复。
- 名字带插件前缀：档案 `english-tutor`，工具 `english_quiz`，避免与内置角色、本人的档案和别的插件撞名。宿主不按插件名特判任何逻辑。
- `server`（可选）：数据目录里的服务端文件不在顶层（`server.ts` / `server.js` / `server.mjs`）时写它的相对路径，例如构建产物 `dist/server.js`；写了就算带代码，要信任。不能放在 `web/`、`agents/`、`skills/`、`node_modules/` 里（信任的哈希不算这些目录，改了会看不出来）。从源码安装时据它判断要不要先构建。

## 规则与 MCP 服务

`rules` 列出的每个文件按 `src/rules/types.ts` 的规则格式保存，例如：

```yaml
# rules/oncall-first-look.yaml
name: 项目 A 初看
description: 项目 A 有需要关注的新消息时通知本人
judge: ai
trigger: { event: message }
actions: [{ type: notify }]
```

- 插件启用时，每个文件只导入一次，始终**停用**，由本人持有；规则页显示“来自插件 <名字>，还没启用”。本人看过条件和动作后再打开。规则动作引用本插件的档案时可以用短名，导入时加插件前缀。
- 已导入的文件名记在插件自己的保留状态中。本人删掉规则后，重启、停用再启用或卸载重装都不重建。同一插件新增的规则文件仍会导入。
- 停用、撤销信任或删除插件都保留规则和来源；本人可在规则页删除。规则已经启用时，停用插件也不会替本人关闭它。

清单的 `flows: [<id>]` 带流程定义（`flows/<id>.yaml`，id 和文件名相同，写法见 docs/v2/flows.md）：

- 启用时每份补进本人的流程清单（`library/_flows`），按普通流程校验。本人已有同 id 的不覆盖，插件详情写“已有同名流程，没有覆盖”；加过的记在插件的保留状态里，本人删掉后不再加回来，同一插件新增的流程仍会加。
- 交给本包档案的阶段（`by: { run: { agent: helper } }`）加上插件前缀，和规则一样。
- 用到的对象类型（如 `github:pull-request`）所在的插件还没启用时先不加，原因写在插件详情；之后任何插件启用或被信任时再试一次（规则同样）。为此插件加载时先跑完所有插件的代码，再补各插件带来的技能、空间、规则和流程。
- 例子：仓库的 `examples/plugins/ghdelivery`（GitHub 需求交付：流程、三个技能、一条对象状态变化规则），`omem plugin install <仓库>/examples/plugins/ghdelivery` 安装，要先启用 GitHub 平台包。

`mcp` 的值只含传输定义和密钥名：网址用 `headers`，命令用 `env`，两者都是字符串列表，不能填写值。启用后通过宿主的 MCP 保存接口加入本人的列表，名字是 `<插件 id>-<短名>`；同名服务已存在时不覆盖。档案 frontmatter 的 `mcpServers: [web-search]` 会解析成带前缀的名字。

**带 `command` 的项必须先信任插件**：即使没有 `server.*`，设置 → 插件 也会要求确认，确认框列出全部 MCP 命令。信任只把定义加入列表，实际启动由使用它的 Agent 后端负责；插件代码选了隔离运行，也不把外部 MCP 命令放进插件沙箱。网址 MCP 不需要代码信任。初次加入的密钥值全空，Agent 页列出每项未填的名字，运行时不传未填的变量或请求头。

插件卡片列出它的档案、技能、规则状态和 MCP 服务；规则链接到规则页，MCP 链接到 Agent 页，并提示“还要填：<名字>”。删除插件会保留 MCP 服务，它们可能已有本人填的密钥。

## 场景包：不带代码的插件

场景包把一类工作的空间结构、档案、技能、规则、流程和 MCP 定义交给另一个人。设置 → 插件 → **打成场景包**，勾选对象并填 id、名字和说明，完成后显示服务器上写到的目录和遗漏依赖提醒。命令行等价：

```bash
omem plugin pack --id projecta --name "项目 A" --description "项目 A 的处理做法" --space project-a --space project-notes --agents helper --skills project-guide --rules <规则id> --mcp web-search
omem plugin pack --id projecta --name "项目 A" --skills project-guide --out ./projecta-pack
omem plugin install ./projecta-pack
```

- 默认写到 `<数据目录>/plugins-out/<id>/`，`--out` 可改；拒绝已有目录，不能写进仓库或正在使用的 `<数据目录>/plugins/`，经过目录链接也一样。
- `--space <id>` 可重复；网页用同一打包表单勾选空间。只导出 id、名称、类型、说明、同时选中的技能挂载；不导出空间设置的其他字段、原件、页面、记忆、成员、仓库路径或会话 id，也不读取空间正文。个人、代码仓库和临时工作区不能打包。未选中的挂载技能，以及规则或档案引用的未选空间，逐项提示名称和 id，方便补选。
- 档案写到 `agents/<名>.md`，技能复制完整目录（包括 `references/`、脚本和其他资源），规则写到 `rules/` 并列进清单，导出时也停用；流程（`--flows`）原样写到 `flows/`，阶段用到的技能、档案没打包和用到插件对象类型时逐项提醒。档案引用的技能和 MCP 未被选中时逐项提醒。
- MCP **始终不导出变量或请求头的值**。旧档案内嵌的 MCP 会转成清单项，密钥只留名字，命令同样等待信任；档案原有的 `plugin` 归属去掉，由安装后的新包决定。
- 写入前扫描全部复制的文本：本人的已存密钥（包括 MCP 密钥映射中的值）和 macOS、Linux、Windows 用户目录绝对路径，命中按文件和行报告，整个包不写入。CLI 可重复 `--allow <包内相对文件>` 逐文件放行用户目录路径；已存密钥不能放行，要先从文件里拿掉；不会把密钥值印在报告里。命令帮助说明同样的限制。含会话或人员的 id、邮箱的文件照常打包，但在提醒里列出，分享前自己核对。
- 规则打包和导入都经过 `contributions.ts` 的 `portableRule`：带脚本或转发的规则不打包、导入时也不创建（插件详情里写明原因，其余规则照常导入）；完全访问、发到的会话、指定的 AI 去掉，定时规则原本回复到那个会话的改成只告诉本人。规则的 `spaceId` 和 Agent 动作的 `space` 在打包时仅保留本包带的空间，导入时仅保留接收方已有的空间（含本次先创建的），因此规则和空间一起打包后，停用着导入到原来的空间。未带走的空间有名称提醒，装上后可在规则页重新选。
- 插件的档案只能用插件自己带来的 MCP 服务（清单 `mcp` 里的，名字加插件前缀）；写了别的名字会被忽略，本人已有的服务和上面的凭据不会因为装了一个包就被它用上。插件技能目录里的符号链接不复制。
- 为保留 `<id>-<名>` 的约定，档案加前缀后最多 48 字符、MCP 服务最多 40 字符；超长时拒绝写包，需要缩短名字或 id。包不包含后端安装、本人密钥和现有插件的代码，引用这些本机配置的档案需要接收者自行补齐。

`POST /api/plugins/pack` 接受 `id`、`name`、`description`、`spaces`（空间 id 数组）、`agents`、`skills`、`rules`、`flows`、`mcp`、`out`、`allow`，列表字段用数组，返回 `{ dir, warnings }`。`GET /api/plugins/pack` 给表单列选择项（含可打包的 `spaces`）。两个接口都只给本人，网页与 CLI 共用打包检查。装到别处后，场景包无代码时不需要信任；带命令 MCP 时仍需先看命令、确认信任。

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
- `api.object`：平台上带状态的东西（合并请求），可以挂到事项上、被流程阶段等待；`actions` 把本插件的工具声明成对象卡上的按钮，本人点了直接执行，Agent 调同一个工具走审批档位，默认每次先问。写法和约束见 docs/v2/flows.md 第 8 节和文末，SDK 类型见 `packages/plugin-sdk/README.md`。
- `api.hook({ name, label?, handle(ctx, req) })`：外部平台有变化时主动叫醒 omem，不用一直轮询，见下文“回调”。
- 内置插件的 `server.ts` 随 `tsc` 编译到 `dist/plugins/<id>/server.js`，类型只从 `src/plugins/types.ts` 引入。

### 连接器：以用的人的身份调一个平台

插件可以带一个让人连接的平台（docs/v2/multi-user.md 的“插件扩展”）。公司内部系统的连接器只能这样放在数据目录的插件里，不进仓库。

```ts
api.connector({
  id: "notes-api", label: "笔记平台", channel: "notes", apiBase: "https://api.notes.example/v1",
  unavailable: (app) => null,                       // 不能用时返回原因（没配应用、缺密钥）
  authorizeUrl: (app, { state, challenge, redirectUri, scopes }) => "https://…/authorize?…",
  exchange: async (app, { code, verifier, redirectUri }) => ({ accessToken, refreshToken, expiresIn, scope }),
  whoami: async (app, tokens) => ({ externalId, name }), // 服务端拿令牌查，不信浏览器
  refresh: async (app, refreshToken) => ({ accessToken, refreshToken, expiresIn }),
  features: [{ id: "read", label: "读笔记", description: "读你的笔记", scopes: ["notes.read"] }],
});
api.tool({ name: "notes_recent", description, schema, handler: async (ctx) => {
  const c = await ctx.connection("notes-api");     // 这次用的人自己的连接；没连接时是 null
  if (!c) return "请先在 omem 的账号页连接笔记平台";
  return await (await c.fetch("/notes?limit=10")).text();
} });
```

- 连接器 id 要以 `<插件 id>-` 开头；插件的代码卸载（撤销信任）时一起注销。
- 账号页“已连接的应用”列出它，按功能一项项授权；令牌由宿主保管（`secrets/vault.db`），快过期时刷新。
- `refresh` 在平台拒绝刷新令牌（吊销、过期、用过）时抛一个带 `grantRejected: true` 的错误，宿主才把连接标为“需要重新授权”并通知那个人；别的失败（网络、平台出错）当作暂时的，下次用到时再刷新。
- `ctx.connection(provider).fetch` 只能请求 `apiBase` 下的地址，宿主带上令牌，插件拿不到令牌本身。
- 清单里写 `connectors: [{ provider: notes-api, features: [read] }]`，没连接或缺功能时插件页顶上提示去账号页连接。
- 想让人用它登录，把它的 id 加进 `auth.providers`（设置 → 成员）。
- 只用来读的平台写 `identity: false`：只存令牌，不登录、不绑定、不记身份。用 key 或账号密码连接的写 `credentials: { fields, verify }`，不用授权流程的三个函数。

### 鉴权方式：认组织自己的凭据

命令行和 MCP 连远程 omem 时（docs/v2/remote-clients.md），除了 omem 发的 API 令牌，还可以带组织自己的凭据（比如内部登录体系签发的 JWT，用 `OMEM_AUTH_CMD` 从内部命令行取）。认它的办法写在数据目录的插件里，不进仓库：

```ts
api.authenticator({
  id: "acme-sso", label: "公司统一登录",              // id 以 <插件 id>- 开头，也是 identities 的 channel
  claims: (token) => token.startsWith("eyJ"),        // 只看形状，不发请求
  verify: async (token) => {                          // 验签名和有效期；不是有效凭据返回 null
    const c = await checkWithOrgKeys(token);          // 插件自己的验证
    return c ? { externalId: c.sub, name: c.name, email: c.email, emailVerified: true, expiresAt: c.exp * 1000 } : null;
  },
});
```

- 清单里声明 `permissions: { authenticators: [acme-sso] }`；只能在 omem 进程里运行（设置 → 插件 选“在 omem 里运行”）。
- 宿主只认 `Authorization: Bearer`，按凭据的哈希记住结果到 `expiresAt`（最多 10 分钟），不保存凭据本身。
- 认出的身份先按 `identities` 找账号，再按 `emailVerified` 的邮箱认领预建账号，都没有时按 `auth.signup[<id>]` 处理（默认等批准，命令行会收到“等 omem 的主人批准”）。

### AI 账号的登录方式：让成员用组织的身份登录某个后端

成员用自己的 AI 账号（[agent-accounts.md](agent-accounts.md)）时，有的后端在公司环境里不走它自己的登录，而是用组织统一身份换来的凭据。插件给这个后端注册一个登录方式，凭据怎么换、写成什么格式由插件决定：

```ts
import type { AgentLoginDef } from "@omem-ai/plugin-sdk";   // 只有类型；数据目录里的插件不用装

const login: AgentLoginDef = {
  backend: "traex", id: "sso", label: "用示例公司账号登录",       // id 在插件内唯一，全名 <插件 id>:<id>
  async login(ctx) {                                            // ctx: userId、home、env、secret、settings、signal、show
    const device = await startDeviceFlow(ctx.signal);           // 插件自己的授权（设备码或网页）
    ctx.show({ url: device.url, code: device.code });           // 宿主显示在页面上，也用机器人发到他的飞书私聊
    const t = await waitForTokens(device, ctx.signal);
    await writeCredentials(ctx.env.TRAE_HOME, t);               // 写到 env 指的位置（他的账号目录里）
    await ctx.secret.set(t.refreshToken);                       // 宿主按人保存的一份秘密，不进账号目录
    return { user: t.user, expiresAt: t.expiresAt };
  },
  async refresh(ctx) {                                          // 可选：到期前 10 分钟调用，也可以由“检查”触发
    const t = await renew(await ctx.secret.get(), ctx.signal);
    if (!t) return null;                                        // null：续不了，这个人要重新登录
    await writeCredentials(ctx.env.TRAE_HOME, t);
    return { expiresAt: t.expiresAt };
  },
  async logout(ctx) { await revoke(await ctx.secret.get()); },  // 可选：退出时清理；之后宿主删目录
};
api.agentLogin(login);
```

- 清单里声明 `permissions: { agentLogin: [traex] }`（它要往成员的账号目录写凭据，设置 → 插件 的权限说明里会列出）；后端必须是能按人登录的（Agent 目录里带 `account` 的，或本人自己写了 `account` 的后端）。
- 只能在 omem 进程里运行：隔离运行的插件调用 `api.agentLogin` 会出错，撤销信任或停用时登录方式一起消失。`login`、`refresh`、`logout` 都在 omem 进程里调用，不进沙箱。
- `ctx.env` 是 Agent 目录里 `account.env` 按这个人的账号目录展开后的变量；`ctx.home` 是账号目录本身。`ctx.secret` 存在 `secrets/vault.db`（提供方 `agent:<后端>:<插件 id>:<id>`），不在“已连接的应用”里出现，这个人退出或被停用时删除。
- 登录 11 分钟没完成、60 秒内没调用 `show` 也没完成时，宿主取消（`ctx.signal`）。`show` 只接受 http(s) 链接。
- 续签：按 `expiresAt` 提前 10 分钟（最短 1 分钟一次）调用 `refresh`，时间记在库里，重启后照常；返回 null 或抛错时登录态改成“登录过期”并通知这个人，账号目录留着。没有 `refresh` 时到 `expiresAt` 直接算过期。
- “我的 AI 账号”里一个后端同时列出它自己的登录方式和插件提供的，成员选一个；登录态记下是用哪种方式登录的。
- 插件自己的配置（应用标识、站点、接口地址这类）写成清单的 `settings`，本人在 设置 → 插件 里填；`login`、`refresh`、`logout` 从 `ctx.settings` 读到本人填的值。登录方式以外的代码（鉴权方式的 `verify` 等）用 `api.settings()` 读，每次用时读，改了不用重新加载；只有在 omem 里运行的插件有 `api.settings()`，隔离运行的在工具的 `ctx.settings()` 里读。
- 主人要填的应用配置写 `appFields`（client id、secret、站点），在设置 → 采集 → 其他平台里填，存在 `secrets/connector-apps.json`，插件用 `api.appConfig(id)` 读；接口地址依赖它时 `apiBase` 写成函数。令牌不是 Bearer 时用 `sign(app, { url, headers }, secret)` 放进请求头或 query。插件自己发的请求（换令牌、查账号）用 `api.fetch`。
- 工具写 `whenConnected: true`：只在这次运行的人连了本插件的某个连接器（`<插件 id>-…`）时给出。
- 工具里 `ctx.saveSource({ uri, title, text, space? })` 存原件：`uri` 写 `平台:编号`，同一个 uri 再存是更新，也作 origin_key。
- 内置的 `connect` 插件就是这样接入几百个平台的，见 docs/v2/connectors.md。

### 平台包：给已连接的平台加读取能力

```ts
api.platform({
  provider: "connect-figma",                     // 在哪个连接器上（目录里的或别的插件的）
  features: [{ id: "design", label: "读设计稿", description, scopes: ["file_content:read"] }],
  syncMinutes: 120,
  guide: "file 的 id 是文件链接里 /design/ 后面那段",
  readers: [
    { kind: "file", label: "设计文件", id: "文件 key", read: async (c, id) => ({ id, title, text, url, updatedAt }) },
    { kind: "project", label: "项目", id: "项目 id", changes: async (c, id, cursor) => ({ items: [{ kind: "file", id, cursor }], cursor }) },
  ],
});
```

- `features` 替换连接器原来的功能，各自申请自己的 scope。
- `read` 把一项读成 Markdown。`changes` 列出容器里 `cursor` 之后改过的东西，按时间从旧到新，每项最好带上自己的位置。`c` 是这次用的人的连接（`ctx.connection` 的同一个对象）。
- 用户通过 `connect_read`、`connect_watch` 使用这些读取器，宿主负责定时同步和写原件（docs/v2/connectors.md）。
- `api.text.html(html)` 把 HTML 转成 Markdown。

### 回调：外部平台叫醒 omem

平台上的合并请求推了新提交、有人回了评论，插件声明一个回调，平台的 webhook 调它，宿主马上去读插件说的对象，不用等下一次轮询（实现在 `src/plugins/hooks.ts`）。

```ts
api.hook({
  name: "mr",                        // 小写字母开头，最长 40
  label: "合并请求有变化",
  async handle(ctx, req) {           // req = { headers, query, body }，body 是原始文本
    if (!verify(req.headers["x-signature"], req.body)) throw new Error("签名不对");
    const e = JSON.parse(req.body);
    return { refresh: [{ kind: "merge-request", key: e.id }], emit: [{ kind: "mr.pushed", keys: { id: e.id } }] };
  },
});
```

- **地址**：`POST /api/hooks/<插件 id>/<名字>/<密钥>`，不用登录。密钥由本人在 设置 → 插件 的插件卡上“生成地址”，只显示这一次（宿主只存哈希，kv 里的 `plugin-hook:<插件>/<名字>`）；可以重新生成（旧的马上失效）或撤销。插件卡上列出每个回调、地址有没有、什么时候生成、上次被调用的时间。卸载插件时删掉它的密钥。管理接口 `POST` / `DELETE /api/plugins/:id/hooks/:name/secret` 只给本人。
- **校验**：插件、名字、密钥不对一律 404；每个回调每分钟最多 60 次，多了 429（`retry-after: 60`）；正文最大 1 MB（超了 413）。正文按原始文本交给插件，平台的签名由插件自己校验；`handle` 十五秒内要回来。
- **执行**：`handle` 以本人身份、在插件的空间里跑（`ctx` 和对象的 `read` 一样，隔离运行的插件经子进程代理）。返回的 `refresh` 里，`kind` 不带前缀就是本插件的类型，别的插件的类型跳过；只重读 omem 已经在跟的对象（有未结束的事项挂着它），读法和轮询一样（`refreshObject`），状态变了或修订变了照常记信号、推进流程、发规则事件。`emit` 记成 `plugin.<id>.<kind>` 信号（也是 omem 内部事件 `plugin.signal`）。每次调用写一条 `audit_events`（`plugin.hook`，成功时记重读了几个、跳过几个、发了几个信号，失败时记原因），失败回 400。
- **修订**：对象的 `read` 可以多交 `revision`（插件自己定的“有变化”标记，如头提交加评论数）和 `note`（这次变了什么）。状态没变而修订变了，宿主记 `object.<全名>.updated`；流程阶段可以写 `done: { object, status: "updated" }` 等它，规则的对象触发选“有更新”。`updated` 是保留字，插件的状态不能叫这个名字。
- **轮询还在**：有回调的对象类型可以把 `poll.minutes` 设长（如 60）当兜底；对象进了终态、或没有未结束的事项挂着它，照旧不再读。

## 订阅事项与评审事件

在 `plugin.yaml` 中声明事件，在宿主配置的 `plugins.eventSpaces` 中按插件 id 授予空间。默认授权列表为空。例如插件 `sample` 声明 `permissions: { events: [item.status] }`，本人在宿主配置里写 `"eventSpaces": { "sample": ["project-a"] }`，即可订阅项目 A 的事项状态。

```ts
api.subscribe({
  id: "status",
  events: ["item.status"],
  async handle(ctx, event) {
    await receiveStatus(event.id, event.entity.id, event.data.status, ctx.signal);
  },
});
```

示例中的 `receiveStatus` 由插件实现。每条事件携带版本 `v: 1`、稳定的 `id`、类型、时间、实体、空间、操作者和事实字段。可选类型为 `item.created`、`item.status`、`review.finished`、`finding.decision`、`finding.resolution`。事项事件给出标题、类型、前后状态、父事项与链接。评审完成给出运行、结论和问题数。问题事件给出位置、取舍或复核结果及理由。

候选事项也会发 `item.created`，此时 `data.status` 为 `candidate`。本人留下或拒绝候选时，同一事项会发 `item.status`，`data.from` 为 `candidate`。拒绝时 `data.status` 为 `cancelled`，留下时为 `open`（等待类事项为 `waiting`）。只为已采纳事项建外部工单的插件应同时订阅这两种事件，按状态过滤：候选创建时跳过，转为 `open` 或 `waiting` 时再建单。

宿主在业务事务内保存事实和投递状态。提交后，同一订阅按同一实体的变更顺序调用 `handle`。回调有 15 秒时限，失败后按指数退避重试，累计 6 次失败后暂停该实体的后续投递。插件停用期间保留进度，授权空间在入队和回调前各检查一次。宿主定期清理超过 14 天的事件。宿主在插件处理成功后、记录成功前退出时，会再次投递同一个 id。插件有外部副作用时用这个 id 做幂等键。

用 `omem plugin failed-events sample:status` 查看失败事件的 id 和错误。在保留期内用 `omem plugin replay sample:status <事件id>` 重新排队。隔离进程通过 IPC 收到同样的事件。

## 把平台条目同步成事项

插件声明 `permissions.itemProvider: true`，通过 `api.itemProvider({ id, label, statuses, pull, setStatus? })` 注册。宿主给接口加插件前缀，例如 `sample:issues`。`statuses` 把外部状态映射为 `active`、`done` 或 `cancelled`。`pull(ctx, { target, cursor })` 返回一页 `{ items, cursor, done }`。每条至少有稳定的 `key`、`url`、`title`、外部 `status` 和 `updatedAt`。可附修订号、父条目键、负责人、类型及摘要。

本人通过 `GET /api/item-sync` 查看数据源和已启用的目标，通过 `PUT /api/item-sync` 指定空间、目标、建事项及回写方式。默认先建候选，状态回写前询问本人。开启同步时可选择直接建事项或直接写回。宿主保管游标。对同一提供者、同一用户和连接账号，相同外部键归首次导入它的空间。该空间的重叠订阅更新同一件事项，其他空间跳过该键。父键可指向同页或已导入的条目，父子须同空间、同提供者、同连接主体，并遵守事项树的三层限制。

事项详情 `GET /api/items/:id` 的 `external` 包含提供者 id、外部链接、状态和修订。用 `GET /api/item-sync` 返回的 `providers[].label` 显示提供者名称。`syncedAt` 是最近成功同步的时间，`direction` 区分拉取（`pull`）和回写（`push`），`error` 保留最近的错误。发生冲突时，`external.write.state` 为 `conflict`，`external.write.status` 是请求写入的状态，`external.status` 是最近同步到的外部状态。获授权的插件收到事项创建或状态事件时，`data.links` 含提供者 URL，正文保存在事项详情。

例如已连接 GitHub 的用户可以用以下请求订阅一个仓库的 issue。GitHub 提供者注册的是增量读取能力，只同步 issue，跳过 PR。

```http
PUT /api/item-sync
Content-Type: application/json

{"spaceId":"project-a","provider":"github:issues","target":"example/project-a","importMode":"candidate","mode":"confirm","enabled":true}
```

`importMode` 可选 `candidate` 或 `direct`，`mode` 可选 `confirm` 或 `direct`。成员使用自己的连接，在自己有读写权限的空间开启同步。后台拉取和回写也检查当前授权。

支持条件写入的平台可实现 `setStatus(ctx, { key, status, expectedRevision })`，返回平台实际保存的状态和新修订。插件用 `ctx.idempotencyKey` 识别重复请求，用平台的条件写检查外部修订。发生冲突时保留外部状态，交给本人处理。

## 指标按数据源取数

插件声明 `permissions.metricProvider: true`，通过 `api.metricProvider({ id, label, querySchema, collect })` 注册。`querySchema` 是描述一条查询的 Zod 类型。`collect(ctx, { metrics, from, to })` 收到时间范围和一组 `{ id, query }`，返回 `{ metricId, at, value, dims?, source? }` 的数组。数值必须有限，点只可归属本批的指标。

`GET /api/metrics/providers` 返回数据源 id、显示名和查询的 JSON Schema。定义指标时通过 `metric_define` 或 `PUT /api/metrics/:id` 填写 `providerId` 和 `providerQuery`。宿主校验查询，到期后按数据源、空间和连接用户合批采集，沿用指标点、维度和越线提醒。采集失败记下错误及时间，连续失败只提醒一次。普通指标继续走 Agent 采集。

服务端类型从 `@omem-ai/plugin-sdk/server` 导入。两类提供者在宿主进程运行。三种接口的 `CallContext` 只含 `userId`、`spaceId`、`signal` 和 `connection(provider)`。连接须列在插件清单的 `connectors` 中，并属于当前用户。回写专用的 `WriteContext` 还含 `idempotencyKey`。

## 渠道

插件可以实现一个聊天平台，把它接到 omem 的同一个收件箱：

```ts
export default function register(api: PluginApi) {
  const channel = api.channel({
    id: "matrix",                        // 对外为 <插件 id>-matrix
    label: "Matrix",
    owner: (settings) => settings.ownerId,
    // 已由宿主按 maxLength 分段的纯文本：回复或通知
    send: async (to: { chatId: string; topicId?: string }, text: string) => {
      // 用插件自己的平台客户端发送
    },
    maxLength: 4000,
  });
  // 插件监听器收到平台消息时调用；监听也可由声明的服务提供数据。
  // channel.receive({ chatId, topicId, isGroup, senderId, text, messageId, addressed: true });
}
```

清单为本人绑定身份声明设置：

```yaml
settings:
  - { key: ownerId, label: 本人在这个平台上的 id, type: text }
```

- **仅在 omem 进程里运行**：与连接器、内容块一样，`api.channel` 不能用于隔离模式；数据目录插件要在 设置 → 插件 选择“在 omem 里运行…”并确认，且插件启用后才注册。
- `receive` 通过 `resolveIdentity(app, "<插件 id>-matrix", senderId)` 认人。本人绑定从 `owner(settings)` 每次读取，设置保存后立即生效；成员用同一渠道的身份绑定。没人绑定的发送者不回答；还没设本人时，仅私聊提示一次绑定方法。群里只处理 `addressed: true` 的消息。
- 消息走 `answerFromChannel`，与 Telegram 相同，命令、线程、合并、权限和 ACP 运行都由宿主管理。平台客户端和监听协议由插件实现。
- 渠道定义可以带 `close()`：宿主停掉渠道时（插件停用、撤销信任、重新加载）调用一次，插件在里面关掉自己开的监听、定时器和连接。不写的话，这些东西会留到进程结束。
- 初次回复经渠道的 `send` 返回原会话，后续回复经 `registerThreadSender`；通知经可注销的 notification sink，给本人的设置 id 或成员在该渠道的身份 id 发 `title\nbody`。这个 API 约定平台身份 id 也是私聊 chat id。
- 宿主按 `maxLength` 分段。`send` 出错只记日志和最近错误，不抛进 Agent 运行；渠道行显示运行状态、最近发送错误和插件设置链接。
- 停用、卸载或撤销信任时，宿主注销发送器和通知 sink，旧的 `receive` 随即失效，已经在途的一轮完成后也不再发。插件服务沿用服务管理器停止；平台监听器如在服务端代码里自行开连接，由插件自行管理连接资源，宿主会关闭其消息和投递入口。

## 服务与流

清单声明插件的常驻进程和它对页面开放的 WebSocket：

```yaml
services:
  - { name: probe, command: node, args: [probe.mjs], idleMinutes: 10, description: 每秒采一次 CPU 和内存 }
streams:
  - { name: live, service: probe, path: /live }
```

- **服务**（`src/plugins/services.ts`）：第一次用到时启动（工具里 `api.service().ensure()`、页面打开流、设置里点“启动”），在插件目录里运行，`command: node` 用 omem 自己的 Node。拿到的环境变量：`OMEM_SERVICE_PORT`（只在 127.0.0.1 上监听）、`OMEM_SERVICE_TOKEN`（只认带这个令牌的请求）、`OMEM_PLUGIN_DIR`、`OMEM_PLUGIN_DATA`（`<数据目录>/plugin-data/<id>/`，它自己的数据）、`OMEM_SERVICE_SDK`。omem 的令牌、密钥类环境变量不传给它。没有打开的流且超过 `idleMinutes` 没用就停；omem 退出时停；上次没停掉的（被杀、开发时重启）下次启动前按记下的进程号清掉。最近 200 行输出在设置 → 插件里看。
- **服务的帮助模块** `packages/plugin-sdk/service.mjs`（不依赖任何包）：`serve({ http(req, res), socket(ws) })`，检查令牌、处理 WebSocket 握手和帧（文本、二进制、ping、关闭，单条最多 16 MB）。
- **流**：页面 `omem.stream("live")` → 外壳打开 `ws(s)://…/api/plugins/<id>/streams/<name>`（带本人的令牌，和事件流一样）→ omem 检查是本人、插件的代码已被信任、流已声明 → 启动服务 → 把连接原样转到服务的 `path`，请求头里换成服务的令牌。外壳和页面之间用 postMessage 中继，二进制帧转移所有权、不复制（截屏这类每秒几帧的数据可以直接走）。有流打开时服务不会被当成空闲。
- 页面写成普通 HTML 时，`<script type="module">import { connect } from "/plugins/_sdk/omem.js"</script>` 就能用 SDK（同一份 `packages/plugin-sdk/client.ts`，构建时打包成一个模块，含表单和图表的渲染），`<link rel="stylesheet" href="/plugins/_sdk/omem.css">` 拿到 omem 的按钮、输入框、卡片等样式。

## 语音

清单写 `voice: true` 的插件，页面可以和语音模型（设置 → 后端与模型 → 语音，docs/v2/ai-models.md）对话。宿主只负责接通，说什么由插件定：

```ts
const status = await omem.voiceStatus();   // { allowed, ready, detail, api, model }；没配好时 detail 说明原因
const call = await omem.voice({            // 在点击里调用
  instructions: "Play a waiter in a café…", // 给语音模型的说明，最多 6000 字
  onTurns: (turns) => draw(turns),          // [{ role: "user" | "assistant", text, final }]，边说边更新
  onState: (state, detail) => …,            // connecting / live / ended / failed
});
call.mute(true);
const record = await call.stop();           // 或 await call.ended：{ transcript, startedAt, endedAt, api, model }
```

- **麦克风和连接在外壳里**：沙箱页面没有 omem 的来源，不给它麦克风。页面发 `voice-start`，外壳（`web/src/views/Plugin.vue`）用 `web/src/lib/voice.ts` 拿麦克风、建 WebRTC 连接、放对方的声音，只把转写的文字转给页面；页面拿不到音频，也拿不到连接用的临时凭证（外壳不替页面转发 `voice/…`）。浏览器的麦克风授权是给 omem 的地址的，在 omem 里授过一次就行。
- **只在点击之后开始**：外壳收到 `voice-start` 时检查本人刚在页面里点过（点击的激活会传到外壳的窗口），没有就拒绝（`code: "gesture"`），页面再放一个按钮让本人点。进行中外壳顶上显示“<页面名>正在使用麦克风”，带“静音”和“结束”，本人随时可以停；离开页面时自动结束。同一时间只有一段。
- **宿主给的会话**：`GET /api/plugins/:id/voice` 是状态；`POST …/voice/realtime/secret`（Realtime：临时凭证）和 `POST …/voice/live/sdp`（GPT-Live：omem 用 key 开会话）带上插件的 `instructions`。插件的会话不带任何 omem 工具，也不进 `voice_sessions`；记录怎么存、交给谁评价由插件自己做（英语练习把它当成一个内容块，见下）。没声明 `voice` 的插件调这两个接口得到 403。
- **没配语音模型时**：状态里 `ready: false`，`detail` 写原因；页面应说明去 设置 → 后端与模型 → 语音 配置（`omem.navigate("/settings?tab=agents&section=voice")`），不要把入口藏起来。

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

### 提问和展示块

插件的档案和别的 Agent 一样用宿主的 `ask_user`（可带 `fields` 表单和 `view`）和 `show`（表格、图表、指标、方案对比、时间线），见 [interactive-ui.md](interactive-ui.md)；每个插件的档案都能用，没写代码和页面的插件也能交互。在插件会话里，它们和插件自己的块排在一起：`sessionView` 把这个会话的提问列成 `kind: "ask"` 的块、展示列成 `kind: "view"` 的块，页面用同一个提交接口（`blocks/:id/submit`，`answers` 是 `{ value?, text?, choice? }`）回答提问；宿主检查字段，答案作为“[回答]”消息回到会话。表单填得慢，档案说明里让它 `wait_seconds: 0`，交出就结束这一轮。

渲染在 `packages/plugin-sdk/blocks.ts`，不依赖框架：外壳的默认页和插件自己的页面都用它（英语练习页里陪练交的表单和图表也是它画的）。图表的颜色是验证过色觉和对比度的分类色，深浅色各一套；两组以上有图例，每根柱子悬停有数值，“看数据”展开成表格。

### 放在 omem 页面上：插槽

插件的展示块可以声明放在 omem 自己的页面上，不用跳到插件页（2026-11-16，`src/plugins/slots.ts`，设计见 [flows.md](flows.md) 第 8 节）：

```ts
api.object({ kind: "pull-request", … });
api.block({
  kind: "ci_summary",
  description: "合并请求的检查结果",
  display: true,
  schema: api.z.object({ passed: api.z.number(), failed: api.z.number() }),
  // 看页面的人、事项所在的空间：ctx.userId、ctx.spaceId；slot 是位置、事项、阶段和对象
  load: async (ctx, slot) => readChecks(await ctx.connection("connect-github"), slot.object?.key),
  view: (d) => ({ title: "检查", components: [{ type: "metric", items: [{ label: "通过", value: d.passed }, { label: "失败", value: d.failed, good: "down" }] }] }),
});
api.slot("item.panel", { block: "ci_summary", when: { object: "pull-request" } });
```

- **位置**：`item.panel` 事项页侧栏（外部状态下面），`flow.stage` 流程里选中阶段的说明下面，`today` 今日页右栏的最上面。
- **条件 `when`**：`object` 是本插件的对象类型——事项页侧栏上要求事项挂着这种对象，挂了几个就显示几块；阶段下面要求这一段跟着这种对象（`by` 或 `done` 写了它），对象是事项上最近挂的那个，还没挂时为 `null`。`stage` 是阶段 id（只用于 `flow.stage`），`flow` 是流程 id，`space` 是事项所在的空间，都可以写一个或一组。今日页没有事项，不能写条件。不满足就不显示。
- **声明时检查**：位置只有这三种；块要先用 `api.block` 声明、`display: true` 并带 `load` 和 `view`；`when.object` 要是本插件已注册的对象类型；同一个块在同一位置只能放一次；条件和位置不配（`stage` 用在别处、今日页写条件）也拒绝。声明错了，插件的代码加载失败，信任撤回。
- **取数**：网页先 `GET /api/slots?at=&item=&stage=` 拿到这一页要画的块，再逐块 `GET /api/slots/<插件>/<块>?at=&item=&stage=&object=`。宿主核对事项对这个人可读（不可读 404）、条件仍然满足、对象确实挂在这个事项上，然后按看页面的人和事项的空间构造 `PluginContext`（今日页用插件自己的空间），十五秒内调 `load`，结果按块的 `schema` 校验，再把 `view` 的结果按展示组件（[interactive-ui.md](interactive-ui.md)）校验，交互页 `page` 不能放。插件读不到、交回的内容不合 schema、画错都只是这一块报 502，网页在那一块里写原因和“重试”，别的块和页面照常。
- **画法**：网页用 `UiView` 画（和 `show` 交出的展示是同一个渲染器，Markdown 经 DOMPurify）。每块上面一行小字写插件名和对象标题；一块渲染出错由它自己的错误边界接住。
- **什么时候消失**：插槽在插件的代码加载时登记、卸下时清掉，所以插件停用、撤销信任、卸载或重新加载时插槽跟着消失，接口不再列出它，直接取数返回 404。只有在 omem 里运行的代码能声明插槽（隔离运行不能声明内容块）。设置 → 插件的卡片上写“放在页面上：事项页侧栏（ci_summary）”。

### 不在插件页里的时候

插件档案在别的会话里（比如飞书里 `/as english-tutor`）交出内容块时，宿主替本人新开一个这个插件的会话，把块放进去，工具结果里给 Agent 一个链接 `#/plugin/<id>?session=<会话>`，让它发给本人。配置了网页地址（`config.webUrl`，设置 → 设备 → 网页地址）时链接是完整地址，飞书里能直接打开；页面打开时停在那个会话上。同一个地址也让通知卡片里的页面链接能从飞书打开。

## 存储

表 `plugin_records`：`(plugin, user_id, collection, key)` 唯一，`data` 是 JSON，带 `space_id`、创建和更新时间，参与多设备合并。插件的服务端代码用 `ctx.store`，Agent 用 `plugin_query` / `plugin_put`（只能读写本次运行所属插件的数据）。不需要为插件写迁移。

表 `plugin_blocks`：插件自己的内容块（含答案）、提交的答案、判分结果、状态（open / submitted / shown）。提问和展示在 `asks` 和 `ui_views`。

本人的设置存在插件记录的保留集合 `_settings` 里，按清单 `settings` 校验（单选只能是列出的值，数字在范围内），插件代码用 `ctx.settings()` 读，Agent 和 `plugin_query` 读不到这个集合。

逐题的作答、统计这类数据放插件存储，不写进记忆；偏好（“想多练听力”“喜欢商务场景”）由档案写成专属记忆。

## 页面

插件页面放在 `#/plugin/<id>`，外壳用 iframe 载入 `/plugins/<id>/`：

- iframe 带 `sandbox="allow-scripts allow-forms allow-popups"`、不给同源，页面拿不到本人的 Cookie、令牌和 localStorage，也不能直接调 `/api`。
- 页面经 `packages/plugin-sdk/client.ts`（postMessage）请求外壳，外壳只转发到 `/api/plugins/<id>/…`，其他路径拒绝。
- 外壳把主题 token（`--bg`、`--ink`、`--accent`……）和深浅色发给页面，主题切换时再发一次；页面字体、颜色与主站一致。
- 页面用 omem 自己的样式和组件，不另做一套：内置插件的页面直接引入 `web/src/styles.css`（`.btn`、`.btn.primary`、`.input`、`.textarea`、`.card`、`.badge`……）和 `web/src/components` 里不依赖主站状态的组件（`UiSegmented`、`UiCheckbox`、`UiSelect`、`Skeleton`、`Icon`）；普通 HTML 页面引入 `/plugins/_sdk/omem.css`（构建时从 `styles.css` 复制）。SDK 画的表单和图表也用这些类，只补自己的布局。
- 外壳把服务端事件里和本插件有关的（`plugin`、`run`）转给页面，页面据此刷新；初始化时还带上路由的查询参数（`params.session` 指定打开哪个会话）。
- 页面调 `openSettings()` 让外壳打开设置弹窗；保存后页面收到 `settings: true` 的事件。
- 插件页面的静态文件带 `access-control-allow-origin: *`（沙箱里的 module script 要求跨源许可），只是公开的构建产物。`omem peer open` 的本机代理对 `Origin: null` 的请求只放行这些文件（`/plugins/<id>/…`、`/plugins/_sdk/…`，不含 `..` 和 `%`），并自己补上这个头，所以经过的中间设备是旧版本（2026-11-07 之前转发时会丢掉它）也能加载；页面的流在本机代理上走原始隧道。
- 构建和开发：内置插件的页面就是一个 Vite 页面。`pnpm run build` 最后一步（`scripts/build-plugins.ts`）把每个 `plugins/<id>/web/index.html` 构建到 `web/dist/plugins/<id>/`，再打包 SDK（`/plugins/_sdk/omem.js`、`omem.css`）。开发时（`pnpm run dev`）不构建：网页的 Vite 开发服务器在同一个 `/plugins/<id>/` 直接从源码提供页面（`web/vite-plugin-pages.ts`），改页面、SDK 或 omem 的样式和组件都热更新，不用刷新；只给插件页面会加载的路径（页面源码、SDK、`web/src`、依赖、Vite 客户端）加跨源许可。数据目录插件的页面不经过 Vite，仍由 API 提供。

### 插件接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/plugins` | 已加载的插件（导航用），含带来的规则、MCP 和渠道状态 |
| `GET` / `POST /api/plugins/pack` | 本人列出可打包对象 / 写出场景包 |
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
| `POST` / `DELETE /api/plugins/:id/hooks/:name/secret` | 本人生成（返回只显示一次的密钥和地址）/ 撤销回调的密钥 |
| `POST /api/hooks/:plugin/:name/:secret` | 外部平台调回调（不用登录，见“回调”） |
| `GET /api/plugins/:id/streams/:name`（WebSocket） | 流，只给本人，转到插件的服务 |
| `GET /api/plugins/:id/voice` | 语音能不能用（清单声明了没有、语音模型配好了没有） |
| `POST /api/plugins/:id/voice/realtime/secret`、`POST …/voice/live/sdp` | 外壳为页面开语音会话，带插件的说明、不带工具；外壳不替页面转发 |

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

**口语对话**（页面上“新练习”里和做题并列的一种方式）：选场景（可写这次想刻意练的说法），和语音模型把场景演一遍。

- 一次口语练习是一个内容块 `speaking`（`{ scene, goal? }`）：页面用 `english_speaking_start` 放进会话（会话标题以“口语 · ”开头），陪练也可以用 `english_speaking` 交出一个。
- 开始时页面调 `english_speaking_brief` 取给语音模型的说明：扮演场景里的另一个人、按本人的口语等级说话（还没有就用练得最多的那项技能的等级）、把薄弱的单词和短语自然地带进对话、口音跟设置走、本人用中文问时简短用中文答再回到英文、中途不逐句纠错。然后 `omem.voice()`。
- 结束后对话记录作为这个块的答案提交：插件存进 `speaking` 记录，消息“【口语练习】……对话记录……”交给陪练；一句没说的不交，块留着可以再开始。
- 陪练按技能 `english-speaking` 评价，用 `english_speaking_grade` 交：CEFR 等级、四项 1–5 分（流利度、语法、词汇、得体，看不出的写 null）、给本人看的评价、涉及的知识点。等级把画像里的“口语”分数拉向它（第一次直接定，之后每次走 40%）；知识点按对错进画像，薄弱的之后会出现在题里。同一次再交一遍是更正，不重复计入。
- `english_snapshot` 多了口语的次数、近 7 天分钟数和最近一次评价。

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
2. **第二期**（2026-10-28）：插件设置；宿主通用块（当时的 `plugin_form`、`plugin_chart`，2026-11-08 起由 `ask_user` 的表单和 `show` 代替）和默认插件页；数据目录里的声明式插件；英语题库（陪练补题、宿主按画像选题）；插件会话链接与网页地址（飞书里交出的块转成练习页链接）。
   还没做：内容块在问答页和运行详情里显示、“每日练习”规则模板、服务端语音合成（听写原文就不用发到页面）。
3. **第三期**（2026-10-28）：数据目录里带代码的插件与信任确认（代码哈希，改了重新确认，撤销立即卸载）；`services`（按需启动、空闲停止、清理遗留进程、输出可看）与 `streams`（本人鉴权后转发 WebSocket，外壳中继给沙箱页面）；`approval: true` 的插件工具每次等本人批准；`packages/plugin-sdk/service.mjs` 和 `/plugins/_sdk/omem.js` 让数据目录插件不装包也能写服务和页面；设置 → 插件。
   还没做：服务作为 MCP 服务器直接给 Agent 提供工具（现在经 `server.ts` 的工具转一层）；截屏、输入这类系统相关的现成插件。
4. **语音**（2026-11-11）：清单 `voice: true`，SDK 的 `omem.voice()` / `voiceStatus()`，外壳拿麦克风和连接、只给页面转写；英语练习的“口语对话”（`speaking` 块、陪练按 `english-speaking` 评价、口语进画像），代替原来网页上单独的“口语”页和 `speaking-coach` 角色。`omem peer open` 下插件页面的文件和流（本机代理放行沙箱的跨域请求并补上跨域头）。
5. **插槽和开发**（2026-11-16）：`api.slot` 把展示块放到事项页侧栏、流程阶段下面和今日页；`omem plugin link` / `unlink`（不复制、按目录信任、改了自动重新加载、不随设备同步）；从源码安装时先列出命令、本人确认后在隔离的子进程里装依赖并构建；清单 `server` 指定服务端文件。
   还没做：内置的 GitHub 插件没有放插槽；链接的插件在 omem 里运行时，服务端入口引用的其他文件改了要重启。
