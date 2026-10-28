# 插件：带页面、档案和工具的一整套能力

有些场景要的不是一问一答，而是一组题、一张表、一块屏幕：出一批题、本人一次提交、AI 看结果再出下一批，过程里记下水平和薄弱点。机器人只适合一条一条地说，这类强交互放在网页里做，由插件提供。

插件把一个场景需要的东西打成一个包：Agent 档案、技能、工具、数据和独立页面。宿主负责加载、权限、存储和转发；理解和出题交给插件里的档案。第一个内置插件是英语学习（`plugins/english`）。

## 目录

```
plugins/<id>/
  plugin.yaml          清单
  agents/<名>.md        Agent 档案（格式同 library/_agents），对外名字是 <id>-<名>
  skills/<名>/SKILL.md  技能，首次启动播种到 library/_skills（已有的不覆盖）
  server.ts            服务端代码：工具、内容块、判分（只有内置插件可以带）
  web/                 页面源码；构建到 web/dist/plugins/<id>/
```

内置插件在仓库的 `plugins/`。本人自己的插件（包括接内部系统的）以后放数据目录 `plugins/<id>/`，不进仓库；第一期只加载内置插件。

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
page: { title: 英语练习 }                                # 有 web/ 时出现在导航
```

- 插件档案能用的工具 = 清单 `tools` + 插件自己注册的工具 + 通用插件工具（`plugin_query`、`plugin_put`）。档案 frontmatter 里写的 `tools` 只能在这个范围内选，超出的忽略并警告。
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

- `api.tool`：注册工具，名字必须以 `<id>_` 开头。`ctx` 里有本次运行的用户、空间、运行 id 和限定在本插件、本用户的存储 `ctx.store`。
- `api.block`：注册一种内容块，宿主自动生成同名工具 `<id>_<kind>` 让 Agent 交出这种块（见下）。
- 构建时 `server.ts` 随 `tsc` 编译到 `dist/plugins/<id>/server.js`，类型只从 `src/plugins/types.ts` 引入。

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
- 页面显示会话的消息和块，按时间排；Agent 的文字是 Markdown。

## 存储

表 `plugin_records`：`(plugin, user_id, collection, key)` 唯一，`data` 是 JSON，带 `space_id`、创建和更新时间，参与多设备合并。插件的服务端代码用 `ctx.store`，Agent 用 `plugin_query` / `plugin_put`（只能读写本次运行所属插件的数据）。不需要为插件写迁移。

表 `plugin_blocks`：内容块（含答案）、提交的答案、判分结果、状态（open / submitted）。

逐题的作答、统计这类数据放插件存储，不写进记忆；偏好（“想多练听力”“喜欢商务场景”）由档案写成专属记忆。

## 页面

插件页面放在 `#/plugin/<id>`，外壳用 iframe 载入 `/plugins/<id>/`：

- iframe 带 `sandbox="allow-scripts allow-forms allow-popups"`、不给同源，页面拿不到本人的 Cookie、令牌和 localStorage，也不能直接调 `/api`。
- 页面经 `plugins/sdk/client.ts`（postMessage）请求外壳，外壳只转发到 `/api/plugins/<id>/…`，其他路径拒绝。
- 外壳把主题 token（`--bg`、`--ink`、`--accent`……）和深浅色发给页面，主题切换时再发一次；页面字体、颜色与主站一致。
- 外壳把服务端事件里和本插件有关的（`plugin`、`run`）转给页面，页面据此刷新。
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
| `POST /api/plugins/:id/call/:tool` | 页面调用插件自己的工具（以本人身份，限本插件的工具） |

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

## 分期

1. **第一期（本次）**：清单与加载、插件档案进 Agent 列表、插件存储、内容块协议、插件页 iframe 与 SDK、英语插件（四种题型、宿主判分、Agent 评翻译、画像与学习曲线）。
2. **第二期**：宿主通用块（`form`、`markdown`、`chart`），没写前端的插件也能交互；内容块在问答页和运行详情里显示；飞书里退化成带“打开练习页”的卡片；题库预取（Agent 在后台补题，宿主按画像选题，减少等待）；插件设置页；“每日练习”规则模板；服务端语音合成。
3. **第三期**：数据目录里的插件与信任确认；`services`（插件的常驻进程，宿主按需启停）与 `streams`（宿主鉴权后转发 WebSocket，照 `ide-web.ts`），用于远程看屏幕、一起操作这类插件；危险操作走 `approvals.tools`。
