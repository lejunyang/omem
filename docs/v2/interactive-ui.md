# 界面块：对话里可交互的内容

状态：2026-11-08 设计；同日实现第 1 阶段的主体（组件块、表单提问、`show`、插件会话），见第 9 节的说明。第 11 节是待定的选择。

Agent 现在只能用文字和人沟通。少数地方有按钮（`ask_owner` 的选项、`suggest_next`、批准卡片）。真正能交出“界面”的只有插件内容块，而且只在插件自己的会话里能用。这份设计让任何会话里的 Agent 都能交出可交互的内容，人在上面操作，结果结构化地回到 Agent。适用的场景包括网页问答、飞书、编码交办里“待你确认”和“待修改”的问题、插件页，以及规则和后台运行需要找人的时候。

## 1. 现状和要解决的

现在有的：

| 机制 | 能做什么 | 限制 |
| --- | --- | --- |
| 插件内容块（[plugins.md](plugins.md)） | `plugin_form` 表单（文字、多行、数字、单选、多选、1–5 打分），`plugin_chart` 柱状图或折线图；英语插件自己的 `english_quiz` | 只在插件的 Agent 运行里能用（`blockTool` 要求运行属于某个插件），主助手没有这组工具 |
| `ask_owner`（`src/agents/asks.ts`） | 一个问题，最多 6 个选项按钮，加一个文本框；能在本轮里等回答，没等到时回答作为新消息回到会话 | 一次只问一件事；飞书卡片是一个 form 容器，里面只有选项按钮和一个输入框，没有多个字段 |
| `suggest_next`、批准 | 下一步按钮；工具调用先经本人批准 | 只是按钮 |
| 宿主的决定（评审计划、升级、修改项提问、交付） | 也是 ask，带 `handler` | 内容只有 Markdown 和选项 |
| 运行产物（[artifacts.md](artifacts.md)） | 交办留下的 HTML 报告能在沙箱 iframe 里看 | 只能看，结果回不到 Agent |
| 回答正文 | Markdown，网页上能画 mermaid | 静态 |

问题：

1. 一次要问好几件事，只能拆成几轮，或者塞进一段文字，让人按编号逐条回。
2. 设计方案、界面改动、交互细节只能用文字描述，人没法试。比较几个方案全靠想象。
3. 数据、对比和进度只能写成 Markdown 表格。
4. 飞书里能做的更少，复杂的确认没有合适的地方处理。
5. `ask_owner` 这个名字在多人使用时不对：提问对象是这次运行服务的用户，不一定是 omem 的所有者。

目标：

- 两层能力。第一层是**组件块**：用 JSON 描述，由宿主来画，安全、样式统一，飞书里能降级显示。第二层是**交互页**：Agent 写的 HTML 在沙箱里运行，用来放小型 demo、原型、模拟和定制的可视化。
- 两层都能“只给人看”，也能“作为提问的一部分”。人选择或填写的结果是结构化的值，回流方式和现有的 ask 一样。
- 宿主只负责渲染、存储、权限和回流，不为每个场景单独写界面，也不在宿主里规定什么时候用哪种块。这些写进角色说明，由 Agent 自己判断。

## 2. 两层

### 2.1 组件块

组件块是一个 JSON 结构，宿主用 zod 校验，不合格的错误直接回给 Agent 改，做法和 `submit_review` 一样。组件分三类：

**展示**

| 组件 | 内容 |
| --- | --- |
| `markdown` | 一段 Markdown，可以带 `src:` 和 `mem:` 引用，经 DOMPurify |
| `table` | 列定义和行数据，可排序，最多 200 行；单元格是纯文本或带引用的 Markdown |
| `callout` | 一句话结论和依据，按语气（结论、达成、需要关注、故障、中性）配不同的图标（2026-11-14 加） |
| `chart` | 柱状图、横向条形、折线图、面积图、饼图，最多 4 组数据，可以堆叠、画目标线，带“看数据”表格 |
| `compare` | 并排的方案卡片：标题、要点、优点、代价，可以带图或一个交互页 |
| `diff` | 文件片段的改前和改后（复用交办视图的 diff 渲染） |
| `timeline` | 事件列表：时间、标题、说明、引用 |
| `metric` | 数字、单位和变化；变化的方向和哪个方向是好事决定颜色，可以带对比基准和最近的走势 |
| `artifact` | 引用一份运行产物（截图、录屏、报告） |
| `page` | 引用一个交互页（2.2） |

**输入**（每个都有 `id`、`label`、`help`、`required`）

| 组件 | 内容 |
| --- | --- |
| `text` / `textarea` / `number` | 文字、多行文字、数字（可以设范围） |
| `choice` / `multi` | 单选、多选；选项可以带说明 |
| `scale` | 1–5 打分 |
| `date` / `datetime` | 日期、日期时间 |
| `toggle` | 开关 |
| `person` | 选人：omem 的用户；在飞书里也可以是联系人 |
| `space` / `source` | 选空间、选原件（只列出提问对象能访问的） |
| `pick` | 从同一组里的 `compare` 卡片或几个交互页里选一个 |
| `rank` | 给几项排序 |
| `checklist` | 逐条处理：每条选“通过 / 不通过 / 改成…”，可以写备注。用于批量审批，比如一批记忆、kb-scout 的归属建议、评审问题 |

**结构**

- `section`：分组，带标题。
- `steps`：分几步填，最后一步提交。
- 输入字段可以写 `show_if: { field, equals | in }`，满足条件才显示。

一个提问最多 30 个输入字段，一个块最多 40 个组件。

### 2.2 交互页

交互页用来放组件块表达不了的东西：一个能点的界面原型、几种交互方式的对比、一个参数可调的计算或模拟、一张定制的可视化图。

- **怎么交**：用 `ui_page` 工具，参数是 `title`，再加 `html`（单文件，不超过 300 KB）或 `path`。`path` 指编码 Agent 工作区或收件目录里的文件或目录，限制和 `attach_artifact` 一样。给出 `page_id` 时，这次交的是那个页面的新版本。
- **存在哪**：复用运行产物的存储（`<数据目录>/artifacts/<id>/`，路径里带随机密钥）。新加一张表 `ui_pages` 记录版本：页面 id、运行、会话、空间、用户、标题，以及每个版本对应的产物 id。会话里显示最新版，可以切到旧版。提问引用的是某一个具体版本。
- **沙箱**：继承产物的做法。响应头带 `Content-Security-Policy: sandbox allow-scripts allow-forms`，不含 `allow-same-origin`，所以页面跑在不透明源里，读不到 omem 的 cookie，也调不了 `/api`。在此基础上再收紧：除了它自己的路径和宿主的 UI 套件，**不能连外网**（`default-src`、`connect-src`、`img-src` 只放行 `'self' data: blob:`）。页面里可能有 Agent 从空间里查到的材料，这样页面不会把内容带出去，原件里的注入文字也没有地方可发。
- **UI 套件**：`/ui-kit/<版本>/`，随 omem 一起发布。里面有：
  - `omem-ui.js`：桥。
  - `tokens.css`：浅色和深色 token、基础控件样式，取自 `web/src/styles.css`，页面不用自己配色。
  - 少量固定版本的库（第 11 节待定）。
- **桥**（只和外层页面用 postMessage 通信，外层只接受来自这个 iframe 的消息）：

  | 调用 | 作用 |
  | --- | --- |
  | `omem.ready()` / `omem.onTheme(fn)` | 告诉外层已加载；拿到浅色或深色主题，主题切换时收到通知 |
  | 自动 | 把内容高度告诉外层，外层调整 iframe 高度（内联显示时最高 640px，超过的出滚动条，可以展开全屏） |
  | `omem.submit(value, summary?)` | 提交结果。只有页面是某个提问的一部分时可用，`value` 按提问声明的 `value_schema` 校验（可选） |
  | `omem.draft(value)` | 保存还没提交的状态，关掉再打开不丢 |
  | `omem.open(link)` | 让外层打开 omem 内部的链接（`#/…`、`src:`、`mem:`），别的链接一律不放行 |

  和插件页不同，交互页没有调接口的能力。它是一次性的展示和选择，不是应用。需要长期存在、有自己数据的，做成插件页。
- **尺寸**：角色说明里要求页面在 390 宽度下不横向溢出、尽量做成单文件、使用 token。宿主不检查这些。

### 2.3 和插件内容块的关系

- 插件内容块里属于插件自己的类型（比如英语插件的 quiz，有自己的判分逻辑）保留，作为“插件扩展的组件”：插件注册类型、渲染和判分，存在 `plugin_blocks`。
- 宿主通用的 `plugin_form` 和 `plugin_chart` 改由组件块实现：前者等于带 `fields` 的 `ask_user`，后者等于 `show` 一个 `chart`。工具名先保留为别名，下一个版本再删。
- 渲染器只有一份：扩展 `packages/plugin-sdk/blocks.ts`，它本来就不依赖框架。网页外壳用一个 Vue 包装组件调用它，插件页直接用它。

## 3. 工具

继续放在现有的 `ask` 分组里（分组 id 不变，标签改成“问人与通知”，说明页 `skills/omem/references/owner.md` 改名为 `ask.md`）。分组里原来有 5 个工具，加上新的一共 7 个。主助手写的是 `group:ask`，自动就能用到新工具。

| 工具 | 作用 |
| --- | --- |
| `ask_user`（原 `ask_owner`） | `question`、`options`、`allow_text`、`wait_seconds` 不变。新增：`fields`（输入组件，多个问题一次问完）、`view`（一起显示的展示组件块，或交互页的 `page_id`）、`value_schema`（交互页提交值的结构，可选）。回答是文字摘要加上结构化的 `value` |
| `wait_answer` | 不变，返回的内容和 `ask_user` 一样 |
| `show` | 把组件块或交互页放在这一轮回复的下面，只展示。一轮可以调用多次 |
| `ui_page` | 新建交互页或给它出新版本，返回 `page_id` 和版本号。不会自动显示，要用 `show` 或 `ask_user` 引用 |
| `suggest_next`、`notify`、`stay_quiet` | 不变 |

**改名。** 把 `ask_owner` 直接改成 `ask_user`，不保留旧名。宿主文字里的“本人”仍然指这次运行服务的用户，这个定义不变。要一起改的有：显式列出这个工具的角色（`roles/coder.md`）、`src/agents/code.ts` 里的编码说明、`_common.md`、`skills/omem/references/` 和文档。

**问别的人**（第 5 阶段）：`ask_user` 加一个可选参数 `to`，取值是 omem 的用户 id。只能问对这个会话所在空间有读权限的人。问题只显示给那个人，回答回到发起提问的会话。规则里的“执行前让负责人批准”也可以走这里。访客模式仍然没有提问工具。

**角色说明**（写在 `_common.md`，只给带 `ask_user` / `show` 的运行，用 `<!-- tools: … -->` 标注）：

- 要问的事超过一件，用 `fields` 一次问完；一句话能问清的，直接在回复里问。
- 有几种方案、界面或交互要人选，并且试一下比读描述更容易判断时，做一个交互页，配上 `pick` 让人选。页面要小，只放这次要比较的部分，用 token，不要做成装饰。
- 数据和对比用 `table`、`chart`、`compare`，数据必须来自工具查到的记录。
- 交出块以后，回复里不要再把内容写一遍。

**编码这边：**

- 编码 Agent 提问用的也是 `ask_user`，所以 `fields` 和 `view` 它都能用。界面类的改动可以直接拿工作区里的原型文件交成交互页（`ui_page` 的 `path`）。
- 宿主自己的决定卡片改用组件块生成，不再是纯 Markdown：
  - 评审计划：逐项勾选（`checklist`）。
  - 评审问题“待修改”：`diff` 加上“修 / 不修 / 改成…”。
  - 修改项提问：问题加上相关产物。

## 4. 在哪里显示

| 位置 | 组件块 | 交互页 |
| --- | --- | --- |
| 网页问答（`views/Ask.vue`）、首页对话 | 在消息下面内联显示；提问在 `AskCard` 里 | 内联 iframe，可展开全屏 |
| 编码交办视图（`CodeWork`）：待你确认、待修改、编码前检查 | 内联显示 | 内联显示 |
| 插件页 | 同一个渲染器 | 同上 |
| 飞书 | 能映射的组件在卡片里直接画，其余给链接（第 5 节） | 给链接 |
| 通知、`RemoteChat` | 给链接 | 给链接 |

同一个提问在网页、卡片、侧边栏任意一处回答后，其他地方都变成“已回答”的记录（现有行为）。

## 5. 飞书

### 5.1 卡片里直接画

飞书卡片 2.0 的表单容器支持单行和多行输入、下拉单选、下拉多选、选人、日期、日期时间和勾选器，卡片里还有表格、图表和图片组件。可以映射的组件直接画进同一个 `form`，提交走现有的卡片回调（`lark-actions.ts`，3 秒内答复，慢的先回“已收到”）。

| 组件 | 卡片元素 |
| --- | --- |
| `text` / `textarea` / `number` | `input`（多行、数字校验由宿主在回调里做） |
| `choice` / `multi` | 选项少且短时用按钮，否则用 `select_static` / `multi_select_static` |
| `scale` | `select_static`（1–5） |
| `date` / `datetime` | `date_picker` / `picker_datetime` |
| `toggle` | `checker` |
| `person` | `select_person`（飞书联系人，回调里映射成 omem 用户） |
| `markdown` / `table` / `chart` / `metric` | `markdown` / `table` / `chart` / `markdown` |
| `artifact` 里的图片 | `img`（上传到飞书） |

元素名称和限制（卡片大小约 30 KB、表格行数、图表配置）实现前按飞书卡片 2.0 文档逐项核对。

卡片画不了的（交互页、`rank`、可编辑的表格、条目很多的 `checklist`，或者超出卡片限制）不在卡片里另做摘要或截图，只给一个按钮：“打开填写”或“打开交互页”。链接开了飞书网页应用（5.3）时用 AppLink，否则是普通网页链接；没设网页地址、没有链接可给时，才把要填的字段写成文字，让人直接回复。

### 5.2 卡片放不下的交给网页

- 配置了飞书网页应用（5.3）时，按钮用 AppLink 打开：桌面端在侧边栏，手机上全屏。卡片按钮用 `multi_url` 给桌面和手机不同的链接。
- 没配置时，链接到 `webUrl` 上的普通页面，在飞书内置浏览器里走现有的飞书登录。

### 5.3 飞书网页应用入口

- **单独的入口**：`/lark/`，Vite 另建一个入口 `web/lark.html`。只有这个入口加载飞书 JSSDK，主站不加载。路由只有三个：
  - `/lark/ask/<id>`：一个提问（组件块、交互页、批准）。
  - `/lark/page/<id>`：只看一个交互页。
  - `/lark/run/<id>`：运行进度和编码交办的待确认项。

  页面复用 `web/src` 的组件，不另写一套前端。
- **免登**：在飞书里打开时调用 `tt.requestAccess`（appID 是 `lark.appId`，不申请额外权限）拿到 code，发给 `POST /api/auth/lark/h5`。服务端用现有 `larkProvider` 的 v2 token 接口换出身份，走同一套身份映射（`identities`），然后发会话 cookie，结果和在网页上用飞书登录一样。
  - 没开多人登录时，`/lark/` 只认 `ownerOpenId`。
  - 不在飞书里打开（没有 JSSDK 环境）时，退回普通登录。
  - cookie 在飞书 webview 里能不能保持（SameSite、第三方 cookie）要在真机上验证。保持不了，就改成短期 token 存在 sessionStorage。
- **权限**：免登只换出身份，权限照常按用户算（`scopeFor` / `accessibleSpaces`）。`/lark/` 不放宽任何接口。
- **AppLink**：形如 `https://applink.feishu.cn/client/web_app/open?appId=<lark.appId>&…`。侧边栏的打开方式和路径参数叫什么，**还没核实**，实现时按飞书文档并在真机上确认。
- **多个机器人**（`lark.bots`）：网页应用都用主应用；其他机器人发的卡片也链接到主应用。
- **前提**：设置 → 渠道 里给出检查和操作指引。
  - 机器人应用开启“网页应用”能力。
  - 桌面端和移动端主页填 `<webUrl>/lark/`。
  - H5 可信域名包含 `webUrl` 的域名。
  - 发版。
  - 用户的设备能访问 `webUrl`。
- **待验证**：`webUrl` 是内网 http 地址（IP 加端口）时，网页应用的主页和可信域名接不接受，JSSDK 鉴权是否要求 https。如果不接受，就需要一个域名（内网 DNS 或反向代理）。这是部署问题，不进代码。

## 6. 回流

- **提交**：提问变成已回答，记下 `answer`（文字摘要）、`value`（JSON），如果引用了交互页，再记下页面的版本。交给 Agent 的消息是“【回答】问题 / - 字段：值 …”，后面附上 `value`（超长截断）。`wait_answer` 返回同样的内容。
- **校验**：宿主按 schema 检查必填、选项和范围；交互页的 `value` 按 `value_schema` 检查。不合格的退回页面并显示原因，提问保持可以继续填写。
- **草稿**：还没提交的输入存在提问的 `draft` 字段里，网页和飞书侧边栏之间共享。
- **只展示的块**：存在这一轮回复的 `messages.meta.ui` 里，没有回流。

## 7. 数据

- `asks` 加三列：`ui`（`fields`、`view`、`value_schema`）、`value`、`draft`。
- 新表 `ui_pages`：页面和版本，文件存在运行产物里（设备本地，和产物一样不随 pull 搬）。
- `messages.meta.ui`：`show` 交出的块，内容是组件块 JSON，或者交互页的 id 加版本。
- `plugin_blocks` 只保留插件自己定义的类型。

## 8. 安全

- 组件块由宿主渲染，文字一律走 Markdown 和 DOMPurify，不接受 HTML。
- 交互页：
  - 运行在不透明源里，不能连外网，读不到 cookie，调不了 `/api`。
  - 桥只接受来自自己那个 iframe 的消息。
  - `submit` 只对页面所属的那个提问有效。
  - `open` 只放行 omem 内部的路由。
- 页面里的文字可能来自原件，也可能带注入。但页面本身没有任何能力（不能调工具，不能发消息），最坏的情况是误导人，和 Markdown 回答的风险相同。
- 产物文件的密钥链接只用在 iframe 里，不出现在聊天、飞书卡片和通知里。对外给的都是 omem 路由的链接，打开时要登录或免登。
- 读权限：交互页和组件块跟着它所在的运行和会话的读权限走。

## 9. 分阶段

1. **组件块和提问**：`ask_owner` 改名为 `ask_user`，多字段提问，结构化回答，`show` 展示组件块。网页问答、编码交办视图和插件页用同一个渲染器。`plugin_form` / `plugin_chart` 去掉。宿主的评审计划和待修改问题改用组件块。

   2026-11-08 已做：`src/agents/ui-blocks.ts`（第 2.1 节除 `diff`、`artifact`、`page`、`person`、`space`、`source`、`rank`、`steps` 以外的组件）、`ask_user` 的 `fields` / `view` / `submit_label`、`asks.value`、`show` 与 `ui_views`、`#/ui/<id>` 页面、飞书卡片的字段说明和链接、插件会话的 `ask` / `view` 块、删掉 `plugin_form` / `plugin_chart`。和设计不同的地方：展示组件只有一个渲染器（`packages/plugin-sdk/blocks.ts`），表单在 omem 网页上用 omem 自己的控件画（`web/src/components/UiFields.vue`，不用原生日期控件），插件页用 SDK 里的简单控件；带表单的提问在问答页跟在提出它的那条回复下面，不放在输入框上方。宿主的评审计划、待修改问题后来也改用了组件块（见下）。编码交办视图里编码 Agent 的提问照常是 `AskCard`，能带表单和交互页。

   2026-11-08 补做（`src/agents/review-chain.ts`）：评审计划确认（`askPlan`）的问题只留一句，评审档、轮数、评审项数是指标，评审项和各自的阻塞级别是表格，编码说明和理由是 Markdown；评审结束要你决定的卡片（`askDone`）把“默认要改的问题”从正文里前 5 条的编号列表改成全部问题的表格（级别、问题、位置，最多 50 行）。按钮和处理逻辑不变。修改项提问（`code-task`）没改：它在飞书里本来就有专门的排版，产物组件也还没做。
2. **飞书卡片**：能映射的组件直接画，不能映射的给网页链接。

   2026-11-08 已做（`src/channels/lark-asks.ts` 的 `cardFields` / `valueFromCard`，`src/channels/lark-ui.ts`）：带表单的提问在卡片的 `form` 里直接填，字段映射见 5.1 的表（`pick` 是下拉，方案的要点写在表单上方；`checklist` 每条一个下拉和一个备注框，超过 12 条退回网页；`show_if` 的字段在卡片里都显示，标明“X 是 Y 时填”，不标必填，宿主按条件丢掉不适用的）；提交先由宿主检查，错了弹出原因、卡片不关；卡片超过约 24 KB 退回字段说明加网页链接。日期选择器回来的是“2026-11-15 +0800”，日期时间是“2026-11-15 14:00 +0800”（按飞书文档），宿主转成 `2026-11-15` 和带时区的时间。展示组件里的表格和图表用卡片自己的 `table`、`chart`（VChart）元素，每种最多 5 个，其余写成文字；`show` 交出的内容在飞书里是回复之后的一张卡片，发失败时改发文字。没在真机上看过。

   2026-11-14：展示组件加了 `callout`（结论、风险的色块）、`metric` 的 `trend` / `good` / `note` / `spark` 和分组标题、`chart` 的 `area` / `hbar` / `stack` / `goal`；飞书卡片里指标、结论、方案对比也用卡片自己的元素画（不再是文字），网页上的图表和指标重画过。画法和卡片能力的边界见 [lark-cards.md](lark-cards.md)。
3. **交互页**：`ui_page`、收紧的 CSP、UI 套件、桥、版本；在问答和编码里内联显示。

   2026-11-08 已做（`src/agents/ui-pages.ts`、`web/src/components/UiPage.vue`）：`ui_page(title, html | path, page_id?)` 存进 `ui_pages`（每版一行，随设备同步），`page` 组件放进 `show` 或 `ask_user` 的 `view`。和 2.2 节不同的地方：页面只能是单个文件，不经运行产物的密钥路径，而是网页取到文档后放进 `srcdoc` 的 iframe（只有 `sandbox="allow-scripts"`），宿主在文档最前面放 `<meta>` 的安全策略（`default-src 'none'`，脚本和样式只能内联，图片字体只能 data:，`connect-src 'none'`）、基础样式和桥。这样页面连 omem 自己也连不上，经设备转发、飞书里打开都不用另配；代价是不能引用别的文件，UI 套件里的库也就没做（第 11 节第 2 项）。主题：网页把当前的 token 值发给页面，切换浅色深色时实时更新。提交：页面所在的提问没有 `fields` 时，`omem.submit` 的值存成 `asks.value`（最多 20000 字符），说明文字作为回答；草稿存 `asks.draft`。编码 Agent（`coder`）也有 `ui_page`，可以把工作区里的原型交成页面放进提问。飞书卡片里交互页是一行说明和“打开交互页”链接。本地开发实例里看过：页面在问答页的提问里显示、能全屏、切版本，开关能点，深色主题实时生效，页面里的 `fetch` 被拦，`omem.submit` 的选择回到会话。
4. **飞书网页应用**：`/lark/` 入口、免登、AppLink 打开侧边栏，设置里的检查。

   2026-11-08 已做：`web/lark/index.html`（Vite 的第二个入口，唯一加载飞书 JSSDK 1.5.48 的页面）和 `web/src/lark/`：先 `GET /api/auth/session`，没登录时在飞书里 `h5sdk.ready` 后 `tt.requestAccess({ appID, scopeList: [] })`（客户端太旧报 103 时退回 `tt.requestAuthCode`），把 code 交给 `POST /api/auth/lark/app`；服务端用 v2 token 接口换令牌（不带 `redirect_uri` 和 PKCE），按飞书登录同样的身份规则发会话；没开多人登录时只认 `ownerOpenId`。不在飞书里（UA 不含 Lark/Feishu）就跳到主站同一个地址，走普通登录。路由只有 `#/ui/<id>`，复用主站的 `UiItem.vue`。配置 `lark.webApp`（设置 → 渠道 里飞书机器人下面的开关，写明开发者后台要填的主页 `<webUrl>/lark/` 和 H5 可信域名）；打开后 `uiLink` 给 AppLink：`https://applink.feishu.cn/client/web_app/open?appId=…&mode=sidebar&lk_target_url=<编码后的 /lark/#/ui/<id>>`（参数按飞书文档“打开网页应用”核对过：`mode=sidebar` 在侧边栏打开，`lk_target_url` 需要飞书 5.12 以上）。没在飞书真机上验过：`requestAccess` 的 code 不带 `redirect_uri` 换令牌（文档没写明），会话 cookie 在飞书 webview 里能否保持，内网 http 地址能否作为主页和可信域名。
5. **补充**：`rank`、可编辑的表格、问别的用户（`to`）。

   2026-11-08 已做：字段 `rank`（回答是 id 的顺序，每条恰好一次）和 `table`（列 `text` / `number` / `choice`，预填的行可改可删可加，空行丢掉，最多 `max_rows`）；两者在飞书卡片里不画，卡片退回网页链接。`ask_user` 的 `to`：只在本人自己会话里 `kind = ask` 的一轮可用，对方要是有效的 omem 用户并能读会话所在空间（`accessibleSpaces`）；提问记 `context.askedBy` / `toName`，归对方（`userId`），只发给对方（通知 + 飞书私聊，卡片和网页写明“X 的助手替 ta 问你”），不进提问人的群；回答以提问人的身份回到原会话（“[回答] 小李回答了…”）。成员自己发起的对话里，普通的 `ask_user` 本来就问那个成员。曾经在发卡片前用 Playwright 给交互页截图放进卡片，后来去掉了：要服务器装浏览器，流程也绕；卡片画不了的一律只给链接（5.1）。

每个阶段按约定同步 README、architecture 状态表、acceptance、`.repo-review/wiki/reference/changes-since-2026-10-13.md`、`skills/omem/references/`；界面约定变了改 `.agents/skills/omem-design`。

## 10. 验证

- **单元测试**：
  - schema 校验和错误信息。
  - 卡片映射（假飞书客户端）、卡片提交回调。
  - 提交回流和草稿。
  - 桥的消息过滤、交互页的 CSP 头。
  - `/lark/` 免登（假 token 接口）。
- **假 ACP 端到端**：Agent 调 `ask_user(fields)`，网页提交，下一轮里 Agent 看到 `value`；`ui_page` 加 `pick` 的选择能回来。
- **真实 Agent**：
  - “设置页的通知开关怎么设计，给两个方案让我选”：看它会不会做出能试的页面，选的结果能不能回来。
  - 一个需要好几项信息的交办：看它是不是用一张表单问完。
- **界面**：1440 和 390 宽度截图，不能横向溢出；飞书真机分别看桌面端侧边栏和手机。

## 11. 待定

1. 交互页能不能联网。默认不能；要不要允许个别页面放行固定的 CDN。
2. UI 套件带哪些库：图表库、组件库，要不要带一个轻量框架（Preact 加 htm，或者 Vue 的运行时）。
3. 多字段提问是扩展 `ask_user`，还是另起一个工具。建议扩展，只保留一个入口。
4. 问别的用户（`to`）放在哪个阶段，权限除了空间读权限还要不要再收紧。
5. 网页应用用主机器人应用，还是单独建一个应用。建议用主应用，身份映射是现成的。
6. 内网 http 地址能不能作为网页应用的主页（真机验证）。另外第 4 阶段里 `requestAccess` 的 code 不带 `redirect_uri` 换令牌、飞书 webview 里的会话 cookie，都要真机确认。
~~7. 给卡片用的页面截图~~：不做，卡片画不了的只给链接。
