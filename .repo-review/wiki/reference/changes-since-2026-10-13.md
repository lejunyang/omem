---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，按模块列出入口文件；读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-14
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。

## 轻量命令行 @omem-ai/cli（11-13）

- 新包 `packages/cli`（npm `@omem-ai/cli`，命令也是 `omem`）：只有连远程 omem 的 `login`、`open`、`remote` 和远程的 `tool` / `mcp`，Vite 打成一个无依赖的文件，给只用别人 omem 的人装，不带服务端的依赖。
- npm 包统一放到 `@omem-ai` 下（11-13）：应用 `omem-assistant` → `@omem-ai/app`，SDK `omem-plugin-sdk` → `@omem-ai/plugin-sdk`（`web/vite-plugin-pages.ts` 的别名、`web/tsconfig.json` 的 paths 一起改），三个包都从 0.0.1 起；`omem-cli` 因和别的包名太像发不出去，用 `@omem-ai/cli`。`scripts/upgrade.ts` 会先卸掉旧名字 `omem-assistant` 的全局链接。
- `remote`、`login`、`open` 三组命令和 `clientInfo` 从 `cli-main.ts` 移到 `src/remote-commands.ts`，两个命令行共用；`omemHome()` 移到 `src/core/home.ts`（`config.ts` 照旧导出）。`scripts/publish-npm.ts` 和 `publish.yml` 多发这个包。回归：`test/omem-cli.test.ts`。

## Chrome 扩展连接 omem：多连接与把拾取发给 omem（11-10）

- 扩展存多条连接（本机、远程地址、经已登录连接转发的配对设备，`chrome/src/shared/connections.ts`），用 `omem login` 同一套确认页换 `om_` 令牌；浏览器 cookie 只用来提示「已登录为 X」，写请求不靠它（omem 对带 cookie 的写请求要求同源）。
- 新接口 `POST /api/clips`（`src/sources/clips.ts`，路由权限是目标空间的 `source.write`）：截图校验后存成图片原件，正文里的 `{{image:key}}` 换成 `omem-file:` 和 `src:`；`mode: ask` 走问答入口，`mode: source` 存成笔记并排进整理。确认页 `CliLogin.vue` 的文案不再只说命令行。
- 拾取时多记元素上下文（`chrome/src/shared/element-context.ts`：CSS 路径、属性、文字、精简 HTML、子元素概况、所在标题，各项有上限）和页面上下文。回归：`test/clips.test.ts`、`chrome/src/shared/omem-send.test.ts`，e2e `chrome/e2e/omem-send.e2e.test.ts`（起真实 omem）。

## Chrome 扩展并入仓库：默认不连 CDP 与拾取（11-10）

- 原来独立的 DevTools 扩展并入 workspace（`chrome/`，包 `omem-chrome`），界面换成 omem 的配色。约定在 `chrome/AGENTS.md`，设计在 `chrome/docs/changes/no-cdp-and-pick/design.md`。
- 默认不连 `chrome.debugger`：面板一打开就连、且只在标签页关闭时才断，是 Chrome 顶部一直显示调试提示条的原因。现在 `attachDebugger` 只在「CDP 增强」开启时放行；不开时 Mock 和调用栈由页面钩子（`src/inject/page-hook.ts`）改写 fetch / XHR，资源搜索由面板读 `inspectedWindow.getResources()` 送给后台，模拟器用 DNR 会话规则，禁用缓存、限速、原页面模拟置灰。
- 「拾取」：`src/inject/pick-overlay.ts` 在页面上选元素、量间距、框区域、整页逐屏拼接，`src/background/pick-service.ts` 截图裁剪后存 IndexedDB；侧栏 `src/sidepanel/` 是拾取篮（引用记录、导出 Markdown）。回归：`chrome/src/shared/pick.test.ts`、`no-cdp.test.ts`，e2e `chrome/e2e/pick-and-hook.e2e.test.ts`。

## 规则批次与 Codex 审批子会话清理（11-08）

- 规则 Agent 的会话原来一律保留，批次结束和重启后换会话都可能积压。`session-cleanup.ts` 按排队续轮与有效的话题跟进判断是否还需要，完成、失败、取消且不再被引用的归档；`jobs.ts` 在换成新会话后退役旧的。会议、多 Agent 工作、聊天及编码续轮保持保留。
- Codex 的 guardian 自动审批会话没有经 ACP 报出 ID，归档父会话也不会连带归档它。`catalog.ts` 为后端声明 `sessionHistory` 格式和目录；`session-children.ts` 只读 rollout 首条元数据，按 omem 来源、guardian 类型和已登记父会话精确识别，再通过 ACP 归档。普通工作子 Agent 和其他聊天不纳入，`CODEX_HOME` 覆盖默认目录。
- 每轮结束处理子会话，失败单独持久登记；定时清理也检查已结束的保留会话，补宿主中断的遗漏。活跃的在线会话和其他存活进程拥有的会话不被后台检查打断。回归：`test/session-children.test.ts`、`test/session-cleanup.test.ts`、`test/rule-merge.test.ts`。

## 设置 → AI 与 API key（11-07）

- 设置页的“Agent”改名“AI”，分通用 / 语音 / 决策 / 图片生成 / API key 五个子页（`?tab=agents&section=keys` 可直达）。通用就是原来的内容。
- `config.ai.providers` 登记 API key 的提供方（openai、anthropic、typesafe、openrouter、openai-compatible），key 在 `secrets/ai-keys.json`（`src/core/ai-keys.ts`）。OpenAI / Anthropic 的提供方可生成 `codex@<编号>` 等后端（`config.ts` 的 `keyedProfiles`），启动时由 `keyEnv` 注入 key，额度单独计。
- 语音、决策、图片三类模型的设置与可用状态（`categoryStatus`），功能本身分阶段做，设计在 docs/v2/ai-models.md。
- 图片生成（`src/core/images.ts`）：工具 `generate_image`（新分组 `media`，只在图片模型可用时给出），图片存进 `files/`；技能 frontmatter 加 `requires`（`skillUsable`），内置技能 `image-generation`。
- 语音（`src/core/voice.ts`、`web/src/lib/voice.ts`）：Realtime 发临时凭证、GPT-Live 由 omem 代开会话，工具经 `/api/voice/tool` 只读执行；问答页麦克风与语音对话；口语练习页 `/speaking`，`speaking-review` 运行由新角色 `speaking-coach` 按技能 `speaking-assessment` 评价；迁移加 `voice_sessions`。
- 决策模型接入（`src/core/decision.ts`）：OpenAI Decisions 与 System One（Jev、本机 StartLux）两种格式；规则加 `judgeWith`（迁移加 `rules.judge_with`），模型判断和 `check` 动作默认决策模型优先；访客把关先问决策模型（`lark-guest.ts` 的 `decisionGate`）；设置页“试一下”（`POST /api/ai/decision/test`）。

## 访客开放空间按名称多选（11-06）

- 设置 → 渠道 → 访客提问的空间 ID 输入框改成 `UiSelect` 多选，显示空间名称和 ID，保存仍用 `lark.guests.spaces`。旧的失效 ID 保留为可取消的选项，不因修改范围丢失；私聊说明直接指向“开放给访客的空间”，明确未选择时没有知识库资料可查。保存期间选项暂停操作，防止连续请求丢失选择。入口：`web/src/views/Settings.vue`、`web/src/components/UiSelect.vue`；验证：`pnpm run check`（英文 Git、屏蔽本机可选文档解析器，915 项测试）、1440 / 390 浏览器交互与输入法回归。

## 交办轮次查询走索引（11-05）

- 编码循环找交办各轮的查询（`id = ? or json_extract(input, '$.continueFrom') = ?`，`lastRound`、`advanceWork`、`rounds`、`workRoundIds`、`reconcileWaiting` 等约 26 处）和按 `parent_id` 找链下运行原来都是全表扫描，常驻服务器上每次 6–14 ms，一步要查十几次。迁移加 `runs_continue_from`（表达式索引）和 `runs_parent`，查询写法不用改。合成库 1.1 万条运行：`lastRound` 34.5 → 0.048 ms，`codeChainRounds` 165.7 → 0.187 ms。入口：`src/core/db.ts`；验证：`test/runs-index.test.ts`、`scripts/bench-scale.ts --code-rounds`。

## 启动清理临时索引（11-05）

- 失效工作区逐份清理临时原件时，符号删除和采集位置的级联删除缺索引，积压较多时启动迟迟不能监听。数据库迁移补齐 `symbols(source_id)` 与 `source_locations(source_id)`；旧库迁移、查询计划和其他原件保留有回归。合成库 2 万原件、10 万符号清理 300 份：9044.1 → 372.9 ms。入口：`src/core/db.ts`；验证：`test/source-purge-index.test.ts`、`scripts/bench-scale.ts --source-purge`。

## 网页接入 Git 仓库（11-05）

- 设置 → 空间新建“代码仓库”时，同一输入框自动识别本地目录与 HTTP(S)/SSH Git 地址。`POST /api/spaces` 复用 `cloneRepository`，成功后建空间并排同步；权限检查在联网前执行，非法协议与含凭据链接拒绝，克隆失败不创建空间。网页等待期间防止重复提交，失败保留表单。入口：`src/server/http.ts`、`web/src/views/Settings.vue`；回归：`test/http-space-repository.test.ts`。

## 规则启用确认与飞书回调登记（11-04）

- `save_rule` 为会话中的停用规则准备宿主确认卡片，回答送达后再展示；点击先校验规则快照、本人身份和空间，再在事务中启用规则并保存回答，不排 AI 续轮。修改后旧卡片失效，不另生成普通的建议按钮。`confirmation.ts`、`agents/asks.ts`。
- 飞书卡片发送前保存交互记录，按钮携带交互标识；发送接口尚未返回时的点击也能在校验机器人、会话和操作者后绑定消息。建议卡片等待回答投递，不再依赖四秒定时器抢发。`lark-asks.ts`、`lark-actions.ts`、`lark-bot.ts`、`lark-send.ts`。
- 规则变更发出实时事件，网页更新列表和未编辑的详情，不覆盖正在修改的表单。`rules/store.ts`、`Rules.vue`。回归：`test/rule-confirmation.test.ts`，真实 Codex 在隔离库验证保存与启用。

## 飞书选项卡片布局（11-04）

- `src/channels/lark-asks.ts` 按选项文字长度排版：两个短选项保持并排，更多短选项每行最多两个，长选项独立成行，用可换行的文字展示完整内容，旁边保留简短的“选择”（下一步建议为“继续”）按钮。“用文字回答”放在输入框后，不挤入选项行。选项编号、表单附言和回调动作保持对应；`test/asks.test.ts` 覆盖长短混排、六个长选项、文字回答和批准/拒绝。

## ID 优先搜索（11-04）

- 全局搜索和运行页直接识别裸 id，先按索引查精确命中并显示，加载状态持续到其余文本或向量搜索结束；运行页沿用筛选，追加时去重，分页偏移按文本结果计算。新查询立即使旧响应失效。入口：`src/core/id-query.ts`、`src/agents/runs.ts`、`src/server/http.ts`、`CommandPalette.vue`、`Runs.vue`；浏览器回归：`scripts/check-id-search.ts`，规模对比：`scripts/bench-scale.ts --runs`。

## 飞书回答尾注（11-04）

- 回答底部的“运行”改成 `id`，后面直接列出本次运行记录中的后端、模型、思考强度（如 `id r… · codex · gpt-6.1-sol · low`）；兜底后读取更新的 AI，未指定模型或强度标“默认模型”或“默认强度”，无 AI 记录只显示 id。普通回答、进度卡片、访客和后续投递共用，整行粘到 `Ctrl K` 仍能打开运行。入口：`src/channels/lark-bot.ts`、`lark-progress.ts`、`src/core/lookup.ts`。

## 网页组合输入保护（11-04）

- `web/src/lib/composition.ts` 统一隔离输入法组合期间的键盘事件，并取消确认回车引起的隐式表单提交；主站和英语插件的 Vue 入口共用。原生 input / textarea、父级键盘处理、Teleport 弹窗与下拉筛选、全局快捷键都受保护，保留输入法选词的默认行为。`scripts/check-composition.ts` 用真实 Vue 控件和浏览器回归，操作系统输入法另需手动验收。

## 中断的 Git 操作续轮（11-03）

- `code-sync.ts` 在 merge / rebase 之外识别 cherry-pick / revert 及其 sequencer；`placeOnBranch` 保留现场，`syncWorktree` 先解决并继续未完成的操作再暂存与同步，`code.ts` 让失败重试和无需拉取的续轮也进入恢复。多提交序列和空提交不再卡住，冲突仍未解决时保留现场。`test/code-sync.test.ts` 覆盖工作区入口、后续提交、空提交、revert 和 ACP 端到端恢复。

## 飞书文档编辑审批（11-03）

- `lark_doc_update` 首次用 `approval_docs` 列出本次所有待改文档、`summary` 说明整体改动；宿主核对文档实际对象后记在审批上下文，按本人和文档实际对象复用追加、局部替换和失败重试的批准，跨轮次、会话及旧版批准记录均兼容；最近的拒绝仍拦截；新文档、整篇覆盖、移动和新建不借用局部编辑授权。`lark-doc-approval.ts` 管范围匹配和去标签预览，`test/lark-wiki.test.ts` 覆盖拒绝、重复待批、失败重试与续轮边界。卡片不再直接显示 XML 标签；新建文档也可传摘要。

## 需求切换性能（11-03）

- `src/items/work.ts` 批量读取交办轮次和评审状态，只取列表摘要，避免逐轮解析完整补丁和检查输出。`Requirements.vue` 在普通需求切换时立即显示新标题和加载骨架；同一编码内切换需求点保留面板。`test/req-work-summary.test.ts` 覆盖大结果、查询数量、旧工作区字段和跨轮应用状态；`scripts/bench-scale.ts --requirements` 提供可复现的规模基准。

## 对话投递、引用与编码接续（11-03）

- `roles/_common.md` 与原件工具说明明确：工作文件、确认表内的代码锚点优先引用库内原件并核对版本、行号；不能从 Git remote、提交号或其他平台的路径规则猜造代码网页地址。

- 确认卡片和建议触发的后续回答回到原渠道；卡片回答与普通消息合并时只投递一次（`agents/inbox.ts`、`jobs.ts`、`channels/common.ts`）。
- 文档引用按完整 Markdown 块高亮，表格、列表与代码块不会从引用行被切断（`web/src/lib/cited-document.ts`、`CitationDrawer.vue`）。
- 连续三次验证失败、裁决未交付先交给发起助手；`settle_code_task` 的 retry 可附 `existing_authorization` 说明原需求或已有授权，后台接续也能恢复，新的业务决定仍问本人。编码确认卡片先显示问题和按钮，完整技术记录默认折叠（`code-tasks.ts`、`code-loop.ts`、`tools.ts`、`channels/lark-asks.ts`）。

## 调度与 Web 服务

- **拉取命令归入设备**（10-27）：数据拉取统一用 `omem peer pull <设备或 SSH 主机>`，保留 `--remote-home`、`--overwrite` 和 `--dry-run`；移除旧的顶层 `omem pull` 入口。`scripts/relay.mjs` 的白名单与长任务超时识别一起调整；下文历史记录里的旧命令均指这项功能。
- **完整手动拉取**（10-27）：`src/core/pull.ts` 与新增的 `pull-transfer.ts`、`pull-snapshot.ts`、`pull-data.ts`、`pull-repos.ts`。SSH / HTTP 共用快照，传整个附件目录、仓库历史与非忽略工作文件、已检出子模块和编码工作区 / 补丁；业务表补上评审、问题、标注、归档、规则、学习和质量记录等，辅助表增加跨设备标识，自增编号重分配并保持关联。聊天追加合并并换算引用和行号；已有本地仓库保留改动与分叉，远端另存副本。新导入的任务规则、定时任务停用，远端排队运行取消，本机活跃任务保留。覆盖备份数据和托管仓库，恢复失败回滚。替代下文 10-16 的辅助表不参与合并及旧 worktree 不拉取的行为。
- **整理合并与队列隔离**（10-25）：`src/agents/jobs.ts` 将同空间、同要求的待整理材料去重合并，等待 30 秒、每批最多 40 份，同空间串行，保留聊天最早待整理行号。`src/agents/runs.ts` 先筛选有空位的任务类别，避免前 100 条后台积压挡住后续对话。空间自动整理开关不启动回溯；显式请求的历史回溯完成后，旧聊天也会作为新入库材料参与整理。
- **gzip**（10-25）：`src/server/http.ts` 按客户端支持压缩网页静态资源和超过 1 KB 的 JSON 等文本响应，实时事件保持流式发送。

## 插件

- **插件系统与英语练习**（10-28）：设计在 `docs/v2/plugins.md`。`src/plugins/registry.ts` 加载 `plugins/<id>/plugin.yaml`，插件档案经 `specs.ts` 的 `setPluginSpecSource` 出现在档案列表（本人改过的存 `library/_agents`，带 `plugin` 字段），技能播种到 `library/_skills`，工具与内容块由 `server.ts` 的 `register(api)` 注册（名字带 `<id>_` 前缀）。表 `plugin_records`（插件记录，`plugin_query` / `plugin_put`）和 `plugin_blocks`（内容块，答案只在服务端）。`src/plugins/blocks.ts`：内容块工具只能在 `plugin:<id>` 会话里用，提交后宿主判分、结果作为带 `meta.submission` 的消息进入会话（`inbox.ts` 的 `Inbound.meta`）。接口在 `src/plugins/http.ts`（`/api/plugins/*`、`/plugins/<id>/` 静态页）。网页 `web/src/views/Plugin.vue` 用无同源权限的 iframe 载入插件页，经 `plugins/sdk/client.ts` 的 postMessage 只转发本插件的接口。内置 `plugins/english`：`english_quiz`（选择、填空、听写、翻译）、`english_grade`、`english_snapshot`，学习者画像在 `learner.ts`（类 Elo 技能分、知识点、薄弱和该复习的点）。插件页面由 `scripts/build-plugins.ts` 构建到 `web/dist/plugins/<id>/`。

- **插件第三期**（10-28）：`src/plugins/trust.ts`（数据目录插件的代码哈希与信任记录，`secrets/plugin-trust.json`）、`registry.ts` 的 `trustPlugin` / `untrustPlugin` / `loadCode` / `codeRuns`（信任前不 import 代码，撤销时 `tools.ts` 的 `unregisterTools`）、`api.z`、`api.service()`、插件工具的 `approval`（`tools.ts` 的 `alwaysApprove`，走 `held`）。`src/plugins/services.ts`：服务的启动、令牌、空闲停止、遗留进程清理与输出；`http.ts` 的 `attachPluginStreams`（`/api/plugins/:id/streams/:name` 的 WebSocket 转发，本人鉴权）与 trust、services 接口、`/plugins/_sdk/omem.js`。`src/core/procs.ts` 收拢了 `freePort`、`reachable`、`killPid`、`commandLine`（`ide-web.ts` 改用它）。`plugins/sdk/service.mjs`（服务端帮助模块）、SDK 的 `stream()` 与外壳 `Plugin.vue` 的中继；设置页“插件”（`web/src/components/PluginsSettings.vue`）。
- **插件页面复用 omem 样式**（10-29）：英语练习页引入 `web/src/styles.css` 和 `UiSegmented`、`Skeleton`，删掉自己那套 token 和按钮样式（主按钮原来是蓝色）；`plugins/sdk/blocks.ts` 的表单和图表改用 `.card` / `.btn` / `.input` / `.textarea`；构建时把 `styles.css` 复制成 `/plugins/_sdk/omem.css` 给普通 HTML 页面用。
- **插件图标、SDK 包、开发热更新、pnpm workspace**（10-30）：清单 `icon` 可写图标名（`web/src/lib/icons.ts`，新增 languages、notebook、gauge 等）或页面目录里的 `.svg`，本人在设置 → 插件里换（配置 `plugins.icons`，`PUT /api/plugins/:id/icon`，`registry.ts` 的 `pluginIcon` / `setPluginIcon`）；英语学习改用 languages。SDK 从 `plugins/sdk` 移到 `packages/plugin-sdk`（`@omem/plugin-sdk`，Vite 别名与 tsconfig paths）。开发时 `web/vite-plugin-pages.ts` 让网页的 Vite 开发服务器从源码提供内置插件页面和 `/plugins/_sdk/*`，带热更新（`OMEM_DEV_PAGES` 让 API 认为页面可用），`build-plugins.ts` 去掉 `--watch`。仓库成为 pnpm workspace（根、`packages/*`、`vscode`、`site`，一份锁文件）；`upgrade.ts`、osdk 的依赖安装只装应用（`--filter omem`），文档站 CI 用 `--filter omem-docs`。
- **npm 发布**（10-30）：根包改名 `omem-assistant`（接着 npm 上的 0.0.1），SDK 改名 `omem-plugin-sdk`（`@omem` scope 是别人的）并能构建发布（`packages/plugin-sdk` 的 vite + tsc，`dist/` 与类型）；`.github/workflows/publish.yml` 在推到 main 的提交信息带 `[publish]` 时运行 `scripts/publish-npm.ts`，只发版本号没发过的包。根包 `files` 的 `plugins/*/agents`、`skills` 改成 `/**`（原来打不进包）。`upgrade.ts` 在旧名字 `omem` 的全局链接还在时先移除再链接。
- **插件第二期**（10-28）：清单 `settings` 与 `src/plugins/settings.ts`（值存插件记录的保留集合 `_settings`，`/api/plugins/:id/settings`，外壳 `web/src/components/PluginSettings.vue`，页面经 SDK `openSettings()` 打开）。宿主通用块 `src/plugins/generic.ts`（`plugin_form` 检查必填、`plugin_chart` 只展示，状态 `shown`），渲染在 `plugins/sdk/blocks.ts`，没有自己页面的插件用 `web/src/components/PluginDefault.vue`。`loadPlugins` 也读 `<数据目录>/plugins`（`source: "data"`，不加载 `server.ts`，`web/` 直接当构建产物）。`blocks.ts` 改成按 `PluginEnv` 工作：`presentBlock` 共用，`ctx.present()` 不经 Agent 放块；不在插件会话里交出的块新开会话并返回 `sessionLink`。英语插件的题库：`english_bank_add`、`english_next`（页面工具），`learner.ts` 的 `pickFromBank`，提交消息按出题方式提示陪练补题。`config.webUrl` 与 `src/core/util.ts` 的 `webLink`，`channels/item-notification.ts` 的通知卡片链接也用它。

## 记忆

- **写入检查、复核、对比运行**（10-18）：`src/memory/quality.ts`、`roles/memory-reviewer.md`、`jobs.ts` 的 `memory-review` / `ingest-shadow`，网页“记忆 → 质量”，`omem memories stats|check|prune|rejections`。详见 [记忆与事项](../concepts/memory-and-items.md) 的“记忆质量”一节。
- **记忆记录写入来源**（10-17）：`memories.agent_profile / model / effort / run_id`，由工具令牌带入。10-18 修正了兜底重试时令牌记录的仍是主模型的问题（`runner.ts` 的 `runRole`、`sessions.ts` 的兜底分支）。
- **档案专属记忆与标签**（10-18）：`memories.agent`、`memories.tags`；`recall` 可按 `tag` 筛，档案只看到共享的和自己的。
- **事项自动收尾**（10-25）：状态 `expired`（`src/items/store.ts` 的 `CLOSED_STATUSES`，有新依据或备注时重新打开）；`src/items/expiry.ts`（按类型期限、积压、保留、推断候选、清点）；`config.items`；`notify-gate.ts` 新增 `ownerFollowUp` / `ownerReactions`；新工具 `settle_items` 与角色 `roles/item-keeper.md`（运行 `item-settle`）；定时任务 `item-sweep`（每小时）、`item-digest`（每天 09:30，飞书卡片按钮 `item:keep|reopen:<id>`，`lark-actions.ts`）；表 `item_checks`；接口 `/api/items-expiry*`、`/api/items/:id/keep`；事项页积压预览与期限显示，设置 → 定时任务 的期限设置。
- **记忆目录**（10-25）：`memories.folder` 与 `memory_folders`（目录说明），`src/memory/folders.ts`（规范化、检查、移动、改名合并、删除上移、给 Agent 的目录树文本）；`remember` / `supersede` 的 `folder`、`recall(folder=…)`、新工具 `list_memory_folders`、`organize_memories`；`jobs.ts` 的 `memory-organize` 与新角色 `roles/memory-organizer.md`（定时任务“整理记忆目录”）；`/api/memory-folders*`；网页 `MemoryFolderTree.vue`。`omem pull` 合并 `memory_folders`。
- **写法要求**：`roles/_common.md` 的“怎么写记忆”重写，ingest 先按“和本人有关、以后能直接用、确定”三问筛。

- **相关空间**（10-18）：`space_relations` 表与 `relatedSpaces` / `relateSpaces` / `unrelateSpaces`（`src/core/spaces.ts`）。限定在一个空间的运行对相关空间只读（`runner.ts` 的 `readable`/`writable`，工具层 `writeSpace`、`inScope`）；`search`/`scan`/`find_symbol` 默认带上相关空间；`remember` 和记忆复核会列出相关空间里的相近记忆（`quality.ts` 的 `similarMemories`）；定期整理的候选来自 `src/core/space-candidates.ts`，由 dreamer 用 `relate_spaces` 决定。空间类型 `topic` 在界面上改叫“通用”。

## Agent 与模型

- **后台会话复用与清理**（10-23）：`background-sessions.ts` 为巡检、整理、简报、出卡和 Wiki 写作/检查保留在线 ACP 会话，按完整权限、指令和模型隔离，只在第一轮发角色说明。使用本轮真实上下文占用，超过 60% 或用量未知则释放；默认 60 分钟空闲、3 个后台进程。MCP 令牌逐轮指向当前运行，取消/正常停服时清理。CLI 单次任务启用临时参数；ACP 按能力调用 `session/delete`，Codex 实际归档而非完全不落盘。现有聊天、编码续轮和历史记录不批量更改。配置在 `sessions.background`，验证在 `test/background-sessions.test.ts`。同日补齐 TraeX：ACP 释放时用目录声明的 `archiveArgs` 调用归档命令，CLI 后备 `traex-cli` 使用 `--ephemeral`；其他 ACP 优先走 `session/delete`，无协议和命令能力时明确提示保留历史。

- **交办同时改多个仓库，worktree 改动可检索**（10-19）：`delegate_code` 的 `repo_spaces`（数组）、`check_commands`、`space`；`/api/delegate` 加 `repos`；`omem delegate --repos`。每个仓库一个 worktree（`runs/<id>/work/<空间>`），补丁按仓库存 `patches/<空间>.patch`，运行输出 `worktrees`、`repos`（旧运行的 `worktree`/`changes.patch` 仍认）；应用时全部先检查再一起应用，之后删 worktree。改过的文件建索引到临时空间 `wt-<运行id>-<仓库>`（类型 `worktree`，`src/agents/worktree-index.ts`），评审可读；`listSpaces` 默认不含它，`writeSpace` 拒绝写入，`omem pull` 不合并；应用、丢弃或 `repo-sync` 发现 worktree 不在时连同索引删除（`sweepWorktreeSpaces`）。运行页交办可多选仓库，详情按仓库显示检查和 diff。

- **按任务配置模型与强度**（10-16）：`config.agents.roleModels[角色][后端]`，`src/agents/models.ts` 的名称归一化（`GPT-Sol-6.1` 能对上 `gpt-6.1-sol`），会话级 `/model` 命令和飞书 `/model` 卡片（`src/channels/lark-model-card.ts`），网页 设置 → Agent → 按角色指定。10-18：Agent 档案回答的会话里 `/model save` 改写档案本身。
- **排队识别与兜底链**（10-16、10-17）：`config.agents.fallback`、`queueTimeoutMinutes`；`acp.ts` 从原始流识别 traex 的 `queue_begin`，区分“迟迟不开口”和“中途卡住”，前者走兜底（`runner.ts` 的 `fallbackProfiles`、`isRetryableAgentError`）。
- **静默运行**（10-16）：`runs.quiet`，巡检/做梦/整理返回 QUIET 时不进运行列表。
- **25 个内置 ACP Agent 与官方注册表**（10-14）：`src/agents/catalog.ts`、`omem agents registry|add`。

- **Windows 上新版 Claude Code 启动失败**（10-18）：它的 npm 垫片指向原生 `claude.exe` 而不是 JS 脚本，原来退回 `cmd /s /c` 时路径里的空格把命令拆坏（`'C:\Program' 不是内部或外部命令`）。`npmShimTarget` 现在也认 `node_modules\…\*.exe`，直接运行它（`src/agents/spawn.ts`）。
- **codex-cli 后备调不了 omem 工具**（10-18）：`codex exec` 的审批策略是 never，MCP 工具默认要审批，所以每次调用都被拒（`MCP tool call requires approval, but approval policy is never`）。`codexArgs` 现在加 `-c mcp_servers.omem.default_tools_approval_mode="approve"`，只放行 omem 这一个服务器，档案里额外配的 MCP 服务器不变，沙箱仍是 read-only / workspace-write（`src/agents/cli.ts`，测试 `test/cli-args.test.ts`）。

## 飞书

- **新会话直接执行任务与独立话题**（10-24）：`/new [任务]` 不再把参数只当标题，带任务时直接进入新会话执行，空指令仍开空白会话；网页返回新的会话 ID。新增 `/topic <任务>`，可从飞书群聊或机器人私聊主界面发起，以本条指令消息作为话题根，由机器人先开话题，拿到真实 ID 后再启动 AI，进度和答案留在话题内。后续追问按持久的独立话题设置路由，即使 `/mode chat` 也不并回主会话；已在话题内则直接拒绝，不启动 AI 或重置上下文。保留用户、空间和发消息权限，不带旧历史；开话题失败不启动任务。入口 `commands.ts`、`inbox.ts`、`threads.ts`、`lark-bot.ts`、`lark-send.ts`；`test/threads.test.ts` 用假 ACP 与飞书客户端验证。

- **通知保留外链按钮**（10-23）：普通通知此前只发送标题和正文，漏掉 `link`；现在与事项卡片一起显示 HTTP(S) 外链按钮，站内路由、无效地址和其他协议不生成按钮。事项正文或来源已有同一外链时不重复。入口 `src/channels/item-notification.ts`、`lark-bot.ts`，假客户端回归 `test/notification-card.test.ts`。

- **修复话题回复的内部引用外泄**（10-23）：规则首次开话题回复补上原件引用转换；主动发送、卡片更新及草稿同时覆盖。文档引用链接到原文，不把 omem 行号当成飞书段落锚点；没有外部地址时保留文字。卡片仅处理 Markdown，回调参数不改。

- **普通 @ 跳过缺席成员**（10-23）：目标群完整成员列表没有该姓名时，继续发送正文与其余提及，仅工具回执记录跳过，不再回退全局同名记录和邮箱。全局未关联记录不宣称是多人；群内真实重名、分页不完整和权限错误仍报错。加急、限定收件人不静默降级，已知机器人身份保留。内置消息技能同步此口径。

- **附件采集不再被解析卡住**（10-22）：原文件先保存，文档附件进入独立、可重试的 `lark-resource-parse` 运行，异步调用转换器，成功后关联原消息并整理；失败保留文件和错误，不阻塞消息分页。视频封面可选，原始 JSON 的视频本体参与缺失检查，外链副本不冒充原附件。Docling 修复构建路径及工具链启动提示混入正文，补齐 CSV / Office 格式分流，旧版 Office 缺 LibreOffice 明确提示。实际 CSV / DOCX / XLSX / PPTX 与表格附件解析通过；真实 Agent 两次工具行为抽查通过。

- **机器人卡片的名称规则漏触发**（10-22）：实时入口兼容事件的 `bot` 和读取接口的 `app`，不再把机器人送去用户通讯录查姓名，而是通过只读采集接口核实同一群、同一消息的发送者名称；只保存事件携带的机器人侧 ID，成功名称缓存 10 分钟，失败留待下条消息重试。匹配规则前等待群名；消息入库保留机器人类型，后续采集可修正旧类型。假客户端验证名称条件命中与两路去重，真实卡片只做条件判断验证。指定群的真实机器人 @ 已确认消息 mentions 正确，未观察到对方响应。见 `lark-sender.ts` 与 `test/lark-sender.test.ts`。

- **气泡失败与任务状态分开、群内 @ 补齐**（10-22）：气泡上传失败尝试撤回原消息，不再用“任务失败”收尾；`output.thinkingDelivery` 单独记录投递原因，`read_run` 区分它和运行状态。普通超时不禁用后续气泡，权限拒绝只冷却当前群。兜底卡片只保留状态及最终结果；收尾等待慢请求并清理表情、监听器和计时器。`mentions` 支持已知机器人侧 open_id；姓名记录不明确时核对授权目标群的完整成员列表，不按姓名合并跨应用身份，重名和不完整分页拒绝。邮箱 API 的非零业务码保留权限原因。机器人不在群成员列表里，须用本应用已收到的 @ 身份，app_id 和采集侧 open_id 不直传。见 `lark-cot.ts`、`lark-progress.ts`、`lark-people.ts` 及对应测试。

- **消息结构化、引用、图片与历史回溯**（10-18）：`src/channels/lark-messages.ts`、`lark_messages` 表、`lark_cursors.oldest_ms / backfill_to_ms`、按月的历史原件；网页聊天视图 `ChatView.vue`。
- **会话类型与采集方式**（10-18）：单聊、机器人单聊、普通群、话题群、omem 自己的机器人；免打扰；`lark.capture.policies` 与单会话覆盖。见 [渠道](../concepts/channels.md)。
- **免打扰不自动采集**（10-17），10-18 修正了“@我”补采只排除订阅群、不排除已读群导致重复的问题。
- **事项卡片**（10-16、10-18）：事项提醒发带“已处理/忽略”按钮的卡片；引用回复精确定位事项（`src/channels/lark-actions.ts`、`roles/_common.md` 的“事项与本人的回复”）。
- **setup 扫码建/绑机器人**（10-15）：`src/channels/lark-setup.ts`，App Secret 存 `secrets/lark.json`。
- **工作渠道**（10-14）：机器人消息工具、进度卡片、卡片回调、监听群、全量采集、日程、妙记、代码活动。

- **引用回复字段**（10-18）：真实 lark-cli 返回的引用回复是 `reply_to`，此前只认 `parent_id`/`upper_message_id`，聊天行的“↩ 回复”一直没出来；`parentOf` 现在先取 `reply_to`。远程 `lark-raw` 加 `types` 参数，能列出单聊。
- **飞书文档本地化**（10-18）：`src/channels/lark-docs.ts` 把文档里的图片、画板、视频/附件下载到 files/（正文写 `omem-file:`），内嵌表格转成表格，同步块读出原文，分栏/高亮块/按钮/书签/勾选/子页面列表转成 HTML（表格里的图片和链接写成 HTML 的 `<img src="omem-file:…">`、`<a href="src:…">`，网页 `web/src/lib/markdown.ts` 渲染前换成本地地址）；链接的文档一并导入（默认两层，`lark.capture.docLinkDepth`；视频与附件上限 `docMediaMaxMB` 默认 100 MB）并换成 `src:` 链接，读不到的通知本人并定时重试（`retryMissingDocs`，只改父文档里那条链接）。`importUrl` 对飞书文档多返回 `related`（一并导入且有变化的文档，也要整理）和 `missing`。素材下载被拒时改用预览接口，限流时退避重试；每篇文档记下它被读到时还能往下跟几层链接（`meta.depth`：直接给的 2，链接 1，链接的链接 0），重新读取和更新检查只按这个层数跟，不再每读一次都从它开始重新跟两层（之前 157 篇一路涨到 800 多篇）；一篇文档的素材 4 个并发下载（每个 lark-cli 调用约 1 秒，逐个下载时图多的文档要几分钟）；飞书写法的加粗（`**AI：**为…`，CommonMark 不认）在代码之外改成 `<b>`；原件页标题只有代码文件取文件名，其他原件显示完整标题（以前带 `/` 的标题只显示最后一段）；lark-cli 失败时错误里带上它返回的原因。旧文档用 `omem lark docs-refresh` 或远程 `lark-docs-refresh`（`stop: true` 停下）重读；远程 `lark-doc-raw` 核对文档相关的 lark-cli 返回，`lark-doc-import` 立即读一篇，`lark-docs-status` 看刷新进度和还没本地化的文档数。`/api/files` 支持视频类型和 Range，网页 Markdown 里视频用 `<video>`，`[名](omem-file:…)` 是附件下载链接。

- **读不到的文档、重新读取、更新检查**（10-19）：重试次数和间隔可配置（`lark.capture.docRetryMax` 默认 3、`docRetryHours` 默认 6），用完安静放弃（已删除、不存在、不是 docx 的按 lark-cli 错误码 3380002/3380003 等直接放弃，不提醒），`docs-missing --ignore` 手动放弃，同一批只发一条汇总通知；重新读取的进度存在 kv `lark_docs_refresh`，启动时 `resumeRefresh` 接着读，本次已读过的跳过；新的定时任务 `lark-docs-watch` 按上次修改后 7/30/90/180/365 天（`docRecheckDays`）检查，`drive metas batch_query` 批量取最后修改时间，改过的才重读。元数据新增 `fetchedAt`、`changedAt`、`modifiedAt`、`checkedAt`。

- **飞书里的人与 @**（10-19）：`src/channels/lark-people.ts`、表 `lark_people`（邮箱为主键的人，记 lark-cli 与机器人各自的 open_id、user_id）。采集时 `learnPeople` 用 lark-cli 的 `+search-user` 批量取名字和邮箱，机器人收到消息时记下自己的 id；`lark_send` / `lark_card` 加 `mentions`；`lark_messages` 加 `mentions` 列。聊天原文去掉 `@名字(ou_…)` 的 id（`withoutOpenIds`，启动时一次性清理旧原件 `cleanUpLarkIds`），网页显示邮箱。机器人权限加 `contact:user.employee_id:readonly`、`contact:user.email:readonly`、`contact:user.id:readonly`，`omem lark bot-permissions` 检查并给申请链接或扫码补齐（`checkLarkApp` 现在对照全部所需权限）。lark-cli 出错时缺权限不再误报成登录失效。

## 运维

- **`omem service`**（10-15）：自带 PM2 的后台服务（`src/core/service.ts`）。
- **`omem pull <host>`**（10-16）：经 ssh 拉另一台机器的库，合并或覆盖（`src/core/pull.ts`）。新表 `memory_rejections`、`shadow_writes` 不参与合并。10-18 起对已配对的设备改走 HTTP（`fetchPeer`，`/api/peer/snapshot`）。
- **多台设备**（10-18）：`omem peer invite|add|list|call`、`omem diag`；配对码 = 地址 + 本人 API 令牌（`src/core/peers.ts`），`via` 经中间节点转发（`/api/peers/:id/*`），固定远程命令清单（`src/core/peer-exec.ts` 的 `peerCommands`，`POST /api/peer/exec`）。同时改了鉴权：没有配置令牌时只信任本机请求（以前对所有来源都当作本人）；网页支持 `?token=` 和 401 时填写令牌。临时 ssh 转发见 `scripts/relay.mjs`。配对码带本机所有网卡地址，断线后自动换地址；`omem peer name` 设本机名字（`config.node.id`），`omem link` 给浏览器带令牌的链接，`omem user tokens|revoke` 管令牌，`omem peer open` 在本机转发设备的网页。设备之间不自动同步，`omem pull` 手动拉。设计与以后的持续同步方向见 `docs/v2/architecture.md` 的“多台设备”。
- **默认监听所有网卡、开机自启、更新命令**（10-18）：`config.host` 默认 `0.0.0.0`（旧配置里的 `127.0.0.1` 视为未设置，`localhost` 只给本机）；`omem service enable|disable`（`src/core/autostart.ts`）；`osdk run upgrade` / `scripts/upgrade.ts`，远程 `update` 复用它。
- **判官按需启动**（10-15）：`src/sources/judge.ts`。
- **对话里建空间、关联仓库**（10-15）：`create_space`、`connect_repository`（`src/core/repositories.ts`）。

## 文档与技能

- `skills/omem/SKILL.md`（给外部 Agent 的说明）补了写记忆的要求、`tags`、聊天原件的行格式；AGENTS.md 加了“仓库里的几类说明”和改功能时要同步的文档清单（10-18）。

## 代码理解

- tree-sitter 接入 Go/Rust/Java/Kotlin/Swift 与另外十几种语言（10-14），见 `src/sources/treesitter.ts`、`treesitter-more.ts`；[导入到可检索](../flows/import-to-searchable.md) 一页只写了 TS/JS/Python。
- Swift 语法解析时关掉 V8 的优化编译（10-18）：Node 24 的 TurboFan 编译它约 400 KB 的词法函数会耗尽 zone 内存、整个进程崩溃（Node 22、26 没有这个问题），其他语法不受影响。见 `treesitter.ts` 的 `NO_TIER_UP`。

## 网页

- 变更点逐处跳转（10-27）：选中的变更点下面列出它在代码里的各处位置（按页面顺序，同一文件按行号；改动里没有的文件标“不在改动里”），点哪处跳哪处；代码上方的吸顶条显示“上一处 / 下一处”和计数，键盘 `n` / `N` 同样可用；跳到的行短暂描边；文件树给当前变更点涉及的文件加同色圆点（`ChangeView.vue` 的 `stops` / `go`，`DiffTree` 的 `hot`）。`scripts/doc-screens.ts --serve` 只启动演示数据供手动查看。
- 文档站（10-27）：`site/`（VitePress，独立的 package 和锁文件）：首页、开始使用、命令行、各功能页；主题沿用网页的 token（`site/.vitepress/theme/custom.css`），`<Shot>` 组件显示截图。`.github/workflows/docs.yml` 在 main 上 `site/**` 变化时构建并发布到 GitHub Pages（`DOCS_BASE` 为仓库名）。截图由 `scripts/doc-screens.ts` 生成：在临时数据目录里放入虚构的演示数据（示例商城 · 退款改造：需求、方案、群聊、代码、Wiki、记忆、事项、带五个评审项的交办、规则），用构建好的网页截 17 张到 `site/public/screens/`，README 也引用它们。
- 编码前的 Git 同步（10-27）：`src/agents/code-sync.ts`（`syncWorktree` 拉取 / 合并 / 变基，`finishSync` 把每轮冲突交给解决者再继续，`moveToTarget` 把未应用的改动变基到目标分支最新提交，`popStash` 放回同步前收起的改动）。`code.ts` 的 `syncPhase` 在编码前运行：冲突交给编码 Agent（`conflictTask`，`roles/coder.md` 加了 `ask_owner` / `wait_answer`），剩下的停下来发提问 `code-sync`（继续 → 新一轮 `syncResume`；放弃 → 回到同步前）。`WorktreeRef` 新增 `start` / `syncHead`：应用时先 `merge --ff-only` 到 `syncHead`（目标分支必须还在 `start`），再应用补丁。没有会话链的网页交办续轮用 `review-fix.ts` 的 `queueStandaloneFix`（可带 `extraInput`）。`code-git.ts` 推送可指定 `branch`，`force` 用 `--force-with-lease=<分支>:<上次拉取的提交>`。接口 `POST /api/runs/:id/move-to-target`、`GET /api/asks/:id`；`/api/delegate` 接受 `sync` / `syncOnly`。
- 运行页的引用与修改点（10-26）：选中文字后有“加入提问 / 加入修改点”两个按钮，范围是运行详情和从它打开的引用抽屉（带 `data-quotable` 的区域；`CodeView` 行带 `data-line`，引用带上行号）。引用按运行存在本机（`web/src/lib/quotes.ts`），按 [1]、[2] 编号；提问抽屉（`AskAboutRun` 的 `basket`）可缩小成可拖动的图标（`QuoteDock.vue`，位置记在本机），继续选别处再加入；修改点在 `FixBasket.vue` 里逐条写要求，和评审里定为“改”的问题一起开始修改，“概览”的修改框也会带上它们。
- 差异的上下 / 左右两种排列（`lib/diffLayout.ts`，本机记住），左右时删掉的行和替换它们的行并排；改动文件树（`DiffTree.vue`，文件夹可折叠，单层目录合并显示），在“变更”标签和“活动”的改动里都有。点变更点时把它第一处标记滚到屏幕约三分之一处（以前滚的是整个文件，标记常在屏幕外）。
- 规则“发到”选群聊后保存，下拉框仍显示群名（以前显示那个群对应会话的标题，常是群里的第一条消息）。
- 应用后的“接收位置与提交”移到页头下面的卡片里；Windows 上接收目录路径统一成本机格式（`git worktree list` 给的是正斜杠）。

- 定时任务改成表单（`web/src/components/CronEditor.vue`）：每隔几分钟/几小时、每天、工作日、每周几天、自定义 cron，显示含义和接下来三次时间（10-19）。
- 加载态（`Skeleton.vue`）与虚拟滚动（`VirtualList.vue`，动态行高）：原件列表、长原件、聊天、运行列表、记忆列表（10-18）。
- 原生 select / checkbox / datetime-local / confirm / prompt 全部换成自己的组件（10-18）：`web/src/components/UiSelect.vue`、`UiCheckbox.vue`（含 switch）、`UiSegmented.vue`、`UiDateTime.vue`、`DialogHost.vue` 与 `web/src/lib/dialog.ts`。约定写进了 AGENTS.md 和 `.agents/skills/omem-design`。


## 2026-10-19：事项来源、通知与跨空间归属

- 通知持久化本次事件来源，飞书正文和来源区共用最终 URL 去重集合；定时提醒使用设定提醒的来源。
- 事项来源默认合并，显式 replace/remove 要求旧快照和原因，保留修复历史。
- ingest 只读发现可访问空间中的已有事项，跨空间进展提交提案，主助手复核后应用；空间写权限仍独立检查。
- 本人主助手可通过受限 MCP 工具预览/修复错误关联并审计，保留未迁移事件仍使用的共有来源，旧卡片停用后可刷新原消息；按钮回调校验 payload 目标和操作者权限。部署与数据修复见 docs/v2/item-maintenance.md。

## 2026-10-19：飞书机器人消息与事项来源摘要

- 机器人收到消息事件先应答再处理，按消息 id 去重（`handled_messages`，channel `lark-bot`）。以前处理慢时飞书在约 20 秒、5 分钟后重推，同一条消息变成两三轮回答。
- 分享的群（`share_chat`）、名片、合并转发读成文字：群名先查个人采集的 `lark_cursors`，再用机器人、最后用本人 lark-cli（只读）；说明是否已采集，没有采集时提示订阅和回溯。只有材料的消息多等 `sessions.contentWaitMs`（默认 15 秒）。
- 引用回复：消息接口返回 `msg_type` 和字符串 `sender.id`，以前按事件字段读成 `[undefined]`。引用助手自己的回复（卡片读出来只有“请升级客户端”）时，按回复时记下的 `larkMessageId` 取回答原文。别人的 @ 保留名字，只去掉对机器人的 @。
- 事项来源：`refExcerpt`（`src/items/evidence.ts`）给出原件标题和所引行摘要；飞书卡片来源区按最终 URL 合并，网页事项详情的“相关依据”显示标题和摘要。

## 2026-10-19：子模块递归与交办编码链

- 代码仓库：`git ls-files --recurse-submodules` 索引已检出子模块的文件，gitlink 目录不当文件；omem 克隆的仓库在同步前逐个初始化子模块（嵌套在父模块内更新，单个失败不阻塞），状态写入空间设置。
- 交办编码：评审不通过自动续轮（最多 3 轮），复用同一 ask 运行、同一 worktree 和编码 Agent 会话；新增 `continue_code_run` 用于本人之后的调整，不再新建交办。
- 飞书新增独立“编码交办”卡片：交办开始时在原消息下开话题，编码/评审各轮进度在同一张卡片更新。

## 2026-10-19：多 Agent 长任务工作会话

- `run_agent(own_topic=true)` 建立独立工作会话（飞书由原消息开话题）：专门 Agent 的长产出只留在工作会话，新增 `digester` 角色自动消化，结论、决策点和下一步才回主会话；主助手不再原样转发长输出。
- 工作会话以 ask 运行为锚、轮次落库（最多 8 轮）；`continue_agent_work` 在原话题续下一轮，本人在话题里回复即在工作会话继续。
- 主助手职责更新：判断长任务、自动推进或明确请本人介入；交办编码仍走编码链和“编码交办”卡片。

## 2026-10-19：read_source 读聊天/记忆、网页分页与布局

- `read_source` 支持 `msg:<id>`、`mem:<id>`（也认不带前缀的消息 id）：以前复核记忆时记忆标的来源是消息，工具只查 `sources` 表，连续报“找不到原件”；现在分别渲染消息和记忆原件（`src/agents/tools.ts`）。
- 原件列表：文件夹默认折叠，展开过的跨分页保留，搜索时全展开；分页每页 1000 份，滚到底自动加载（`web/src/views/Sources.vue`，服务端 5000 上限）。
- 运行记录：后端分页（`limit` 上限 500、`offset`、`countRuns`，`GET /api/runs` 返回 `{runs,total}`），网页每页 100 条滚动加载，运行事件只在新 run 排队时刷新列表；类型补中文名（`ingest-shadow` 对比整理、`memory-review` 复核记忆等）。
- 布局修正：运行页侧栏头部改成两行网格，标题不再被控件挤成竖排；设置页 tab 横滚不再显示滚动条；空间卡片网格允许长路径换行，不再撑破页面；类型下拉选项文字与图标垂直居中。

## 2026-10-20：多 Agent 话题与回复整理

- 飞书话题键沿用 `omt_…` 原样：以前 omem 开工作话题时去掉了前缀，本人在话题里的回复变成另一个会话，助手在那里再委派又开了一套工作，导致同一话题里出现两路回复。迁移把旧键改回并合并同一话题的重复会话（`src/core/db.ts` 最后一条迁移）。
- 在话题里再 `run_agent(own_topic=true)` 续在同一项工作（`agent-work.ts` 的 `workInConversation`）；消化结果只发一处（`workDeliveryTarget`：有话题发话题，否则回主会话），飞书里是一张卡片，完整报告在折叠面板里（`lark-send.ts` 的 `fold` 块）。`roles/digester.md` 改成“整理成能直接用的回复”，不再压到两屏。
- 回复取最后一次工具调用之后的文字（`types.ts` 的 `replyFromSegments`，ACP 与命令行后备都按工具调用切段）：之前把中途的叙述和最终回答拼在一起，读起来像发了两遍。
- 发往聊天的本机路径改写（`common.ts` 的 `localPathLinks`）；`lark_*` 在话题会话里默认发进话题（`tools.ts` 的 `larkPost`）。
- 运行详情加“所在会话与关联”（`http.ts` 的 `runContext`），任务全文可展开。
- 外部只读访问的设计见 `docs/v2/external-access.md`（未实现）。

## 2026-10-20：通知收敛、原生思考气泡、预加载、Agent 学习分层、记忆召回统计

- 通知默认只在**未读 / 紧急 / 临期 / 未处理**之一成立时推送：lark-cli 的 `im +messages-read-status` 查本人已读（`lark-read.ts`，peer 命令放开该只读接口）；`config.notify` 加静默时段（22:00–09:00，定时提醒不受限、紧急可穿透）和开关。`notify` 增加 `urgency`。heartbeat / ingest 职责改成“能查的先查、长任务开话题推进、缺手段再问本人”。
- 飞书过程回显改用原生 `im.v1 message_cot`（AG-UI 事件，参考 deepcoldy/botmux 的 cot-message）：可折叠气泡、工具调用逐行、最新调用转圈、`RUN_FINISHED` 收尾；失败自动回退原“处理中”卡片。
- 网页路由 chunk 首屏后空闲预取、侧栏 hover/focus 预取（`preload.ts`）。
- Agent 学到的东西分三层：档案只存身份（Agent 经工具写超长 prompt 会被拒并引导到技能/记忆），步骤沉淀为技能，偏好与经验进 `scope=agent` 的记忆；`_common.md` 写明分工。code review 类档案按此逐步积累。
- 记忆加召回账本 `memory_recalls`：recall 每次落账，运行结束时回答/消息/写入引用到的记忆记为命中；记忆页新增“召回”标签和四种排序，便于治理。

## 2026-10-20：思考气泡协议修正、教指定档案、档案页可视化

- 原生思考气泡之前建得出、内容不更新：message_cot 的事件 `content` 必须是 JSON 字符串，传对象被网关报误导性的 41050（no user authority）；修正后工具行按 START（进行中转圈、可流 ARGS）→ END+RESULT（停止转圈）两段推送，整轮失败自动 best-effort 收尾并停用，不再留下永久空转气泡（`src/channels/lark-cot.ts`）。
- `remember` / `recall` 新增 `agent` 参数：主助手可用 `remember(agent="某档案")` 教任意档案的专属偏好/经验（档案不存在直接报错），`recall(agent="…")` 只看该档案；档案自己运行仍默认归属自己。主助手无 spec 时可见全部记忆以便统筹（`src/agents/tools.ts`）。
- 网页档案详情新增“挂的技能”和“专属记忆”两个折叠块：技能可直接勾选/移除（即时保存 frontmatter），专属记忆可查看与撤回（`Agents.vue`、`GET /api/agents/:name`）。

## 2026-10-20：气泡与进度卡重复、排队时多卡、长任务上限与卡死看门狗

- 思考过程只在原生气泡展示：普通“处理中”卡片不再回显模型思考文本；气泡首批事件推送成功后，卡片收敛为一行提示并最终承载结论；气泡不可用时卡片保留步骤作为后备（`lark-progress.ts` 加 minimal 模式）。
- 排队中的回合不再立刻建气泡和进度卡：消息轮到本回合真正 running 时才创建，修掉“回合 A 还在跑时发 B，出现两张永不更新的卡”的问题（`lark-bot.ts` 监听 run running）。
- 气泡收尾更稳：finish 后等所有工具 END/RESULT 推完再发 RUN_FINISHED（带 30 秒兜底），避免结束早于最后的工具事件；增加 proven 标记（`lark-cot.ts`）。
- 多 Agent 工作轮数上限 8 → 20；触顶不再把错误抛给本人，主助手改为直接在本会话继续完成请求（读工作会话上下文），`continue_agent_work` 工具返回指引（`agent-work.ts`、`tools.ts`）。
- 交互式运行（ask/agent）30 分钟没有任何事件即自动中止并释放会话通道，agent 进程挂死时后续排队消息不会再永久沉默（`runs.ts` 心跳看门狗 watchStalls）。

## 2026-10-20：档案页记忆渲染复用与记忆归属语义澄清

- 设置 → Agent 档案详情的“专属记忆”改用与记忆一级页相同的 `components/MemoryCard.vue`（类型中文化、有效期/标签/复核状态/演变依据按钮一致），添加技能改用 `UiSelect`，不再用原生 select；Memory.vue 也改为复用该组件。
- 记忆归属语义写清：`scope="agent"` 只表示“当前正在运行的档案自己”，不能指定别的档案；主助手教指定档案必须 `remember(agent="档案名")`（档案不存在报错），查看用 `recall(agent=…)`（`roles/_common.md`、`roles/assistant.md`、remember/recall 工具描述）。
- peer 新增只读命令 `library-file`：查看远端知识库 Git 里的档案/技能文件内容、目录或 git 历史，便于排查 Agent 学到了什么。

## 2026-10-20：save_skill 可挂到指定档案

- `save_skill` 增加 `agent` 与 `attach`：主助手教某个档案时 `save_skill(agent="档案名")` 保存技能并写进该档案 frontmatter（已挂则不重复）；在档案内运行默认挂当前档案；`attach=false` 只建共享技能。目标档案不存在报错（`src/agents/tools.ts`）。`_common.md`、`skills/omem/SKILL.md` 同步说明；补测试。

## 2026-10-20：通知闸门修 src 引用失效、首次提醒宽限、“忽略”学习

- 之前“已读不推送”几乎从未生效：心跳通知的来源是聊天原件行（`src:<id>#L2-L4`），闸门却只认 `msg:<id>` 直接 ID。新增 `notify-gate.ts`：把引用行解析回飞书消息，命中任一即不推——①触发消息已读；②本人在该消息上回了表情（OK/DONE 等表情）；③本人之后在同群/同话题回复过。
- 普通、非紧急、未过期事项的首次提醒宽限 5 → 30 分钟（`config.notify.firstNudgeDelayMinutes`，旧字段 `minItemAgeMinutes` 改名），紧急/过期/本人设定的定时提醒不受限；heartbeat 职责写清不要几分钟内催、无新变化不重复催。
- 通知卡片点“忽略”会学习（`core/notify-lessons.ts`，存 kv `notify_mute_rules`）：按标题/正文的关键词（中文二元组+拉丁词，去停用词）匹配，相似度达阈值的同类提醒以后只进应用内通知、不再飞书推送；规则可审计、计命中数，`GET /api/notify-mute-rules` / 删除接口已备。作用边界：关键词相似匹配会有误伤可能，目前规则只静默推送不删除提醒，阈值 0.55，上限 100 条。

## 2026-10-20：忽略学习改为 AI 语义判断；档案页只认真专属记忆与样式修正

- 通知“忽略”不再用关键词匹配：点忽略时由模型把这条通知总结成一句带对象/场景边界的中文规则（一次性事件不生成），存 `kv notify_ignore_rules`；每次推送前由模型拿规则对新通知做语义判断，命中才静默（紧急通知不静默，不确定一律放行），规则可审计、计命中、可删除（`notify-lessons.ts`、`notify-ai-gate.ts`，`GET /api/notify-ignore-rules`）。新增 `ignore_notification_rule` 工具，本人引用消息直接说“这类不用提醒我”也能记录规则。
- 修复档案详情“专属记忆”混入共享记忆：之前列表语义是“共享+该档案”，导致一个排查类档案的详情里显示了二十多条与它无关的共享记忆；新增 `listMemories(agentScope:"own")`，档案页只列真正 `agent=档案名` 的记忆（`http.ts`、`memory/store.ts`）。
- 档案详情样式：改名“挂载技能”；技能 chip 可悬浮看描述、点击跳到技能管理页、× 单独移除，保留“+ 挂载技能”下拉；挂载技能与专属记忆各自在自己的卡片内滚动，不再一起滚动；修正 padding。

## 2026-10-20：首催宽限在通知层强制执行；已回复检测提前且更稳

- 30 分钟首次提醒宽限此前只写在角色提示里、代码没用上。改为在 `notify()` 集中强制：普通、非定时、非紧急事项的第一次通知，事项建立未满 `firstNudgeDelayMinutes`（默认 30）直接拒绝（425）；ingest 想立刻催也催不出来。定时提醒/urgent/已有通知的后续更新不受限。
- 已回复检测（`notify-gate`）重排：先做"本人在触发消息之后于同群/同话题回复"这一最强且不依赖读权限的判断（话题仅在双方都带话题标记时才要求一致，避免漏判）；触发引用解析不出消息行时，回退为同群近 30 分钟内本人有发言；之后才查已读与表情。修复"本人明明 12:06 已回复、12:01 ingest 仍催"的误打扰（注：12:01 时回复尚未发生，属于宽限要解决的场景）。

## 编码交办进度与续轮（2026-10-20）

- 修复手动 `continue_code_run` 被自动三轮上限挡住的问题；自动上限保留，手动第 4 轮及以后复用首轮工作区和上一轮编码会话。排队时重读主链，拒绝重复 queued/running 和过期自动回调。入口：`src/agents/code-chain.ts`、`tools.ts`、`code.ts`。
- 编码飞书卡片的创建、更新、失败状态、有限重试和重启恢复改为持久记录；已有话题查真实消息锚点，私聊走普通回复，不再改原会话 `lastMessageId`。卡片含各轮独立评审摘要，到上限或需要本人时持久记录等待状态。`read_run` 可查投递，`retry_code_progress` 只恢复原卡片；发起主助手的上下文保留结果，不自动唤醒以绕过自动轮数限制。入口：`src/channels/lark-code-progress.ts`、`src/agents/runs.ts`。恢复操作见 `docs/v2/acceptance.md`。
- 验证使用临时数据库、假飞书客户端；历史被吞掉的 API 错误仍未知，真实投递待应用后验收。

- **编码收尾异常隔离补充**（10-20）：`trySettleCodeChain` 确保交接记账失败不会把已完成运行改成失败，也不会阻断终态事件。飞书恢复逐链隔离，已发最终卡片但记账失败仍重试；缺卡创建耗尽后首次启动补一次有限预算，明确撤回或 HTTP 404 后换 UUID 补建，权限和限流失败保留原 ID。`test/code-settlement.test.ts` 和飞书进度测试覆盖这些故障路径。

## 2026-10-21：审查修正（通知闸门、召回统计、思考气泡）与界面修正

- 通知闸门 `notify-gate.ts` 三处缺陷：聊天行正则解构多跳了一组，消息 id 恒为空，已读和表情判断从未生效；聊天行时间按 +08:00 解析，而采集写的是 UTC，“同群近 30 分钟本人发过言”的回退永远不命中；表情比对用的是机器人的 open_id，lark-cli 读到的是它自己应用的 id。已读查询改为“确知已读才算”（`lark-read.ts` 的 `readMessageIds`），查不到、字段缺失或 lark-cli 不可用都不静默。
- 记忆召回“命中”只记本次运行（`markUsed(runId, …)`），以前一次命中会把这条记忆在所有运行里的召回都记成命中；迁移按每次运行重算。Agent 运行不再重复保存整段叙述（`output.fullText`，迁移删除）。
- 思考气泡：同一段推理在第一次推送后追加的文字没有再推，长段落只显示开头；改为按已推长度推增量，后面出现工具调用或结束时才关闭这段。
- `continue_agent_work` 不指定 agent 时取最后一个非 digester 的轮次（以前会选到 digester，报“没有名为 digester 的 Agent 档案”）。`ignore_notification_rule` 加进 assistant / heartbeat 的工具清单（角色说明里提了，清单里没有）。去掉未使用的 `notify.proactivelyInvestigate`、`notifyPolicy`、`isUrgent`、`isUnread`、`cotWorkingFor`。
- 原件页：代码仓库空间一次取全部路径（`GET /api/sources/paths`，不算行数），目录树的计数完整、不再分页；平铺列表加载后不满一屏会继续加载，“还有 N 份，向下滚动加载”的提示去掉，加载提示居中。
- 聊天原件的图片和附件：`[Image: img_…]` 形式的图片消息也能显示；采集时没下载的（旧消息、只有 key 的行）在第一次显示时经 `GET /api/lark/messages/:mid/resources/:key` 由本人 lark-cli 读取（失败再用机器人），存入原件文件，之后直接显示。
- 编码交办详情的 diff 默认折叠，展开某个文件才渲染它的行，可一键全部展开。
- `scripts/dev.ts` 在 Windows 上不再经 shell 启动 node（路径含空格时 API 起不来）。

## 2026-10-21：内置角色可管理、档案进化

- 内置角色（`roles/*.md`）在 Agent 页列出，可“自定义”：复制到 `library/_roles/<名>.md`，源码版本另存在 `_roles/.base/`。之后的运行用自定义版本（`runner.ts` 的 `loadRole(name, app)`）。omem 更新改了源码时列表显示“源码有更新”，可“恢复源码版本”（删自定义，Git 历史保留）或“合并源码更新”：`git merge-file` 三方合并，干净就直接保存，有冲突交给模型（`role-merge` 运行，`oneshot.ts` 的无工具一次调用），结果同样校验后保存。命令行 `omem roles list|customize|reset|merge`。
- 内置角色和档案一样能学：`remember(agent="reviewer")`、`save_skill(agent="reviewer")`（挂载写进自定义版本的 frontmatter），角色运行时注入它的专属记忆、常用技能排在前面；角色内 `scope=agent` 写自己的经验，不传时仍写共享（ingest 记的是本人的偏好）。档案名不能与内置角色重名（记忆和技能按名字归属）。`list_agents` 同时列出内置角色。
- 档案进化：新角色 `coach` 和每晚 04:10 的 `profile-review`（最近有 3 次以上运行、且有本人随后的纠正或失败的档案/角色，每晚最多 3 个）。coach 读运行产出和之后本人在同一会话说的话：经验和偏好直接 `remember(agent=…)`（照常经过写入检查和复核），提示词、技能、设置的改动用新工具 `propose_profile_change` 存为 `profile_proposals`，本人在档案页采纳（提示词显示差异）或忽略。档案页“进化”区显示近 30 天运行、专属记忆被召回/用上的次数、上次复盘、待采纳建议和历史，可“立即复盘”。
- Agent 页重做：左侧“我的档案 / 内置角色 / 技能”，＋ 进入完整的新建表单（名称、用途、后端、模型、强度、空间、目录、工具、可读空间、技能、写文件、提示词、工作约定），已有档案默认是表单、可切“原文”；挂载技能和工具用 `ChipPicker`（一个 ＋ 下拉，选中即加）。去掉列表头部的内联新建。
- 通知的 AI 闸门改用 `agents/oneshot.ts` 的 `askModel`（与角色合并共用）。

## 2026-10-21：多 Agent 协作改成主助手接手的循环

- 不再有 digester：专门 Agent 每轮完成或失败后，报告作为它的消息放进工作会话，并在该会话的通道里排一个“协调”回合（`ask` + `coordinate`，`agent-work.ts` 的 `onWorkRunSettled`）。主助手以这项工作负责人的身份读报告（`sessions.ts` 的 `coordinationNote`）：继续交办、换 Agent、自己核实、整理结论或请本人决定。回复发到 `workDeliveryTarget`，各 Agent 的完整报告折叠在下面（`jobs.ts` 的 `deliverCoordination`）。本人在话题里的新消息与报告合并成同一回合。
- 防失控：本人上次在工作会话说话以后最多自动推进 `MAX_AUTO_TURNS`（6）次，超过时 `continue_agent_work` / `run_agent` 在协调回合里被拒绝，提示词要求汇报；专门 Agent 轮数上限 20 → 30（协调回合不计）。失败的轮次也会交给主助手（以前只在成功时推进）；协调回合本身出错会在话题里说一声。
- 信息不丢：同一个 Agent 的下一轮接着它上一轮的会话（`persistSession` / `resumeSessionId`，接不上时改新会话），任务前附上这项工作到目前为止的经过（本人的话、其他 Agent 的报告，`workContext`）。
- Agent 之间可以请教：新工具 `ask_agent(name, question)`（档案和主助手自动有），被请教的档案在提问的工具调用里直接运行（不排队，避免所有槽位都在等请教时卡死），是一条可见的子运行（`consult.ts`），不能再请教或交办（`denyTools`）；重启时中断的请教直接失败。
- 飞书里每个 Agent 的回合、被请教的回合和主助手的协调回合都有自己的原生思考气泡，标题写明是谁在做什么，按顺序出现在工作话题里；工作话题建好之前不在原群里显示（`lark-agent-cot.ts`）。
- 编码交办停下（通过、到自动轮数上限、失败、无改动）时，唤醒发起的主助手在原会话发一条结果和下一步（`code-chain.ts` 的 `wakeAssistantForCodeResult`，`handoff`），这一回合没有编码工具。编码和评审的输出只取最后一次工具调用之后的文字，评审的中途叙述不再进到结果消息里。
- 迁移：仍在排队的 `agent-followup`（旧 digester）运行取消；`roles/digester.md` 删除。

## 2026-10-21：规则页

- 新增“规则”（`src/rules/`，设计见 `docs/v2/rules.md`）：一句话原话 + 触发（新消息 / 第一次看到的群 / 定时，每条或每群一次）+ 条件（宿主求值的 JSON：群名、群里的机器人、发送人、邮箱、正文、消息类型、@ 本人、卡片标题，all / any / not）+ 判断方式（条件、条件 + 模型确认、模型，模型判断每规则每小时最多 60 次）+ 按顺序的动作（交给 Agent、持续监听、拉机器人进群、优先采集、通知）。
- 事件来源：机器人实时收到的群消息（`lark-bot.ts`）和本人采集的所有会话（`lark-personal.ts`，含第一次读到的群）；同一条消息对每条规则只处理一次（`rule_handled`）；定时规则建 `rule:<id>` 定时任务。
- 交给 Agent：可以从触发消息开话题；回复方式“只告诉我”（结论通知本人）、“先给我看”（它的 lark_send 变成草稿）、“直接回复”（结论和 @ 发在这个群/话题）；它只能往触发的群发（`runRole` 新增 `lark` 范围）。
- “拉机器人进群”以本人身份（lark-cli `im chat.members create`）把 omem 自己的机器人加进群，是本人身份唯一的写操作，只在本人配置的规则里发生（AGENTS.md 已写明）。“优先采集”把群设为 ingest 并立刻采集一次，之后免打扰也照读。
- 模型的两件事都是无工具的一次调用：从原话生成规则（`draftRule`），判断事件是否满足原话（`aiJudge`）。规则页可“用最近的消息试一试”（只看不做）、看触发记录。助理有 `list_rules` / `save_rule`，它建的规则默认不启用。
- 共享组件修正：`UiCheckbox` 的选中样式写成了 `.on .box`，任何带 `on` 类的祖先（比如选中的列表行）都会让它显示成选中，改为只看自身。

## 2026-10-21：机器人与本人采集不重复写；批量回溯与补拉图片附件

- 机器人在群里实时写下的消息，本人采集（lark-cli）再读到时会重复追加一行（两边都写 `lark:<群>` 原件，之前不查）。现在双方按行尾的消息 id 跳过对方已写的（`linesWritten`，只查原件末尾 20 万字），`lark_messages` 的行号指向已有的那一行。规则、监听、通知原本就按消息 id 去重，不受影响；历史回溯写按月原件，按 `lark_messages` 去重，与实时原件不重叠。
- 批量回溯：`omem lark backfill [会话…] --name/--kind/--all --days N`；助手的 `set_lark_backfill` 改为一次多个会话（`chat_ids`），本人说“某类群”时助手先用 `list_lark_chats` 挑出会话。
- 补拉缺的图片和附件：`fillResources` 找出 `lark_messages` 里没有本地文件的图片/文件 key，以及 10-16 之前只存在于聊天原件行里的 key，逐个用本人 lark-cli 读取（机器人兜底）；CLI `omem lark fill-files`（前台，打印进度），远程 `lark-fill-files`（后台，完成后通知，`status: true` 看进度），`POST /api/lark/fill-files`，`set_lark_backfill files=true`。

## 2026-10-21：规则按应用 id 认出 omem 自己的机器人

- 新字段 `chat.hasOwnBot`：群成员里有没有 `lark.appId` 这个应用（机器人收到的消息直接算有），不看名字。`chat.bots` 仍是名字列表，成员读取同时保留应用 id（`engine.ts` 的 `chatBots`）；“拉机器人进群”后清掉这个群的缓存。
- 从原话生成规则时告诉模型机器人的真实名字（`kv.lark_bot_name`），并要求“助理机器人 / omem 机器人”用 `chat.hasOwnBot`。之前模型会写 `chat.bots contains "omem"`，而机器人名字通常不含 omem，条件永远成立。

## 2026-10-21：TraeX 按模型的思考强度与结构化排队状态

- 探测（Agent 页“检测模型”、飞书 /model 卡片）逐个切换模型读 reasoning_effort，存为 `effortsByModel`；TraeX 的默认模型没有强度选项，之前因此显示“不支持”。`/model`、模型卡片、设置页的强度选项按当前模型列出，没有强度的模型直接说明。
- TraeX 内置启动参数加 `-c features.headless_queue_status=true`；已保存的旧默认参数（`acp serve`）自动换成新的（`catalog.ts` 的 `previousArgs`）。排队状态从 `session_info_update._meta.trae.queueStatus` 读（`acp.ts` 的 `queueStatusOf`，旧的 queue_* 更新仍兼容）：排队中暂停空闲计时，位置变化发状态，结束时报告等了多久；思考气泡里显示同样的内容。

## 2026-10-21：豆包 OpenAPI 作为云端模型后端

- 新后端 `doubao`（`src/agents/doubao.ts` + `dispatch.ts` 统一各传输入口）：豆包 Managed Agent OpenAPI（sessions / events / MessageStream），设备码 OAuth 拿用户 access_token 存 `secrets/doubao.json`（按飞书 app id 分，自动刷新、保留 refresh token），会话留在豆包，线程用 `resumeSessionId` 续聊；reasoning 进思考、artifact 附为链接；云端运行用不了 omem MCP 工具，请求带工具时会说明。
- 权限按应用区分：`omem doubao status` 检查 omem 持有 secret 的全部应用（租户令牌读 `doubao:*` 用户权限）和 lark-cli 自己的应用；`omem doubao login [--app]` 设备码授权，也有远程命令 `doubao-status` / `doubao-login`（远程发起后在飞书确认，完成通知）。
- 在一台设备机器上真机验证：助理机器人应用有权限，授权后两轮对话正常且第二轮记得第一轮答案（同一 session）。

## 2026-10-21：新话题继续旧工作；思考气泡超长修复；后台进度不私聊

- 问题：本人在一个新飞书话题里让主助手接着旧工作做时，它用 `continue_agent_work(work_id)` 把下一轮排进旧工作会话，之后专家的报告、协调回复、编码交办交接（code-chain handoff）都回到旧话题；旧话题里已排队的轮次继续在旧 lane 跑。现在从别的会话（尤其新话题）继续旧工作会 `forkAgentWorkTo`：在新会话建工作线程、新 ask 链承载后续所有轮次（专家仍接它自己的 Agent 会话与工作经过），旧工作标记 superseded、旧 lane 里排队的轮次取消；编码交接在唤醒主助手时跟随最新工作会话。
- 思考气泡：飞书对单个 COT 事件有长度限制，推理文本整段推送时返回 “event[n] content too long”，气泡被错误结束并显示“思考过程可能包含不符合规则的信息，已隐藏”，且当时会全局停用所有后续气泡。现在 reasoning delta 按 4000 字分段；超长只结束本轮气泡，后续轮次照常。
- 通知：编码评审到上限、`set_lark_backfill files=true` 的补拉完成等后台任务通知一律发到所在工作话题（`notify.larkConversationId`，飞书 sink 按会话 key 回复到话题），不再私聊本人。

## 2026-10-20：Oncall 本人被 @ 保留规则

- 新增默认关闭的 `lark.capture.mentionRetention`：绑定 CLI 本人身份、授权租户、工单确认群映射；可通过固定 bytedcli 只读命令发现新关联群，分类只定优先级。
- @ 搜索提前且不跳过常规已读群；真实 mention 命中后独立保存触发消息、优先上下文和持续采集，不受免打扰及普通预算限制。邀请当前 omem app 使用用户鉴权，前后以 omem SDK 核验成员，审批/有限重试/采集失败存库。
- 两入口共用消息/原件行与资源关系；机器人事件先持久化，失败重试与重启恢复独立于用户读取。记录本人移除、机器人移除和真实解散。规则不发群消息、不回复、不改工单。
- `omem lark retention-status` 查看配置与进度；启用步骤、搜索/轮询延迟、权限和编辑覆盖边界见 `docs/v2/lark-mention-retention.md`。

- 保留规则评审修正：分页正文逐页保存，缺失/重复令牌不推进游标；不依赖未经核实的消息更新事件，机器人以自身权限有限回读近期已保存消息，覆盖本人离群后的近期卡片更新。真实解散状态不被后续移除事件覆盖。

- Oncall 保留规则评审修正：实时完成回执独立保存，回读成功删除任务，十次失败停止自动重试并输出状态；尚未确认可读的机器人群不排回读。优先列表每轮共用 20 次请求预算，群分页和话题分轮持久续读、逐页保存，倒序越过时间窗停止。身份不匹配恢复常规订阅路径；恢复 @我联系人学习，说明旧聚合源替换；聊天按时间展示并保持引用行号；已存资源 key 不重复下载。

- Oncall 保留规则第二轮评审修正：消息保存透传原件写入状态，仅实际变化触发整理；完整处理成功后记录消息摘要，无变化回读跳过渲染与引用查询。处理摘要和刷新时间标记随 72 小时窗口清理；补安静群重复回读、真实编辑仍整理和标记过期测试，说明未确认 skip 群仍先保存单条触发消息的边界。

- 2026-10-21：历史回溯不再把整页已知 ID 当作终止，新增持久远端页令牌和话题进度，逐页保存、已知 ID 补资源，完成需要耗尽证据，旧队列原目标保留并重新核验。机器人回读改按群复合索引游标限量检查，清理分批；卡片资源失败独立重试，不阻断后续正文更新。main 兼容补丁保留已合入通知/手动续轮、规则与资源能力。

- 2026-10-21：补空归属消息专测（三项归属 NULL 且原件无 ID 时仍补原件、续 next、重放不重复）；补四十群旧结束复核后恢复整理意图及永久附件失败状态回归。原树验证内部 requestBackfill，最新 main 兼容树验证正式 chat_ids/files 工具入口；清理 parentOf 无用导入和无调用者 rebuildArchive。

## 2026-10-22：编码交办结果回到主助手、自动推进可设置、静默排查与“别人在处理时不插手”

- 编码交办停下后唤醒主助手失败：c7cc213 在 ES 模块里用了 `require(...)`，Node 下直接报 `require is not defined`，第 3 轮以后每次停下主助手都不说话。改为静态导入；顺序也调整为先判断“下一轮已自动排队”再写入消息，避免同一结果重复写三次。`test/esm.test.ts` 检查 src 里没有不经 createRequire 的 `require(`（vitest 自带 require，测试发现不了这类问题）。
- 后台通知发到工作话题（同一提交）查的是不存在的 `conversations.key` 列，且回复型目标被提前丢弃，通知发不出去；改为 `external_id`，放行 `replyTo` 目标。
- 自动推进上限可设置：`agents.autoAdvance.turns`（多 Agent 工作本人上次说话后最多自动交办几次，默认 6）、`codeRounds`（编码交办自动改到第几轮，默认 3）；设置 → Agent → 自动推进。
- 思考气泡：单个事件内容上限从 4000 字降到 1000 字（飞书按字节限长），工具参数和结果同样截断；网关或能力类失败只停 30 分钟，不再整个进程停用。
- 飞书里问助理：思考气泡可用时不再先发“处理中”卡片，只加“处理中”表情，有结论再发回答；气泡 15 秒内没出来才退回进度卡片。
- 规则交给 Agent 并“在消息下开话题”时不再先发“按规则处理这条消息”的卡片，Agent 的气泡或回答以话题回复开出话题（`replyAt`）。
- 规则可以等待与跳过：`trigger.waitMinutes`（命中后等几分钟，`rule-fire` 运行）、`trigger.unless`（`owner-engaged` 本人已在讨论里、`answered` 已有人回复）；动手时读话题或前后半小时的讨论（`src/rules/context.ts`：已存消息 + 一次只读 lark-cli 列表），模型判断也带上讨论。
- Agent 回复方式 `silent`（静默排查）：不开话题、不发气泡、最后文字不发出；任务附上讨论和怎么决定发不发、追问什么；它在话题里发过言就跟进该话题 24 小时（新消息一分钟后交回同一 Agent 会话），本人在话题里说话即停止。

## 2026-10-22：移除“Oncall 本人被 @ 保留”

- 10-20 加入的 `lark.capture.mentionRetention`（`lark-retention.ts`、`lark-event-queue.ts`、`omem lark retention-status`、`docs/v2/lark-mention-retention.md`）整体移除：它依赖公司内部的工单命令行，按工单系统的字段做群映射，绕开规则系统另写了一套“被 @ → 优先采集 → 邀请机器人”，还让这些群跳过规则和监听。同样的事用规则表达（条件“@ 了本人”，动作“优先采集”“拉机器人进群”）；要核对是不是值班工单群，交给 Agent 档案挂的值班技能（内部命令行写在技能里，`library/_skills`，不进仓库）。
- 机器人每分钟回读近 72 小时消息、失败事件持久队列只服务于这些群，一并移除；`im.chat.member.user.deleted_v1`、`im.chat.disbanded_v1` 不再订阅。
- 同一提交里通用的部分保留：历史回溯按远端页令牌续读、两路消息共用 `lark_messages` 与原件行、@ 我的消息写进各群原件。

## 2026-10-22：访客提问、规则给直接 @ 让路、私聊指令

- 有人 @ 机器人时规则让开：`markAddressed` 在 `rule_handled` 记一条 `@bot`，`consider` 遇到就跳过（含跟进话题的接续），机器人和采集两路送来都一样。别的机器人 @ 它照常走规则。
- 访客模式 `lark.guests`（默认关）：未登记的人在群里 @ 机器人（`p2p` 时也包括私聊机器人）、别的机器人 @ 它且没有规则接手 → `guest` 运行。新内置角色 `gatekeeper`（判断 answer / refuse / ignore，输出 JSON）和 `guest`（只读工具，空间是群所在空间——个人空间不算——加 `guests.spaces`，都没有时用一个空的 `guest` 空间）；`prepareRun` 对 `guest` 不给技能、相关空间和本人偏好。每人每小时 `perHour` 次。
- 私聊指令 `lark.commands`（默认关）：`main.ts` 每分钟调 `pollOwnerCommands`，用 `+messages-search --sender <本人> --chat-type p2p` 找本人发的 `/ai`、`/ai拉群`（kv `lark_cmd:<消息id>` 去重），排 `lark-command` 运行。`/ai`：主助手（`runRole`，不能发飞书）读最近的私聊处理，结果以本人身份 `+messages-send --as user --markdown` 发回私聊，加署名；回 `NO_REPLY` 时只通知本人；按私聊续 Agent 会话（kv `lark_cmd_session:<会话>`）。`/ai拉群`：以本人身份 `+chat-create --users <对方> --bots <lark.appId>`，机器人在新群里先说明来由，再经 `answerFromChannel` 带上私聊作上下文回答。
- AGENTS.md 的飞书身份约定改为：以本人身份写只有规则里的“拉机器人进群”和本人亲手发的私聊指令。

## 2026-10-22：本人在群时的访客、最近打开的文档、运行筛选

- `lark.guests.ownerPresent`：本人也在的群里，访客可以照常受限（`guest`）、把关后交给主助手（`gated`，guest 运行带 `gateOnly`，只判断）或直接交给主助手（`free`）。交给主助手时按本人身份运行，`Inbound.asker` 写进消息 meta，会话里显示为“某某（群里的同事，不是本人；本人也在这个群）”。本人在不在群：`ownerInChat` 用机器人的群成员接口，缓存半小时，查不到当不在。
- 最近打开的文档：`captureRecentDocs` 在每次采集里排在 @我 之后、会话之前，`drive +search --opened-since` 列本人最近打开的 docx / doc / wiki，没存过的用 `importUrl` 读进采集空间，每次最多 10 篇；`lark.capture.recentDocs`（默认开）、`recentDocsDays`（默认 7）。远程只读命令 `lark-recent-docs`。
- 运行记录：`/api/runs?kind=` 可逗号分隔多个，`agent:<名>` 是某个 Agent 档案的运行；页面上换成可多选的筛选，补上 Agent 档案、访客提问、私聊指令等类型。静默判断改为 `isQuiet`（QUIET 前面有一句话也算），迁移把以前漏判的巡检等运行补标；勾选框改名“含无事可报”。

## 2026-10-22：对话前带上相关记忆

- 记忆也有向量了：迁移给 `memories` 加 `embedding`，`embedPendingMemories`（`src/search/embeddings.ts`）在后台循环、`omem setup embeddings` 里跟在片段后面补齐；换向量模型时一起清空，`updateMemoryText` 改了内容就清掉这条的向量。
- `src/memory/passive.ts` 的 `passiveRecall`：消息向量与记忆向量余弦 ≥ `memory.passive.threshold`（默认 0.6）的、最多 `limit`（5）条，限定在本次运行可读的空间、共享或本档案的记忆、无归属或本人的；不含偏好和经验（它们在 `learnedContext` 里每次都带）。
- `sessions.ts` 的 `threadTurn`：本人（或登记用户）的新消息才查，监听群、协作进展、编码交办结束不查；结果作为“可能相关的记忆”接在新消息后面；同一 Agent 会话里带过的不再带（`passiveSeen`，会话重开后重新算）。访客运行（`prepareRun` 的 `recall` 为 null）不带。
- 召回统计：`memory_recalls.via`（`recall` / `passive`），被动带上的用上与否照常按回答里有没有 `mem:<id>` 判断；“记忆 → 召回”多显示一句被动带上的次数与命中率。设置 → 检索 可开关、调门槛。
- 校准与对照见 `docs/v2/evaluation.md`“对话前带上相关记忆”：0.6 时正例约八成带上相关记忆、带上的 96% 相关，反例一成误带；VCPToolBox 的 RiverMemo 在同样数据和向量下比直接余弦低 11 个点，没有引入标签图联想。

## 2026-10-22：写记忆前先对照已有的

- `src/memory/passive.ts` 拆出 `nearMemories`（按向量找相近记忆，被动召回、整理、写入检查共用）。
- 整理新材料：`jobs.ts` 的 `knownNearMaterial` 把新内容按 1500 字切几段，各取相近记忆（余弦 ≥ 0.6，当前空间和相关空间），最多 12 条附在 ingest 任务后。
- `remember` 工具：Agent 写入前 `memoriesNearWrite` 找同一空间、同一档案可见的相近记忆（向量 ≥ `SAME_TOPIC` 0.75；没有向量时主题名相同或两字相似度 ≥ 0.3），有就返回 409 列出它们和已有的主题名、标签，Agent 用 `supersede`、放弃，或带 `distinct_from` 重新调用。本人写入不拦。
- 做梦整理：`sameTopicPairs` 在有变化的记忆和同空间其他记忆之间找向量相近的对，列进 dreamer 任务。
- `roles/_common.md` “怎么写记忆”加“先看已有的再写”；`skills/omem/SKILL.md` 写了 `distinct_from`。

## 2026-10-22：思考气泡收尾竞态与诊断日志

- `lark-cot.ts` 在上传期间收到新文字、工具状态或结束信号后，继续补推事件，再检查所有推理节点和工具是否结束；已关闭的段落收到迟到文字时另开节点，避免丢末尾文字或缺少 MESSAGE_END 就发 RUN_FINISHED。
- 原先 30 秒兜底只重复检查，缺少工具完成事件时会一直等待。现在从首次结束请求计时，到期标记缺失工具状态并收尾，重复 finish 不延长截止时间，终态清理定时器。
- 新增 `lark-cot` 结构化诊断：运行/气泡/消息 ID、请求序号、接口阶段、事件类型及 UTF-8 字节数、耗时、错误码和可用的服务端 logId。成功与请求写标准输出，失败与超时写标准错误；不记录正文、工具参数或原始错误响应。清理失败单独留痕，内容超长按业务响应和 HTTP 异常统一识别。
- `test/lark-cot.test.ts` 用假客户端控制请求完成时序，覆盖并发收尾、分批、迟到/缺失工具状态及各阶段错误和日志脱敏。历史隐藏提示的直接原因仍无法由旧日志确定；本次修复已复现的协议缺陷，真实飞书展示待部署验收。

## 2026-10-23：发送者名字查不到时短暂不再查

- `src/channels/lark-sender.ts`：名字没查到（本人不在的群里机器人发的消息 lark-cli 读不到、通讯录权限缺失）也缓存 2 分钟，之后再试；原先每条消息都会在处理前再起一次 lark-cli 或调一次通讯录接口。

## 2026-10-23：git 不再为临时仓库留下 fsmonitor 进程

- 用户配置里开了 `core.fsmonitor` 时，git 对每个碰到的仓库起一个脱离的 `fsmonitor--daemon`，仓库目录删掉后进程还在。测试里每个应用都有一个临时知识库仓库，交办编码也开临时 worktree，累积了几千个常驻进程，占满提交内存后测试进程分配失败。
- `src/core/git.ts` 的 `disableGitFsmonitor` 用 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` 把 `core.fsmonitor=false` 放进进程环境（`App.open` 调用，测试在 `test/setup.ts`），omem 和它启动的 Agent 跑的 git 都继承；已在环境里设过就不重复。

## 2026-10-23：定时 / 消息唤醒

- `src/agents/wakes.ts`：`wake_later` → `scheduleWake` 建 `kind=wake` 的排队运行（`not_before` 为唤醒时间，`wakeTime` 限 1 分钟到 7 天）；到点 `fireWake`。`wake_on_message` → `saveRule` 带 `temporary`（`expiresAt`、`once`、`setBy`、`watch`），条件是群 id 加参数给的条件（默认排除机器人），动作 `wake`；`runAction` 的 `wake` 调 `fireWake`，`once` 时触发后 `deleteRule`；`consider` 跳过过期的，巡检 `expireTemporaryRules` 删除。普通规则不能带 `wake`（`saveRule` 拒绝）。迁移：`rules.temporary`。
- `fireWake`：目标是会话时加一条 `meta.wake` 的助理侧记录，有排队的 ask 就并进去，否则开 `input.wake` 的 ask 运行；`sessions.ts` 在这一轮只有唤醒记录时用 `# 唤醒` + `WAKE_NOTE` 框起来（不做被动召回），`jobs.ts` 的 ask 处理器把回答 `deliverToThread`，QUIET 不发。目标是档案时开 `kind=agent` 运行（`threadId` 指回原会话，唤醒自己时带上次的 `resumeSessionId`）。`skipIfOwnerSpoke` 时本人之后说过话就跳过。
- 每个会话或档案最多 5 个待触发（`checkPending`），`cancel_wake` 列出 / 取消；主助手和 Agent 档案都有这三个工具。`GET /api/wakes`、`DELETE /api/wakes/:id`；`GET /api/rules` 不再返回临时规则，规则页列表底部单列“临时唤醒”。
- `roles/_common.md` 加“等一会再接着做”，`docs/v2/rules.md` 加“临时规则”，`skills/omem/SKILL.md` 列了新工具。

## 2026-10-23：工作文件、案例页、日常不足信号

- 工作文件（`src/sources/work.ts`）：原件 `kind=work`，uri `work/<路径>`，meta 记 `expiresAt`、`links`（`item` / `rule`）、写入它的运行和写入次数。`write_file` 工具（主助手和 Agent 档案）：`replace` / `append`，`expires` 接受 `30d`、`12h`、`2w`、日期或 `never`；挂事项时新建会在事项时间线记一笔，规则触发的运行里写的默认挂到那条规则。巡检先 `expireWorkFiles`，过期的变墓碑（`deleteSource`），同一路径再写是新文件。不排进 ingest。
- 事项：`read_item` 和 `GET /api/items/:id` 带 `files`，网页事项详情显示“工作文件”。规则：`agentAction` / `silentAgent` 的任务里加“这条规则的工作文件”（`ruleFiles`）。原件页可按“工作文件”筛，详情显示过期时间。
- 案例：`write_page` 的 kind 加 `case`；`upsert_item` 把有 4 条以上时间线的事项标成 done 时，返回里提示写 `cases/<主题>` 案例页并记一条指向它的 experience。`roles/_common.md` 加“工作文件与案例”。
- 不足信号（`src/memory/gaps.ts`）：失败运行按类型计数、回答开头说没找到（`NOT_FOUND`）配上前一句提问、本人以“不对 / 错了 / 你搞错…”开头的消息配上前一条回答、复核撤回、写入检查拦下（按原因计数）、被动召回带上 / 用上。做梦整理任务新增一段（有信号时即使没有别的变化也会跑），`roles/dreamer.md` 第 5a 条说明怎么处理；`GET /api/shortcomings?days=`，网页“记忆 → 不足”。

## 2026-10-23：问本人、下一步按钮、工具审批

- 新表 `asks`（`src/agents/asks.ts`）：`question` / `suggestion` / `approval` 三种，带选项（`label`，可选 `message`：点了替本人说的话）、是否允许文字回答、状态、回答、是否已被 Agent 拿到（`consumed`）、何时展示（`shown_at`）。
- 工具：`ask_owner`（先等 `wait_seconds`，默认 40）、`wait_answer`（每次 ≤ 50 秒，codex 等 MCP 客户端默认 60 秒超时）、`suggest_next`（只在有会话的运行里）。`prepareRun` 给主助手和 Agent 档案前两个，非访客都给 `wait_answer`。
- 回答去哪：有 Agent 在等就直接给它；提问的运行还在跑就先留着，运行结束时 `settleAsks`（`runs.ts` 收尾调用）作为 `[回答] …` 消息送回会话；没有会话的通知本人。建议按钮在运行结束后展示（飞书机器人回完话立刻 `showSuggestions`，其他情况 4 秒后），点了用 `receive(fromAsk)` 替本人说出 `message`。
- 对话里回复即回答：`receive` 先调 `answerFromMessage`——回编号选最近带选项的提问或建议；有提问就以这句话作答（Agent 在等时这条消息不再开新一轮）；审批要“批准 / 拒绝 + 理由”；其余情况让旧建议失效。`fromAsk`、群里别人说的话、访客不参与。
- 审批：`config.approvals.tools`（默认空）、`waitSeconds`；`callTool` 对列出的工具先 `held`：建审批、等一会；批准后 `setApprovalExecutor` 用当时的工具上下文执行，结果写进 `result`；拒绝理由经 `describeAnswer` 回给 Agent。
- 展示：飞书 `src/channels/lark-asks.ts`（卡片：选项按钮 + 文字框表单；审批是批准 / 拒绝；答完卡片改成记录；交互 `purpose: "ask"`，`lark-actions.ts` 转给 `handleAskAction`）；网页 `AskCard.vue`（对话页输入框上方、回答下方，“今天”页“等你回答”），接口 `GET /api/asks`、`POST /api/asks/:id/answer`，事件 `type: "ask"`；Telegram / OneBot 等发编号列表。
- `roles/_common.md` 加“问本人、给本人选项”，`skills/omem/SKILL.md` 列了新工具。

## 2026-10-23：飞书知识库、加急与只给部分人看、以本人身份写文档

- 知识库（`src/channels/lark-wiki.ts`）：`wikiNode`（`wiki +node-get`，131014 = 不在知识库）、`wikiChildren`（`+node-list` 分页）、`personalLibrary`（`wiki spaces get my_library`）。`importLarkDocument` 对 `/wiki/` 页面在 depth > 0 时把文档类子节点当同一层的链接（`docWikiChildren`，正文没链到的追加到末尾“知识库子页面”），整条导入共享预算 `docMaxPerImport`（`opts.budget`）。
- 知识库爬取：kv `lark_wiki_crawls` 存队列、已见节点、读到的原件 id；`crawlLoop` 每篇 `importLarkDocument(depth 0, wikiChildren false)`，新建的页面用 `relinkParent` 改掉此前页面里的链接；`batch` 读完一批 `paused`，`continueCrawl` 继续；缺权限时暂停不计失败；`resumeCrawls` 启动时继续；读到的交给整理（kv `lark_wiki_crawls:<id>` 记已交出的数量）。工具 `lark_wiki_crawl`，`omem lark wiki-crawl`，`GET /api/lark/wiki-crawls`、`POST /api/lark/wiki-crawls/:id/(continue|stop)`。`import_url` 加 `depth`。
- 授权（`src/channels/lark-auth.ts`）：lark-cli 错误带 `missing_scopes` 时抛 `LarkScopeError`；`asOwner` 把它变成一次 `auth login --scope … --no-wait --json`，链接经 `notify` 发给本人，后台 `--device-code` 等确认；同一组权限有效期内只发一次链接。`USER_FEATURES` 列读知识库和写文档要的权限，`omem lark user-permissions [--grant]`、`GET/POST /api/lark/user-permissions`、设置页“检查 lark-cli 授权”。
- 写文档（`src/channels/lark-doc-write.ts`）：`placeFor`（不填 / `my_library` = 个人文档库根目录；知识库页面；云空间文件夹）和 `docPlace` 判断位置是不是本人自己的（个人文档库，或 `drive metas` 的 owner 是 lark-cli 登录的本人）。工具 `lark_doc_create` / `lark_doc_update` / `lark_doc_move`：不是本人自己的位置时经 `held` 审批，问题写明知识库名和父页面，执行器带 `approved: true` 重跑不再拦；外部 Agent（工具上下文没有 `larkChats`）不能用；只有主人能用。
- 加急与只给部分人看：`larkTarget` 加 `urgent`（≤ 10 人）和 `only_to`（≤ 20 人），`larkDelivery` 按 `ctx.larkPowers` 放行并用 `resolveMention` 对人；`lark-send.ts` 的 `deliverLark`（`urgentLark` = `im.message.urgentApp`，`sendEphemeral` = `/ephemeral/v1/send`，按 `ou_` 前缀选 open_id / user_id）；草稿确认带上 `delivery`。规则 agent 动作加 `allowUrgent` / `allowPrivate`（`runner.ts` 的 `LarkAccess`，本人自己的运行两样都有），任务里写一句什么时候可以用；规则草稿生成会按原话勾上；规则页两个开关。
- `skills/library/lark-messaging/SKILL.md` 加加急和只给部分人看；`roles/assistant.md` 加知识库爬取和写文档的工具与做法。

### 2026-10-23：规则档案的临时复查

规则触发的档案给自己设唤醒时，延续原空间、用户身份、群聊投递范围与草稿/静默设置，复查可回到原话题。指定其他档案不会继承原运行的渠道权限或会话。档案唤醒返回 QUIET 时不投递，避免无变化也发消息。入口：`src/agents/wakes.ts`、`jobs.ts`；回归：`test/wakes.test.ts`、`test/lark.test.ts`。

## 2026-10-23：长说明的确认弹窗

- 临时唤醒取消时，标题与说明分开显示，说明不再挤进标题。
- `DialogHost` 的内容区支持长链接换行和限高滚动，操作区保留在可见范围；关联说明的无障碍标签。桌面、手机和较矮视口检查换行、滚动、取消与焦点返回。


## 2026-10-23：技能目录、档案默认 AI 与任务选型

- 技能页可展开多层目录，查看、编辑、新建和删除附属文本文件，切换文件时保护未保存内容。入口仍为 SKILL.md，附属文件列表改为递归相对路径；文件读写拒绝越界、符号链接、二进制和超过 2 MB 的文本，修改保留知识库 Git 历史。
- 内置角色的默认后端、模型和强度从设置页移到 Agent 档案页，继续使用原有 roles / roleModels 配置，无需迁移。与自定义档案共用检测控件：可用后端优先，模型和强度来自检测结果，无法检测时手填。
- 设置页新增任务选型：自主选择开关、总体偏好、具体后端/模型/强度及适用说明。工具 list_ai_backends 提供实际可用性和偏好；交办、独立工作会话续轮、请教、编码和评审可临时选择 AI 并记录理由，不覆盖档案默认。临时 assistant 任务无需新建档案，受调用者权限限制，禁止再次交办。
- 当前已开始的一轮不切换 AI；后台角色继续用角色默认。不同 AI 的工作轮次不复用旧后端会话；编码自动续轮保留本次编码和评审选择。ACP 实际握手发现明确指定的模型或强度不支持时失败，不悄悄使用默认值。
- 验证明细见 docs/v2/acceptance.md 对应条目。

## 空间与归档（10-23）

- 问答、原件和运行列表按所选空间展示，切换空间退出旧详情。任务规则保存所属空间、可选执行空间与结果会话；主助手成为默认执行者，不再选最接近的专用档案。旧无空间任务规则保持全局。入口：`src/rules/`、`src/core/capture-space.ts`、`web/src/views/Ask.vue`、`Runs.vue`。
- 规则分为任务规则和归档规则。归档先尊重手动归属及来源绑定，再按创建顺序匹配确定性条件，未命中的由 `archivist` 判断，不确定留个人。自然语言编写由 `archive-rule-writer` 调用草稿工具，核对保存后生效。入口：`src/sources/archive.ts`、两个新角色说明、`web/src/views/ArchiveRules.vue`。
- 历史材料可预览规则结果、校验后应用或交给 AI 判断；原件详情可指定归属并查记录。迁移保留 ID、正文、引用、消息位置与切片 ID，更新空间索引并失效向量缓存，原采集入口别名避免重复副本。已有记忆、事项和 Wiki 不自动搬动。

- 空间与归档补验：真实 Codex 完成隔离归属判断和自然语言草稿匹配，浏览器完成空间切换、规则保存及手动迁移。修正文本附件漏归档、归档后逐份重复排整理任务，以及模型使用未知材料类型的问题；类型条件明确使用 doc 等内部键名，并在草稿和保存入口统一校验。

### 2026-10-23：归档顺序、材料整理与飞书节点

- 移除归档规则的数字优先级，按创建顺序首条命中；编辑不改变顺序，旧规则自动迁移。
- 归档规则页使用任务规则的左列表、右编辑结构；加号左侧新增整理入口，在右侧预览并应用已有材料的归属。
- 飞书文档采集保存知识库 ID、节点及父节点，包括零深度导入和正文未变的刷新；标题、正文和上述元数据均可匹配。增加固定只读设备命令 `lark-wiki-node` 查询节点。

### 2026-10-24：归档条件改为名称和目录

- 归档移除 ID、token、作者和父页面地址条件；旧规则含已移除字段时整条停用，保留原始配置供核对，不自动放宽条件。
- 材料类型与采集渠道显示中文选项，逐条说明字段用途；按名称和文字匹配，不推测主题或同义词。
- 飞书采集保存知识库名、直接父目录名和完整祖先目录路径；失败或目录不完整时不使用旧名称匹配，排除未知字段也不命中。
- 整理已有材料可单独更新飞书目录，进度持久保存，正文、切片与引用不变；共同的祖先节点短时缓存，主动刷新清除缓存。

## Wiki 生成入口（10-24）

聊天新增 `generate_wiki`，与网页、CLI 共用 `src/wiki/generate.ts` 的规划与逐页写作流程。`focus` 完整传给每个写作子运行，保留发起用户和材料只读范围，页面只写入目标空间。助手不再自己先写工作文件或尝试用普通交办调用内置 Wiki 角色；规划、写作、检查说明补充代码优先、过时文档辨别和草稿核实。自定义角色需合并源码更新才能取得新工具与说明。

## 2026-10-24：分档、多角度评审方案（设计，未实现）

- 现状是交办编码链单个 `reviewer` 评审、自动最多 3 轮（`src/agents/code-chain.ts`）。新设计在中大型改动上扩展：`docs/v2/review.md`。
- **工作集（workset）**：一个需求的跨空间上下文容器，只引用不复制，成员含文档、聊天、会话、文件、仓库空间与目标分支/基线，带版本快照与 stale 提示；新增 worksets / workset_members 表与 `create_workset` 等工具，可挂事项。
- **业务理解简报**：新角色 `business-analyst` 编码前从工作集提取带引用的业务规则和编号变更点（CP），本人确认或 lead 采信；业务规则仍沉淀到记忆/Wiki，不建第二份知识。
- **分档与评审委员会**：新角色 `review-lead` 编码前后两次 triage（light/standard/full，确定性预筛 + 理由可调）；功能（现有 reviewer）、风格规范、架构、业务理解、历史问题回扫五个只读赛道各跑独立会话、可分别配模型；新增 reviews / review_findings 表与 `submit_review`，lead 去重裁决、增量复审，轮数不收敛/僵持/方案分歧时停下来升级本人，防死循环。light 档保持现有链路不变。
- **变更解读视图**：以需求维度组织的三栏界面（业务 CP ↔ 代码行双向定位、气泡图例引导、流程图、分轮 diff、就地提问），引用统一走 CitationDrawer；（初稿原型已被修订版替换，见下）。分四阶段落地，未实现。

## 规则页整理（10-24）

- 去掉侧栏“规则”下的二级菜单，改为规则列表顶部的“任务规则 / 归档规则”切换（同 Agent 页的“档案 / 技能”），`/rules/tasks` 重定向到 `/rules`。
- 任务规则：空间选择并入“什么时候看”（“所有空间的群”或某个空间），新建规则默认不限空间；“结果发到”只在定时规则要回复时出现在动作里；动作的空间选择改为“默认空间”并用提示说明解析顺序；判断方式与说明同行，缩短触发说明。
- 归档规则：整理入口从图标按钮改为列表底部的“整理已有材料”；选中的规则可上移调整匹配顺序；文案统一为“规则原话 / 从原话生成条件”。原件详情的归属改为标题下一行“空间 · 依据 + 换空间”，历次归属显示空间名。

## 评审方案修订（10-24，设计，未实现）

- 档位改为可编辑的有序清单 `config.review.tiers`（默认轻 / 标准 / 完整），每档的触发条件（复用规则条件编辑器，字段为宿主算好的改动指标）、评审项、最多轮数、是否先看计划、业务简报策略都在 Agent 页新增的“评审”标签里改，可增删档位。
- 评审项（初稿的“赛道”）就是 Agent 档案：内置五项是内置角色，走现有自定义 / 合并；专项（如安全评审）新建档案勾“用作评审项”，可设“额外在什么时候加上”和挡住应用的级别；作为评审项运行时强制只读。
- 工作集并入事项：事项加材料清单（`item_materials`），简报和变更视图挂在事项上。
- 评审结果放在运行详情的“概览 / 变更 / 评审 / 活动”标签里，讲解与就地提问用右侧抽屉；去掉独立三栏页面、首次引导和行内气泡。新原型 `docs/v2/design/review-prototype.html` 直接引用 `web/src/styles.css`。
- 落地顺序改为：可配置多评审项 → review-lead 协调 → 事项材料与简报 → 变更视图。

## 分档评审第一阶段（10-24）

- `config.review`：有序档位（默认轻 / 标准 / 完整，`when` 条件、`guide` 一句话说明、`checks`、`maxRounds`）和评审项设置（`label`、`blocks` 阻塞级别、`when`、`guide`）。条件字段为宿主算的改动指标（行数、文件数、仓库数、路径、检查是否通过、任务原文），比较新增 `gte / lte`。第一轮先按条件选档，再请模型对照说明判断能否升档、加评审项。
- 新内置角色 `review-business` / `review-arch` / `review-style` / `review-history`；Agent 档案挂成评审项后也可参加。评审项运行时只给只读工具和 `submit_review`，不带额外 MCP，不能写。
- `submit_review` 写 `reviews` / `review_findings`；没调用的按文字结论兜底。达到该项阻塞级别的问题合成修改单交给编码续轮；轮数上限随档位（`CodeChain.maxRounds`）。
- `delegate_code` 新增 `review_tier`、`review_checks`；`/api/delegate` 接受 `reviewTier`。接口：`/api/review-settings`、`/api/review-options`、`/api/runs/:id/reviews`、`/api/runs/:id/file`。
- 界面：Agent 页“评审”标签；运行详情“本次评审”、按行号的 diff 与上下展开、选中内容就地提问（每个运行一个问答会话）。
- 同期修正：定时规则“先给我看”发到飞书会话时草稿落到原话题，网页会话按直接回复；归档迁移只让两个相关空间的向量重新加载。

## 分档评审第二阶段：评审负责人（10-24）

- 新内置角色 `review-lead` 和工具 `rule_review`（只在负责人运行里可用）；评审一轮的逻辑移到 `src/agents/review-chain.ts`，可在编码运行末尾执行，也可在本人确认计划后作为 `review` 运行执行。
- 档位新增 `lead`（默认标准、完整开）、`confirmPlan`（默认完整开）；`config.review.rereviewAllEvery` 默认 2。编码前预估档位，编码后判档可参考预估、开负责人的档可降一档。
- 四种停止条件（轮数上限、不收敛、僵持、方案分歧）写 `reviewStop`，链的 `waitReason` 同名；提问卡片的答复通过 `registerAskHandler` 处理（确认计划、继续 / 接受 / 停下）。
- `review_findings` 增加 `merged_into`、`triage_note`；`/api/runs/:id/reviews` 返回预估、各轮负责人结论、停止原因和待答的决定。飞书进度卡片加评审项行与负责人结论。

## 界面整理（10-24）

- 设置 → Agent“排队与兜底”改成逐行选择后端 / 模型 / 强度（可上移、移除），排队等待时间改为下拉；记忆对比运行的强度有选项时也用下拉。
- 空间卡片精简：说明限两行，目录只显示最后一级，相关空间一行，原件数、页面数和子模块状态放在底部。
- 事项卡片长标题、长等待对象不再溢出，空间标签显示空间名；全局 textarea 只能纵向拖动，`.stack` / `.card` / `.field` 里的段落去掉浏览器默认外边距。
- `delegate_code` 新增可选 `title`，运行列表和进度卡片用它代替任务第一行。
- 编码运行的 Agent 会话改为保留（`persistSession`），之前 Codex CLI 的编码会话是临时的，第 2 轮续接必然失败；续接仍失败时在同一工作区换新会话并带上原始任务。`continue_code_run` 续接最近一个有会话的轮次。
- review-lead：低于阻塞级别的待确认点用通过并写“建议你确认”，只有挡住应用的分歧才上报；结论不写问题编号。运行页在等你确认计划 / 做决定时不再重复显示同样的说明。
- 设置保存后只在改了启动时才读的设置（监听地址和端口、向量检索、飞书机器人开关和应用、Telegram、OneBot）时提示要重启，并列出是哪几项；`PUT /api/settings` 返回 `restart`（改动的启动项名称），去掉总是为真的 `restartNeeded`。
- 规则页的临时唤醒可以点开看详情（只读）。全局选中文字改为深色字，深色按钮和提示上选中的文字不再看不清。

## 回溯速度、换 AI、运行显示模型（10-25）

- 飞书历史回溯从 10 分钟一次的采集里拆出来，在独立后台循环按 `lark.capture.backfill.pagesPerMinute`（默认 20）和 `concurrency`（默认 2）推进，限流时退避（30 秒起翻倍，最长 10 分钟）；配置每轮读取，改了立即生效。去掉 `pagesPerPoll`。`set_lark_backfill` 新增 `pages_per_minute`、`concurrency`，返回总体进度；远程命令新增 `backfill-status`。
- `generate_wiki` 新增 `execution`，规划和各页写作都用它（`input.ai`）；新工具 `switch_run_ai` 给排队 / 进行中 / 失败的运行及子运行换 AI。`runRole` 在调用方没给选择时用运行自己的 `input.ai`（编码和评审运行除外）。
- 运行记录新增 `ai` 列（后端、模型、强度），在准备运行时记下主角色的选择，回退到别的后端时更新；运行列表和详情显示。排队中的运行返回 `waiting`（等空位、等同一会话前面的运行、定时）：这是 omem 自己的排队，开始时才选定模型；后端自己的排队在运行开始后的过程里显示。

## 网页缓存与预加载（10-25）

- 构建产物 `assets/*`（文件名带哈希）返回 `cache-control: public, max-age=31536000, immutable`，`index.html` 和前端路由回退返回 `no-cache`；之前全部是 `max-age=0`，每次都要回源验证。
- 经中间节点转发（`/api/peers/:id/*`）时保留对方的 `cache-control`、`etag`、`last-modified`，并转发 `if-none-match`、`if-modified-since`；之前这些都被丢掉，`omem peer open` 打开经中转的设备时浏览器完全不缓存。
- 修正路由预加载：没写明 key 的路由（记忆、学习、Agent、规则、通知、设置）都被算成 `/` 互相覆盖，空闲预加载和悬停预加载对它们不生效；规则归档页也加入空闲预加载。

## 唤醒复查不留空气泡（10-25）

- 唤醒开的档案运行（`input.wake`）的思考气泡改为先收着不发（`startCot` 的 `defer`）；运行结束时 `endCot` 判断：回 QUIET 就丢掉，从不创建；有话要说就整段发出并收尾，再投递回复，顺序不变。实时发出的气泡如果运行最后是 QUIET，会被撤回（`finishCot` 的 `quiet`）。
- 唤醒开的 ask / agent 运行回 QUIET 时记 `quiet = 1`（之前对话类运行一律不记），`wake` 运行本身也记为无事可报；迁移把以前的补标。

## 多个飞书机器人、归属判断积压、任务选型、检测缓存（10-25）

- 新配置 `lark.bots`（`id`、`appId`、`agent`、`enabled`、`ownerOpenId`）和 `lark.botRelay`。每个额外机器人一条长连接，被 @ 或私聊时以绑定的 Agent 档案回答，会话 channel 为 `lark:<id>`；后续投递、`lark_*` 工具（`ToolContext.larkBot`）都经这个机器人发。群里每轮带 omem 机器人名单；回复里 `@名字` 由 `relayMentions` 在进程内交给对应机器人，连续转交有上限，有人发话清零。`lark-send.ts` 新增 `setLarkBotClient`、`larkClientFor`、`postedByOmem`，`Target.bot`；`reactLark` / `unreactLark` / `updateLarkCard` / `uploadLark` 多一个 `bot` 参数。`omem setup` 加“添加机器人”，设置 → 渠道加“其他机器人”。
- 常驻机器上积压了上千个“判断材料归属”：历史回溯按月写的 `lark:<会话>@<月份>` 原件每写一页都重排一次；`queueArchive` 只看最早的排队任务，它满 40 份后每次都新建单份任务且不去重。改为合并进任何未满的排队任务、全队列去重；同一会话已判断过的（留在个人空间的聊天、已判断会话的历史月份）沿用判断；启动时 `compactArchiveQueue` 重新打包旧队列。迁移加了 `json_extract(meta,'$.chatId')` 的部分索引。
- 任务选型：之前候选只在 `list_ai_backends` 里，真实运行里一次自主选型都没有。现在打开自主选型且有候选时，能交办的运行的环境说明里有“任务选型”一节；`_common.md` 改为每次交办对照候选选择。
- 模型检测：`/api/profile-options` 的后端带上缓存的检测结果；前端 `lib/probes.ts` 各页面共用，同一标签页只问一次；显示检测时间。
- 运行记录页加状态筛选（全部 / 排队中 / 进行中 / 失败），筛选时列表随运行状态变化刷新（合并 0.4 秒内的事件）。

## 机器人能力一致（10-25）

- 主机器人和 `lark.bots` 跑同一套代码：`startLarkBot(app, ref)` 建连接，`setupLarkBot(app, ref, client)` 装处理逻辑（测试传假客户端）。原先额外机器人的简化处理（`onBotMessage` / `botTurn`）删掉，`registerMainRelay` 换成按机器人的 `registerRelay`。
- 新增 `core/bot-context.ts`：AsyncLocalStorage 记“以哪个机器人说话”。`larkClient()` 跟随它；运行开始时重置为主机器人，`runTool` 按 `ctx.larkBot` 切换；`lark-cot` 不再用 `setCotSdk` 设的全局客户端（只留给测试），每个气泡记 `bot`；进度卡片、提问卡片、编码进度、Agent 气泡、通知按所属会话选机器人；`card_interactions` 加 `bot` 列（迁移）。
- id 按应用区分：额外机器人不把自己看到的 open_id 写进 `lark_people.bot_open_id`，@ 人和读群成员用 `user_id`；卡片可操作人、本人在群判断（`ownerInChat`）用各自应用的 id；去掉“只有主机器人能加急 / 只给部分人看”的限制。
- 群的采集、规则、监听只做一次：`keepsRecords` 判断主机器人是否在群里。规则事件带 `bot`，规则交给的 Agent 通过这个机器人回复。

## 分支：评审已有分支、按分支检索（10-25）

- `code` 运行新增输入 `branches`（按仓库空间：`branch`、`base`）和 `fetch`：`checkoutBranch` 把分支 `--detach` 检出成 worktree 再 `reset --soft` 到分叉点，跳过编码，`coderSummary` 是提交列表；`reviewRound` 对它不续轮、不发升级提问，通知标题“分支评审…”；`applyCodeRun` 拒绝，`continue_code_run` 拒绝并提示 `from_branch`。`createBranchReview` 是工具、接口和命令行共用的入口。
- `delegate_code` 新增 `from_branch`（输入 `fromBranches`）：worktree 从该分支开始。`/api/delegate` 接受 `fromBranch`，`omem delegate --from-branch`。
- 新工具 `review_branch`、`list_branches`；`search`、`find_symbol` 新增 `branch`。`review_branch` 和 `delegate_code` 一样不给外部 MCP、不给唤醒接手的回合和请教。
- `worktree-index.ts`：`indexBranch`（`git show` 读分支改过的文件，不检出；空间 `br-<仓库>-<分支>-<hash>`，类型仍是 `worktree`，设置里有 `branch`、`baseRef`、`commit`、`deleted`），`branchIndexes`、`refreshBranchIndexes`（`repo-sync` 时更新），`overlayRepo`；交办工作区也记下删除的文件。`sweepWorktreeSpaces` 删掉分支已不存在的分支索引。
- `search.ts` 的 `shadowedFiles`：检索空间里同时有仓库和它的工作区 / 分支索引时，仓库里被改过或删掉的同名文件不出现。工具层 `canRead`：能读仓库就能读它的工作区和分支索引。
- `core/git.ts`：`resolveRef`、`fetchBranch`、`defaultBaseRef`、`listBranches`（不列 `omem/<运行>` 交办分支）。
- 接口：`GET /api/spaces/:id/branches`、`POST|DELETE /api/spaces/:id/branches/index`、`POST /api/review-branch`、`/api/search?branch=`。命令行：`omem review-branch`、`omem branches`、`omem search --branch`。网页：运行页“交办”弹窗分“实现 / 评审分支”，可选起点分支、要评审的分支和基线。

## 原件关注程度、标注与存量整理（10-25）

- `sources` 加 `attention`（focus / reference / ignore，null 为一般）和 `attention_by`（owner / agent / rule，低的不覆盖高的）；新表 `source_notes`（行范围、outdated / wrong / key / note、以哪份为准）、`attention_rules`、`digest_jobs`、`digest_done`。`src/sources/attention.ts`。
- 检索：忽略的不进全文和向量召回（`includeIgnored` 例外），融合后按档和标注调整分数，命中带 `attention`、`notes`。`read_source` 开头列出本段的标注和档位。
- `upsertSource` 对没人定过档的新材料套用关注程度规则；`scheduleIngest` 跳过仅检索和忽略的；`ingest` 角色可写主题页、`annotate_source`、`set_source_attention`。
- 存量整理 `src/agents/digest.ts`：运行类型 `triage`（角色 `triager`）、`digest`（角色 `distiller`），定时任务 `digest` 每 10 分钟补排；连续 3 批失败暂停。
- 工具：`set_source_attention`、`annotate_source`、`attention_rules`、`digest_sources`；`list_sources` 加 `level`。接口：`/api/sources?level=`、`/api/sources/levels`、`PUT /api/sources/:id/attention`、`POST /api/sources/attention`（含 dryRun）、`/api/sources/:id/notes`、`DELETE /api/source-notes/:id`、`/api/attention-rules`、`/api/digest-jobs`。远程命令 `digest-status`、`source-levels`；命令行 `omem digest`。网页：原件页档位筛选、详情里的档位和标注、“整理”弹窗。

## 并行与模型容量、存量整理加速（10-25）

- `src/agents/capacity.ts`：按“来源 + 模型”计数的空位（来源是账号：`traex-cli` / `codex-cli` / `claude-cli` 的 `source` 指向对应 ACP 后端）。`config.agents.capacity`：`perModel`（默认 3），`limits` 带模型是该模型上限、不带模型是整个后端合计（可不设），0 表示不自动使用。`config.concurrency` 上限改为 32。
- `runRole`：开始前 `acquire`；默认模型满了按顺序换到角色在其他后端配置的模型（`roleModels`，`roleAlternatives`）和兜底，都满了等（状态“等模型空位”），重试也重新取空位；显式 execution 和档案任务不换。对话回合 `holdForRun` 计入占用但不等，运行结束 `releaseRun`。
- 选型：`routingGuide` 不再要求有候选，列出各模型占用和近 7 天完成、失败、中位时长（`loadLines`），豆包标明没有工具；`list_ai_backends` 返回每个模型的 used / limit / recent7d 与 `tools`；`validateExecution` 拒绝助手自选上限为 0 的模型。`choosableProfiles` 去掉已有 ACP 的同源命令行后端。
- 存量整理：任务加 `parallel`、`batch`、`chars`；`queueNextBatch` 补足到 `parallel` 批，各批材料不重叠（查在途批次的 `sourceIds`），不再用 lane；精读批次在任务里附带行号的正文（默认 15 万字、最多 40 份），分级默认每批 150 份。`updateDigestJob` / `PUT /api/digest-jobs/:id` / `digest_sources action=pace` / `omem digest --pace` 调速度；`after` 等另一个任务做完再开始（那个任务完成时立即补排）；`countDigest` 把做过后被降档的材料算进已完成（以前精读降档后从总数和进度里消失）。
- 接口 `GET /api/agents/load`；网页 设置 → Agent → 并行（`AiCapacity.vue`），整理弹窗可设同时几批、每批几份并调整进行中的任务。
- 评审角色：`review-style` 从“只报明确约定”扩展到通用代码质量（重复造轮子、为封装而封装、模块划分、命名、注释里的中间指令）；`reviewer`、`review-business`、`review-arch`、`review-history` 加常见漏项和迁移类改动的对照要求。
- 分支评审的可读范围：`CodeInput.readSpaces`（`review_branch` 的 `read_spaces`、`POST /api/review-branch` 的 `readSpaces`、`omem review-branch --read`），加进编码与评审运行的空间范围；需求文档在个人空间、迁移要对照源仓库时用。接口按发起人可访问的空间校验。
- 评审档位条件新增 `change.codeLines`（有效代码改动行数）：`reviewMetrics` 按 `isSourceFile`（`src/sources/chunk.ts`，源代码扩展名，排除 `.min.js`）只累计源代码文件的增删行；档位理由和负责人估计里同时写出总行数和有效代码行数。默认档位不变，可在 Agent 页 → 评审 改用它。

## 编码和评审结束的卡片、夜间通知早上补发（10-26）

- 评审结束（不再自动续轮时）发一张带按钮的卡片（提问 `review-done`，`review-chain.ts` 的 `askDone`）：结论、改动和检查、各级问题数和默认要改的前几个（严重及以上和负责人接受的，与网页默认选中一致）、需求拆分的变更点数。分支评审或没通过的交办：“按评审修改 / 先不改”，输入框的文字作为补充要求一起改；通过的交办：“应用到仓库 / 丢弃改动”。分支评审通过且没有要改的只发通知。停下来等本人决定的（`escalate`）也带上同样的摘要。
- 确认评审计划的卡片带上编码 Agent 的改动统计、检查结果和说明。
- 宿主自己的提问（带 `handler` 的：评审计划、评审结果、升级）在非飞书会话里发起时也发到本人和机器人的私聊（`lark-asks.ts` 的 `targetFor`）；Agent 的提问仍只在它的会话里。
- 在网页上开始修改、应用或丢弃后，评审结果卡片作废（`cancelHostAsks`）；网页“概览”不重复显示这张卡片。
- 免打扰时段（`notify.quietStart` / `quietEnd`）里的普通通知不再直接丢掉推送：记为待发（`deferNotification`），时段结束后每 5 分钟检查一次，仍未读且不满一天的补发（`takeDeferred`），三条以内逐条发，多了合成一张列表。

## 评审的过程按评审项分开看（10-26）

- `runs.ts` 的 `addRunEvent`：流式文字按标签（`phase` / `check`）分开合并，同一运行里并行的评审项各写各的文字行，存下的 `text` / `thought` 事件带上标签（之前只存 `{ text }`，并行时会混在一起）。
- `/api/runs/:id/reviews` 每轮带 `reviewRuns`（这一轮的交办下单独起的 `review` 运行：确认计划后的评审、重新评审、补拆分）。
- 网页 `ReviewProcess.vue`：有评审的交办，“活动”标签按编码 Agent、各评审项、需求拆分、评审负责人分节显示工具步骤、文字和思考，顶上是宿主的进度；“评审”标签每个评审项和负责人旁有“看过程”，跳到对应一节。升级前记录的文字没有标签，归在“没有分开记录的输出”。

## 需求拆分独立成一步、拒收抄错的引用、引用抽屉加宽（10-26）

- `review-chain.ts`：`reviewContext` 拼评审任务（原 `reviewRound` 开头）；`splitChangePoints` 用 `review-business` 角色只做需求拆分，提交工具 `submit_change_points`（评审会话都有，写进交办运行的 `output.changePoints`，按轮次）。档位里没有业务评审时和各评审项并行跑；`POST /api/runs/:id/change-points` 给已有的评审补一次（`review` 运行，`splitOnly`）。`/api/runs/:id/reviews` 每轮带 `changePoints`，网页优先用它，其次用业务评审的。
- `deadRefs`：`submit_review` 和 `submit_change_points` 里 `src:` / `mem:` 指向不存在的原件或记忆时拒收，让评审者核对后重交（模型常把 id 抄错一两个字符）。
- 引用抽屉：文档类原件默认加宽（`omem.drawerWide` 记住本人的选择），表格保持列宽、横向滚动，图片不超出。

## 按评审修改、本人对问题的决定、引用打开代码和文档（10-26）

- `src/agents/review-fix.ts`：`review_findings` 加 `decision`（fix / later / wontfix）和 `decision_note`。`setFindingDecision`：不改必须写理由，并在所属事项记一条 `decision` 事件（`materialsBrief` 列出“本人的业务决定”）。`decisionsBrief`：同一次工作各轮和 `fromReview` 指向的分支评审里暂不改、不改的问题，进评审任务，评审者不再提。`startFix`：选中的问题和本人补充的要求写成任务；交办编码续在原工作区（`queueNextCodeRound`），分支评审基于分支交办（`fromBranches`、`itemId`、`readSpaces`、`fromReview`，挂在发起评审的会话下）。
- 工具 `fix_review`（`fix` / `later` / `wontfix` 带理由 / `text`）；`read_run` 列出最新一轮评审问题的编号、负责人裁决和本人决定。接口 `PUT /api/runs/:id/findings/:fid`、`POST /api/runs/:id/fix`。
- 网页：概览的每个问题右侧“改 / 暂不改 / 不改”（默认负责人接受的和严重以上的要改），下面“按评审修改 / 再改一轮”框可写补充要求，开始后跳到新运行。
- 引用：`/api/runs/:id/file` 不必指定空间（路径可带仓库空间前缀），分支评审清理工作区后读分支提交上的文件，找不到时到评审可读空间的已索引原件里找；引用抽屉新增 `file` 类型，`refAction(ref, runId)` 把 `路径:行` 变成链接（问题位置、依据、变更点位置）。文档类原件（飞书文档、Markdown）在引用抽屉里按排版显示、被引的行单独标出，可切回原文行号（`lib/sources.ts` 的 `readsAsDocument`）。

## 事项材料、运行页评审标签、运行记录查找（10-25）

- `src/items/materials.ts`：表 `item_materials`（kind：source / conversation / repo / space / run，`ref`、`label`、`meta` 里有分支、基线、说明和加入时原件的 hash）。`addMaterials` 校验本人能看到、只能加自己的会话和运行；`materialViews` 给出可读、已删除、加入后有更新；`materialSpaces` 和 `materialsBrief` 给编码和评审用。
- `CodeInput.itemId`：`review_branch` / `delegate_code` 的 `item_id`，`POST /api/review-branch`、`/api/delegate` 的 `itemId`。编码和评审的可读空间加上材料所在空间，任务里附“所属事项”和材料清单；运行和分支自动成为材料（`linkRunToItem`），评审结束在事项时间线记一条；续轮带上 `itemId` 和 `readSpaces`。
- 工具：`upsert_item` 加 `materials_add / materials_remove`（只改材料时不动事项字段），`read_item` 返回 `materials`；`submit_review` 加 `change_points`（`reviews.change_points`），`roles/review-business.md` 要求提交变更点。
- 接口：`GET /api/items/:id` 带 `materials`（运行附最新一轮的结论），`POST /api/items/:id/materials`、`DELETE /api/items/:id/materials/:mid`；`GET /api/runs/:id` 的 `context.items`。
- 运行记录：`runs.roles`（`|coder|reviewer|`，`prepareRun` 记下内置角色，迁移按类型和评审记录补旧的），`/api/runs` 的 `kind=role:<名>`、`q`（标题、id、任务原文）、`brief`（不带输入输出）；网页每页 40 条。原件：`/api/sources/:id?window=`（聊天取最后几行）、`/api/sources/:id/messages?from=&to=`，列表每页 200 条。
- 网页：`lib/reviews.ts`（`useReviews`）、`ReviewSummary.vue`（概览）、`ReviewChecks.vue`（评审）、`ChangeView.vue`（变更，`DiffFile` 的 `points` / `active` 画标记和高亮）、`AskAboutRun` 的 `heading` 和插槽（讲解抽屉）、`ItemMaterials.vue`、`lib/refs.ts`（`refAction`）。
- 分支评审的说明写明 HEAD 在分叉点、改动在暂存区是正常的检出状态，评审者不要求“确认分支”。

## 内存观察、本地向量分批、回溯失败退避（10-25）

- `src/core/memory-watch.ts`：每 10 分钟记一次进程内存（RSS、V8 堆、external、ArrayBuffer），保留两天；`diag` 的 `memory` 给出当前细分、向量缓存大小和抽样历史，以及前后四分之一时段 V8 堆的最低值（持续上升才是泄漏；本地向量模型的内存池和向量矩阵是涨到峰值后持平）。
- 本地向量模型：一批里的文本按长度排序、按“条数 × 最长文本 ≤ 1.6 万字”分组再送入模型（整批按最长的补齐，注意力内存随长度平方增长），结果顺序不变；`embeddings.memArena: false` 关闭 onnxruntime 的 CPU 内存池（默认保持，速度优先）。
- 飞书历史回溯：每个会话记连续失败次数，失败后按 30 秒翻倍、最长 1 小时等待再试（`retryAt`）；本人不在群里、没有权限（230002 等）记为 `gaveUp`，不再重试；同一页失败 3 次后不再要求附件下载齐全，先保存消息继续翻页（缺的附件之后用 `lark fill-files` 补）。限流仍由整个回溯循环退避，不算会话的失败。本人重新回溯某个会话时清掉放弃和等待。`backfillOverview` 加 `waitingRetry`、`gaveUp`，`set_lark_backfill` 的进度里列出。以前只剩失败的会话时，回溯循环每十几秒重试一次、永不停止。
- 向量矩阵按页加载（每页 4000 行，页间让出事件循环），`VectorIndex.prepare` 异步加载，`search` 只看已加载的空间、未加载的在后台开始加载；`vectorSearch` 先 `prepare`。启动预热改成异步。复用的 chunk id 只淘汰装着旧向量的空间（以前清空全部缓存，下一次检索同步重读全部约 48 万向量）。起因：一次分支评审第一次检索 37 万向量的代码空间，主进程被一条同步查询卡住约 13 分钟，所有工具调用、回复和计时器都在等，评审项和同时在跑的整理全部按“600 秒无活动”失败。
- 评审项失败后自动等 30 秒重试一次（只重试失败的项）；仍失败的发卡片问本人是否重新评审（`review-retry`：重试评审 / 不用了，选重试或直接回一句补充要求即排一个新的 `review` 运行）。全部失败时运行仍记为失败，但卡片已发出；部分失败时其余结论照常交给负责人。
- 2026-11-07：部分评审项失败时，`review-retry` 卡片改为“只重试<该项>/只重试没完成的 / 全部重新评审 / 不用了”。只重试时新的 `review` 运行带 `input.only`，`reviewRound` 只跑这些项，其余项从这一轮的 `reviews` 行取结论（不重跑需求拆分），再交负责人裁决；直接回一句补充要求也只重试失败的项。按修改项推进的交办（其余项的问题已变成修改项）和全部失败时仍只有整轮重试。旧卡片按原来的“第一个选项 = 整轮重试”处理。回归：`test/review.test.ts`。

## 2026-10-26：定时规则选择群聊与缺失目标处理

“发到”补充已采集的飞书群，不要求先和助理建立会话。保存时创建或复用本人的群会话，不接管访客会话、不发送消息。缺少投递目标的旧规则明确失败，不再追加禁止发群的指令后私发本人；其他机器人会话保留对应机器人。见 `src/rules/destinations.ts`、`src/rules/actions.ts`、`web/src/views/Rules.vue` 和 `test/rule-destinations.test.ts`。

## 2026-10-26：网页独立评审修改可继续下一轮

修复从网页分支评审进入修改后，第二轮误要求问答会话链的问题。无会话链任务通过 `continueFrom`、`resumeSessionId` 复用工作区与编码会话，保留执行配置和来源评审；写事务内拒绝重复提交、工作区缺失或已释放的续轮。失败请求不关闭确认入口、不修改问题决定。实现与回归：`src/agents/review-fix.ts`、`test/review-fix.test.ts`。

## 2026-10-26：应用修改回原目标分支

编码修改按首轮目标分支选择接收工作区：已有工作区就复用，否则自动检出本地分支；只有远端记录时建立对应本地分支。仓库主目录保持原分支，不要求用户手动切换。确认框和结果显示目标分支及接收目录，结果可复制目录；应用后查看文件读取接收位置。多仓库先全部预检，失败清理本次新建的未改动接收工作区与分支；成功保留接收工作区，不自动提交或推送。旧分支任务从 `fromBranches` 或 `baseRef` 恢复目标。实现：`src/agents/code.ts`、`src/server/http.ts`、`web/src/views/Runs.vue`；回归：`test/code-worktrees.test.ts`、`test/branch-review.test.ts`。

## 2026-10-26：应用后的提交与推送

运行详情的接收位置新增 Git 面板：读取实际分支、HEAD、暂存 diff 和文件状态，填写信息后提交或提交并推送，也可仅推送已有提交。与主助手的 `code_git_status` / `code_git_action` 共用 `src/agents/code-git.ts`，按运行及仓库定位记录中的接收工作区，校验原仓库、原分支、空间权限与读取后的状态。只提交暂存内容，不自动 add；推送固定 origin 原分支，不强推、不拉取，保留 Git hooks。提交和推送逐步记录，推送失败不丢本地提交，可单独重试。编码 Agent 仍在临时工作区产出补丁，不直接提交；自动交接和规则运行的工具限制同步更新。接收目录继续保留，后续明确指定同一分支的新交办基于本地最新 commit。回归使用临时仓库及本地裸远端，覆盖状态变化、未暂存修改、分支/仓库变化、权限、非快进与 hook 拒绝、失败恢复、并发请求。

## 2026-10-27：规则运行以 QUIET 结尾不再发出

规则交给档案、在触发消息的话题（或群）里自动回复时，档案常常先用 `lark_send` 发结论（要 @ 值班人），最后写一句总结再加 QUIET 表示“不要重复发”。之前只有唤醒运行认 QUIET，首轮运行会把“总结 + QUIET”整段发到话题里。现在规则运行的回答以 QUIET 结尾（`isQuiet`）时不投递，运行仍在列表里、思考气泡保留；规则任务说明里也写明“用 lark_send 发过结论的最后只回 QUIET”。实现：`src/agents/jobs.ts` 的 `agent` 处理器、`src/rules/actions.ts`；回归：`test/lark.test.ts`。

## 2026-10-27：重试接着做、运行中追加消息、盯群

- **重试**（`src/agents/retry.ts`）：编码交办点“重试”不再按原输入从头建工作区，而是在同一链里作为新一轮，接着原工作区和编码 Agent 会话做；ACP 会话一打开就记一条 `session` 事件，写到一半失败的也能接上；上一次已写完代码、在检查或评审时失败的，只重跑检查和评审。已应用或丢弃的按原输入重来。Agent 运行重试时任务前面带上一次的错误和已做的写入（`attemptNote`），发过的消息不再发；工作会话和静默排查接着原会话。重试保留发起人，网页跳到新运行。
- **运行中追加消息**（`src/agents/steer.ts`）：会话的一轮进行时，同一发送人的新消息先照常排进下一轮；正在进行的这一轮下次调用工具时，把它们附在工具结果后面交给 Agent，并从下一轮移走，下一轮空了就取消（`steeredInto`），飞书里不再单独回复；没赶上的照常成一轮。
- **盯群**（`src/channels/lark-watch.ts`、`set_chat_watch`）：主助手可以自己盯（`spec=assistant`，默认），也可以交给档案；规则带本人的目的（`note`）、到期时间（`expiresAt`，默认 3 天，巡检或下一条消息时结束并通知本人）和批次（`batchMinutes`，默认 10 分钟，处理者可以自己调；后来的消息不推迟这一批，@ 本人或机器人的 30 秒内）。整个群（含话题）一个会话，处理者自己判断哪些话题要单独交给 Agent。本人在自己的消息里要求时，`invite_bot` 用本人身份把 omem 的机器人拉进群（`inviteOwnBot`，与规则动作共用）。没事的批次回 QUIET，记为无事可报。规则页列出“正在盯的群”（`/api/watches`），可取消。

## 2026-10-27：需求点成树、重新整理拆分

- **树形变更点**：`change_points` 多了可选的 `parent`。需求涉及几个页面或模块时，拆分者先建页面 / 模块节点，再把变更点挂在下面（最多 4 层）；怎么分组由它按需求材料自己的组织决定，小需求仍平铺。`pointTreeProblem` 拒收编号重复、父节点不存在、成环或太深的提交。“变更”标签按文件夹折叠展开（超过 20 个时只展开第一层），点一组高亮组下全部代码；标签和概览的数字只数变更点。
- **重新整理**：`requestSplit` 起一个只做拆分的 `review` 运行，`revise` 时把当前的变更点（`currentPoints`：本轮单独的拆分，或业务评审交的）和本人的要求一起交给拆分者，在原来的上面调整、编号尽量不变，整份替换；同一轮还有评审或拆分在跑时拒绝。入口：“变更”里的“重新整理”（`POST /api/runs/:id/change-points` 带 `revise` / `note`），主助手的 `resplit_change_points`。
- 实现：`src/agents/review.ts`、`review-chain.ts`、`tools.ts`、`web/src/components/ChangeView.vue`、`DiffFile.vue`；回归：`test/branch-review.test.ts`。
- 文档站首页：问答、记忆、原件排在前面，评审放后面；首屏图换成三张截图叠放的 `HeroCollage.vue`（浅色 / 深色各一套，`doc-screens` 生成 `*-dark`）。

## 2026-10-27：每次评审都单独拆需求

之前档位里有业务评审时，变更点靠业务评审在 `submit_review` 里顺带交 `change_points`；需求一大，问题清单和变更点要一次交齐，常被漏掉，本人只好在“变更”里手动点“拆分需求”。现在 `reviewRound` 不论档位都和各评审项同时跑一步单独的需求拆分（`splitChangePoints`，提交 `submit_change_points`），失败时随没完成的评审项在 30 秒后自动重试一次；业务评审的角色说明不再要求交变更点，字段只为旧的自定义说明保留。评审进行中“变更”标签显示“需求拆分和各评审项同时进行”，不再给“拆分需求”按钮；按要求起的拆分运行（包括主助手发起的、刷新页面前发起的）页面会接着跟进。概览里的“需求拆分”统计改用 `currentPoints`。实现：`src/agents/review-chain.ts`、`roles/review-business.md`、`web/src/components/ChangeView.vue`；回归：`test/branch-review.test.ts`。

## 2026-10-27：交办进行中调整、每轮先拉取、一个分支一个交办

起因是一次长交办里：本人在会话里随口问的话被当成“按评审修改”卡片的回答，接连开了好几轮；按分支评审修改又在同一分支开了第二个工作区；“后面从简”没有办法落到评审上，也停不下来。

- **卡片回答**：`src/agents/asks.ts` 的 `answerFromMessage`。宿主处理的提问（`context.handler`：评审结束、评审计划、停下的评审、同步冲突）只认编号或以选项开头的回复；其他话照常交给助手。`Ask.handler` 让文字渠道的提示也说清这一点。
- **交办进行中调整**：新增 `src/agents/code-steer.ts`。`addCodeNote` 把本人的补充记在当前一轮的 `output.notes`；编码中的 Agent 在下一次 omem 工具调用时收到（`tools.ts` 的 `steering`），没收到的在它这一轮写完、检查之前接着同一会话交给它（`code.ts` 的 `code()`）；已写完代码的随下一轮任务（`queueNextCodeRound`）。`setRoundReview` 设之后各轮的评审（`input.roundReview`：档位可比之前轻、只做哪些评审项、`split: false` 不拆需求），还没开始评审的这一轮也生效，续轮沿用。`stopCodeWork` 停下这一轮和排队中的评审，链停在 `waitReason: "stopped"`，不唤醒助手接手。工具 `message_code_run` / `set_code_review` / `stop_code_run`，`continue_code_run` / `fix_review` 多了评审选项；接口 `POST /api/runs/:id/notes`、`PUT /api/runs/:id/round-review`，`/fix` 收 `review` 和 `reviewAi`，编码运行的“停止”按本人停下处理。
- **评审计划**：`review.ts` 的 `planReview` 多了 `only`（只做这些评审项）；本人指定的那轮不受“上一轮已是某档，不降档”的限制，不再走计划确认；`review-chain.ts` 在 `split: false` 时不跑需求拆分。
- **每轮先拉取**：`code.ts` 的 `syncPhase` 在没有显式同步时，先用 `code-sync.ts` 的 `behindOrigin` 看目标分支在 origin 上有没有新提交，有就按 `pull` 合进来（冲突照常交给编码 Agent）；拉到的内容写进运行说明的“Git 同步”。
- **一个分支一个交办**：`review-fix.ts` 的 `openDelegationOn` 找同一仓库、同一目标分支上没应用的交办。`delegate_code`（除非 `parallel`）和网页交办遇到时拒绝；分支评审的 `startFix` 续在它上面（它还在跑时拒绝）。`startFix` 把没选“改”的未定问题记为 `later`。
- **多轮换模型**：档位的 `rotateModels` 和共用的 `review.rotation`（`config.ts`、`review.ts` 的 `rotatedExecution`）；第 1 轮各评审项用自己档案的模型，之后按轮次加评审项序号在列表里轮换。`roundReview.rotate` 让一次交办单独开关（工具参数 `rotate_models`）。设置在 `ReviewSettings.vue` 档位页“怎么推进”。
- **网页**：`ReviewSummary.vue` 的“待处理”按本人还要处理的算（含负责人定为要改的提示），最新一轮带上之前各轮的“暂不改”；补充要求和评审选项存在 `lib/quotes.ts` 的 `fixDraft`，切标签不丢，“修改点”抽屉共用；`NextRoundReview.vue` 选之后的评审档位、拆需求和评审 AI；`CodeSteer.vue` 在进行中的交办上补充和改评审；选中文字浮出的按钮悬停底色不透明。
- **编码交办卡片只放状态**：`src/channels/lark-code-progress.ts` 的 `snapshot` 不再把运行事件（编码 Agent 的流式文字、每次工具调用）附在卡片上；卡片只有轮次、状态、评审结论和结果，过程看思考气泡。
- **Windows 上的拉取**：`pull-transfer.ts` 解包时以快照目录为工作目录、用相对路径调用 `tar`（Git for Windows 的 GNU tar 会把 `C:\…` 当成远程主机）。

## 2026-10-28：复用工作区、准备命令

起因是大仓库每次交办都在 `runs/` 下的新 worktree 里重装依赖。设计和后面两步（在 VS Code 里打开工作区、VS Code 插件）写在 `docs/v2/ide.md`。

- **复用工作区**：新增 `src/agents/workspaces.ts`。仓库空间设置 `workspaces`（本人已有的 `git worktree add` 目录）和 `pool`（omem 在数据目录 `workspaces/<空间>/<n>` 自建的数量），`leaseWorkspace` 借出、`releaseWorkspace` 归还。租约是工作区 git 目录里的 `omem-lease.json`，只在运行目录 `runs/<id>/work/<空间>` 的链接（Windows 为 junction）指向它时有效；本人的目录有未提交改动不借；归还时 `reset --hard` + `clean -fd`（保留忽略的文件）并回到原分支。`code.ts` 的 `addWorktree` 先借、借不到再新建；`WorktreeRef.slot` 记真实目录，`workDirOf` 让编码 Agent、检查和评审在真实目录里运行；`removeWorktrees` 对借来的只归还不删除。
- **准备命令**：仓库设置 `setupCommand`，`code.ts` 在同步之后、编码之前对每个工作区比较命令和锁文件（Git 索引里的版本）与上次成功时的 `setupKey`，变了才运行；失败不中止，失败输出交给编码 Agent。
- **检查命令的引号**：`code.ts` 的 `shell` 在 Windows 上照 Node `shell: true` 的方式原样传给 cmd，带双引号的检查命令以前会被转义坏。
- **网页与接口**：设置 → 空间 → 编辑（仓库空间）加准备命令、复用工作区数量和目录，列出各工作区状态；`GET /api/spaces/:id/workspaces`。
- **在 VS Code 中打开**：`code.ts` 的 `codeFolders`（工作区的真实路径，应用后为接收位置）与 `GET /api/runs/:id/folders`（带 `local`、主机名）；网页 `OpenInIde.vue` 和 `lib/ide.ts` 生成 `vscode://file/…` 或 `vscode://vscode-remote/ssh-remote+<别名>/…`，SSH 别名和编辑器（VS Code / Insiders / Cursor）存在看的人的浏览器里。
- **VS Code 插件第一版**：新增 `vscode/`（独立 package），设计在 `docs/v2/ide.md` 第三节。宿主新增 `GET /api/code-runs/at?folder=`（`code.ts` 的 `codeRunsAt`，按文件夹找交办和各轮）。插件：`current.ts`（当前交办、路径对应）、`review.ts`（评论控制器：评审问题线程与改 / 暂不改 / 不改，选中提问走 `/api/ask` 并轮询会话写回线程，修改点，“开始修改”调 `/fix`；“修改单”视图）、`runs.ts`、`progress.ts`（`/api/runs/:id?after=` 轮询事件到输出通道和状态栏）、`delegate.ts`（任务文档 + CodeLens 调 `/api/delegate`）。`vscode/test/run.mjs` 用 `seed.mts` 起演示 omem，在真实 VS Code 里跑 `suite.cjs`。
- **网页版 VS Code**：新增 `src/server/ide-web.ts`（按需启动官方 `code serve-web`，回环随机端口与 connection token；会话 cookie；`/ide` 的 HTTP 与 WebSocket 代理，转发时加 `vscode-tkn`、去掉 omem 自己的 cookie 与 Authorization；进程树结束与遗留进程清理；下载中的 202 换成自动刷新页）。`http.ts` 加 `GET /api/ide/open`（本人，设 cookie 后跳转）、注册 `/ide` 代理和 upgrade 处理；配置 `ide.web.enabled / command`（设置 → 外观与说明）；`/api/runs/:id/folders` 带 `web`；`OpenInIde.vue` 的编辑器多“网页版 VS Code”；Vite 代理 `/ide`（ws）。
- **网页版 VS Code 经设备打开**：新增 `src/core/peer-tunnel.ts`，`/ide` 和 `/api/ide/open` 原样转发（含 WebSocket 升级，不跟随跳转）：`omem peer open` 的本机服务把它们交给路上第一台直连设备；中间设备在 `/api/peers/:id/ide…`、`/api/peers/:id/api/ide/open` 上原样转给下一台，升级请求单独核对本人令牌。`ide-web.ts` 的 `ideAllowed` 也认本人令牌（转发来的请求）。
- **插件的连接设置**：新增 `vscode/src/connection.ts`（`omem.connection` = `local` / `direct` / `peer`，`omem.port`、`omem.url`、`omem.peer`、`omem.sshHost`；令牌按服务地址存 SecretStorage；omem 机器上的路径与本窗口 URI 互转，Remote-SSH 窗口和 `sshHost` 都走 `vscode-remote`）和 `connect.ts`（“连接 omem…”：本机先试默认端口、粘贴 `omem link` 链接或配对码逐个地址试连、填地址和令牌、从本机 omem 的 `/api/peers` 选设备；状态栏连接状态，`omem.connected` 控制欢迎页）。修正：以前 Remote-SSH 窗口里的文件夹（`vscode-remote` 协议）被跳过，认不出交办。评审线程正文不再重复标题，已选的决定按钮隐藏。
- **插件连配对的设备不再要本机服务**：`connection.ts` 的 `pairedPeers` 读数据目录（`omem.home` / `OMEM_HOME` / `~/.omem`）的 `secrets/peers.json`，`target()` 照 `peerFetch` 的走法算出请求地址和令牌（直连用设备地址，`via` 发到中间设备的 `/api/peers/<id>`，地址不应答时试其他地址）；没有数据目录时才经本机服务转发。连接选项改名“本机配对的设备”。
- **网页版 VS Code 不再要开关**：去掉 `ide.web.enabled`，运行页“在 VS Code 中打开”一直有网页版；`GET /api/ide/cli` 给出要用的 VS Code 命令行，齿轮面板里显示并可就地填 `ide.web.command`；找不到命令时打开返回说明。转发给 serve-web 时带 `X-Forwarded-Host`（`peer-tunnel.ts` 第一跳加上），修正经 `peer open` 打开别的机器时 WebSocket 去连对方回环端口、1006 断开。插件：空的提问线程不再有两个删除按钮（空线程 VS Code 自带删除），标题改为“问 omem，或记为修改点”；直接连接到本机回环地址时按本机文件对应路径。
- **交办清理、工作区设置、主目录里改**：`src/agents/code-cleanup.ts`（`cleanupCandidates` / `cleanItems`：没应用的交办、已应用的接收工作区、runs 下的遗留 worktree）和工具 `clean_code_runs`（先列清单，`confirm` + `run_ids` 才清）；工具 `set_code_workspaces`（`pool`、`workspaces`、`setupCommand`、`inPlace`）。`workspaces.ts` 的 `inPlace` 把仓库主目录作为第一个候选（干净才借，`leaseWorkspace` 返回 `{ path, main }`，分支评审不借主目录），`code.ts` 在主目录里不建 omem 分支、`WorktreeRef.inPlace`，应用时不打补丁、`releaseWorkspace(keep)` 不重置，丢弃照常重置。`connect_repository` 按 git remote 认出同一仓库的已有空间，不再新建；`relink: true` 改关联（有未应用交办时拒绝，删掉 omem 自建的复用工作区）。设置 → 空间加“直接在仓库主目录里改”。
- **先应用再接着改**：`code.ts` 的 `applyCodeRun(…, { keepWorking })` 应用后保留工作区，把应用的部分在工作区里提交（`omem: 已应用到 …`）作为新的起点，之后的差异和下一次应用只含新改的；`partlyAppliedTo` / `partlyAppliedAt` 让运行页和 `code_git_action` 能在接收目录提交。网页概览的“先应用再接着改”、`fix_review` / `continue_code_run` 的 `apply_first`。
- **按钮状态**：`styles.css` 的悬停样式不作用于禁用的按钮；`api.ts` 给触发写请求的按钮加 `busy`（转圈、不可点），请求结束移除；`.lnk` 改为全局样式。评审选项收成一行摘要，点开再选；之前各轮的“暂不改”改为“改”时本地状态同步更新。

## 2026-10-28：工具按需给出、omem tool 命令行

起因是主助手每次会话要带 80 个工具、约 65KB 的参数说明，每加一个能力就再多一个工具。

- **按需给出**：新增 `src/agents/tool-help.ts`。`CORE_TOOLS` 是直接列出的常用工具（检索、读原件、记忆、事项、问本人、`lark_send`，以及各后台角色交结果的工具）；一次运行能用的工具超过 `DIRECT_ALL`（20）个时，其余的不单独列出，换成 `omem_help`（工具名看说明和参数，分组 id 看 `skills/omem/references/<分组>.md`，不填列出全部）和 `omem_call(tool, args)`。`omem_call` 的说明里按分组列着本次能用的工具名和一句话用途。`tools.ts` 的 `mcpTools` 给 MCP 列表用（`/api/tools`、`/mcp`、`omem mcp`），`callTool` 处理这两个工具，转调时照常检查工具清单、审批和对比运行。主助手的工具说明约从 65KB 降到 18KB；工具不多的角色不变。
- **omem tool**：`src/cli-main.ts` 新增 `omem tool [名] [参数…]`：一个 JSON 对象、`键=值`（值能按 JSON 解析就按 JSON）或 `-f 文件`（`-` 为标准输入）；`omem tool help [名|分组]`。有 `OMEM_TOKEN` 时调服务的 `/api/tools/<名>`，没有时按 `omem mcp` 的范围在本机执行（`externalToolContext`，不含交办编码、评审分支和角色专用工具）。
- **Agent 进程的环境**：新增 `src/agents/tool-cli.ts`。`prepareRun` 的 `mcp.env` 带 `OMEM_URL`、`OMEM_TOKEN`，并把 `<数据目录>/bin` 放到 PATH 前面，那里的 `omem`（Windows 为 `omem.cmd`）用当前的 node 运行当前的 omem；`acp.ts`、`cli.ts` 启动 Agent 时合并进去。环境变量本身不授权，权限仍由令牌决定。
- **说明拆分**：`skills/omem/SKILL.md` 只留概览、接入方式和分组表，原来的长清单按分组移到 `references/`（sources、memory、items、wiki、agents、owner、code、lark、learning）。`roles/_common.md` 开头说明了 `omem_call` / `omem_help` 和 `omem tool`。
- 测试：`test/tool-help.test.ts`（分组完整、列表拆分、权限、参数说明、命令行参数、环境）。

## 2026-10-28：事项搜索、记忆里的引用、运行写下的东西、更新原通知、配置合并保存

- **事项页**：`Items.vue` 的快速输入框改为右上角“新建事项”弹窗；新增搜索框（`/api/items?q=`，搜索时 `status=all`，请求按序号丢弃过时结果，进行中显示 `.spinner`）。
- **记忆里的引用**：新增 `web/src/components/MemoryText.vue`，把记忆正文里的 `[[slug]]` / `[[空间:slug|文字]]`、`[文字](src:…)`、裸 `src:` / `mem:` / `msg:` 变成链接，经 `openCitation` 在引用抽屉里打开；`MemoryCard`、`CitationDrawer` 的记忆和演变、记忆页的复核撤回与对比运行都用它。
- **搜索加载态**：`CommandPalette.vue` 在防抖和请求期间显示“搜索中…”，旧结果变淡；`Memory.vue` 输入后立即进入加载态并丢弃过时结果；`styles.css` 新增 `.spinner`。
- **运行写下的东西**：新增 `src/agents/run-writes.ts` 的 `runWrites`，按运行的 `tool-write` 事件和带运行 id 的行（工作文件 `meta.runId`、记忆 `run_id`）列出写下的东西及打开位置；`GET /api/runs/:id` 返回 `writes`。`RunActivity.vue` 在结束的运行下列出它们并给“运行记录”链接（运行页自身不显示链接）。起因：问答回答末尾的“已记录：…”只说写了什么，网页上找不到，工作文件又写在别的空间。
- **更新原通知**：`notify` 接受 `replaces`（之前通知的 id）：新通知的 context 记 `replaces`，原通知标为已读、记 `replacedBy` 并取消夜间暂缓；飞书渠道发送普通通知后记下 `larkMessageId` / `larkBot`（`setNotificationCard`），遇到 `replaces` 时改原卡片而不是发新的，改失败才发新卡片。`notify` 工具返回通知 id，参数加 `replaces`；`skills/omem/references/items.md` 同步。
- **配置合并保存**：`src/core/config.ts` 的 `saveConfig` 改为三方合并（`mergeConfig`）：以本进程上次读入或保存时的配置为基准，只把本进程改过的字段写到磁盘上的现状之上，其余以文件为准，传入的对象变成合并结果。以前服务、`omem setup`、CLI 各持一份启动时的完整配置，谁后保存就整份覆盖别人改过的项（包括服务运行期间的手改）。
- **飞书工具默认发到本会话**：`lark_send` / `lark_card` 等不填 `chat_id`、`reply_to`、`user_id` 时，发到本次运行所在的飞书会话（`tools.ts` 的 `runLarkChat`）。起因：本人在私聊里让助理发起授权，Agent 拿不到当前私聊的 chat_id，发不了可更新的授权卡片，只好改用 `notify`。
- **飞书回答带运行 id、按 id 查找**：飞书回答卡片底部小字“运行 <id>”（`lark-send.ts` 的 markdown 内容支持 `note`，`lark-progress.ts` 的 `finish` 带上，访客的回答也带）。新增 `src/core/lookup.ts` 的 `lookupId` 与 `GET /api/lookup?id=`：运行、记忆、原件、事项、消息、对话、规则、通知、页面按 id 查（接受 `运行 `、`src:`、`mem:`、`msg:` 前缀和 `#L` 行号），按调用者能看的空间过滤；`CommandPalette.vue` 输入像 id 的内容时把命中放在第一行，回车打开对应页面或引用抽屉。
- **运行记下新建还是更新**：`tool-write` 事件多记工具回执 `result`（前 400 字）；`runWrites` 从回执里取 id 和“已新建 / 已更新 / 已更正”，旧事件仍按原来的方式推断；`RunActivity.vue` 显示为“新建工作文件：…”“更正记忆：…”。
- **访客被拒后本人确认**：`lark-bot.ts` 的 `answerGuest` 在群里拒绝一个人后调用 `askOwnerAboutGuest`：本人在群里（`ownerInChat`）就发群内仅本人可见的卡片（`sendEphemeral`），否则发到本人私聊；交互 `purpose=guest-approval`，payload 存原消息。`lark-actions.ts` 处理按钮：同意时 `decideGuest` 把原消息交回注册的机器人（`onGuestApproved`），`handle(m, { by })` 跳过采集和门卫，按本人身份交给主助手，上下文写明本人同意；不同意只在 guest 运行记一条状态。`roles/gatekeeper.md` 的群内拒绝回复改为“需要主人同意，已经去问了”。运行记录页加“当前空间 / 所有空间”。

## 2026-10-28：会议规则（本人入会时拉机器人进会）

- **触发与条件**：`rules/types.ts` 加触发 `meeting`、字段 `meeting.title / no / participants / participantCount / host`（`EVENT_FIELDS` 按触发分组，`/api/rule-options` 给出）、运算 `gte` / `lte`；`store.ts` 校验会议规则只用会议字段、动作只能是 `meeting-bot` / `notify` / 只告诉我的 `agent`；不写条件的会议规则表示每场会议（`engine.judge`）。`testRule` 对会议规则用 `lark_meetings` 里最近的会议试。
- **入会事件**：新增 `src/channels/lark-meetings.ts`。有启用的会议规则时常驻两个 `lark-cli event consume`（`vc.meeting.participant_meeting_joined_v1` / `…_ended_v1`，用户身份；关 stdin 停止），起不来就每分钟 `vc +meeting-list-active`。`main.ts` 每 15 秒 `tickMeetings`。新表 `lark_meetings`、`lark_meeting_lines`（迁移）。
- **动作 `meeting-bot`**：`bots`（`main` / `lark.bots` id）、`confirm`、`record`、`spec`、`space`、`task`、`answer`、`importShared`、`leaveWithOwner`。入会、读事件、会中发消息、离会都用机器人自己的客户端调 `vc/v1/bots/{join,events,message,leave}`（请求格式按 lark-cli 1.0.97 的 `--dry-run` 核对）。确认卡片 `purpose=meeting-join`，`lark-actions.ts` 处理。
- **记录与旁听**：会中事件两种形态都认（lark-cli 的 `event_type + payload`、接口的 `activity_event_type + *_items`），转写按 `sentence_id` 覆盖；会议原件 `lark:meeting:<id>`，结束后 `scheduleIngest`，再用 `vc +detail` 找 `minute_token` 把妙记补进去（`lark-personal.ts` 拆出 `minutesText`、`minutesSeen`）。旁听运行 `lane=meeting:<id>`，输入带 `meeting` 时结果不投递（`jobs.ts`）；新工具 `meeting_send`（只在 `meeting.answer` 的运行里可用，`skills/omem/references/lark.md`）。
- **权限检查**：新增 `src/rules/permissions.ts` 与 `GET /api/rules/:id/permissions`；`save_rule` 结果附上。`lark-setup.ts` 加 `larkAppScopes`、`larkEventLink`，`larkScopeLink` 可指定 `token_type`；机器人清单加 `vc:meeting.bot.join:write`、`vc:meeting.message:write`，lark-cli 用户清单加 `vc:meeting.meetingevent:read`。
- **界面**：`Rules.vue` 触发加“我加入会议时”，条件字段随触发切换，动作“拉机器人入会”的编辑项，“飞书权限”一节（重新检查），“用最近的会议试一试”。

## 10-29：提醒时区、会议不建事项、工具按分组授权

- **提醒晚 8 小时**：事项的提醒时间按写入时的样子存（`2026-10-28T16:45:00+08:00`），到期查询却拿它和 `now()`（UTC，`…Z`）按字符串比，东八区的提醒要等 UTC 走到同一个钟点才发出。`items/store.ts` 加 `UTC(col)`（SQLite `strftime` 换算成 UTC）用于 `dueReminders`、事项排序和巡检的过期查询；存的值不变，Agent 读到的仍是本人的时间。
- **会议不建事项**：`roles/ingest.md`：飞书日程和会议邀请本身不建事项、不设提醒（飞书自己提醒），只有分给本人的具体任务才建；`_common.md` 同样写明。
- **工具按分组授权**：`tool-help.ts` 的 `expandTools`：角色和 Agent 档案的 `tools` 可写 `group:<分组>` 和 `-<工具>`，加载时展开（`ROLE_TOOLS` 不随分组授出），保存角色时检查分组名。主助手改成按分组写（排除 `write_page`、`propose_item_update`、`propose_profile_change`、`meeting_send`），实际可用的工具和以前一样；以后新工具放进分组就可用，自定义过的主助手也不用再为工具清单合并。
- **改卡片不再依赖读消息接口**：`tools.ts` 的 `larkGuard` 遇到 `reply_to` / `lark_update_card` 时，先从 `card_interactions`（机器人发的卡片）和 `lark_messages` 找消息所在的会话，找不到才调飞书 `im.message.get`，失败时把飞书的错误码带进报错。起因：机器人读不了消息时，改自己刚发的卡片也报“无法确认被回复消息所在的飞书会话”。


## 10-29：编码交办卡片的检查行、运行标题的悬浮提示

- 编码交办结束的卡片原来把运行输出的 `repos`（含 `git diff --stat` 的文件列表）原样转成 JSON 放在“检查：”后面；没有配置检查命令或交办了多个仓库时都会这样。`src/channels/lark-code-progress.ts` 的 `checkLines` 改为每个仓库一行：检查命令通过 / 未通过（退出码、耗时）或“没有配置检查命令”，加上改动规模（`--stat` 最后一行）。文件明细只在运行页看。
- 运行标题在创建时截成 60–80 字的标签，交给 Agent 的任务（`input.task` / `input.text`）不截。运行列表的简要模式（`listRuns` 的 `brief`）现在带上任务的前 600 字，`web/src/views/Runs.vue` 的列表项和详情标题悬浮时显示它。
- 记忆里的页面引用（如 `[[cases/x]]`）原来带着类名 `page`，被全局 `.page` 的页面内边距撑开，左右留白很大、虚线下划线错位；`web/src/components/MemoryText.vue` 的类名改为 `ref-<种类>`。运行记录列表头部的状态和范围两组筛选不再挤在一行，状态单独一行，范围与“含无事可报”一行。

## 10-29：换仓库目录

- 复用工作区只认和仓库共用提交记录的 `git worktree`；同一仓库（remote 相同）单独 clone 的目录以前只显示“不可用”，本人得知道去让助手 relink。现在 `listWorkspaces` 把它标成 `clone`，设置页给出“设为仓库目录”，保存时也会问；空间设置多了“仓库目录 · 换目录”。
- 换目录的逻辑从 `connect_repository` 抽到 `src/agents/repo-relink.ts`（`relinkRepoSpace`）：进行中的交办拒绝，没应用的交办先返回清单、确认后丢弃，删 omem 自建的复用工作区，把新目录从复用列表里去掉。接口 `POST /api/spaces/:id/relink`。`remoteKey` / `sameRepository` 移到 `core/repositories.ts`。

- 并行交办：主目录借给某个交办（`inPlace`）还没应用或丢弃时，别的交办应用到主目录会被拒绝（`applyTargets` 查 `leasedTo`），以免两次改动混在一起、丢弃时一并被重置。

## 10-29：交办改成工作分支，工作区自动管理

本人用下来觉得别扭：几轮的改动以未提交的形式堆在一起不好回溯；“应用”“提交”两步都要手动，主目录要应用后才看得到；复用工作区要填个数、填目录、开“主目录里改”，填错了还要回去看哪个不可用。改法（设计在 docs/v2/ide.md 第一节）：

- **工作分支**（新增 `src/agents/code-branch.ts`）：`planBranch` 定分支（`fromBranches` 接着已有分支，只在 origin 上的先建本地分支；`branchNames` 新名；否则 `omem/<运行id>` 由编码 Agent 用 `git branch -m` 改名，`settleRound` 读回）。新分支从仓库目录的本地 HEAD 切出，记 `cutFrom`，改动按和它的分叉点算（`changeBase`）。`WorktreeRef` 加 `commits`、`newBranch`、`cutFrom`、`pending`。
- **每轮**：`branchWorktree` 借工作区并 `placeOnBranch`。分支没在别处检出就直接检出它；在别处（仓库目录）检出就以游离 HEAD 停在分支末端，`settleRound` 结束时在那里 `merge --ff-only`，快进不了就记 `pending`、通知本人，下一轮不挪工作区并让编码 Agent 先合并。未检出的分支用带旧值校验的 `update-ref`。宿主把剩下没提交的改动（含检查命令改出来的）提交成“第 N 轮没提交的改动”，之后工作区回到游离状态。diff、改动规模、补丁按 `changeBase..HEAD` 算（以前的交办仍是 `--cached HEAD`）。只做同步的一轮直接记 `synced`，不再评审合并进来的代码。同步停在冲突上时 `placeOnBranch` 不动工作区。
- **编码任务**加“分支”一节：在哪条分支、怎么提交、要不要改名，以及同一仓库其他没确认交办的分支（`siblingsText`），可以 cherry-pick。`roles/coder.md` 的“不要提交”改为按分支说明提交。
- **确认**：`applyCodeRun` 对工作分支上的交办转到 `confirmBranchRun`：可先压缩（`commit-tree` 同一棵树，检出处 `reset --soft`），推到 origin 同名分支（分叉时只有压缩过或本人同意才带 lease 覆盖），设上游，归还工作区，记 `appliedAt` / `pushed`。`discardCodeRun` 归还工作区，删这次新建、没推送、没在别处检出的分支。评审结束卡片的“应用到仓库”在这类交办上变成“确认并推送”。`keepWorking` 对它们不做事。
- **工作区**（`workspaces.ts` 重写）：只剩 omem 自建的 `workspaces/<空间>/<n>`，按需建到 `MAX_POOL` = 4，满了就收回闲着的（运行不在进行、干净、HEAD 在某条分支上，`parked`），对方的链接删掉，下一轮再借。`pool`、`workspaces`、`inPlace` 设置不再起作用（借着它们的旧交办照旧归还）。`setupCommandFor` 不设时按锁文件选 pnpm / yarn / bun / npm，`none` 不准备。事项结束（`upsertItem` 关闭时）`releaseItemWorkspaces` 归还没确认交办占着的工作区，分支保留。
- **接口和工具**：`GET/POST /api/runs/:id/branch`（`rename` / `checkout` / `squash`）、`POST /api/runs/:id/sync`（`queueSyncRound`）、`POST /api/runs/:id/apply` 带 `squash` / `force`，`/api/delegate` 带 `branch`。工具 `code_branch`（放进 code 分组，交给编码交办和规则的主助手不可用），`apply_code_run` 加 `squash_message` / `force`，`delegate_code` 加 `branch`、只在指定已有分支时查重复交办，`set_code_workspaces` 只剩准备命令。读文件接口在工作区归还后从分支读。
- **网页**：运行页新增 `CodeBranchPanel.vue`（提交列表、推送状态、检出位置；改名、在仓库目录检出、压缩、合并 / 变基、确认并推送），工作分支的交办不再显示“应用到原分支”“移到目标分支最新提交”和接收位置面板；设置 → 空间只剩仓库目录（换目录）、准备命令和工作区状态。
- **顺带修的**：`App` 的数据目录改为绝对路径。以前用相对的 `--home ./.omem` 时，`git worktree add` 在仓库目录里解析工作区路径，建错地方。

## 2026-10-29：同一条会议规则按条件确认

- `meeting-bot.confirm` 兼容布尔值，并支持只含会议字段的条件（all / any / not）；`rules/meeting.ts` 共用执行与试运行的判断。满足时先发卡片，否则直接入会；确认条件所需数据未知时先问。参会人读取失败或没有事件时保留未知，人数不算 0；会议摘要和卡片显示未知。
- `lark-meetings.ts` 保存本次触发决定的布尔值与理由，卡片回调沿用计划。`compile.ts` 支持从“30 人及以上先问，否则直接拉”的原话生成单条规则，缺名称或动作的返回值改用中文报错。
- `Rules.vue` 的入会确认改为“始终询问 / 直接加入 / 满足条件时询问”，复用会议条件编辑器；试运行显示入会方式。`scripts/doc-screens.ts` 增加虚构的会议规则和截图。
- 回归覆盖 29 / 30 / 31 人、人数未知、嵌套条件、卡片确认、旧布尔值与试运行不执行动作；工具用法同步到 `skills/omem/references/owner.md`。
- 验证：`LANGUAGE=C pnpm run check` 通过（94 个测试文件、553 项测试、类型与构建）；真实 Codex gpt-6.1-sol / low 生成两条单规则草稿并核对人数边界；1440 / 390 宽度检查切换、修改、保存回读和试运行，无横向溢出。文档截图使用虚构数据重新生成；真实会议待验。

## 10-30：会邀人数、在会议里拉机器人、入会事件状态

- **两种人数**：规则字段加 `meeting.invitedCount`（会邀人数）。`lark-meetings.ts` 的 `invitedCount` 按会议链接（`/j/<会议号>`）在已采集的日程原件里找日程 id，找不到再查 `calendar +agenda`；主日历 id 缓存在 kv `lark_primary_calendar`；参与人按 `calendar/v4/.../attendees` 读，`chat` 类型按 `chat_members` 展开去重，跳过会议室和拒绝的。入会时和在会人数一起读，存进新列 `lark_meetings.invited`（迁移）。`meeting.participantCount` 不再算 `user_type = 10` 的应用（`Person.bot`，`countOf`）。确认卡片和试运行写两种人数；规则页“满足条件时询问”的默认条件改为会邀人数 ≥ 30；生成规则的提示说明两者区别。
- **在会议里拉机器人**：每个机器人的长连接注册 `vc.bot.meeting_invited_v1`，`botInvitedToMeeting`：本人邀请的直接 `bots/join`，别人邀请的发 `meeting-join` 卡片；设置取本人为这个机器人设的会议规则，没有就记录、回答、导入共享文档。不需要规则，`ruleId` 为 `invited`。
- **入会事件状态**：lark-cli 先打印 ready、十几秒后才因没订阅退出，以前权限检查会误报“正在接收”。现在监听要稳定 45 秒才算在接收，45 秒内退出的不算；没在接收就每分钟轮询。轮询能用时，权限检查把它写成说明，不算缺项。


## 10-30：设置页“占用”

常驻服务器的数据目录到了几十 GB，要知道是飞书文档、群聊附件还是数据库占的，才能决定要不要压缩图片和视频。

- **统计**（新增 `src/core/storage-scan.ts`）：顶层各项递归求和（不跟随符号链接）；`files/` 每个文件按引用归来源——`lark_messages.resources` 和 kv `lark_res:*` 是聊天附件，原件 `meta.media` 是在线文档里下载的图片和附件，`meta.original` 按原件 uri 是否 `lark:` 分聊天附件或导入原件，没人引用的单列——再按扩展名分图片、视频、音频、文档、压缩包、其他；数据库用 `dbstat` 按表（索引并入所属表）汇总，表名归到原件、切块、全文索引、代码、飞书、运行、会话、记忆、Wiki、事项几个模块，原件按 `kind` 加来处（`lark:`、`directoryRoot`、链接）统计正文、切块和向量字节，另报 `freelist` 空闲页。
- **运行方式**（`src/core/storage.ts`）：`dbstat` 要读遍所有页（本机 1 GB 的库约 10 秒），放到子进程里跑，只读连接，结果 JSON 存 kv `storage_report`，重启后还在；同一时间只跑一个。没用 worker 线程：`node --watch` 下 worker 会多发模块跟踪消息，而且子进程的内存不算在服务进程里。
- **接口与网页**：`GET /api/storage`、`POST /api/storage/scan`（只有本人）；`web/src/components/StorageUsage.vue`，设置页新标签“占用”，统计中每 3 秒刷新。

## 10-30：角色说明每个会话只发一次，能当系统提示的就当系统提示

10-27 一条编码交办续了 9 轮，每轮都把整段说明（`_common.md`、角色、环境、偏好与经验、技能目录）连同任务重发进同一个会话。

- **只发一次**：`AgentRequest` 分成 `system`（常驻说明）和 `prompt`（这一轮）。`types.ts` 的 `withInstructions`：新会话、且说明没有作为系统提示时，才把说明放在第一条消息前面；接上的会话只发这一轮。`runner.ts` 的 `runRole`（编码续轮、补充说明那一轮、多 Agent 话题续轮、规则、会议、`/ai`）、`sessions.ts`、`background-sessions.ts`、`dispatch.ts`（CLI）、`doubao.ts` 都走它。
- **系统提示**：Agent 在 `initialize` 里声明 `sessionCapabilities.systemPrompt` 时，`acp.ts` 在 `session/new`、`session/resume`、`session/load` 带上 `systemPrompt`（append 模式）。实测 codex-acp 2.5.0 把它变成 Codex 的 developer instructions，换进程恢复后仍在，恢复时改不了（沿用建会话时的）；claude-agent-acp 0.99.0 按进程设置，所以恢复时也要带。ACP SDK 1.8.0 不认这个字段，发送时原样带出。
- **时间移出说明**：`prepareRun` 的 `system` 不再含当前时间（`now` 单独给），每轮消息开头写“现在：…”，说明在会话里保持不变，后台会话池直接用它做身份。

## 10-30：编码续轮的会话太长就换新会话

同一条交办续 9 轮时，编码会话的上下文涨到 100K–240K，后几轮每次模型调用都要带着它（10-27 两条链，编码 Agent 的调用平均约 150K）。

- `config.sessions.codeResumeMaxTokens`（默认 100000，0 表示每轮都新开）。`code.ts` 的 `code()`：上一轮结束时记下 `output.coderContext`（后端 `usage_update` 的最新占用），超过上限就不再 `resumeSessionId`，运行里写一行“换新会话”。
- 新会话的任务：原始任务、“之前各轮已经做的”（每个工作区 `git log --oneline <start>..HEAD` 最多 30 条，上一轮编码说明前 4000 字）、这一轮的评审要求；改动从工作分支读。旧交办（没有提交的）同样提示改动在工作区里。

## 10-30：说明按工具裁剪，记忆和技能按任务给

- **`_common.md` 按工具给**：小节标题下一行 `<!-- tools: a b -->` 的，只有这次运行有其中某个工具才放进去（`runner.ts` 的 `commonGuide`）。事项、工作文件、唤醒、问本人、写记忆、学到的东西放哪、按任务选 AI 七节标了工具。编码 Agent 拿到的共同约定从 7164 字降到约 1950 字，评审约 1540 字，主助手不变。
- **记忆按任务挑**：`runRole` 先算 `taskLessons`——本档案或本角色自己的偏好与经验照旧都带（最多 16 条）；共享的只取和“角色说明 + 任务”最接近的 8 条（记忆向量的余弦；没有向量时取最新的 8 条），以前是按更新时间取最新 24 条。对话的会话说明（`prepareRun` 没有任务时）仍是最新 24 条。
- **技能目录**：`specs.ts` 的 `skillIndex`：档案或角色自己的技能带说明，其他的只列名字（“其他技能（用到时 read_skill 读全文）”）；主助手仍列全部说明。去掉了“（你常用的）”标记。

## 10-30：按评审修改只复审提出问题的评审项

10-27 的两条链每轮都是“按评审修改”续上的，这条路径不带 `reviewOnly`，每轮 6 个评审会话（加负责人）都从头审一遍完整 diff，其中 3 个在 Codex 上。

- `review-fix.ts` 的 `startFix`：只选了问题、没写补充要求、也没指定之后各轮评审项时，下一轮 `reviewOnly` 是这些问题所在的评审项；每 `review.rereviewAllEvery` 轮（默认 2）照旧全部重审。`queueStandaloneFix` 不再从上一轮继承 `reviewOnly`。
- `code.ts`：`reviewOnly` 不再只在有评审负责人的档位生效；运行里的评审理由写“这一轮只复审要改的问题所在的评审项：…（每 N 轮全部重审）”。需求拆分不受影响（仍按“每次评审都单独拆需求”）。

## 10-30：运行页“上下文”

以前运行记录里看不出发给 Agent 的说明有多大、模型每次调用读了多少上下文。

- **`prompt` 事件**：`types.ts` 的 `sessionPrompt`（包住 `withInstructions`）每轮记一条：说明怎么发的（`system` 系统提示 / `message` 第一条消息 / `resumed` 接上会话没发 / `none`）、说明字数、这一轮消息字数，新会话还有 `parts`（共同约定、角色、环境、偏好与经验条数和字数、技能目录）。`prepareRun` 算 `parts`；ACP、CLI、豆包、后台会话池、对话都经它发。
- **网页**：`web/src/components/ContextUsage.vue`，运行详情活动区上方的“上下文”：按编码 Agent、各评审项、负责人分开，列说明组成、发出的消息、模型调用次数（同一数值重复上报只算一次）、上下文起始 → 峰值、累计读入（各次调用的上下文之和）。数据来自已有的 `usage` 事件和新的 `prompt` 事件，不改接口。文档截图 `run-context`。

## 10-30：只读远程命令 agents / search / prompt / ide

在本机查常驻服务器上的行为，不用 ssh 上去：`omem peer call <设备> <命令> '<json>'`，都只读，参数都校验，经中间节点转发时中间节点不用更新（`/api/peers/<id>/api/peer/exec` 原样转给目标，命令名只在目标上核对）。

- **`agents`**：`peer-inspect.ts` 的 `agentsReport`。每个后端的命令、是否装好、解析到的路径、ACP 适配器 npm 包的已装版本（顺着命令的符号链接或 npm 垫片找 `node_modules` 里的 package.json，不启动 Agent；npx 档案只给包名）、配置的模型和强度、`cachedProbe`。用来确认 codex-acp 是否够新（2.5.0 起收 `systemPrompt`）。
- **`search`**：`searchPreview`，本人身份跑和 `search` 工具同一个 `search()`，参数 `query`、`space`（缺省所有空间）、`limit`（最多 30）；返回原件 id、标题、uri、类型、空间、行号、分数、命中通道和工具会给的片段（500 字内）。
- **`prompt`**：`promptPreview`，`role` 或 `agent`（档案名，二选一）加 `space`，可带 `task`（`runner.ts` 新导出的 `lessonsForTask` 按任务取偏好与经验，`runRole` 同用它）。返回 `parts`、`system`（最多 30000 字）、`now`；工具令牌签发后立刻撤销，结果里没有令牌和 MCP 环境。
- **`ide`**：`ide-web.ts` 的 `ideWebReport`。VS Code 命令行、serve-web 下载的各版本服务端（版本、提交、`node-pty` 原生模块）、服务端数据 / 用户数据 / 扩展目录、已装扩展、语言包与服务端版本差几个小版本（`minorsBehindServer`，差得多时菜单会半中半英）、`argv.json` 的 `locale`、语言和终端相关设置、最近几次服务端日志（ptyhost / remoteagent 末尾，连接令牌已隐藏）、运行中的 serve-web 进程（`procs.ts` 的 `findProcesses`）。
- 回归：`test/peer-commands.test.ts`（参数校验、各命令的返回形状、令牌不外泄）。
- 验证：`omem peer call <设备> agents '{}'` 看适配器版本；`search` 查一个真实问题；`prompt` 看说明里的偏好与经验；`ide` 看语言包版本和终端日志。

## 10-30：飞书里的引用与只读分享链接

一次群里的回答结论不错，但每段末尾的引用在飞书里只剩一串标题（“日志摘录及 LogID”“关键代码与调用位置”……）：10-23 的转换只把有外部地址的原件换成链接，其余留下文字。

- **`src/channels/citations.ts`**（从 `common.ts` 移出，`common.ts` 仍转出 `resolveCitations` 等）：逐条判断引用在句中还是句末（前面是句末标点、另一个句末引用，或独占一行），句中的保留文字并链到目标，句末的换成 ①② 链接，没有目标的句末引用直接去掉；代码块里的不动。目标：网页和飞书文档链原文；飞书聊天原件的行经 `lark_messages(source_id, line)` 找到消息，`msg:` 来自飞书会话的按 `meta.externalId` 找到消息，链接是 `applink …/chat/open?openChatId=<群>&position=<位置>`，位置来自 lark-cli 返回的 `message_position`（新增 `lark_messages.position`，采集时保存；缺的在发送前 `prefetchLarkPositions` 用一次 `+messages-mget` 补，失败 10 分钟内不再试，读不到时只打开会话）。其余（代码、工作文件、记忆、Wiki、omem 内的消息）有运行 id 时进一份分享。卡片的多个 Markdown 块一起编号、共用一个分享。`resolveCitations` / `resolveCardCitations` 变成异步，事项通知和提问卡片用同步的 `resolveCitationsSync`（不建分享）。
- **`src/core/shares.ts`**：`prepareShare` 按运行能读的空间（访客运行用 `input.spaces`，其他按运行的用户）复制被引的部分：原件被引行前后各 3 行（表格从表头起，没给行号的最多 400 行），记忆正文，Wiki 页面或 `#小节`，会话消息；里面的 `src:`/`mem:`/`[[…]]` 只留文字，omem 的图片换成说明。令牌 32 字节随机，表里只存 SHA-256；`shares.expiryDays`（默认 0 不过期）；撤销或过期时清空副本。记录运行、来处（飞书 · 群名）、标题（发出去的第一行）和回答发出后的飞书消息 id（`attachShareMessage`）。分享随设备，`pull` 不带过去（`pull.ts` / `pull-snapshot.ts` 的设备表）。
- **接口**：`GET /api/share/:token`（43 位令牌、无查询串，`http.ts` 的 `SHARE_ROUTE`）在鉴权钩子前放行，只返回快照，`no-store`、`noindex`；`GET /api/shares`、`DELETE /api/shares/:id` 只给本人。
- **网页**：`#/share/<令牌>/<序号>` 由 `views/Share.vue` 单独渲染（`App.vue` 的 `bare`，不加载空间、不弹令牌框），代码按行高亮被引范围，Markdown 经 DOMPurify 后把引用、Wiki 链接和非 http 链接变成文字；设置 → 分享（`ShareSettings.vue`）改有效期、看打开次数、撤销。文档截图新增 `share-link`、`share-link-mobile`。
- **角色说明**：`_common.md` 的“引用”加一条：外部系统（日志、监控、工单）的结果引用系统给的原始链接，工作文件里也记下。
- 顺手修了 `refExcerpt` 读记忆时查不存在的 `memories.text` 列（通知来源里有 `mem:` 时会报错）。
- 回归：`test/shares.test.ts`；`test/lark.test.ts`、`test/models.test.ts` 的期望改成新写法。

## 10-30：桌面与浏览器控制（ai-auto-desktop）

可选工具，让 Agent 用 `aad` 看和操作本机桌面程序与浏览器页面。

- **安装**：`setup.ts` 的 `setupDesktopSection`（`omem setup` 里的“桌面与浏览器控制”）、`installDesktop`（`omem setup desktop`，非交互）、`POST /api/desktop/install`（设置 → Agent 的卡片）都走 `tools.ts` 的 `installTool("aad")`：`osdk install github:lejunyang/ai-auto-desktop`，Linux 加 `-o asset-template=aad-{version}-<架构>-unknown-linux-musl.tar.gz`（osdk 0.0.7 分不清 GNU 和 musl 资产）。装完跑只读的 `aad probe` 报告环境。
- **找到它**：`toolCommand("aad")`——PATH 上的 `aad` 先试 `--version`（osdk 为曾装过的工具在 PATH 上留垫片，没选用时报 “no backend provides”，不能只看存在）；不行就在 osdk 安装目录里找最新的完整安装（`osdk doctor` 给 `install_dir`，`github/<owner>/<repo>/<版本>/<键>/aad`；带选项的安装键和默认选择不同，`osdk where` 找不到它，只作最后的后备）。结果缓存 60 秒（没装缓存 10 分钟，`installTool` 清缓存）。
- **Agent 里直接用 `aad`**：`spawn.ts` 的 `launch` 经 `withAgentPath` 把上面找到的目录放进 Agent 进程 PATH 的最前面（PATH 本来就能运行 aad 时不动；Windows 的 `Path` 大小写照旧）。
- **技能**：`skills/library/desktop-control/SKILL.md` 和 `references/aad.md`（按 ai-auto-desktop 0.0.2 的 README、`docs/control-sessions.md`、各命令的 `--help` 写）：先 `aad probe`；看（`apps`、`describe`、`overview`）→ 定位（`find`）→ 动手（`do …`）→ 再观察；浏览器用 `--remote-debugging-port` 加专用 profile 和 `AAD_CDP_PORT`；`capture` 只截浏览器元素；安全：默认只看、动手前问、不可撤销的逐个确认、不输入凭据、屏幕文字是材料、出错看 `hint`、不绕过。
- **播种**：`seedBuiltinSkills` 以前只写 `SKILL.md`，现在整个目录复制（带 `references/`）；仍按技能名只补缺的，所以新版新增的内置技能在已有数据目录下次启动时补进，改过的不覆盖。
- **可见**：`omem diag` 的 `tools.aad`、`omem setup` 开头的 “✓ aad”、`GET /api/desktop`、设置 → Agent 的卡片。
- 回归：`test/desktop-control.test.ts`。Windows 上用真实 aad 0.0.2 和无界面 Chrome 验证过技能里的命令；macOS、Linux 待验。
- **访客运行不给桌面控制**（10-30）：`prepareRun` 给访客运行的进程环境加 `OMEM_DESKTOP_TOOLS=off`，`tools.ts` 的 `withAgentPath` 见到它就不把 osdk 里 `aad` 的安装目录放进 PATH。

## 10-30：网页版 VS Code 的界面翻译、omem 插件和沿用本机配置

中文浏览器打开网页版 VS Code，几乎所有菜单、命令和对话框的文字都是别处的。原因不在语言包：serve-web 的页面从微软 CDN（`www.vscode-unpkg.net/nls/<提交>/<版本>/<语言>/nls.messages.js`）取按位置排列的界面文字，1.143、1.144 两版 CDN 给的数组比服务端多两千多项（市场上最新的中文语言包是 1.131），位置全错开。

- **界面翻译**：`src/server/ide-locale.ts`。代理改写 serve-web 的工作台页面（请求页面时不要压缩），把 CDN 的脚本换成 `/ide/_omem/nls/<提交>/<语言>.js`：照 VS Code 生成服务端翻译的办法，对这一版 `nls.keys.json` 的每个键取已装语言包 `main.i18n.json` 里的翻译，没有就用英文（`translateMessages`）；语言包取 `extensions.json` 登记的、该语言最新的一个（`packFor`）；结果按提交、语言、语言包版本缓存在 `ide/nls/`（`workbenchNls`）。没有语言包、键和文字数对不上时页面用英文。1.144 + 1.131 语言包：25233 条里 20398 条有翻译。
- **omem 插件**：`src/server/ide-setup.ts` 的 `installOmemExtension`，serve-web 启动前用仓库的 TypeScript 把 `vscode/src` 转成 CommonJS（没有 TypeScript 时用 `vscode/out`），连同 package.json、README、图标放进 `ide/server/extensions/omem.omem-vscode-<版本>` 并登记进 `extensions.json`，删掉 VS Code 的用户扩展扫描缓存；源码摘要（`.omem-source.json`）没变就跳过。`ide-web.ts` 启动 serve-web 时带 `OMEM_URL`（omem 实际监听的回环端口）、`OMEM_TOKEN`、`OMEM_HOME`；插件 `connection.ts` 的 `hostOmem()` 在没设 `omem.port` 时用它们。插件声明 `untrustedWorkspaces` 支持，受限模式下也启用。配置 `ide.web.omemExtension: false` 关掉。
- **沿用本机配置**：`seedMachineSettings` 在网页版没有 `data/Machine/settings.json` 时，从 `~/.vscode-server`（Insiders 同理）的机器设置或桌面 VS Code 的用户设置拿一份，去掉 `omem.*`，来源记在 `.omem-seeded.json`（`ide.web.reuseSettings: false` 关掉）。`reuseExtensions`（`ide.web.reuseExtensions: true` 才做）复制 Remote-SSH 和桌面版登记的、平台和 `engines.vscode` 都合适、网页版里还没有的扩展，每个只拿一次（`ide/reused-extensions.json`）。快捷键、片段在浏览器里，不复制。
- **遗留服务端**：启动前结束带着 omem 的 `--server-data-dir` 和 `--server-base-path /ide`、却没有 serve-web 的 `server-main.js`（`reapServers`）。
- **`ide` 远程命令**：多了 `interfaceStrings`（每种已装语言翻译了多少条）、`omemExtension`（源码摘要和已装的是否一致）、`reuse`（各来源设置的键数、桌面版快捷键条数和片段文件名、扩展的版本 / 平台 / 能不能用；不含内容）、`lastStart`。
- 终端：本机直连和经 `peer open` 都能建终端、跑命令；常驻服务器上之前的会话都没有 `ptyhost.log`，终端请求从没到过服务端，当时是菜单错位找不到入口。更新后用 `ide` 的 `logs.sessions` 确认。
- 回归：`test/ide-setup.test.ts`（按键翻译与英文兜底、选语言包与重建、改写页面、插件安装 / 刷新 / 换版本 / 无编译器、设置播种、扩展沿用）、`test/ide-web.test.ts`（经代理的页面改写与翻译脚本、插件已装、环境变量）。

## 10-30：外部 Agent 用设备的库（omem tool --peer / omem mcp --peer）

让本机的 Claude Code 用本机的模型整理常驻服务器的数据（原件、记忆、Wiki、事项），不走服务器自己的模型。

- **目标节点**：`src/agents/peer-agent.ts`；`http.ts` 新增 `GET /api/peer/tools`（`mcpTools` 同款列表，参数 `space`、`spaces`、`readOnly`）和 `POST /api/peer/tool`（`session`、`name`、`args`、`caller` 等）。鉴权同其他 `/api/`：本人令牌；成员令牌 403。名字不合法、`args` 不是对象返回 400；没有或不允许的工具返回 `isError` 的结果。
- **工具集**：内置分组里的工具，去掉角色交结果的 `ROLE_TOOLS`、插件工具和 `PEER_DENY`（飞书发送 / 卡片 / 文档写入 / 采集设置、`notify`、`ask_owner` / `wait_answer` / `suggest_next`、唤醒、`run_agent` / `ask_agent` / `generate_wiki` / `digest_sources` / `switch_run_ai`、交办编码与评审与 Git 动作、`save_agent` / `save_skill` / `save_rule` / `connect_repository` 等）。`test/peer-tools.test.ts` 的归类用例：每个内置工具都要在某个分组里，`PEER_DENY` 里的名字都要是真工具。`READ_ONLY_TOOLS` 抽到同一文件，`omem mcp --read-only` 共用。
- **运行归属**：调用方的本机名 + 会话名对应一条 `peer-agent` 运行（标题“设备 <本机名> 的外部 Agent（<会话>）”，第一次调用创建、状态进行中；闲置 15 分钟变完成，再用时重新打开；服务重启后由 `jobs.ts` 里的处理器直接结束）。每次调用一条 `tool` 事件（被拒的带 `refused`），写入工具的 `tool-write`；记忆等带 `run_id`、`agent_profile = peer:<本机名>`、调用方告知的模型。`omem_help` 不新建运行。网页运行页加了“设备的外部 Agent”类型名。
- **客户端**：`cli-main.ts` 的 `peerToolBackend`：`omem tool --peer <id> [名] [参数]`、`omem mcp --peer <id>`（`--session`、`--space`、`--spaces`、`--read-only`；环境变量 `OMEM_PEER_SESSION` / `OMEM_PEER_AGENT` / `OMEM_PEER_MODEL`）。走 `peerJson`，读本机 peers.json，本机服务不必运行；经中间节点只用它的 `/api/peers/<id>/…` 转发，中间节点不用更新。默认会话：`omem tool` 为“cli-本机名-日期”，`omem mcp` 每个进程一个。
- **文档**：`skills/omem/SKILL.md` 的“在另一台设备上用这个库”、README 命令行清单、architecture“多台设备”和状态表、acceptance P4b、文档站设备页。

## 10-30：任务选型看时段；升级 ACP 适配器的远程命令

- **时段**：`runner.ts` 的 `routingGuide` 加一句：偏好和候选里写了时段（峰谷价格、排队高峰）的按每轮开头的现在时间选；不再把各模型的占用写进说明（说明一个会话只发一次，占用会过期），改为要求交办前用 `list_ai_backends` 看，它的结果加了 `now`（本人时区的日期、星期和时间）。`capacity.ts` 的 `loadLines` 随之删除。设置里候选“适合哪些任务”的提示写上可以写时段。
- **`agent-upgrade`**（`peer-exec.ts`）：把目录里带 npm 包、且已经全局装好的 ACP 适配器升到 npm 最新版（`npm i -g <包>@latest`），返回升级前后的版本；别的包一律拒绝。

## 10-30：Wiki 多级目录、原件变化提示与自动检查、搜索命中呈现

- **目录**：页面路径就是目录（`a/b/c` 在目录 `a/b` 里，没有单独的目录表）。`src/wiki/store.ts` 的 `buildNav` 从路径生成目录树（目录名取自它的 `index` 页标题，空间 `index` 是首页），`wikiNav` 不再读 `index.md` 里的分组；`movePages` / `expandMoves` 移动页面或整个目录（旧路径写进页面 `aliases` 和新表 `page_aliases`，`readPage` / `pageContext` 对旧路径照常打开，其他页面里的 `[[链接]]` 与 `](wiki:…)` 由 `rewriteLinks` 改成新路径，页面引用的原件状态不因移动或改链接而重置）。新工具 `move_page`、`confirm_page`，`list_pages` 加 `folder` / `direct` / `limit` / `offset`（页面多时先给 `folderOverview`），`write_page` 把页面放在顶层时提示已有目录。HTTP：`GET /api/wiki/:space` 多返回 `aliases`、`stalePages`、`upkeep`；`POST /api/wiki/:space/move`、`/organize`；`/lint` 可带 `pages`。CLI：`omem wiki move`、`omem wiki organize`。
- **整理目录**：新角色 `roles/wiki-organizer.md`（`config.roleNames`）和运行类型 `wiki-organize`（`jobs.ts`）：顶层页面 ≥ 6 或某目录直接页面 > 40 时按主题分目录，一轮最多看 150 页，还有剩余且这一轮移动了页面就接着排下一轮（最多 12 轮）。规划、写作、检查角色说明加了目录要求；`wiki-plan` / `wiki-write` 的任务里页面超过 80 页只给目录概况。
- **网页**：`web/src/components/WikiTree.vue`（可折叠目录树，页数、过期标记，展开状态存在浏览器 `omem.wiki.open.<空间>`，几百行用 `VirtualList`）、`WikiTreeRow.vue`、`lib/wikiTree.ts`；`WikiAttention.vue` 把“N 页引用的原件已变化”放到页面顶部（目录顶部和手机顶栏也有入口）；页面头部加“移动”“检查这页”，新建页面可选目录，概览页按目录卡片显示。
- **自动检查**：`src/wiki/upkeep.ts`（`main.ts` 启动）。原件变化触发一个 30 分钟防抖计时，启动 3 分钟后和每小时再看一次；原件已安静 30 分钟、该页 24 小时内没检查过、空间 3 小时内没跑过检查，才排 `wiki-lint`，一次最多 10 页；聊天、会话、动态、会议这类只追加的原件不触发；`autoLint` 设置现在对所有空间有效（原来只在代码仓库同步后），新增 `autoOrganize`。`wiki-lint` 运行的输入可带 `pages`，手动检查仍看全部。
- **搜索**：`src/search/present.ts` 给 `GET /api/search` 的每个命中加 `display`（标题、标题高亮范围、去掉 Markdown / HTML 标记后匹配处周围的摘录和高亮范围、所在位置、短链接）；排序和 `search` 工具的片段不变。网页 `HitText.vue` 用文本节点和 `<mark>` 渲染，`CommandPalette.vue` 显示标题而不是链接。
- 测试：`test/wiki-tree.test.ts`、`test/wiki-upkeep.test.ts`、`test/search-present.test.ts`。

## 10-30：表情反馈与机器人权限、事件检查

- **记录发出的消息**：`lark-send.ts` 的 `sendLark` / `sendEphemeral` 发出后报给 `onLarkSent`，`lark-feedback.ts` 写进 `lark_sent`（消息 id、会话、运行、对话、用途、机器人）。`Target` 多了 `purpose`、`runId`、`conversationId`；回答、通知、进度卡片、交办进度、工具发送、线程投递各自带上；进度卡片变成回答时 `markLarkSent` 改成 answer。
- **表情事件**：`lark-bot.ts` 给每个机器人注册 `im.message.reaction.created_v1` / `deleted_v1`，交给 `onLarkReaction`：应用加的忽略；机器人发的消息上谁的都记（本人 / 其他用户 / 访客），别人的消息上只记本人的；`feedback` 存原始 emoji_type 和 `feedback.emoji` 映射的极性（确认类单列，未知为中性），取消只填 `removed_at`，id 由（消息、人、表情）派生，多台设备拉取时相遇。前 3 个原始事件在 kv `lark_reaction_samples`。
- **用途**：`feedbackStats`（`GET /api/feedback/stats`）按档案和模型分本人 / 其他用户 / 访客；Agent 页首屏和档案“进化”一栏显示；`profile-jobs.ts` 的复盘证据带表情、有负面的运行优先选入；`gaps.ts` 的不足信号加负面表情（做梦和记忆页“不足”）；`diag` 的 `lark.reactions` 报近 7 天是否收到过表情事件。
- **通知闸门**：`notify-gate.ts` 的 `ownerReactions` 先读 `feedback`；lark-cli 的解析原来读 `data.items` 和数组形式的 `operators`，真机输出是 `data.messages[].reactions = { counts, details: [{ emoji_type, operator: { operator_id } }] }`，按真机改（`reactionsBy`），`test/item-expiry.test.ts` 的模拟数据一并改成真实形状。
- **权限与事件检查**：`lark-setup.ts` 的 `checkLarkApp` 从应用信息里多读 `event.subscribed_events`、`callback`、线上版本的 `events`；`lark-bot-check.ts` 对照 `LARK_BOT_EVENTS`（收消息、两个表情事件、可选的会议邀请）和卡片回调，`GET /api/lark/bot-check`、`POST /api/lark/bot-check/:ref/scan`（重走应用注册补齐）；设置 → 渠道 新卡片；远程命令 `lark-bot-permissions` 多返回 `events`、`callbacks`、`reactionsQuiet`。读不到订阅时用“近 7 天发了 20 条以上却没有表情事件”提示。

## 10-30：做梦第一次只看 7 天、新库默认开、逐晚合并存量经验

- **时间窗**：`jobs.ts` 的 `dreamSince`：没有 kv `dream_at` 时从 7 天前看起（原来是 1970，会把最近 80 条记忆、60 句话一次塞进去）。
- **默认开**：`scheduler.ts` 的 `dream` 默认 `enabled: true`；`ensureDefaultSchedules` 是 `insert or ignore`，已有的库保持原来的开关。
- **存量经验**：`src/memory/digest-merge.ts` 找 digest 运行写的有效 experience 记忆，按引用的第一个原件（同空间、同档案）分组，组内向量 ≥ 0.75 单链聚类（没有向量时按原件），每晚给 dreamer 最大的 4 组、每组至多 8 条；`roles/dreamer.md` 新增第 00 步。
- **网页**：`GET /api/dream/status`；记忆 → 不足 显示开关、下次时间、上次整理、待合并条数和“立即整理一次”，关着且有不足时提示一次（看过记在本机浏览器）。
- 手动跑一次：`omem peer call <设备> schedule-run '{"id":"dream"}'`（定时关着也能跑）。

## 10-30：档案改进建议 14 天过期

- `proposals.ts` 的 `expireProposals`：随夜里的 `profile-review` 定时一起跑；待处理超过 14 天的改为 `expired`（`resolved_by = system`），12 天以上、还没提醒过的合并成一条通知（“N 条档案改进建议两天内过期”，凌晨发出的按免打扰早上补发），`profile_proposals.expiry_notice_at` 记已提醒。待处理不设上限。同一档案同一标题的建议被之后的复盘再提时，`created_at` 和提醒一起重置。
- 档案页：待采纳建议显示“N 天后过期”，历史里标“已过期”。

## 10-30：存量整理单独的并发槽、工具耗时、后台会话按 token 换新

- **并发槽**：`runs.ts` 把运行分成对话、后台、存量整理三类；`digest` 和 `triage` 一次一个（`BULK_SLOTS`），不占 `concurrency` 的后台槽；排队原因写“等存量整理空位”。10-24、10-28 大批整理时 ingest 排队超时、triage 600 秒没开始回答、Agent 说“omem 接口未返回”都和它抢槽有关。
- **工具耗时**：`acp.ts` 在工具调用完成或失败的事件上加 `ms`；`peer-exec.ts` 的 `toolLatency` 读最近 24 小时运行的工具事件，`omem diag` 的 `toolLatency` 给出 n、p50、p90、最大值和 p90 最慢的 5 个工具（至少 5 次），p90 超过 30 秒带 `warning`。
- **后台会话**：`background-sessions.ts` 的 `tooFull`：上下文占比超过 `maxContextRatio` 或 token 数超过 `sessions.background.maxContextTokens`（默认 120000，0 关）就不再复用；ingest、digest、heartbeat 单次运行的上下文峰值曾到 15～17 万。

## 10-30：公开评测数据的清单与下载脚本

- `scripts/bench/datasets.json`：LongMemEval_s / oracle（MIT）、T2Retrieval、DuRetrieval（Apache-2.0，上游 DuReader-retrieval，Hugging Face 卡片未写）、LoCoMo（CC BY-NC 4.0，只在本机跑）；地址、Hugging Face 公布的 SHA-256、大小。LoCoMo 来自 GitHub，没有公布哈希，`--pin` 第一次下载后写入。
- `scripts/bench/fetch.ts <名>`：下载到 `.scratch/bench/<名>/raw/`，校验哈希（不符删除并停下），转换：C-MTEB 三个 parquet 经 `cmteb_to_jsonl.py`（Python + pandas，原 `prep-t2.py` 并入，种子和抽法不变）成 corpus.jsonl / queries.jsonl；LoCoMo 经 `locomo.ts` 转成 LongMemEval 的形状（`haystack_key` 让同一段对话的问题共用一个空间）。
- `eval-longmemeval.ts --recall`：不启动服务、不用模型，按会话排序算 Recall@5/@10、All@10、NDCG@10，按类型分；`--vector` 用本地向量。
- 只手动跑，没有定时任务；数字写进 `docs/v2/evaluation.md`。
- **档案建议不会不打招呼就过期**（10-30）：`proposals.ts` 的 `expireProposals` 只让已经通知过、且通知已满两天的建议过期；超过 14 天却从没通知过的（检查上线前提的、服务停过的）先通知，两天后才过期，通知里写的是实际过期日期。
## 10-30：原件目录树与按目录定级（原件治理第一期）

- **目录**（`src/sources/catalog.ts`）：按种类给每份原件一条节点链（`dir:`、`wiki:` / `wn:`、`lark-drive` / `from:` / `lark-drive:direct`、`chat:<类型>` / `chat:<会话>` / `chat:<会话>:images`、`site:`、`kind:<种类>[:年[-月]]`），一个空间的树在内存里建好并缓存（原件变化事件作废）。`treeChildren` 返回一层，带份数、各档数量、标注数、节点自己的档。
- **知识库层级**：新表 `wiki_spaces`、`wiki_nodes`（迁移用已有 meta 填，`FILL_WIKI_NODES`，不联网，`checked_at` 为空）；`lark-wiki.ts` 的 `recordWikiNodes` 在 `wikiLocation`（采集、只读目录刷新）时写节点和全部祖先，`wikiChildren` 列出的子节点也写；`lark-docs-refresh` 加 `unchecked`（从没读过位置、或节点还没被新代码读过的文档）。
- **目录定级**：`source_node_levels`（`setNodeLevel` / `reviewNodeLevel` / `applyNodeLevels`），`sources.node_level` / `node_level_by` 存最近的目录档；`effectiveLevel` / `levelSql` 定实际的档（原件自己的档在同级或更高的人定时优先）。检索、计数、整理任务、ingest 都改用实际的档。
- **接口与工具**：`GET /api/sources/tree`、`PUT /api/sources/node-level`；`list_sources(under, depth)`、`search(under)`、`set_source_attention(under)`；分级任务列出“所在目录”，`triager` 先按目录定。
- **界面**：`web/src/components/SourceTree.vue`（懒加载、展开状态存 localStorage、行尾菜单设档、灰色节点“采集”），非仓库空间的原件页用它。

## 10-30：标注治理与被引用次数（原件治理第一期之二）

- **迁移**：`source_notes` 加 `quote`、`quote_hash`、`status`（pending / confirmed / rejected，本人写的迁移成 confirmed）、`stale_at`；新表 `source_note_hits`（本机统计，不同步）、`source_cites`（同步）。
- **排序**（`attention.ts` 的 `noteFactor`、`search.ts` 的 `weigh`）：`w ^ (强度 × 比例)`，比例 = 重叠行 / 片段行，至少 0.25；强度 1 / 0.5 / 0；本人或确认过的“有误”“不检索”盖住一半以上或整份时去掉命中；过时和有误的命中附 ref 指向的前 200 字；被引用加分 `1 + 0.1 × min(1, ln(1+n)/ln(21))`（`cites.ts`，回答在 `addMessage` 记，旧回答启动时补记一次，页面取 `page_cites`）。
- **锚定**（`anchor.ts`）：新标注存 quote / hash，`upsertSource` 在文档正文变化且有行标注时调用 `relocateNotes`，找不到记 `stale_at`，找回来清掉。
- **复核**：`reviewQueue`、`GET /api/sources/review`、`POST /api/source-notes/:id/review`、`POST /api/sources/node-level/review`；原件页“待复核”（`SourceReview.vue`），原件详情的标注带状态和确认 / 否定。
- **工具与角色**：`annotate_source` 加 `quote`、`exclude`，被否定的不能再加；`read_source` 不列否定的、标出待确认和失效；distiller / ingest 的说明补上 quote、exclude 和按目录定级。

## 10-30：重复原件合并与相同内容折叠（原件治理第一期之三）

- **防止**（`lark-docs.ts` 的 `importLarkDocument`）：读到文档在知识库里时按 `/wiki/<节点>` 保存；从知识库链接读到、而库里已有同一 document id 的 /docx/ 副本时，把那份的 uri 改成 /wiki/ 链接接着用。docx 链接本来就能按 document id 找到知识库副本。
- **合并**（`src/sources/duplicates.ts`）：`findDuplicateDocs` 按 document id、`wiki_nodes.obj_token` 或节点找同一空间里的成对副本；`mergeDuplicateDocs` 默认只列出，`dryRun: false` 时每对一个事务：标注按段落移到知识库那份（找不到记失效）、关注程度在更高的人定时带过去、各表的 `source_id`（`page_cites`、`digest_done`、`source_locations`、`source_moves`、`lark_messages`、`wiki_nodes`、`source_cites`…）和事项材料改过去、docx 那份变成保留正文的墓碑，`source_aliases` 记旧 id → 新 id 和 `detail`。入口：`omem lark docs-dedupe [--apply]`、远程 `sources-merge-duplicates`。
- **解析旧 id**：`aliasTarget` / `canonicalSourceId`，用在 `getSource`（`readSource` 读新 id 的正文）、`read_source` 的 `resolveSource`、`/api/sources/:id`、分享快照、飞书引用链接、Wiki 引用。
- **相同内容折叠**（`search.ts`）：非代码原件按正文 hash 和起始行折叠，留排名最高的一份，`sameAs` 列出其余；`search` 工具写“另有 N 份相同内容”，命令面板可展开。


## 10-31：页面写给人读（内置技能 wiki-writing）

- **问题**：按批次追加写成的案例页，一个样本一节往后补，夹着阅读过程（“N 行已读、截图未展开”“本批”）、写给审稿人的否定句（“不能写成……”“不代表……”）和个人姓名，用户找不到该做什么。
- **技能** `skills/library/wiki-writing/SKILL.md`（启动时补进技能库，本人可在网页上改）：七条要求（开头给答案、一句一事、重复结构用表格、不确定集中写一处、不写调查过程、不写给审稿人的话、人写角色或团队），案例页模板（先这样查 → 常见原因表 → 交给谁 → 历史样本表 → 还没查清），新样本加一行而不是追加一节，改写前后对照，知识页的写法和用词。
- **角色**：`distiller`、`wiki-writer`、`wiki-linter` 挂上这个技能并可 `read_skill`；`distiller` 加“怎么写”一节，案例页改按模板、更新时整页改写；`wiki-writer` 加一句一事、表格、不写调查过程；`wiki-linter` 遇到追加式的案例页按模板整页重排；`_common.md` 的“表达”加一句一事和成稿不写过程，“工作文件与案例”改成模板和整页改写。

## 10-30：夜间复盘（换一条信息路径再答一次）

设计在 `docs/v2/replay.md`。

- **选题与选轴**（`src/agents/replay.ts`）：`selectQuestions` 从最近 `replay.days` 天的 ask / agent 运行里按信号（负面表情、本人纠正、没找到、超时、正面对照、慢、正常）排序，取 `replay.max` 题；`touchedBy` 从 `memory_recalls`、工具事件和回答引用解析原运行碰过的记忆、原件、页面；`precheck` 用检索看问题落在本空间、被忽略的原件、别的空间还是哪都没有；`chooseAxis` 按 `replay.plan` 取第一个适用、这题没试过的轴；`modelStep` 按 `replay.models` 阶梯或思考强度降 / 升一档。
- **回到当时**（`src/agents/replay-view.ts`）：`RunView`（`asOf`、`sourceLevels`、`memoryFilter`、`noPages`、`cache`）经 `runRole` / `prepareRun` 的 `replay` 参数进工具令牌（`ToolContext.view`）；`search`、`scan`、`recall`、`read_source`、`list_sources`、`list_pages`、`read_page`、`list_items` 和提示里的偏好与经验按它过滤：记忆按 supersede 链、聊天和对话逐行截断（`visibleLines`）、晚收的原件不存在、改过的文档和页面标“可能泄题”。两臂共用检索缓存（`viewSearch` 按最宽条件算一次）。
- **两臂与评判**：`runArm` 是父运行 `replay` 里就地执行的子运行 `replay-arm`（只读工具 `REPLAY_TOOLS`、影子写入、后端只读模式、临时目录、只放行 `readOnly` 的外部 MCP、“现在”写提问时间）；`checkArm` / `crossCheck` 做引用检查；`judgeOnce` 用内置角色 `roles/replay-judge.md` 两种顺序各一次（子运行 `replay-judge`），`combine` 一致才算胜负。评判的 AI 由本人在 Agent 页选，`judgeChoice` 没选时 `scheduleReplays` 不运行并记下原因（kv `replay_last`）。
- **改动**：`applyEffects` 写 `replay_effects`：M1 胜清空 `reviewed_at` 并写 `review_note`、M1 负记 helped、W1 胜给页面排 `wiki-lint`（新输入 `recheck`）、R2 胜进 `space-candidates.ts` 的关联候选；S1 / S2 / R3 的建议由 `resolveEffect` 采纳或忽略（卡片按钮 `replay:adopt|ignore:<id>`，`lark-actions.ts`）。`jobs.ts` 的 `sendItemDigests` 给本人的清点卡片加“昨晚复盘”一节；做梦任务带 helped 和存量经验噪声，记忆复核任务带复盘备注，coach 的复盘任务带该档案的复盘结论。
- **选型证据**：`replayModelEvidence` → `list_ai_backends` 的 `replay28d`；`runner.ts` 的任务选型说明加一句“只作参考”。
- **入口**：定时任务 `replay`（4:30，默认关）、`omem replay [list|run]`、`GET /api/replays`、`POST /api/replays/run`、`POST /api/replay-effects/:id/:action`、设备命令 `replays` / `replay-run`、`omem diag` 的 `replay`；设置 → Agent → 夜间复盘（`web/src/components/ReplaySettings.vue`），Agent 页首屏的复盘列表（`ReplayList.vue`）。档案 frontmatter 新增 `traits`（`research` 用于 R3），MCP 条目新增 `readOnly`。表 `replays`、`replay_effects`（迁移，随 `peer pull` 同步）。
- **未做**：K 轴、coach 按汇总证据提 `routing.candidates`、私有回归集。

## 10-30：主动读能看到的飞书知识库

- **发现**（`src/channels/lark-knowledge.ts` 的 `discoverKnowledgeBases`）：`wiki +space-list --page-all --page-limit 0` 和 `wiki spaces get my_library`（列表里没有个人文档库），写进 `wiki_spaces` 的新列（简介、类型、可见性、`discovered_at` / `last_seen_at` / `gone_at`）；列表完整时没再出现的记 `gone_at`。新出现的 `walkSample`：顶层一页、前 5 个顶层页面的下一层各 10 个，存 `sample`，调用之间停 300 毫秒。定时任务 `lark-kb-discover`（每周日 2:20，lark-cli 没登录时不做）；`lark-wiki.ts` 的 `wikiChildren` 不给节点时列顶层。`lark-auth.ts` 的 wiki-read 多了 `wiki:space:retrieve`。
- **归属建议**：新角色 `kb-scout`（`roles/kb-scout.md`，运行 `kb-scout`，每批 25 个），任务里有 `lark.knowledge.direction`、已有空间和样本；它的交付工具 `propose_knowledge_mapping`（`ROLE_TOOLS`，在 lark 分组）校验任务里的知识库和可写空间，新建空间要求运行能看所有空间，同名同 id 的新空间当作归入。`proposeMapping` 存 `proposal`（含方向的 hash，`later` 的在方向变了后重看），`autoApply` 时直接 `acceptProposal`。运行结束一条通知（`notifyProposals`，链接 `#/sources/kb`），再排下一批；看过的一周内不再看。
- **决定**（`applyMapping` / `kbAction`）：map / create / ignore / later / reset / pause / resume / update / read；新空间用 `createSpace`；初始程度写到目标空间的 `wiki:<知识库>` 节点（`attention.ts` 的 `setNodeLevel` 加 `future`，节点还没有页面时也能定）；`ensureCrawl` 用 `lark-wiki.ts` 新增的 `startSpaceCrawl` 从顶层建暂停的爬取（`wikiSpaceId`、`skipCaptured`），改目标时停掉旧的，读完一周后重走。
- **每晚读取**（`readKnowledgeDaily`，定时任务 `lark-kb-read` 每天 2:30）：`splitBudget` 先扣固定份额，再按优先级 3:2:1 分 `dailyDocs`；`crawlLoop` 对 `skipCaptured` 的爬取跳过空间里已有的页面（按 wiki 链接或 document id 找，记 `known`，不占份额）；读完的知识库把剩下的让给别的；前一晚读的还在排队整理时跳过那个空间。爬取交接前先 `applyNodeLevels`，仅检索的页面不进整理。每批写 `lark_kb_reads`；简报任务多一行“从飞书知识库读了 N 篇”，材料列表里不再逐篇列这些页面。
- **爬取存储**：每个爬取一个 kv 键 `lark_wiki_crawl/<id>`（原来所有爬取在 `lark_wiki_crawls` 一个值里，每读一篇都整体重写），旧值第一次读取时拆开；`forgetCrawl` 删掉被新爬取取代的。
- **入口**：网页原件 → 知识库（`web/src/views/KnowledgeBases.vue`，路由 `/sources/kb`，方向、建议直接生效和每晚篇数也在这里设）；接口 `/api/lark/kb*`；远程 `lark-kb-list` / `lark-kb-discover` / `lark-kb-read` / `lark-kb-map`；`omem lark kb list|discover|read|map`；配置 `lark.knowledge`（`direction`、`autoApply`、`dailyDocs`、`origin`）。拉取时 `wiki_spaces` 按 `checked_at` 和新的 `updated_at` 取新的。

## 10-31：重写页面不再丢旧路径

- **问题**：`move_page` 把旧路径记在页面 frontmatter 的 `aliases`，`writePage` 却用写作者给的 meta（标题、摘要、类型）整个替换，移动后再重写的页面旧路径就丢了，`page_aliases` 跟着清掉，链接和记忆里的 `[[旧路径]]` 打不开。
- **修正**（`wiki/store.ts`）：`writePage` 合并文件里已有的 `aliases`。
- **补回**：`restoreAliases(app, space, {dryRun})` 读知识库 `git log -p` 里该空间每个页面文件写过的 `aliases:` 条目，沿旧路径往前追，补回现在没有页面占用的；远程 `wiki-restore-aliases`（默认只列出）。`test/wiki-tree.test.ts` 覆盖重写保留和从历史补回。
- **远程开关定时任务**：peer 命令 `schedule-set {id, enabled}` 只改已有定时任务的开关（时间和配置不变），与 `schedule-run` 配合在常驻服务器上打开做梦、夜间复盘等。

## 10-31：设备协作登记模型和强度，原件目录里看不到名字的知识库

- **设备的外部 Agent**：`omem tool --peer` / `omem mcp --peer` 加 `--agent`、`--model`、`--effort`（环境变量 `OMEM_PEER_AGENT` / `OMEM_PEER_MODEL` / 新增 `OMEM_PEER_EFFORT`）；目标节点把这条 `peer-agent` 运行的 `ai` 记成 `{profile: peer:<调用方>:<Agent>, model, effort}`（运行页照常显示），工具上下文带上强度，写入的记忆记模型和强度。`test/peer-tools.test.ts` 覆盖。
- **不是成员的知识库**：飞书对非成员不给知识库名字和共享页面以上的目录（131006），以前目录树里只显示“知识库”“（未命名节点）”。现在用其中最上层的已知页面起名（“「X」所在的知识库”，`unnamed`），读不到标题的目录写“（无权限查看的目录）”或“（还没读到标题的目录）”；原件目录的行菜单可“命名”（`PUT /api/sources/wiki-space-name`），加入知识库后飞书给的名字会替换它。`test/source-catalog.test.ts` 覆盖。

## 10-31：规则给自己的运行指定 AI

- **原因**：任务选型（`agents.routing`）只写进会交办的运行（`DELEGATING`：run_agent、ask_agent、delegate_code……），由助手在交办时选；规则、定时任务这类宿主自己开的运行用档案或角色的默认 AI，规则任务说明里写的模型不会生效。
- **规则动作**（`rules/types.ts`）：`agent` 动作加 `ai: {profile, model?, effort?}`；`saveRule` 用 `validateExecution` 按后端最近的检测核对；`actions.ts` 的 `ruleAI` 把它作为运行的 `execution`（`source: user`，理由“规则「…」指定”）放进普通和静默排查两条路径开出的运行，`runRole` 照常换用。
- **界面与草稿**：规则页“交给 Agent”加“指定 AI”（复用 `AiDefaults`，默认显示档案自己的后端）；`/api/rule-options` 带 `backends` 和各档案的默认后端；草稿生成的提示列出可用后端和检测到的模型，本人点名模型时写 `ai`、不写进 task。`test/rules.test.ts` 覆盖保存核对、运行带上和不指定时不带。

## 10-30：压缩附件（ffmpeg）

常驻服务器 70 GB 的数据目录里图片和视频占了 47 GB，要能把它们转成压缩率高的格式，又不能让原来的引用失效。

- **ffmpeg**（`src/core/tools.ts`）：`OSDK_TOOLS` 加 `ffmpeg`、`ffprobe`（`conda:ffmpeg`），安装用 `osdk use -g`（同时选用，PATH 上的垫片对本人的 shell 也能用）；ffmpeg 只认 `-version`；PATH 上的 ffmpeg 要能跑才算（osdk 装了没选用时垫片只会报 no backend provides），否则经 `osdk exec`。`omem setup ffmpeg` 和向导里的“附件压缩”。
- **压缩**（新增 `src/core/media.ts`）：候选按大小倒序；有损图片 WebP、视频 SVT-AV1（没有时 x264）、音频 Opus（没有时 AAC），可限长边；无损只做 PNG/BMP/TIFF/GIF → 无损 WebP、WAV/AIFF → FLAC。ffprobe 核对时长，省不到 10% 记为 kept。结果写 `file_variants`，作业状态在内存、结束后存 kv `media_compress_last`。
- **对应关系**（新增 `src/core/stored-files.ts`、迁移 `file_variants`）：原件名仍是引用，`storedName` 在原件不在时返回压缩件；`sendStoredFile` 按实际文件给类型和下载名，飞书附件与文档图片的存在检查、`read_source` 给 Agent 的路径、`keepOriginal`（不把压缩过的原件写回）都走它；`storage-scan` 把压缩件归到原件的来源；`file_variants` 进 `pullTables`。
- **网页**：`web/src/components/MediaCompress.vue`，放在占用页附件卡片下。
- **并发、接着做、自动压缩**：配置 `media.concurrency`（默认 2，每次补位时读，改了即生效；ffmpeg 加 `-threads 核数÷并发`）和 `media.auto`（开关与方式、质量、长边、最小文件、是否删原件）。作业状态边做边存 kv `media_compress_last`，`finishedAt` 为空说明被中断，`boot` 里 `resumeMediaJob` 接着做，计数延续、`resumed` 加一；停止后 `POST /api/media/resume` 继续。压缩件改名进 `files/` 前先记 `pending`，`cleanPending` 撤掉中断留下的。`keepOriginal` 存下新文件时 `markStoredFileAdded`，`tickAutoCompress` 每分钟看一次，只压 `media_auto_since`（打开时记下）之后到的文件（取 mtime、ctime、birthtime 最大值，Windows 的 CopyFile 会保留源文件 mtime）。候选修正：无损记录的质量为空，之前同样设置失败的会被重复尝试；可选 `retryFailed`。向导和 `omem setup ffmpeg --concurrency/--auto` 也能设。

## 10-31：设置 → 设备，用设备的 Agent，本机信任收紧

- **改名**：peer 的中文统一为“设备”（原“同伴”）；Wiki 规划与写作里的“读者”改为“用户”（`docs/archive` 与写作检查技能不动）。
- **本机信任**（新增 `src/server/origin.ts`）：没配令牌时只信任 `Host` 是本机名、`Origin` 缺省或同源的本机请求，挡住别的网页对 127.0.0.1 的跨站请求、WebSocket 和 DNS 重绑定；用在 API 钩子、网页版 VS Code（会话 cookie 也要同源）、插件流、`omem peer open` 的本机转发。`/api/tools` 免钩子改为精确匹配；查询参数里的令牌只认 GET / HEAD；`config.token` 和内部令牌用定长比较（`sameSecret`）。
- **设置 → 设备**（`web/src/components/PeerSettings.vue`）：本机名字和地址、生成配对码、粘贴添加（直连或经某台转发）、检查在线与版本、改地址、移除；“持有本机令牌的设备”列出 `peer:*` 令牌（`pairedTokens`，id 是令牌哈希的前 16 位）并可撤销。移除时先请对方 `/api/peer/unpair` 撤销它发的令牌（尽力而为），本机用它的 Agent 配置和引用它们的角色、默认、兜底一并清掉（`dropPeerAgents`）。
- **用设备的 Agent**（新增 `src/core/peer-acp.ts`）：Agent 配置加 `peer: {id, agent}`，`allProfiles` 把命令换成本机的 `omem peer acp <设备> <Agent>`。它对 `/api/peer/acp` 发起升级连接（`tunneled` 收进这个路径，经中间设备照常转发），按行传 `{acp}`、`{mcp}`/`{mcpReply}`、`{stderr}`、`{exit}`。对方只跑自己的 ACP 配置，在 `peer-acp/<调用方>` 目录里启动，`session/new|load|resume|fork` 的 `cwd` 换成这个目录、`mcpServers` 换成替身（支持 HTTP MCP 用 `/mcp`，否则用 stdio 桥，令牌只在这条连接上有效，`toolRelay`）；替身上的列表和调用回到本机，按会话原来的 MCP 配置执行（`@modelcontextprotocol/sdk` 客户端），本机的工具令牌不出本机。服务关闭时断开这些连接。
- **测试**：`test/peer-acp.test.ts`（经中间设备跑假 Agent，检索和记忆落在本机；没有的 Agent 被拒）、`test/origin.test.ts`。

## 10-31：回答不拿否定句当结论；Wiki 换空间、草稿卡片“不发”、跨空间链接

- **写法**（`roles/_common.md`）：“区分事实、推断、未知”改成“说法要有依据，也要给出结论”：推出来的说判断和依据，没查到的说查了哪里、还差什么，不做成每次回答的固定栏目。“表达”加三条：正面说查到了什么，不用“不能证明”“不能直接认定”“尚未确认”“不能把……归因于……”代替结论（附改写对照）；不复述没做的事和任务边界；少用“不是 A，而是 B”和提示语冒号。用 GPT 系模型时这类免责句最多，规则对所有模型生效，不按模型特判。
- **交办任务怎么写**（`roles/assistant.md`）：写目标、已知事实、交付物和一句边界，要对方交回“最有依据的判断和还差的一项”；不把谨慎写成一串禁令（它们会原样变成对方报告里的免责句）。接手报告时不照搬报告里的免责句。写飞书文档、报告、方案前先读 `wiki-writing`；技能说明改为也适用于文档，第 6 条加上“不能证明”“尚未确认”这类话。
- **Wiki 换空间**（`web/src/App.vue`、`Graph.vue`）：路由视图的 key 原来带 `state.space`，在 Wiki 页换空间时视图先按旧路径重建，新实例又把路径里的旧空间写回 `state.space`，选择框跳回去。路径带空间的页面（`/wiki/<空间>`、`/graph/<空间>`）改按路径里的空间做 key，换空间时先跳到新路径；关系图也跟着换空间。Wiki 页收到的页面和运行事件改为几秒内合并成一次重新加载（以前任何空间的任何运行事件都整棵目录重载，忙的时候请求不断）。
- **草稿卡片**（`src/channels/lark-actions.ts`）：点“发送”“不发”后，新卡片放在回调响应里返回（和问答、访客、会议卡片一致），不再在回调还没结束时用接口改卡片（那样改的不一定生效，失败也被吞掉）；发送失败时卡片保持可点并提示原因。`test/lark.test.ts` 覆盖发送和不发。
- **跨空间链接**：Wiki 页里 `[[空间:页面]]` 不再按当前空间的页面列表标成“页面尚不存在”（`Markdown.vue`）；记忆里的 `[[空间:页面]]` 空间名可以是任何文字（`MemoryText.vue`，以前只认字母数字）。

## 10-31：飞书知识库页可搜索

- **搜索**（`web/src/views/KnowledgeBases.vue`）：状态筛选旁加搜索框，在浏览器里按空格分词，每个词都要出现在名称、说明、浅读的目录标题（含子页面标题）、归入的空间名或建议（目标、新空间名、理由）里；状态标签的数字按搜索结果重算；当前标签没有匹配而别的有时给“在全部里看”。Esc 清空。接口不变。

## 10-31：设备的外部 Agent 评审分支；按钮悬停

- **外部 Agent 评审分支**：`review_branch` 不再在 `PEER_DENY` 里。经 `--peer` 调用时（`ToolContext.peer`），建的分支评审带 `peerReviewer`：编码运行检出、取 diff、建索引、定计划后以 `awaiting-peer` 结束（跳过预判、精调、负责人和计划确认），不问本机任何模型，也不占并发槽。新工具 `review_task`（只给外部 Agent，材料 + 各评审项的角色说明，diff 分页），`submit_review` / `submit_change_points` 加 `run_id`、`check`；三者在 `ROLE_TOOLS` 里不随分组授出，经 `PEER_REVIEW_TOOLS` 给外部 Agent。最后一项交齐时 `peerSubmitted` 排 `review` 运行，`reviewRound` 读已交的结论汇总（`review-chain.ts`）。网页显示“等外部 Agent 评审”。`test/branch-review.test.ts` 覆盖。
- **按钮悬停**（`web/src/styles.css`）：通用 `.btn:hover` 改成在原底色上叠一层 `--hover`（`background-image`），实心按钮（`.primary`、`.accent`、`.danger-fill`）悬停统一变淡；`danger-fill` 从 `DialogHost.vue` 移到公共样式。原来红色确认按钮悬停会变成浅底白字。

## 10-31：VS Code 插件：提问流式显示、问题线程写修改点、网页版固定连接

- **提问**（`vscode/src/review.ts`）：命令立即返回，输入框清空；回答按运行事件流式写回线程，思考和工具折叠在 `<details>` 里，结束后换成最终回答。
- **评审问题的线程可以“记为修改点”**：问题标为“改”，修改点带问题编号进下一轮；删掉修改点不删问题线程。
- **网页版 VS Code**（`vscode/src/connection.ts`）：有 `OMEM_URL` 时固定连它、用 `OMEM_TOKEN`，不看浏览器里存的连接设置和令牌；“连接 omem…”只提示。

## 10-31：需求树；设备交办这台机器的 Agent

- **需求树**（新增 `src/items/requirements.ts`、`src/agents/req-split.ts`、`roles/req-splitter.md`、`web/src/views/Requirements.vue`，设计 `docs/v2/requirements.md`）：迁移加 `req_nodes`、`req_versions`、`req_links`、`req_status`、`reqs_fts` / `req_rowids`。每空间一棵树，节点 id 固定，每次修改一个版本（`correct` / `change`，业务变更必须写原因；删除分 `delete` / `remove`），跨空间关联，Agent 写的待确认。检索加 `requirement` 命中类型（`search` 的 `scope: "requirements"`），测试点不进。事项材料加 `req`；`materialsBrief` 带上需求点（`reqBrief`），续轮带交办开始后的业务变更。变更点加 `req`，`submit_change_points` 记 `req_status`。工具 `req_tree`、`req_read`、`save_requirements`、`split_requirements`（分组 items）；编码和评审角色加 `req_read`、`req_tree`。HTTP：`/api/requirements`、`/api/requirements/:id`、`POST /api/requirements`、`POST /api/items/:id/split-requirements`。导航加“需求”，事项材料加“拆需求点”。设备拉取带上四张表并重建检索。
- **设备交办**：`run_agent` / `ask_agent` 不再在 `PEER_DENY` 里；经 `--peer` 调用时排成 `agent` 运行（`fromPeer`），立即返回运行 id，用 `read_run` 取结果。

## 10-31：需求树按端分层、折叠与搜索，拆分从本人的修改里学

- **拆分写法**（`roles/req-splitter.md` 重写）：系统按端（PC端、移动端…），空间即产品；公共规则单独成页面并 link，不重复；依据优先级（本人决定 > 后来的群聊口径 > PRD > 旧实现）；迁移需求必须核对并引用旧代码；acceptance 写可观察的结果；测试点一条一个场景，覆盖边界、错误提示、权限、状态和存量数据。
- **从修改里学**：`ownerCorrections`（`src/items/requirements.ts`）取本人对 Agent 写的节点的更正、删除和确认；`req-split` 任务列出同空间最近的修改，`profile-jobs.ts` 的 req-splitter 复盘证据带上每次拆分之后本人的处理。
- **需求页**：树可折叠（按空间存在浏览器里，首次只展开到模块）、全部展开 / 收起、隐藏测试点、按标题 / 需求 / 验收 / id 搜索（匹配项连同路径）。

## 10-31：设备的外部 Agent 编码

- `delegate_code` 不再在 `PEER_DENY` 里。经 `--peer` 调用时交办带 `peerCoder`（不能指定编码 AI 和 Git 同步）：`runCodeTask` 建好工作分支、工作区、装好依赖后以 `awaiting-peer-code` 结束，跳过预判和本人补充的投递。
- 新工具 `code_workspace`（`src/agents/peer-code.ts`，`ROLE_TOOLS` 里，经 `PEER_REVIEW_TOOLS` 给外部 Agent）：brief / list / read / grep / write / edit / delete / run / output / git / finish。路径限定在工作区内、不能动 `.git`；`run` 只运行仓库设置里的检查命令、准备命令和新设置 `peerCommands`（设置页“设备的外部 Agent 可以运行的命令”，一行一个“名字: 命令”），参数按 `SAFE_ARG` 校验，后台执行可轮询；轮次排队或进行时不能改。
- `finish` 用 `queueStandaloneFix` 排一轮带 `peerFinished`（不随续轮复制）：跳过隐式同步和编码，summary 当编码说明，照常提交、检查、diff、索引，`review=peer` 时带 `peerReviewer` 走外部 Agent 评审。`test/peer-code.test.ts` 覆盖。
- `code_workspace` 加 `git=merge`（`ref`，先 fetch、要求工作区干净，冲突标记留在文件里由调用方改好再 `commit`）和 `merge-abort`：外部 Agent 编码时把另一条分支合并进来。
- 拆分反馈：`ownerCorrections` 也算 Agent 按本人要求做的更正（`by` 不是节点作者），每条写出节点类型、所在上级和是谁改的；`roles/coach.md` 加“读本人对产出的修改”：同类错两次以上提说明修改，一次记做法经验，不把业务规则写进记忆。
- `code_workspace` 加 `import`（`from_run`）：把另一次没应用的交办保存的 patch 用 `git apply --3way` 导入工作区（要求工作区干净，先 merge 它基于的提交），用于接手旧交办；之后旧交办可丢弃。
- 外部 Agent 的交办在确认或丢弃前不让出工作区（`code-branch.ts` 的 `idle()`）：原来它停在 `awaiting-peer-code`（状态 done）时会被新交办收走并 `reset --hard`，未提交的修改丢失。

## 10-31：豆包 CLI 作为后端

- 新传输 `doubao-cli`（`src/agents/doubao-cli.ts`，内置档案“豆包 (CLI)”，空闲上限 30 分钟：整轮结束前没有输出）。`doubao -p` 的 stdout 是最终回复，stderr 的 `{"type":"session"}` 是会话 id，`--resume` 续聊；`--model`、`--effort`、`--permission-mode`（编码 `always_allow`，其余 `ask_risky`）、`-C` 工作目录。
- 没有 MCP：有 omem 工具时说明末尾加 `DOUBAO_TOOL_NOTE`，让它在 shell 里用 `omem tool`（`agentToolEnv` 的令牌和 PATH 会传到它执行的命令）；额外 MCP 服务器给不了，发一条状态说明。
- 提示超过 6000 字或只能经 cmd 调用时写进 `tmpdir()/omem-doubao/<uuid>.md` 让它先读，结束后删掉；默认命令 `doubao` 直接调用 npm 包解压的原生程序（`doubaoAppRoot()`，和包里 `runtime.cjs` 的位置一致）。
- 检测模型（`probeDoubaoCli`，网页 Agent 页的“检测模型”也对它开放）：`--model` 给一个不存在的名字读出可用模型，再按模型试 `--effort none` / `max` 读出强度；都带 `--resume 1`，合法组合停在找会话这一步，不新建对话。
- 它的对话存在豆包账号里，CLI 不能删除或归档（11-03 起经 OpenAPI 删除 omem 建的，见下）。
- `code_workspace` 写新文件时按最近的已有上级目录解析真实路径：工作区在链接后面（如 home 目录是链接）时，原来新文件会被判成“不在工作区里”。

## 10-31：需求页里看编码；本人改写评审建议

- 带事项的交办和分支评审放在这件事的业务空间（`code.ts` 的 `homeSpace`，`delegate_code`、`review_branch`、`/api/review-branch` 都用它）：事项挂了需求点就用需求树所在的空间，否则用事项的空间；原来取第一个仓库的空间，运行记录按业务空间看不到。两个迁移把已有的（带 `itemId` 和 `repos` 的交办，连同各轮和评审子运行）挪过去：从仓库空间，或从不是需求树空间的事项空间（如个人空间）。
- 新增 `src/items/work.ts`：`itemWork`（事项的 `run` 材料按交办归并各轮，算阶段 coding / reviewing / peer / owner / done / applied / discarded 和最新一轮没定的问题数）、`reqWork`（事项的 `req` 材料包含这个节点或在它下面）、`reqWorkMarks`（树上的“等你 N”）。`GET /api/requirements` 的节点带 `work`，`GET /api/requirements/:id` 带 `work` 列表。
- 需求页：详情加“编码与评审”（进行中的在前，已应用或丢弃的收起），`?work=<运行>` 时右栏换成 `components/WorkPane.vue`（评审概览、各轮切换、应用 / 丢弃、就某条提问）；树上标“等你 N”和进行中的图标，可“只看等你处理的编码”。`ReviewSummary` 加 `stay`（开始修改后发 `started`，不跳运行页）。
- 评审问题加 `owner_suggestion`（迁移）：`PUT /api/runs/:id/findings/:fid/suggestion` 保存本人改写的建议（和原建议相同或为空就清掉；没定过的问题标成 fix）。修改任务写“建议（本人改写，以此为准）”，不再带原建议；评审负责人和无负责人时的修改单也用改写后的（`suggestionOf`）。网页问题卡片展开后顺序改为问题 → 依据 → 建议，“改建议”就地编辑，标题旁标“建议已改”。
- 需求页里的编码页加“在 VS Code 中打开”“提问”和运行页的四个标签（概览 / 变更 / 评审 / 活动）。打开一次交办时（`?work=`，`tab=` 记标签），左侧树按这一轮变更点的 `req` 标状态（最差的那个），没涉及的变灰，需求外的变更点单列；点节点不关交办，“需求点”标签里 `ChangeView` 带 `only`（这个节点及下级的变更点和它们下面的点），第一处自动定位。前端 `ChangePoint` 加 `req`；`parsePatches`、`pointQuote` 挪到 `lib/reviews.ts`，运行页同用。
- 同一分支一起改：`review-fix.ts` 的 `sameBranchWork`（同一用户 30 天内、没应用或丢弃、任一仓库的分支相同的交办和分支评审；分支取评审的分支、交办的起点或落点）、`GET /api/runs/:id/same-branch`；`startFix` 加 `withSameBranch`，问题可以来自这些评审，没选的在各自最新一轮记成暂不改，“这次不改的问题”也汇总它们。`ReviewSummary` 的“一起看同一分支的其他评审”：读它们最新一轮的问题，决定和改建议写到各自的运行上。
- 需求页的详情靠左（不再居中留出大块空白），打开交办时最宽 1280px；评审概览和编码页的网格改成可收缩的一列，评审项的长摘要、路径不再撑出横向滚动。
- 旧评审看最新状态：`review_findings.fixed_by` 记接手问题的那一轮（`startFix` 自动记；`PUT /api/runs/:id/findings-fixed` 由本人标或撤回），`GET /api/runs/:id/latest-state` 返回这些轮次的状态和分支上更新的编码（`review-fix.ts` 的 `newerWork`：之后开始的交办；分支评审还算没应用的交办；别的分支评审不算）。`ReviewSummary` 里交出去的问题标“修改中 / 已修改 / 已修改并应用”，不算待处理、不再发给修改、不显示改 / 暂不改 / 不改；旧评审顶部写更新的编码，展开问题可“已在新编码里改了”。`AskAboutRun` 在有更新的编码时让助手以它为准。接着改旧交办时，分支上后来有交办应用过就先 `sync.pull`。
- 没有需求拆分的一轮沿用别处的：`review-fix.ts` 的 `inheritedSplit`（同一交办更早一轮，否则同一分支其他工作最近一轮，有 `output.changePoints` 或评审项给的变更点），`GET /api/runs/:id/inherited-split`；`WorkPane` 这时用那一轮的 `useReviews` 和补丁给树和“需求点”标签，`points` 事件带上来源，需求页图例写明沿用的哪一次。
- 评审问题的写法：`review.ts` 的 `FINDING_FORMAT` 写进各评审项和外部 Agent 的评审任务（标题说清情境；正文 Markdown 分现在的实现 / 源实现 / 触发条件 / 问题，引用 `[说明](路径:起-止)` 在正文里）；`ReviewSummary` 用 Markdown 显示正文和建议（`Markdown` 的 `runId` 让代码引用打开交办的文件），“依据”只列正文没引用的。新工具 `revise_finding`（code 分组，原写法存 `review_findings.revised`），问题上的“看不懂，重新描述”带着草稿打开提问抽屉（`AskAboutRun` 的 `draft`）。
- 代码文件的引用：`GET /api/runs/:id/file` 对图片返回 `binary: "image"`、二进制和超过 2 MB 的返回 `binary`，`GET /api/runs/:id/file/raw` 给原始字节（图片 inline，其他下载，带 sandbox CSP）；引用抽屉显示图片或下载按钮。聊天原件的引用在抽屉里用 `ChatView`（可切回原文行号）。提问抽屉默认 640 宽、可加宽，正文单列不撑宽。
- 外部 Agent 编码过的交办：`startFix` 开的轮次清掉 `peerCoder` / `peerReviewer`，由这台机器编码和评审；等外部 Agent 编码的一轮可 `POST /api/runs/:id/code-here`（`review-fix.ts` 的 `codeHere`）改由这台机器做，交给它的问题（`fixed_by`）跟到新的一轮。
- 差异的文件状态：`web/src/lib/patch.ts` 的 `splitPatch` / `diffMeta` 取代各处各写的切分（`reviews.ts` 的 `parsePatches`、`CodeGitPanel`），文件按改动后的路径命名，带状态（新增 / 删除 / 移动 / 复制）、原路径、相似度、二进制、权限和两边的 blob id；`DiffName` 显示文件头，`DiffTree` 标状态，`DiffFile` 对没有行的文件说明发生了什么、显示图片前后或给下载。新接口 `GET /api/runs/:id/blob?space=&oid=&path=` 按 blob id 读这次交办仓库里的旧版本。
- 过期的卡片：`asks.ts` 的 `ROUND_ASKS`（评审计划、结果、停下、重试）在新的一轮排上（`queueNextCodeRound`、`queueStandaloneFix`）、应用、丢弃时对之前各轮一起作废，`startFix` 连同一起修改的同一分支其他评审；启动时 `sweepRoundAsks` 清理以前遗留的。
- 设计稿 `docs/v2/coding-loop.md`：以修改项代替轮次推进编码与评审（逐项验证、AI 决定评审范围代替档位、不阻塞的“等你决定”、并行编码、检查点与回退），未实现。
- 评审问题的显示：小节标题（`**触发条件**`）紧跟在列表项下面没有空行时，Markdown 把它并进上一条列表项，缩进显示；`web/src/lib/findingText.ts` 的 `findingMarkdown` 在显示前给只有加粗标签的行前后补空行（以“标签：”开头的行前面补空行），`ReviewSummary` 的正文、建议和原来的描述都经过它，`FINDING_FORMAT` 也要求小节标题前空一行。问题正文里 `src:` / `mem:` / `msg:` 引用和直接写的路径不再显示成等宽小标签，和代码引用一样是带下划线的普通链接（只限 `.fd`，回答等处不变）。
- 按修改项推进的交办（`docs/v2/coding-loop.md` 第一阶段）：新表 `code_tasks`、`code_checkpoints`，`review_findings.task_id`；`src/agents/code-tasks.ts`（修改项、检查点、预算、按修改项的改动、回退）、`code-loop.ts`（逐项验证、阶段评审、分流、下一步、`code-task` 卡片、`advanceWork` / `answerTask` / `ownerNote`）。新工具 `plan_tasks`、`finish_task`、`report_task`（编码）、`verify_tasks`（评审项）、`plan_review`（评审负责人），都是角色交结果用的（`ROLE_TOOLS`），运行时按需加给角色（`runRole` 的 `addTools`）；角色说明里带 `<!-- tools: … -->` 的小节同样只给有这些工具的运行（`toolSections`）。`rule_review` 的裁决可带 `owner`；`delegate_code` 加 `max_rounds`；`/api/delegate` 加 `maxRounds`；新接口 `GET/POST /api/runs/:id/tasks`、`POST /api/runs/:id/tasks/:seq`、`POST /api/runs/:id/work`、`GET /api/runs/:id/task-diff`；配置 `agents.autoAdvance.codeRoundsMax`（默认 12）、`taskLoop`（默认开）。
- 按修改项推进的交办（第三阶段）：`code-tasks.ts` 的回退扩展成检查点 / 文件 / 一段（`RevertOp`、`scheduleWorkRevert`、`applyReverts`、`revertLabel`），新接口 `POST /api/runs/:id/revert`、`GET /api/runs/:id/file-at`，`task-diff` 的每段带 `from` / `to`；只回退的一轮（`output.gitOnly`）不叫编码 Agent、不做阶段评审；`recordOutsideChanges` 把一轮开始前分支上的外来改动记成检查点（本人没提交的以 `Omem-By: owner` 提交）。`DiffFile` 的 `revertable` 给每段“回退这一段”；`CodeTasks` 加检查点列表、恢复文件。飞书进度卡片（`lark-code-progress.ts` 的 `snapshot`）对按修改项推进的交办显示修改项。VS Code 插件新视图“修改项”（`vscode/src/tasks.ts`，`omem-rev:` 内容提供者 + `vscode.changes` 多文件对比）。
- 编码问评审：新工具 `ask_reviewer`（编码 Agent，只在按修改项推进的交办里，`ROLE_TOOLS`），`code-loop.ts` 的 `askReviewer` 用 `consult.ts` 的 `consultAgent` 问提出这一项的评审项，在它这次交办的会话里回答（`output.work.sessions`），问答记在修改项上（`TaskNote` 的 `consult`）。`consultAgent` 现在也能问内置角色（`role`）并带运行选项（`extra`：续哪个会话、在哪个目录、能读哪些空间）。
- 并行编码与异议裁决：`src/agents/code-helpers.ts`（`registerRound`、`dispatchTasks`、`joinHelpers`：助手是这一轮的子运行，`input.helperOf`，借工作区池的工作区，提交拣回工作分支，冲突经编码 Agent 解决）；新工具 `dispatch_tasks`（编码负责人）、`rule_dispute`（评审负责人），`taskRound` 认得助手（`actor`、它自己的工作区）；配置 `agents.autoAdvance.parallelCoders`（默认 3）。修改项新状态 `disputed`（裁决中），`code-loop.ts` 的 `arbitrate` / `ruleDispute`；`settleCodingRound` 连同助手的项一起结算。`code.ts` 导出 `addWorktree`、`shell`、`conflictTask` 给助手用。
- 评审和编码同时进行：`src/agents/code-overlap.ts`（`openRound` / `taskFinished` / `settleTurn` / `closeRound`：一轮里逐项验证、没改好的交回同一轮；`planLook` / `startLook`：换模型复看，子运行 `input.secondLookOf`；`snapshot` 只读快照；`withCheck` 每个评审项的会话一次一个回合；`checkArgs` / `runCheck` 统一评审项的角色、模型和会话）。评审项会话、验证从 `code-loop.ts` 挪到这里。`finish_task` 当场记下这一项的提交（`attributeCommits`）并开始验证；`plan_review` 加 `second_look`；`submit_review` / `verify_tasks` 认 `ToolContext.check`（`RoleRunInput.checkName`）；`ReviewPlan.second` / `looks`；`review.ts` 的 `lookName` / `checkLabel`；`WorkState.look` / `lookAI`；`code-steer.ts` 的 `addRoundFeedback`（随工具返回交给编码 Agent）；`runs.ts` 的 `trackAbort`；按修改项推进时 `reviewRound` 不再对主评审项用 `rotatedExecution`。网页：修改项卡片显示复看进度，运行页“之后的评审”在按修改项推进时是“复看由评审负责人定 / 每次换模型复看 / 不复看”。
- 按轮推进的旧交办在本人下一次提修改时转为按修改项推进（`review-fix.ts` 的 `startFix`：设 `taskMode`、之前各轮记成检查点 1，`req.review` 写进 `roundReview`）；`planStage` 把 `roundReview.checks` 当作本人要求必选的评审项。
- 需求页修正：打开交办后点一个详情里没有这次交办的节点（如没涉及的节点），`openedWork` 和 `lastWork` 的监听互相触发，页面卡死，已修。没涉及的（灰色）节点改为打开它自己的页面；交办上方的路径改为回到各节点自己的页面，和返回按钮一样；“需求点”标签直接用树上的节点，不再在详情加载完之前显示上一个节点的部分。`WorkPane` 的标题放不下时截短，返回按钮不再单独占一行；按修改项推进的一轮没有自己的评审（只做了逐项验证）时，也显示修改项列表。超过 4 轮时只列最近 3 轮，更早的放进“更早的轮”下拉；修改项卡片（`CodeTasks`）在手机宽度下不再撑出卡片，长选项换行。
- 重复的修改项：阶段评审时评审项和评审负责人都读到已有的修改项（`code-tasks.ts` 的 `taskList`、`review-chain.ts` 的 `taskCheckBrief`、`TaskReviewOptions.tasks`）；`rule_review` 的裁决可带 `task`，`merge` 到没做完的修改项（`joinTask` 把问题记到那一项的 `origin.findings`，不另开）；`reviewsOf` 带 `task_seq`，“待处理问题”每条标 T 编号、“并到 T5”。复看的评审项也读这份清单。评审设置的“换模型复审”（`review.rotation`）单独成一页（左栏“模型”），档位里只留开关：按修改项推进时复看用的就是这个列表，以前要先打开某个档位的开关才看得到。
- 需求页确认推送：运行页的“同步停在冲突上”、工作分支面板（确认并推送）、应用后的接收位置与提交抽成 `web/src/components/CodeLanding.vue`，运行页和需求页（`WorkPane`）共用；需求页补上“移到目标分支最新提交”，“应用到原分支”的条件和运行页一致。`src/items/work.ts` 的 `Work` 加 `branchWork`，需求页列表评审通过时写“可以确认推送”，推送后标“已推送”；评审概览的标题同样写“可以确认推送”。
- 需求页打开一轮还在进行的交办：以前不沿用更早的需求拆分，每个需求点都显示“没有对应的变更点”，切换需求点只有面包屑变；现在进行中的一轮也沿用最近一次拆分（`WorkPane` 的 inherited split），并写明“这一轮还在进行”。
- 网页版 VS Code 的压缩与缓存：`ide-web.ts` 把 `/ide/stable-<提交>/static/` 的文件 gzip 一次存进 `ide/gzip/<提交>/`，以后直接发、带 `immutable`；界面翻译带 ETag、可 304、要发时压缩。经 `peer open` 打开常驻服务器时 workbench.js 从约 21 MB 变成约 5 MB。
- 和分支比较：`GET /api/runs/:id/task-diff?base=<分支>`（`code-tasks.ts` 的 `workPatches`：`origin/` 开头先 `fetchBranch`，从 `merge-base` 比到工作分支最新提交）；运行页“修改项”的“和分支比较…”，VS Code “修改项”视图的同名命令（`omem.work.compareBase`，右边用工作区里的文件，能问 omem、记修改点）。
- 运行页“修改项”看改动的面板（某一项、检查点、我上次看过之后、和分支比较）加了左边的文件目录（`DiffTree`）和上下 / 左右切换（`lib/diffLayout`），和运行页“改动”一样。
- VS Code 插件：“和分支比较”时左边的 `omem-rev:` 用和右边工作区文件相同的路径（仓库路径放查询参数 `file`），不再把每个文件标成改名；新视图“改动的文件”（`vscode/src/changes.ts`）按目录列出看过的改动，点文件单独对比，超过 50 个文件不自动打开多文件对比。
- 和分支比较的新一侧：`task-diff?base=` 每个仓库返回 `at`（HEAD 正是工作分支最新提交的 worktree），VS Code 插件只在有 `at` 时用那里的文件，否则两边都从 omem 读。以前用交办的文件夹，确认过的交办那里是仓库主目录、已回到别的分支，新增的文件打开报“文件不存在”，修改的文件右边是别的分支的内容。
- 确认推送过的交办接着改：`startFix` 对已经确认到工作分支的交办不再报“已经应用或丢弃”，而是在同一个分支上接着改：分支上还有没应用的交办就作为它的下一轮，否则开一个新交办（`fromBranches` 是那个分支，先 `sync.pull` 拉取 origin 上的最新提交，标题“接着改：…”，带 `fromReview`，选中的问题和本人的要求照常成为修改项）。以补丁应用的仍拒绝（改动可能还没提交，新交办看不到）。网页评审概览和 VS Code 插件在已应用的交办上照常能选问题、记修改点，按钮写“接着改”。
- VS Code 插件的提问和修改点写明是哪份代码：`omem-rev:` 带 `side`（改动前 / 改动后），提问和修改点的位置写“路径:行（改动前的版本 <提交>）”或“（改动后的版本 <提交>）”，编辑器里的文件写“（工作区里的文件）”。以前改动前那一侧的行号和改动后的分不出来。
- 新的内置评审项“精简”（`roles/review-simplify.md`）：功能不变时哪些代码能删、合并、内联或改用仓库已有实现（过度封装、层层传参、重复实现、绕远路、多余的参数和开关、同类文件不在一处），迁移时顺带报搬漏；默认加在“完整”档。
- 交办和分支评审的工作区索引（`wt-…` 空间）不再做向量：`embedPending` 跳过它们，评审期间按文本检索。同一个大分支同时开几次评审时，每次各索引一遍（常驻服务器上 6 次评审约 2.3 万段），本地向量模型在同一个进程里把 CPU 占满，评审 Agent 的 omem 工具调用要几分钟，`submit_review` 等不到回执，评审只留下文字结论。
- 宿主发现的修改项（`code-loop.ts` 的 `hostFindings`）：交办的提交里有被 `.gitignore` 忽略的文件（`code.ts` 的 `ignoredAdded`，按 `git check-ignore -v` 的规则分组）时加“撤回提交了的被忽略文件”，评审任务里也列出；没有别的待做项、检查却没通过时加“检查没通过”，以前会带着失败的检查判为完成（一次交办里检查命令因为删掉了构建脚本一直报错，三轮都判“通过”）。`roles/coder.md` 写明不要 `git add -f` 被忽略的文件。
- 编码 Agent 被挡住的项先交给助手（`settle_code_task`）：`report_task` 的 blocked 在交办来自对话时不给本人发卡片，一轮结束叫醒助手时列出（`code-tasks.ts` 的 `blockedText`），助手让它重做、不做或交给本人（`code-loop.ts` 的 `settleTask`）；本人在对话里回答了“等你决定”的项也由助手转达，已发的卡片关闭。编码任务写明宿主开始前的 Git 同步结果和 HEAD，`roles/coder.md` 说明拉取、推送由宿主做。`delegate_code` 在已有分支上不带事项时沿用这条分支之前交办的事项（`review-fix.ts` 的 `itemOnBranch`）。
- 思考气泡更新超时不再立刻撤回：已经能更新的气泡遇到超时当作已送达接着更新，连续三次超时才撤回并改发“处理中”卡片（`lark-cot.ts` 的 `tolerant`）。常驻服务器上一天里 8 次撤回都是飞书 15 秒没回。

## 11-03：后端会话清理补漏；豆包会话经 OpenAPI 删除

- **ACP 清理补漏**（`acp.ts`）：`discard` 时原连接已断（进程退出，或后台池里闲置期间连接关闭：常驻服务器上 Codex 10-23 以来 92 次“ACP connection closed”）改用 `deleteAcpSession`：另起一个进程，`initialize` 后只调 `session/delete`。之前进程已退出时直接跳过、不提示。
- **聊天换会话时清理旧的**（`sessions.ts` 的 `retireReplaced`，`dispatch.ts` 的 `retireSession`）：聊天会话因轮数上限、换模型或旧会话恢复不了而换成新会话时，旧会话按后端能力归档（`archiveArgs`）、`session/delete` 或豆包删除；在后台进行，失败只写服务日志。编码、交办、评审链的会话仍保留供续轮。
- **豆包**：`deleteDoubaoSession`（`DELETE /v1/sessions/:id`，无令牌时接口回 99991661，路由存在）。`doubao` 与 `doubao-cli` 的单次运行（不续会话、不保留）结束后删掉这次建的会话，失败的也删；CLI 的对话 id 交给同一个接口（同一豆包账号），这台机器没有授权 OpenAPI 时运行里提示会话留在豆包历史里。只删 omem 从后端拿到的 id。
- **飞书里引用和机器人的私聊**（`citations.ts`）：和机器人的私聊不进 `lark_messages`，补到的位置原来无处可存，`msg:` 引用都只打开这个私聊（读者本来就在这里）。现在位置记在 omem 消息的 `meta.larkPosition`；`deliverToThread` 送出的回复记下 `larkMessageId`；没有位置、又正是发往的会话时，引用改成只读分享；没发到飞书的消息（记录、卡片）直接分享。
- **网页的页面参数**（`web/src/lib/route.ts` 的 `pageParam`）：需求、事项、问答、运行、原件页只认自己路径下的 id，路由已经换到别的页、旧页面还没卸载时不再拿新页的 id 去请求（运行页报“需求点不存在：<运行 id>”）。
- **修改项推进的一轮做完再停**（`code.ts`、`code-overlap.ts` 的 `settleTurn`）：编码 Agent 做完一两项就停下时，同一会话里接着做这一轮没做的项（最多 8 次，没进展就停）。没轮到的项不再算一次尝试（`code-tasks.ts` 的 `notReached`，连续 3 轮没轮到交给助手）。助手用 `continue_code_run` / `message_code_run` 说的“接着推进”作为下一轮的交代（`workNote`、`roundNotes`），`new_item: true` 才记成修改项。问本人的卡片带完成标准、评审问题、每次的情况和编码 Agent 的说明（`ownerQuestionText`）。

## 11-03：豆包会话删除真机验收；兼容 CLI 2.31.2

- 真机确认 CLI 创建的会话可以通过 OpenAPI 删除：先用同一 ID 续聊，再经 `retireSession` 删除；`doubao --list` 不再包含它，OpenAPI 查询返回 HTTP 404 / code 3440008。CLI、OpenAPI 的单次任务结束后也都自动删除，删除接口返回 HTTP 200 / code 0。仅使用本次创建的临时会话。
- `doubao-cli.ts` 启动时忽略 stdin：2.31.2 无法把 Node 子进程默认的 socket 接为标准输入，原来的启动方式报“无法连接标准输入”。`spawn.ts` 增加可选的 stdin 模式，其余调用仍默认管道。CLI 仍按 `doubao` 命令识别，不依赖安装包的名称。
- `doubao.ts` 创建或恢复会话时发出 `session` 事件，修复创建成功但读取回复失败后外层拿不到 ID、未清理的遗漏；假接口覆盖流 HTTP 503、回复失败，以及续聊 / 保留会话不删。
- 全量检查的测试脚本修正：假 osdk 用 shell 参数展开取得自身目录，避免测试收窄 PATH 后找不到外部 `dirname`。

## 11-03：需求页切换空间

- 空间选择先退出旧需求和编码详情，再切换空间，避免页面重建后加载旧需求，把空间切回去；直接打开跨空间需求链接仍切到需求所属空间（`web/src/App.vue`）。
- 需求树和详情忽略过期请求的结果及错误；页面卸载时移除事件订阅并清理定时刷新，旧页面不再改动当前空间（`web/src/views/Requirements.vue`）。

## 11-03：编码交办“等谁”分开，助手马上被叫醒

- 修改项新状态“等助手处理”（`assistant`）：被挡住、缺外部字段、验证 3 次没过、连续 3 轮没轮到、评审负责人没裁决都进这里，不再显示成“等你决定”、不发卡片；“等你决定”只留给带选项的业务取舍（`report_task(owner)`、`settle_code_task(owner)` 没选项会被拒绝）。旧数据的 `owner + blocked` 迁移成新状态（`src/core/db.ts`）。
- 一项变成“等助手处理”时宿主马上叫醒发起交办的助手（`code-chain.ts` 的 `wakeAssistantForTasks`，同一交办同时一轮，可回答 QUIET），不等交办停下；交办停下时叫醒它的消息由宿主写明停下的原因和现在等谁（`stopText`）。
- 宿主限制助手（`code-loop.ts` 的 `settleTask`）：同一项最多 retry 2 次；不能替本人决定；retry 只在自动推进的轮数内开下一轮（`advanceWork`）。
- 运行页轮次多时，较早的轮收进“更早的轮”下拉（`web/src/views/Runs.vue`，和 WorkPane 一样）。
- 角色、工具、唤醒和全部限制的表：docs/v2/coding-loop.md 3.1。

## 11-04：外部 Agent 的工具调用留痕

- 经 `/mcp`、`/api/tools` 进来的每次工具调用，到达和返回时在它的运行上各记一条 `tool-call`（工具名，`omem_call` 写成 `omem_call → 实际工具`；返回时带耗时和是否成功）；超过 60 秒的在服务日志里另记一行。Agent 显示某个调用一直没回时，看有没有“到达”就能分清：没到 omem、卡在 omem 里，还是回去的路上慢（`src/server/http.ts`）。
- 令牌无效的调用在服务日志里记一行：令牌只在内存里，服务重启前开的 Agent 会话还拿着旧令牌。
- 启动时整理修改项：已经不等本人的项关掉旧卡片；等助手处理的项叫醒发起交办的助手，没有助手的交办交给本人（`code-loop.ts` 的 `reconcileWaiting`）。
- 服务重启不再打断交办：停止时正在跑的运行因为会话被关掉而出错的，留在“进行中”，下次启动重新排队（`runs.ts` 的 `stopWorker`）；以前这类运行会记成失败（“ACP connection closed”），交办停住。
- 编码写完后被重启打断的一轮，重新开始时沿用写好的代码，接着验证和阶段评审；以前它被当成“没有要编码的项”的一轮跳过阶段评审，直接判为完成（`code.ts` 的 `ranBefore`）。只有真的做了回退的一轮才不再做阶段评审。
- 运行页修改项面板加“重新评审”（`POST /api/runs/:id/review-again`，`code-loop.ts` 的 `reviewAgain`）：评审被打断、或想再看一遍时，开一轮只做评审，看最后一个检查点之前到现在的改动；发出的“确认并推送”卡片失效。
- 启动时整理修改项也处理已经确认（推送）或丢弃的交办：还挂着的卡片关掉，项记成不做。

## 11-04：检索重排

- `src/search/rerank.ts`：可选的本地重排（默认关），bge-reranker-v2-m3 的 q8 ONNX 经 transformers.js 运行，osdk 别名 `rerank-m3`（`osdk.toml` 锁定版本）。`search()` 融合后把前 `rerank.top` 条（默认 20，读整块片段）重新排序，命中带 `rerank` 分数；调用排队，超过 `timeoutMs` 保持融合顺序；`search(..., { rerank: false })` 跳过。`embeddings.ts` 的 `loadLocalModel` 让本地目录的模型逐个加载（transformers.js 的本地路径是全局设置）。
- 对话前带上记忆（`memory/passive.ts`）：开着重排时余弦 ≥ 0.4 的最近 20 条交给重排，过 `rerank.passiveThreshold`（0.5）才带上，`score` 是重排分数；最多等 3 秒，重排没给结果时退回余弦门槛。
- 设置：`omem setup rerank [--model] [--threads] [--off]`、setup 向导的“重排模型”；网页 设置 → 检索 的“重排”卡片（`GET /api/settings` 多了 `rerank` 状态：加载情况、调用次数、超时次数、上一次耗时），改动不用重启。
- 评测：`eval-retrieval.ts --rerank [模型] --rerank-top --rerank-tokens --model`，`eval-recall-gate.ts --rerank`；T2 子集 nDCG@10 86.61 → 91.58（docs/v2/evaluation.md）。`test/rerank.test.ts`。

## 11-04：卡片点击先回应、会议没开 AI 纪要、豆包

- 飞书卡片的按钮要在约 3 秒内回应：回答要做的事超过 2 秒（确认交办会推送分支），先回“收到，正在处理”，做完卡片再更新（`lark-asks.ts` 的 `ANSWER_WAIT_MS`）。以前推送慢时飞书显示“服务未响应”，其实推送照常完成。
- 机器人入会因会议没开 AI 纪要失败（飞书 10022）时，通知说清楚要主持人打开 AI 纪要；之后半小时内每分钟自动再拉一次，入会后再通知一次（`lark-meetings.ts`）。飞书给 omem 的会议信息里没有“是否开了 AI 纪要”，只能靠入会结果判断。
- 豆包会话清理每次都写一行状态：删了哪个会话、经哪个应用，或者为什么没删；豆包 CLI 的说明里加上“这一轮自己做完，不开子 Agent，原件先 search 再按需读”（CLI 没有关子 Agent 的参数）。
- 会议旁听不再在会上打扰本人：会中各段的运行没有 notify，和本人有关的事写在它的回答里；会后的纪要收齐这些（`heldNotes`），先列和本人有关的、再写结论与待办、最后是处理建议。纪要发到本人和主机器人的私聊（当前的会话），最值得做的 1–3 条用 suggest_next 做成按钮，点了或直接回复就由助手接着处理；找不到私聊时照旧作为通知。智能体运行的输入可以带 `denyTools`（`jobs.ts`）。

## 11-04：飞书文档按块编辑、lark-cli 1.0.98

- `@larksuite/cli` 1.0.97 → 1.0.98、`@larksuiteoapi/node-sdk` 1.74.0 → 1.76.0。
- 新工具 `lark_doc_fetch`（飞书分组）：以本人身份 `docs +fetch --detail with-ids`，可按 outline / section / range / keyword 读一部分，拿 block id；只读，不存原件。外部 Agent（`--peer`）用不了。
- `lark_doc_update` 加 `block_replace`、`block_insert_after`、`block_delete`、`block_move_after`、`block_copy_insert_after`（参数 `block_id`、`start_block_id` / `end_block_id`、`src_block_ids`、`revision_id`），`content` 在这些命令里可省略或默认 DocxXML；返回结果、新 block、飞书的提示。块操作沿用追加 / 局部替换的批准（`commands` 仍记为 append、str_replace），旧批准照样覆盖。以前只有追加、替换一段文字、整篇覆盖，改表格只能整篇覆盖。
- 内置技能 `lark-docs`：读 → 按块改 → 重读核对的做法、表格怎么改、新建文档；`references/` 里的 DocxXML / Markdown 写法由 `scripts/sync-lark-skills.ts` 从 lark-cli 自带的说明（`lark-cli skills read lark-doc/...`）同步。主助手改文档前先读它。lark-cli 的其他技能（lark-im 等）是本人身份的命令行做法，omem 的写入走工具，不内置。

## 11-04：工具按用途分组

- `TOOL_GROUPS` 从 10 个按领域的大组拆成 19 个按用途的小组：`read` / `collect` / `curate`（原 sources）、`track` / `notifications`（原 items）、`delegate` / `skills`（原 agents）、`ask` / `wake`（原 owner，`notify` 移到 ask）、`coding` / `git` / `code-handin`（原 code）、`lark-msg` / `lark-docs` / `lark-capture`（原 lark，`lark_wiki_crawl` 移到 collect）；memory、wiki、learning、plugins 不变。每组带 `doc`，几组共用原来的 reference 页，`omem_help` 填分组 id 或说明页名都行。
- 旧分组名不再兼容（11-04 去掉 `GROUP_ALIASES`：常驻服务器上自定义过的主助手已是新分组名，档案都没用分组）。主助手的 `tools:` 改成新分组。
- `test/tool-help.test.ts`：每组不超过 15 个工具（插件组除外）、每组都在 SKILL.md 分组表里。
- `DIRECT_ALL` 20 → 30：常驻服务器上 ingest（21 个工具）两周调了 750 次 `omem_help`、自定义档案（28 个）343 次、dream 6 次，都是工具数刚过线、非常用工具藏在 `omem_call` 后面造成的。`CORE_TOOLS` 加 `list_sources`、`write_file`、`list_runs`、`read_run`、`wake_later`、`cancel_wake`（主助手和档案运行里最常经 omem_call 调的几个）。
- 按两周的调用统计精简内置角色：triager 去掉 source_outline、list_pages、recall、list_items（2810 次运行里没用过，说明里也没提）；kb-scout 去掉 search；memory-reviewer 去掉 list_items。

## 11-04：以本人身份读写飞书的其他数据

- 新工具 `lark_read` / `lark_write`（分组 `lark-owner`）：以本人身份跑一条 lark-cli 命令，风险等级取 lark-cli 自己在 `--help` 里标的 read / write / high-risk-write（缓存）。read 在数据域里放行（不含 api、auth、config、event、apps），`skills read/list`、`schema` 也能读；write 只放行 sheets、base、slides、markdown、task 和 drive 的评论命令，本人自己的文件直接写（新建到云空间根目录也算），别人的文件和所有任务操作先审批，按文件复用（`docEditDecision` 加了 tool 参数）；命令里必须出现 target 的 token；high-risk-write、`--as`、`--yes` 拒绝；在临时目录里运行，下载的文件运行后删除。外部 Agent（`--peer`）用不了。
- 内置技能 `lark-suite`：按业务列出要读的 lark-cli 官方说明（lark-sheets、lark-base、lark-task、lark-drive、lark-im、lark-mail、lark-meeting、lark-workflow-meeting-summary……）和这里能读 / 能写什么；官方说明不复制进仓库，运行时用 `lark_read(["skills","read",…])` 读，和装的版本一致。lark-shared 的登录、授权、高风险确认由 omem 处理，不需要。
- AGENTS.md 的“以本人身份写飞书只有这几处”补上 `lark_doc_*` 和 `lark_write`；仍不能以本人身份发消息、邮件和日程邀请。
- `lark-cli.ts` 加 `larkCliOutput`（`--help`、`skills read` 这类输出文本的命令）。

## 11-04：额度用完自动换后端

- 问题：常驻服务器上 Codex 额度用完，每个运行都先试 Codex 再失败（“Internal error”），没有换到配好的兜底。codex-acp 2.5.0 把“You've hit your usage limit … try again at 2:36 PM.”作为回答文字发出，再以 JSON-RPC internal error 结束这一轮，`data` 里是 `codexErrorInfo: "usageLimitExceeded"`；原来的重试判断只认限流、排队。
- `acp.ts` 的 `promptError`：把 JSON-RPC 的 `data` 拼进错误信息，额度用完的标成 `quota`（`AgentFailureKind` 新增）；`isRetryableAgentError` 认 `quota` 和 `isQuotaMessage`（usage limit、insufficient_quota、out of credits……）。
- `capacity.ts`：`markOutOfQuota` 按来源记到 kv `agent_quota_exhausted`，恢复时间由 `quotaResetAt` 从消息读（本机时间的“at 2:36 PM”取下一次、带日期的、“in 2 hours”，没有就一小时）；`excluded` 在恢复前为真，所以 `acquire`、`fallbackProfiles` 和对话的兜底链都跳过它；`clearOutOfQuota`、`outOfQuotaList`。
- `runner.ts` 的 `noteQuota`：运行和对话轮次遇到额度用完时记下并发状态“… 的额度用完了，<时间> 前自动改用其他后端”；`sessions.ts` 的对话兜底链跳过额度用完的账号（都不可用时仍试第一个）。
- 网页：设置 → Agent → 并行 显示“额度用完”的账号和恢复时间，`DELETE /api/agents/quota/:source` 提前恢复。
- 剩余额度：codex-acp 只在 `/status` 命令的文字里给出各窗口的剩余百分比，不经 ACP 推送，这里不读它。
- 测试：`test/quota.test.ts`，假 ACP 加 `FAKE_QUOTA=1`。

## 切换、卡片与后台接续修复（2026-11-04）

- 运行详情和评审、Wiki、原件、事项、问答待确认列表、Agent 档案与规则详情丢弃旧请求的迟到结果，旧请求也不能结束新请求的加载状态。
- 飞书确认卡片不等待联系人查询；需执行宿主操作或批准工具时，先保存回答并返回回调，再执行后续操作，避免同步 Git 操作阻塞回调的超时计时器。后续失败写回卡片结果。
- 整群共用会话时，记录最近消息的话题位置；后续回复、通知和确认卡片沿用该位置。本人回到群外层发消息后恢复外层投递。独立话题会话仍分别投递。
- 新编码分支从 origin 声明的默认分支最新提交建立；正常续轮同步工作分支，omem 新建的分支再并入它切出的分支（`cutFrom`），本人选的已有分支（如发布分支）只跟它自己的远端，不并入默认分支；冲突沿用编码 Agent 处理流程。读取或更新远端默认分支失败时停止，不按旧版本继续。没有远端的仓库使用本地默认分支，没有默认分支才使用 HEAD。
- 规则助手自唤醒继承原运行的空间、工具限制、渠道范围和执行配置；唤醒其他档案不继承这些权限。

## 11-04：网页版 VS Code 复用已下载服务端

- `src/server/ide-web.ts`：启动时选最近下载完整的服务端，通过官方 CLI 的 `--commit-id` 指定版本；所有项目共用，不再在打开项目时追踪最新版。中断下载的 `.staging`、缺少 Node、服务端入口或启动脚本的目录不参与选择。
- 首次没有缓存时，准备页改为后台检查并显示等待秒数；准备好才刷新进入工作台。HTTP 错误、连接失败或超过 10 分钟后停止检查，显示原因及“重新检查”；保留 serve-web 在准备响应中设置的 cookie。
- HTTP 集成回归覆盖跨项目、重启复用完整缓存，排除不完整目录，等待响应与 cookie。Playwright 验证等待不导航、成功进入、服务端报错以纯文本显示、超时停止、断网和重试；1440 / 390 宽度无横向溢出。真实官方 CLI 复用缓存，约 1 秒返回工作台。
- 验证：独立临时目录、`LANGUAGE=C LC_ALL=C.UTF-8` 下 `pnpm run check` 通过（134 个测试文件、778 项测试、类型检查与构建）。

## 审查修正：续轮同步、卡片与网页版 VS Code 下载（2026-11-05）

- 编码续轮只把 omem 新建的分支并入它切出的分支（`wt.cutFrom`）；本人选的已有分支（`fromBranches`，如发布分支）只拉自己的远端，不再每轮并入默认分支（`src/agents/code.ts` 的 `syncPhase`，`test/code-sync.test.ts`）。
- 飞书卡片操作：联系人查询在回调里最多等 300 毫秒，超时先用 id；“只有 … 可以处理”恢复显示名字；交给对话的“[卡片操作]”在回调返回后再查名字（最多 5 秒），Agent 看到的是名字（`lark-actions.ts`，`test/lark.test.ts`）。
- 提问卡片关闭时只更新真正发出的那张（有 message_id 的记录，优先未处理的）；卡片回答等待 `ANSWER_WAIT_MS` 改为 800 毫秒，比整个回调的 `CALLBACK_WAIT_MS`（1 秒）短，慢回答也带着更新后的卡片返回。
- 飞书会话的下一步按钮和规则确认卡片在回复送达后展示，另有 60 秒兜底（`LARK_SUGGESTION_FALLBACK_MS`）：回复没发出去时按钮不丢，已展示的不重复（`test/rule-confirmation.test.ts`）。
- 网页版 VS Code：服务端由 omem 自己下载（`src/server/ide-download.ts`）：查更新服务的最新版本，流式下载并显示进度（已下载 / 总大小、速度、剩余时间），按公布的 SHA-256 校验，解压后放进 serve-web 的缓存目录，用 `--commit-id` 运行。已有完整版本时直接进入，serve-web 启动一分钟后（之后每天最多一次）在后台下载新版本，下次启动 serve-web 时使用，旧版本在不再运行后删掉。`ide.web.updateUrl: "off"` 时交回 serve-web 自己下载。Windows 上用系统的 bsdtar 解压 zip（Git 自带的 GNU tar 读不了 zip，也会把 `C:` 当成远程主机）。
- 验证：`test/ide-web.test.ts` 用假更新服务覆盖首次下载的进度、下载中其他请求 503、完成后进入、后台更新不影响正在运行的版本、下次启动换新版本、清理旧版本；本机用官方 1.145.0 Windows 包（211 MB，SHA-256 与公布值一致）经 omem 下载解压后，真实 `code-tunnel serve-web --commit-id` 直接返回工作台，没有再次下载。

## 多人登录（2026-11-05）

- 设计与分期：`docs/v2/multi-user.md`。这是第 1 期：登录与会话。
- `src/auth/`：`providers.ts` 登录方注册表（授权地址、换令牌、`whoami`，身份由服务端拿令牌查，不信浏览器）；`lark.ts` 用机器人应用做飞书 OAuth（`authen/v1/authorize` + PKCE、`authen/v2/oauth/token`、`authen/v1/user_info`），身份是 union_id，本应用的 open_id 记成别名；`login.ts` 登录 / 绑定 / 待批准 / 邀请 / 机器人一次性链接；`sessions.ts` 会话 cookie（`omem_sid`，只存哈希）；`http.ts` 的 `resolveAuth`（令牌 → 会话 → 本机）和相关接口。
- 迁移：`users` 加 `kind`、`status`（pending）、`email`、`avatar`；`identities` 加 `kind`（login / alias）、`tenant`、`app_id`、`display`、`verified_at`，已有的飞书 `ou_` 身份改成 alias；新表 `auth_sessions`、`auth_states`、`invites`、`login_links`（本机的，不参与拉取）。
- `resolveIdentity`、`userForToken`、`accessibleSpaces`、`canWrite` 不认待批准的用户。机器人给用户发私聊改用 `larkOpenIdOf`（只取机器人应用里的 open_id 别名）。
- 配置 `auth`：`enabled`、`providers`、`primary`、`signup`（按登录方：approve / closed / open）、`sessionDays`。打开后 `trustedLocal(..., { refuseProxied })` 把带 `X-Forwarded-For` / `Forwarded` / `X-Real-IP` 的请求排除在本机信任之外（插件流、网页版 VS Code、`omem peer open` 同样）。
- HTTP：`/api/auth/session`、`/api/auth/:provider/start|callback`、`/api/auth/link/:code`、`/api/auth/logout` 不经统一鉴权；`/api/auth/account`、会话和身份的删除给每个人；`/api/users`、`/api/invites`、`/api/auth/providers` 只给本人。待批准和受限会话只能访问 `/api/me` 和 `/api/auth/*`（403 带 `code: pending|restricted`）。成员可以 GET `/api/spaces`（只列能读的）。
- 网页：`/login`（不带外壳）、`/account`、设置 → 成员；401 带 `login: true` 时跳登录页而不是要令牌。命令：`/login`；`omem user approve`、`omem user invite`。

## 交办不在细枝末节里打转（2026-11-05）

- 起因：常驻服务器上一次桌面工具的交办，需求的 6 项第一晚做完，之后两天 43 轮、49 个评审修改项几乎都在磨 MCP stdio 层的请求 ID 复用、取消竞态和输出背压，同一处连着修了十层，源码安装和二维码登录实测一直没做。
- 评审负责人（`TASK_RULING`、`roles/review-lead.md`）先问问题和需求、和代码实际用法的关系；碰不到的 `rule_review` 用 `defer` 记成以后再做（finding `decision = later`，修改项 `wontdo` + `origin.later`）。没改好 / 改出新问题的带 `follows`，`followDepth` 超过 `MAX_FOLLOW_DEPTH`（2）的新项交给助手。评审项的说明也要求先找影响验收和实际用法的问题。
- 可交付点（`WorkState.deliverableAt`）：需求本身的项都完成、检查通过的那次阶段评审；之后的阶段评审还有评审项待做时发一次 `work-deliver` 卡片（先推送验证 / 剩下的以后再做），不暂停。之后 `POLISH_STAGES`（3）次阶段评审仍有新问题就暂停 `polishing`，助手接手。
- 推送不结束交办：`deliverBranchWork` 推工作分支（一轮在编码时推最近一次阶段评审的检查点），`apply_code_run` 的 `keep_going`，记在 `WorkState.delivered`。确认时还在等本人的项记成以后再做。
- 接续：`delegate_code` 在已有分支上、`startFix` 的“接着改”新交办时，`carryTasks` 把之前确认过的交办没做完的项接成待做、以后再做的照样列着，旧项记“接到交办 X 的 Tn”。第一轮全是接续项时编码 Agent 仍先 `plan_tasks` 拆这次的任务。
- 助手：停下的消息带 `goalText`（原任务、需求项与评审项进展、轮数、推送）；两种交给助手的说明改成“你是发起人不是转发人”，按原需求判断、用本人的话、不写 T 编号；`settle_code_task` 加 `later`（评审提的待做项可以直接放下，需求本身的项要本人原话）。
- 运行页和飞书进度卡片显示“以后再做”和新的暂停原因。

## 交办的汇报跟着本人换会话（2026-11-05）

- 现象：话题群里在第一条话题交办，本人之后在第三条话题里接着说（助手 `message_code_run`），每轮结果、“有修改项等你处理”、助手的接手汇报和卡片仍发回第一条话题。原因是这些都用 `chain.conversationId`（发起时的会话），只有交办整体移到工作话题时才换。
- `code-chain.ts` 的 `reportConversation` 导出，顺序是本人最近调整交办的会话（ask 运行的 `output.codeReportTo`）→ 工作话题 → 发起的会话；`followOwner` 在 `message_code_run`、`continue_code_run`、`fix_review`、`settle_code_task`、`apply_code_run` 成功后由 `runTool` 调用（`STEERS_CODE`），从调用它的 ask 运行取会话，只认本人自己的会话；换过去时工具返回里提醒助手说一声进度卡片在原话题。
- 结果记录直接写到汇报会话（`settleCodeChain`），交给助手时按消息实际所在的会话判断要不要搬；卡片（`askDeliver`、`ensureOwnerAsks`、`askPlan`、`askRetry`、`askConfirm`、`escalate`、同步冲突）都改用它。
- 验收 R27k；测试 `test/code-loop.test.ts`“reports to the conversation the owner last steered…”。

## 角色与权限（2026-11-05）

- `src/auth/permissions.ts`：全局权限与空间权限清单、内置角色（`BUILTIN_ROLES`）、自定义角色（新表 `roles`，随拉取同步）、`can` / `spacesWith` / `requirePerm` / `canReadRun` / `runReadableSpaces` / `globalPerms`、改动记录（新表 `audit_events`，本机的）。`accessibleSpaces` = `spacesWith(space.read)`，`canWrite` = `can(memory.write)`；旧的空间 owner 成员迁成 manager。
- `src/auth/routes.ts`：每个 `/api` 路由要什么（public / self / owner / 全局权限 / 某空间的权限 / 能读这条运行），`server/http.ts` 的 `preHandler` 统一检查；`MEMBER_ROUTES` 删掉。`test/permissions.test.ts` 用 `registeredRoutes` 检查全部登记。
- `runs.scope`：`createRun` 记下这条运行最多能读的空间；`listRuns` 的 `visibleTo`。事件流按人过滤（运行、通知、提问、插件会话、空间变化）。`listNotifications` / `markRead` 按人。
- 删除别人的对话、读别人对话里的消息现在返回 404（以前成员能删任何对话）。成员 GET `/api/memories`、`/api/memory-folders`、`/api/memory-tags` 不带空间时只含能读的空间。
- `src/auth/tools.ts`：编码、Git、采集设置、规则、档案和技能保存等工具要对应的全局权限；`runner.ts` 建工具清单时去掉，`callTool` 再查一次。`write_page` / `move_page` / `confirm_page` / `generate_wiki` 和 Wiki 规划运行要 `wiki.write`。
- 新接口：`/api/access/roles`（列出、建、改、删）、`/api/access/audit`、`/api/spaces/:id/members`（空间管理者）、`PATCH /api/users/:id` 的 `role`；邀请可以带全局角色和任意空间角色。成员建空间时成为管理者；关联本机目录要 `code.delegate`。`/api/me` 带 `perms`、`writes`、`wiki`、`manages`。
- 网页：导航按权限显示；设置 → 成员 加全局角色、空间角色、角色编辑和改动记录；账号页“我管理的空间”。

## 评审问题正文里的原件引用也要存在（2026-11-05）

- 现象：一条评审问题正文里的 PRD 链接点开报“原件不存在”。评审项抄原件 id 时中间漏了三个字符；`submit_review` 只核对 `evidence` 和变更点的 `refs`，正文里的链接没有核对。
- `review.ts` 的 `inlineRefs` 取出 Markdown 里的 `src:` / `mem:` 引用；`submit_review`（问题的标题、正文、建议，变更点的需求和实现）、`submit_change_points`、`revise_finding` 都用 `deadRefs` 核对，找不到就拒绝并让它用 `read_source` 核对后重交。
- 另有一种：引用了交办工作区里建了索引的文件，工作区归还后这些原件随之删除，链接也会失效；还没处理。

## 审查修正：交办暂停后的收尾、裁决改口、汇报会话（2026-11-05）

- 暂停后没有可做的：`advanceWork` 原来先看 `paused` 和轮数，助手把“只剩打磨”或轮数用完时剩下的评审项都 `later` 后交办一直停着，不出确认卡片（只有本人的操作会经 `renewBudget` 清掉暂停）。现在只在还有可做的项时才被暂停和轮数挡住；没有可做、也没有等谁的项时清掉暂停，照常 `completed`。
- `work-deliver` 卡片（需求做完了）在 `completed`、`confirmBranchRun`、`discardCodeRun` 时关掉，不再一直挂着、点了报错。
- 可交付点：`deliverableStage`（`code-tasks.ts`）在需求本身的项又有没做完的（本人加了一项）时作废，做完再重新记；打磨的次数从可交付点和上次打磨暂停里较晚的那个数起。原来可交付点只记一次，本人加的需求一做完，第一次阶段评审就会因打磨暂停。
- `applyRulings`：评审负责人在同一轮里对同一条问题先 `defer` 再改成别的裁决，`decision = later` 不再留着（原来会让接受的问题变成以后再做，连带丢掉给本人的问题）。
- `followFrom`：只有本人在这一轮说了话（`ownerAskedThisTurn`）才改汇报的会话。原来交给助手的一轮、唤醒、规则触发的运行调用 `settle_code_task` 等也会改，还排在第一条话题里的交接会把汇报拉回去。
- 验收 R27l；测试 `test/code-loop.test.ts` 新增四个用例，“reports to the conversation…”补了交接一轮的情况。

## 连接器与飞书多用户（2026-11-05）

- `src/auth/vault.ts`：连接（每人每个提供方一条）与令牌，存 `secrets/vault.db`，令牌 AES-256-GCM（`secrets/vault.key`）。`connections.ts`：`saveConnection`、`accessToken`（到期前 10 分钟刷新，同一连接串行）、`renewConnections`（刷新令牌两天内到期的续一次，接在 lark-poll 定时任务后面）、刷新失败标 `expired` 并通知一次。`features.ts`：飞书功能与 scope。`LoginProvider.refresh`（飞书 `authen/v2/oauth/token` 的 refresh_token）。
- 登录流程加 `purpose=connect`（要 `connector.use`；`features` 或 `scopes` 决定要哪些 scope）；登录或绑定时令牌带 scope、带刷新令牌或已经有连接，就存下来。接口：`GET /api/auth/connections`、`DELETE /api/auth/connections/:provider`。
- `lark-cli.ts`：`larkActor`（AsyncLocalStorage）与 `setLarkCredentials`；在某人的上下文里 `larkCli` 用 `LARKSUITE_CLI_APP_ID` / `LARKSUITE_CLI_USER_ACCESS_TOKEN` / `LARKSUITE_CLI_BRAND` 跑。`lark-user.ts` 的 `asLarkUser`；`tools.ts` 的 `runTool` 把每次工具调用包进去，`ownerOnly` 改为“本人，或有 `connector.use` 且连接可用的人”。`asOwner` 在成员上下文里给成员发账号页授权链接；`personalLibrary` 按人缓存；`lark_write` 判断“是不是自己的文件”用这个人在机器人应用里的 open_id。
- 去重：迁移给 `sources` 加 `origin_key`（`upsertSource` 用 `originKeyOf` 填，旧数据按 URI 和 `documentId` 回填）、新表 `source_viewers`、`lark_message_lines`（按原件记消息的行，从 `lark_messages.source_id/line` 回填；拉取不带，回落到旧列）。`persistChatMessages` 加 `userId`：本人照旧写进聊天已有的副本，别人只写自己空间里的副本。`captureSpace(app, chatId, userId)`：绑定和已有副本只在采集者有 `capture.route` 的空间才用，否则进他的个人空间。成员导入一篇已在他能读的共享空间里的飞书文档时只记 `source_viewers`。
- `src/channels/lark-member-capture.ts`：开了“我的消息”的成员，每次 lark-poll 后以他的身份读最近活跃的 30 个会话（游标在 kv `lark_member_cursor:<用户>:<会话>`），已有可读共享副本的只记 `source_viewers`。开了日程、妙记、文档的，接着跑 `lark-personal.ts` 的 `captureCalendar` / `captureMinutes` / `captureRecentDocs`（带 `who`：写进他的个人空间，kv 状态键加 `:<用户>`，不占本人的每小时检查）；`capture-space.ts` 的 `sharedCopyFor` 找他能读的共享副本并记下（聊天也改用它）。
- 按读者分开：`lark-docs.ts` 数正文里嵌进来的表格和同步块，有的话 meta 记 `perReader` 和 `capturedBy`，`originKeyOf` 给 `lark:doc:<id>#<用户>`，不会被当作共享副本给别人用。多维表格只存链接，没有要分开的。
- 检索：`search.ts` 按 origin_key（去掉 `#` 以后）合并，留排名最高的一份，`Hit.elsewhere` 列出其余；`SearchOptions.visible`（`visibility.ts` 的 `hitFilter`）让读者看不到的副本在合并前去掉。`search` 工具输出“同一个聊天或文档另有 N 处”，命令面板显示其余几处的空间名。
- 对着真实飞书接口用假令牌核对过返回（2026-11-05）：令牌接口失败是 `{ error: "invalid_grant", error_description, code }`（授权码 20003、刷新令牌 20026），`user_info` 的坏令牌是 HTTP 200 加 `code: 20005`，文档权限接口路径存在（坏令牌 99991668）。据此改了两处：刷新只在 `invalid_grant`（`providers.ts` 的 `GrantRejected` / `grantRejected`，插件的 `refresh` 也这样表示）时标为需要重新授权，网络或飞书出错返回 503、连接不动，下次再刷；文档阅读权限只记飞书真正给出的答案，调用失败（连接过期、缺权限、网络）不记成“不能看”，十分钟内不重复问。lark-cli 1.0.98 以成员身份调用（`LARKSUITE_CLI_USER_ACCESS_TOKEN`）时确实把这个令牌发给飞书、不用本机登录，`auth` 命令在这种方式下不可用；令牌被拒时退出码 3、stderr 里是 `authentication` / `token_invalid`（99991668）。以前这类错误可能被说成“请执行 lark-cli auth login”；现在在成员的调用里改说他的授权不被接受，并把令牌标为过期（`staleToken`），下一次先刷新。用假凭据从 `asLarkUser` 一路走到真实飞书核对过：被拒 → 标为过期 → 刷新被拒（20026）→ 连接变成需要重新授权。
- 机器人检查（`lark-bot-check.ts`）：`checkLarkApp` 带回应用已有的全部 scope（`grantedScopes`），主应用的结果多一项 `members`：连接功能（`features.ts`）要用、应用还没有的用户身份 scope，涉及哪些功能，`token_type=user` 的申请链接；设置页“机器人权限与事件检查”和远程命令 `lark-bot-permissions` 都带上。成员打开这些功能时就不会撞上 20027。
- 授权页地址里 scope 之间用 `%20`（飞书文档的写法；`URLSearchParams` 会写成 `+`）。用真实应用打开授权页（不登录）：回调地址没加进“重定向 URL”时飞书先报 20029，scope 的检查在这之后，要加上回调地址才看得到。
- 向量：`embedPending` 先找正文和标题都相同、已有向量的切块，复制过来；同一批里相同的输入只算一次。迁移加部分索引 `chunks_text_head`（长度 + 开头 80 字，只含有向量的切块）。
- 网页：账号页“已连接的应用”（按功能打开、重新授权、断开、缺权限的授权提示）；本人那里只说明用 lark-cli 登录。

## 插件连接器（2026-11-05）

- `src/plugins/types.ts`：`PluginApi.connector(def)`（`LoginProvider` 加 `features`）、`PluginContext.connection(provider)` 返回 `{ account, scopes, fetch }`。清单加 `connectors: [{ provider, features }]`，`describePlugin` 带出来。
- `registry.ts`：`api.connector` 检查 id 前缀、注册 `registerLoginProvider` 和 `registerFeatures`，`unloadCode` 时撤销。`LoginProvider.apiBase`；`connections.ts` 的 `pluginConnection` 只往 `apiBase` 下发请求（不跟随重定向）。
- 账号页列出所有有功能的提供方（不只是登录方）；插件页在清单要的连接缺失时显示提示条。

## 多服务连接（2026-11-05）

- `src/core/federation.ts`：服务账号（`serviceAccount`，`users.kind = service`，角色 viewer，没有个人空间）、`peer_shares`、`shareInvite`（`peers.ts` 的 `invite` 可以给服务账号发令牌，标签 `fed:<名字>`）、`sharesFor`（本人的设备看到全部）、`fedSearch` / `fedSource` / `fedChanges`；订阅方 `subscribe`（建或认领只读镜像空间，`settings.mirror`）、`peerSearch`、`peerRead`、`syncSubscription` / `syncAll`、`peer_aliases` 换引用。镜像原件 URI 为 `peer:<设备>:<对方 id>`，带 origin_key。
- 迁移：`peer_shares`、`change_log`（原件、页面、记忆的触发器）、`peer_subscriptions`、`peer_aliases`（都是本机的，不参与拉取）。
- `permissions.ts`：镜像空间里谁都没有 `source.write` / `memory.write` / `wiki.write` / `capture.route`（本人也没有）。
- 接口：`/api/fed/*`（服务账号，按授权）、`/api/peer/shares`、`/api/peer/subscriptions`、`/api/peer/offers/:peer`（`peers.manage`）。`addPeer` 探测地址改用 `/api/me`（服务账号读不了诊断）。定时任务 `peer-sync`（第一次关注同步空间时建，每半小时）。
- 工具：`peer_search`、`peer_read`（分组 read，说明在 `skills/omem/references/sources.md`）。命令：`omem peer share/subscribe/subscriptions/sync`。网页：设置 → 设备 → 和别人的 omem 共享。

## 只对部分人开放的原件（2026-11-05）

- 迁移：`sources.visibility`（space / restricted）、`source_access`（每人对每篇飞书文档的阅读权限，记一天）。
- `src/auth/visibility.ts`：`setVisibility`、`sourceVisible`（同步判断，飞书文档未知时为 check）、`sourceReadable`（用读者的连接调云文档的权限判断接口）、`requireReadable`、`visibleHits`、`keptHere`、`isRestricted`。
- 接入：`checkRoute` 改为异步，`src:` 定位的路由再查一次能否读；`/api/search`、原件列表、工具的 `search`（`viewSearch`）和 `read_source` 过滤；`shares.ts` 不复制、`federation.ts` 不检索不发送不同步这两类；`write_page` 在非个人空间拒绝引用受限原件。新接口 `PUT /api/sources/:id/visibility`（`space.manage`）。`PATCH /api/spaces/:id`：非本人只能改 `larkAccess`，带 `mirror` 一律拒绝（设置页保存时去掉它）。

## 飞书卡片排版、@ 处理人与气泡跟随话题（2026-11-06）

- `lark-send.ts`：`cardText`（卡片 Markdown 的原样文字按 HTML 实体转义，取代反斜杠）、`textWidth`、`buttonRows`（按手机宽度 40 单位分行、各行个数尽量平均，太宽的按钮独占一行 `width: fill`）、`cardMentions` / `mentionInCard`、`larkPrivateChat`（`lark_owner_chat*` 或会话 `settings.group = false`）。`buildCard` 的按钮块走 `buttonRows`；表单由 `formFields` 生成：每个字段上方一行粗体 Markdown 问题（多题自动编号、必填红星），字段 `width: fill`，不再用 input 自带的 label。
- `lark-asks.ts`：选项要么全是按钮（`buttonRows`），要么全是编号行（文字 + “选择”，`vertical_align: center`），不再长短混排；问题有两条以上编号要点时输入框为 `multiline_text`；`askCard(app, ask, { mention })` 在群里开头 @ 回答人（`show` 用已算好的处理人 id，私聊不传）。
- `ThreadSettings.group`：`receive` 在渠道给了 `isGroup` 时记下。
- `tools.ts` 的 `larkPost`：交互卡片带 `allowed`、没给 `mentions`、发往群时 @ 其中本人和 `lark_people` 认识的 id。
- `lark-bot.ts`：`toAsker` 给群里的回答（助理回答、访客回答和拒绝）开头加 `<at id=提问人>`，私聊和机器人发来的不加。
- `lark-cot.ts`：`startCot` 的 `locate`；建气泡前 `GET /im/v1/messages/:id` 看锚点有没有 `thread_id`，有就 `reply_in_thread = true`（普通回复会被飞书放进话题，气泡接口不会）。`lark-agent-cot.ts` 在会话没有话题时传 `locate`。`rules/actions.ts` 记 `lastMessageId` 时一起记 `lastTopicId`。
- 验收见 acceptance.md 同名一节；测试 `test/lark-cards.test.ts`、`test/lark-answers.test.ts`，`test/asks.test.ts` 的排版用例改写。


## 豆包临时会话在重启后继续清理（2026-11-05）

- 修复运行中重启造成的遗漏：旧豆包 CLI 任务仍在云端执行，但 omem 的 `finally` 已丢失；重跑只删除新会话，旧会话留在历史里。
- `dispatch.ts` 拿到临时会话 ID 时即登记 `doubao_session_cleanup`，保存创建时选用的应用、所属运行和 omem 进程 ID；正常清理成功后撤掉记录。聊天、明确保留和续轮不登记，显式退役的旧聊天会话也经同一清理路径处理。
- `doubao-cleanup.ts` 启动时及每分钟恢复：原进程仍活着的临时运行让开，原进程已退出时先查云端状态，等到 idle 再删。删除失败保留记录重试，应用变更后仍用原应用；接口返回资源不存在视为完成。不扫描或批量处理既有账号历史。
- 回归用单独的 Node 子进程拿到 ID 后立即退出，确认清理登记先于退出落盘，再用新的 App 恢复；覆盖云端仍在执行、正常完成、接口失败重试、应用变更、404 和权限查询失败。既有 CLI 临时文件测试改用独立临时目录，避免与常驻服务正在使用的文件冲突。
- 真机：CLI 已创建会话、OpenAPI 返回 in_progress 时退出所属 omem 测试进程，用隔离数据库中的清理记录恢复，等待空闲后删除；最终 OpenAPI 返回 HTTP 404 / code 3440008，CLI 列表不再包含这次会话。该清理表是设备本地的进程状态，快照不携带，覆盖拉取保留本机的记录。


## ACP 与豆包共用会话清理，退役被替换的编码与评审会话（2026-11-05）

- `session-cleanup.ts` 统一登记、释放、重启恢复和失败重试。`session_cleanup` 从前一版豆包清理表迁移，后端与会话 ID 共同定位；凭据从当前配置读取，仅保存原配置指纹，命令或身份配置改变时不改用另一身份清理。该表只在本机保留，不随设备快照同步。
- ACP 单次运行和后台池都在拿到会话 ID 时登记；池内复用和仍需续聊的会话不会被恢复清理。ACP 删除是可选能力：正常释放优先原连接的 `session/delete`，连接已断或重启后重新握手；未声明删除时再走配置的 `archiveArgs`，不按 Agent 名分支，不把协议失败当成不支持而换归档。
- 复看评审会话超过上限后，旧实现会保存新 ID 并遗失旧 ID；`keepSession` 现在将被替换的旧会话交给同一清理流程。编码换后端、上下文超限或恢复失败后成功建立新会话，同样退役登记过的旧会话。仍在使用的会话保持续聊能力；没有可核对后端身份的既有历史不批量推断处理。
- 回归覆盖 ACP 子进程退出后的协议删除与归档回退、协议优先、失败后重试、原配置校验、保留会话不自动清理、评审轮换，以及前版豆包清理记录的迁移；真实 Codex / TraeX：临时任务回答 2 后归档成功；另一轮在模型已经产生回复、会话持久化（archived=0）时退出宿主，恢复清理后均为 archived=1，登记表清空。
- 协议归档被拒绝时保留后端错误的 `data`（例如仍被其他客户端占用），不只写 Internal error，也不绕过协议改用归档命令；记录继续等待重试。模型检测和聊天连接也接入统一登记，聊天仍标为保留。


## 慢检索的索引、空缓存与进程隔离（2026-11-05）

- 根因：全范围检索逐空间加载向量，空间计数缺少匹配索引，空空间每轮重新扫描；空结果不经过分页让出的路径，多个同步查询连续占住主线程。修复不依赖材料类别、项目或具体查询词。
- 迁移加 `chunks_vector_space(space_id,id) where embedding is not null`；`vectors.ts` 缓存空结果，新增向量能直接补入，加载前及空间之间让出事件循环，失效的加载提前结束。
- `read-process.ts` / `read-worker.ts` 以只读 SQLite 连接执行检索。SQL、向量、重排分别复用子进程，排队计入时限，执行超时杀掉进程；不同通道互不占住，超时保留其余通道结果。向量新增只同步同一数据目录的进程，删除、空间迁移与模型变更保持失效；服务 / 数据库关闭和父进程退出时回收，空闲五分钟自行退出。
- `trace.ts` 记录查询摘要与分段耗时；`http.ts` 将检索关联到调用工具的运行。日志与诊断不包含查询原文；`toolLatency` 纳入 `tool-call`，与同一运行的 Agent 展示事件按工具名去重，保留原生文件与命令工具。
- 回归覆盖空空间首个向量、查询计划、重复加载、事件循环、硬超时、排队取消、HTTP 响应、只读拒写、后续重建、空间过滤与向量通道回退。规模和公开数据对照见 `docs/v2/evaluation.md`。

- 本机复查发现后台本地向量编码的 ONNX 推理也会占住主线程，补为独立编码进程；批量编码最多 120 秒，问题编码与检索共用交互通道、最多 30 秒。先在进程里确认模型可加载，再允许宿主切换模型并清空旧向量；数据库写入仍由宿主完成。加载期间新增向量按当时的游标决定是留待追加还是由后续分页读取，避免重复入缓存。
- 启动时的向量预加载同样转到检索进程，宿主不再保留一份重复矩阵。

## 2026-11-05：飞书完整复制与节点授权

- 新增 `lark_doc_copy`，专用入口调用官方 `wiki +node-copy`，共享目标可审批后执行，不再因通用读写工具的风险分类直接拒绝；原文档保持不变，返回副本节点供核对。
- 新增 `lark_doc_authorize`：本人指定知识库节点和 create / copy / edit / move，批准覆盖节点及所有后代（含未来页面），供后续会话和定时规则复用。执行按实时祖先链核对，移动两端须在范围内，整篇覆盖另批；用户、操作隔离及最新拒绝继续生效。
- 文档写入审批卡私发本人，回答仍归原任务；外部 Agent 禁用新增入口。工具分组、主助手和内置文档技能已同步。
- 假飞书回归覆盖复制审批、节点授权复用、移出范围、同名与跨知识库节点、循环与快捷方式、操作隔离、拒绝及私聊投递。
- 真实 Codex（gpt-6.1-sol / low）在隔离库验证先授权后复制、下一次复用授权，两次复制仅一张审批卡，均回读核对；飞书调用为假客户端。
- `LANGUAGE=C pnpm run check` 通过：862 项测试、类型检查及构建；固定语言用于避开本机 Git 中文诊断对既有推送测试的影响。

## 2026-11-05：规则气泡与失败投递

- Agent 动作新增 hideThinking 和 failureTo（本人 / 群聊），成功回复方式独立；规则 Agent 与后端异常通过 report_rule_failure 按原规则报告，最终回答不重复发回群里，并发只报告一次。群投递失败时通知本人；启动前失败同样通知，真实任务队列回归覆盖。外部调用不能使用该入口。
- 完整复制修正为目标父节点与目标知识库二选一，兼容 CLI 的互斥校验；回归核对两种目标参数。
- 全量检查通过（872 项测试）；真实 Codex 在隔离库确认模拟复制失败只通过 report_rule_failure 通知本人一次，不向群发消息。

## 2026-11-05：旧交办同步与应用

- 旧交办“移到目标分支最新提交”默认 merge，网页和工具支持显式 rebase；目标已包含时直接跳过，保留工作区全部改动。显式 rebase 使用实际共同祖先，避免从过时切出点重放已有历史。入口：code-sync.ts、code.ts、server/http.ts、tools.ts、Runs.vue、WorkPane.vue。
- 应用时按祖先关系接受已同步历史中的目标位置及后续提交，继续检查补丁；多仓库预检失败回滚到接收区实际原 HEAD。真实 Git 回归覆盖默认合并、变基边界、无操作和未提交改动保留。
- 全量检查通过（872 项测试）；1440 / 390 浏览器验证独立规则设置及同步方式切换，无横向溢出，使用虚构数据重新生成全部文档截图。

## 2026-11-06：规则处理中再次触发并入同一会话

- 起因：报警群短时间大量报警，每条触发一个 Agent 运行，耗资源、排查不及时，结论彼此孤立。
- `src/rules/actions.ts`：Agent 动作（含静默排查的首次触发）的运行放进 `lane = rule:<规则>:<群>`；`joinLane` 发现这条队列里有等着的同规则运行就把触发并进它的 `input.triggers`（最多 60 条，其余记 `moreTriggers`），只有正在跑的就新建一个排在后面、带 `resumeFromRun` 的运行。`merge: false`（规则页取消勾选）时不进队列，和以前一样各自并行。静默排查的话题跟进仍用原来的话题队列。
- `src/agents/steer.ts`：`takeSteering` 对规则队列里正在跑的 agent 运行，在它下一次调用工具后拿走等着的运行的触发（取消那个运行，记 `steeredInto`、`joinedTriggers`），用 `triggerNote` 列出摘要和消息 id、说明怎么一起下结论或分别回复。
- `src/agents/jobs.ts`：等着的运行自己开始时把 `triggers` 里第一条以后的列进任务，按 `resumeFromRun` 续上前一个运行的会话（同档案、同 AI、同范围、前一个已完成）；规则队列里的运行保留会话（`persistSession`）。
- 规则页 Agent 动作加“处理中再次触发时并入同一会话”（默认勾上）；`compile.ts` 的草稿说明加 `merge`。
- 测试：`test/rule-merge.test.ts`（并入等着的运行、换群另开、正在跑的一轮拿走触发、之后再触发另排；结束后等着的运行续上会话且任务里有全部触发，用假 ACP Agent；关掉合并时各自并行）。

## 静默改成工具 stay_quiet（2026-11-06）

- 新工具 `stay_quiet(reason)`（`tools.ts`，分组 ask；不在 CORE_TOOLS，多数会话经 `omem_call` 调）：记到运行输出 `stayQuiet`，并加一条状态事件。`src/agents/quiet.ts`：`mayStayQuiet(app, run)` 决定这一轮能不能用（工具里检查），`quietReason(app, runId)` 给宿主读。
- 去掉 `jobs.ts` 的 `isQuiet` 和 digest.ts、profile-jobs.ts、lark-meetings.ts（`heldNotes` 改为排除 `stayQuiet` 的窗口）里按文字认 QUIET 的地方；后台角色用 `quietOf(ctx, text)`。
- 授予：`threadTurn` 的三处 `prepareRun` 都 `addTools: ["stay_quiet"]`（一个 Agent 会话服务各种轮次）；`runAgentTask` 在 rule / silent / meeting / wake 时加；十个后台角色的 `tools:` 写上它。规则运行静默且这次没有 `lark_sent` 记录时返回 `quiet: true`（气泡撤回）。
- 测试替身：`test/fake-acp-agent.ts` 的 `FAKE_QUIET` 让固定回答前先调 `stay_quiet`（直接或经 `omem_call`），被拒时把拒绝说出来。
- 验收见 acceptance.md 同名一节。

## 运行页“编码”与统一的交办视图（2026-11-06）

- 起因：编码记录要去运行列表里一轮一轮翻；需求页和运行页的编码详情是两套，编码中看不到概览这些标签；看不出分支从哪切出、确认后推到哪（方案 docs/v2/coding-work.md，本人选定放在运行页、仓库做成业务空间的下级空间）。
- `src/agents/code-works.ts`：一次交办或分支评审一项，按投影列算阶段、等谁（owner / active / assistant / idle / ended，两天没动算 idle）、现在、下一步和可做的动作、修改项进度、事项与需求、各仓库分支；`GET /api/code-works`、`GET /api/code-works/:id`；需求详情接口多返回 `works`，需求树的“等你 N”按同一套算。
- 网页：运行页顶部“编码 / 全部运行”；`CodeWork.vue` 取代运行页里的编码详情和 `WorkPane.vue`（提问、修改点、讲解一起搬过来），需求页用同一个组件；`CodeWorkRow.vue` 两处共用。“全部运行”带 `exclude=code,review`，类型筛选去掉这两项；按 id 精确搜仍能找到。
- 测试：`test/code-works.test.ts`。

## 仓库挂在业务空间下（2026-11-06）

- 起因：每个代码仓库都要单独建空间、再和业务空间关联，空间越来越多；同一个需求的交办有的记在业务空间、有的记在仓库空间（方案 docs/v2/coding-work.md 第 4 节，本人选定“下级空间”）。
- `spaces.parent_id`（迁移）；`src/core/spaces.ts`：`childSpaces`、`spaceFamily`、`businessOf`、`setSpaceParent`，`relatedSpaces` 把上下级排在前面（`via: parent | child`）；`src/core/space-repos.ts` 的 `repoSuggestions`。
- 用到的地方：`permissions.ts`（成员跟着业务空间）、`code.ts`（`homeSpace`、`codeRepos` 用业务空间代替唯一的仓库）、`tools.ts`（`search` 写业务空间时带上仓库、`connect_repository` 的 `parent`、`list_spaces` 缩进）、`http.ts`（建空间带 `parent`、`/parent`、`/repo-suggestions`、网页交办记账、检索 / 运行 / 编码列表按业务空间）、CLI `omem space parent`、`--parent`。
- 网页：`lib/spaces.ts`（排序与选择器选项，`UiSelect` 加 `indent`）、设置页的“仓库”一栏和“所属业务空间”、原件页的仓库入口。
- 测试：`test/space-repos.test.ts`。

## 2026-11-06：助手读消息附件

- 起因：别的机器人在群里发了 CSV，助手用 `lark_read` 跑 `im +messages-resources-download`，lark-cli 把它标为写操作（它写本地文件），被拒；其实采集时已经把这个 CSV 存成了原件，只是助手用原始的 `lark_read` 读话题，看不到原件链接。
- 新文件 `src/channels/lark-message-files.ts`：`messageFile` 按 `lark_messages.resources` 找已有原件；没有就用 `messageResourceFile`（本人 lark-cli 的 `+messages-mget --download-resources`，退回机器人）下载，按真名导入群所在的空间（uri `lark:<群>/<消息>/<key>/<名字>`），记回 `sourceId` 和 `parse.status = done`；没采集过的消息先用 `+messages-mget` 读出所在的群。范围：群所在的空间在运行的读取范围里，或群是这次运行自己的群。视频和音频只给文件；解析不了的格式给文件路径和原因。`resourceDownload` 认 `lark_read` 的下载命令。
- 工具 `lark_message_file`（分组 lark-msg，说明在 `skills/omem/references/lark.md` 的“附件”）；`lark_read` 遇到下载命令改走它。

## 2026-11-06：没登录时首页不进登录页

- 现象：常驻服务器打开多人登录后，没登录直接打开 `#/` 停在“无法连接 omem 服务：请先登录”。原因：页面的第一个请求（`/api/me`）返回 401 时 `toLogin` 改了地址，但路由的第一次导航还没完成，完成时把地址写回 `#/`。
- `web/src/api.ts`：`toLogin` 经路由跳转（`setNavigation`，`main.ts` 在 `router.isReady()` 之后 `router.replace`），路由起来之前仍改地址；去登录页抛出的错误带 `login`，`App.vue` 不把它当成加载失败。

## 2026-11-06：登录时选功能，账号页关掉功能

- 起因：本人在真实租户上登录时，飞书授权页列出了以前给这个应用授过的全部权限（只要身份的登录，令牌里也带着 183 项）；新用户想在登录前就选好给什么。
- 登录页：`/api/auth/session` 的登录方式带上可勾的功能（不含后台访问）；勾了的作为 `features` 传给 `/api/auth/:provider/start`，`purpose=login` 时按 `scopesFor` 要这些 scope（自动加 `offline_access`）。不勾就和以前一样只要身份。
- 关掉的功能：`UserSettings.featuresOff`（按提供方）；`connections.ts` 的 `featuresOff` / `usableFeatures` / `setFeatureOff`，`PUT /api/auth/connections/:provider/features/:feature`（本人自己，不能关后台访问）。连接视图每项带 `paused`。
- 用到的地方：`lark-member-capture.ts` 只采集可用的功能（聊天、日程、妙记、最近文档各自判断；以前只有“我的消息”打开时才会采日程等），等批准的账号不采集；`tools.ts` 的 `ownerOnly(ctx, feature)` 和 `featureGate`：文档读取对应“文档与知识库”，写文档、复制、授权对应“让助手写文档”，`lark_read` / `lark_write` 按命令的域（im、docs/wiki/drive、sheets/base、calendar、minutes/vc），`lark_message_file` 对应“我的消息”。本人不受影响。
- 测试：`test/connections.test.ts`（登录页勾的功能才要 scope；关掉后不采集、工具拒绝，再打开恢复；等批准的账号不采集；后台访问不能关）。

## 2026-11-06：后端没开始工作就失败时也换后端

- 起因：常驻服务器夜里的巡检在豆包 CLI 上连续失败（“Local execution environment preparation failed: ENVIRONMENT_ERROR”，几秒内退出），配了 codex、traex 作后备却没有换：以前只有排队、限流、额度、容量这类错误才换。
- `runner.ts` 的 `runRole`：每次尝试记下有没有工具调用（后端自己的 `tool` 事件）和宿主记下的写入（`tool-write`）；都没有就算没开始工作，任何错误都换到链上的下一个后端，状态写“上一个后端没有开始工作就失败了（原因）”。已经开始工作的、取消的、点名了档案或指定了 AI 的运行照旧不换。
- 测试：`test/backend-fallback.test.ts`（第一个后端启动就退出，改用后备；没有后备时报错）。

## 2026-11-06：远程命令 connections

- 起因：常驻服务器上本人的飞书连接只给登录和成员功能用，本人自己读飞书仍走 lark-cli 的登录，所以没有什么会去刷新它的令牌；刷新令牌快过期（两天内）才由后台续期。要在真实租户上看一次刷新，得有个地方取令牌。
- `src/core/peer-exec.ts` 的 `connections`：不带参数时列出每个连接（用户、账号名、状态、权限数、授到的 / 关掉的 / 能用的功能、有没有刷新令牌、到期时间、最近的错误），不带令牌。`check: <用户 id>` 时按成员用到时一样取令牌（`accessToken`，快到期就刷新），再用平台的 `whoami` 确认令牌属于这个账号，返回刷新前后的到期时间。
- 测试：`test/connections.test.ts`（列表里没有令牌；快到期时刷新一次、确认是同一个账号；再查不刷新；没有连接的用户和不合法的 id 被拒）。

## 2026-11-06：远程操作与录制技能

- 起因：本人想在网页上远程打开 omem 那台机器的浏览器或桌面、用键鼠操作，并把做一遍的过程录下来，和助手对话整理成技能；看、操作、录制、回放都交给 ai-auto-desktop（aad），缺的能力在 aad 那边补（ai-auto-desktop#12：查看页按自己的地址连 WebSocket、`aad record --until-stdin-closes`、录制和查找共用命名规则、`aad browser-record steps` 转成可回放步骤、iframe 与页面同前缀时选地址一致的、`run_workflow` 正确报告控制步骤）。
- `src/remote/`：`aad.ts`（一次性命令、长驻进程、`aad mcp` 的 JSON-RPC 客户端）、`sessions.ts`（浏览器会话用 `browser_open` 起无窗口浏览器再接 `aad assist --browser-port`，桌面会话 `aad assist --desktop`；地址栏、录制、回放；30 分钟没人看结束）、`recordings.ts`（表 `remote_recordings`、摘要、`read_recording` 的四部分、技能附带的文件；启动时把还在录的标成中断）、`http.ts`（`/api/remote/*`，`/remote/<会话>/` 的 HTTP 与 WebSocket 转发，查看用的会话 cookie 加 Origin 检查）。
- 网页：`views/Remote.vue`（导航“远程”只在装了 aad 时加上，`desktop.control`）、`components/RemoteChat.vue`（页面旁的对话，和问答同一条线程）；Vite 开发代理加 `/remote`。
- Agent：工具分组 `remote`（`list_recordings`、`read_recording`），主助手 `group:remote`；`save_skill` 加 `from_recording`；内置技能 `skill-from-recording`；说明页 `skills/omem/references/remote.md`。
- 其他：`/remote` 进 `peer-tunnel` 的 `tunneled`、中间设备转发 `/api/peers/:id/remote/*`；`OMEM_TOOL_<名>` 指定某个工具的程序（`core/tools.ts`，也放进 Agent 的 PATH）。
- 测试：`test/remote.test.ts` + `test/fake-aad.ts`；本机真实 aad 与 Codex 跑通一次浏览器录制 → 技能 → 回放（acceptance 有记录）。
- 画面设置（同日）：`src/remote/settings.ts`，每人一份存 kv `remote_settings:<用户>`，换成 `aad assist` 的格式、画质、帧率、最大宽度、鼠标指针、剪贴板参数，新开浏览器用哪个；`aad assist --probe-video` 的结果存 kv `remote_video_probe`（按 aad 版本），开会话时带 `--encoder`，`--codecs auto` 不再每次启动都把所有编码器试一遍；`POST /api/remote/sessions/:id/viewer` 给开着的会话换查看进程（会话、浏览器、录制不动，旧进程退出不结束会话）。网页“画面设置”面板；“新会话”标签在没有打开的会话时是 ghost + primary，文字和背景同色看不见，改成二选一。
- 页面整理（同日）：会话改成浏览器式标签（× 和中键关闭，去掉右下角“关闭会话”），地址栏、画面、录制区放在标签下的一个框里，卡片加内边距、字段名用 `<span>`；浏览器资料可以复制本机 Chrome / Edge / Brave 的资料（`GET /api/remote/browser-profiles` → `browser_profiles`；`browser_open` 的 `copy_profile`、`close_running`，`aad mcp --allow-profile-copy`）；共享一个窗口时录制自动用这个窗口（按窗口句柄或进程加标题在 `aad apps` 里找），共享整个屏幕时才选录哪个程序；`aad apps` 的结果在 `apps` 字段（之前读 `resources`，可录列表一直是空的）；查看页地址带 `lang=zh`。查看页本身的修复在 aad（ai-auto-desktop `fix/viewer-input`）：每个键鼠事件带上按住的修饰键、服务端补按或松开（组合键在修饰键自己的按下没送到时也成立），Mac 上 ⌘ 当 Ctrl、Ctrl+V 粘贴本机剪贴板、浏览器页面的选中文字带回、右键不弹本机菜单、提示文字中文、浏览器页面按查看页大小排版。

## 2026-11-06：文档变化规则、延时 / 模型判断 / 脚本动作，会议邀请修正

- 文档变化：`src/channels/lark-doc-events.ts`。主机器人订阅文档（`POST /open-apis/drive/v1/files/:token/subscribe`，知识库页面经 `wiki_nodes` 或读节点换成文档），结果存 `lark_doc_subscriptions`（含只被规则盯着的文档的 `snapshot`）。`lark-bot.ts` 注册 `drive.file.edit_v1`、`drive.file.bitable_record_changed_v1`、`drive.file.bitable_field_changed_v1`、`drive.notice.comment_add_v1`；编辑按文档合并（静 90 秒、最多 10 分钟），采集过的重新导入并逐行比较，交给 `doc` 触发的规则（`RuleEvent.doc` / `change`，字段 `doc.*`、`change.*`）。每天的文档检查前先替 50 篇已采集文档订阅；订阅成功且最近一个月收到过文档事件时，`checkLarkDocs` 不再检查它们。机器人检查多一行 `docs`（`DOC_SCOPES`），扫码更新应用一并申请这些权限和事件。
- 规则：`trigger.event = "doc"`、`trigger.docs`；`checkDocRule`（只用文档字段、没有群的动作、不能等待）；权限检查订阅列出的文档并列出被拒的原因（1069603：机器人不是管理者）。动作 `delay`（`runActions` 把后面的动作和事件放进带 `not_before` 的 `rule-fire` 运行，`fireAfterWait` 接着做）、`check`（一次模型调用回答是否，否就停）、`script`（`src/rules/script.ts`：`rule-script` 运行，事件经 `OMEM_EVENT` 和标准输入，最小环境，审批卡片 `card_interactions.purpose = rule-script`，运行开始前再核对批准；只有本人经网页或接口保存，`saveRule` 多了 `actor`）。`sendLark` 的 `userIdType` 让卡片能按 user_id 发给邮箱查到的人。
- 会议：`botInvitedToMeeting` 的 `inviter.id` 是对象（真实事件），以前当字符串比较，本人邀请永远走“先问”并停掉 AI 纪要的自动重试；改为取 `open_id`。机器人收到但不处理的事件注册空处理，SDK 不再逐条警告；会议事件监听同样原因的退出只记一次日志。
- 其他修正：运行页首次加载不再在骨架屏下面多一个“搜索中…”；列表底部的转圈和文字居中对齐。左下角账号图标按其他图标的高度重画。成员页同一个飞书账号的登录 id 和机器人里的 id 合成一个标签（悬停看两个 id），× 解绑整个账号（以前只解一个，下次登录会自己补回）；空间和角色改成胶囊样式，角色是行内下拉（`UiSelect` 的 `variant="inline"`）。远程页右上角的版本和“画面设置”按标签高度居中，“打开远程画面”卡片在剩余空间里居中。编码评审里，之前轮次“暂不改”的问题改成“改”后不再从最新一轮消失：还没有交给修改的（`fixed_by` 为空）照样列出，VS Code 插件同理。
- 远程页审查：长期浏览器资料每人一份（本人的位置不变，别人的在 `remote/profiles/@<用户>/`），列表只列自己的；列出和复制本机浏览器的资料（`/api/remote/browser-profiles`、`copyFrom`）只有本人能用。以前给了自定义角色“操作桌面”的人能打开别人的长期资料、复制本人浏览器的登录。

## 2026-11-06：连续触发可分别回复

- 规则 Agent 动作在 `merge` 开启时新增 `mergeReply`：`combined`（默认，合并回复）和 `separate`（每次触发分别回复）。分别回复时同规则同群仍串行并复用 Agent 会话，每个触发各排一轮，保留完整事件、任务和回复位置；当前轮不拿走、取消后续触发。
- `rules/actions.ts` 按最后一个排队或运行中的前驱衔接会话；`agents/steer.ts` 不吸收分别回复的轮次。`jobs.ts` 按当前消息投递，已有话题或未选择开话题的消息也保持自己的锚点；思考气泡遵循同一投递位置。
- 提示 Agent 复用调查时仍逐条完成任务中的操作、核对本条状态和答复，不能用首条处理或汇总结论代替其他触发。平台专属的接手与确认流程仍放在本人的数据目录技能中，不进入宿主。
- 规则页、自然语言草稿、工具说明、README 和文档站同步。专项回归覆盖默认合并、独立并行、三次连续触发串行续会话、各自回复、完整长事件、已有话题及从旧模式切换。
- 验证：`LANGUAGE=C pnpm run check` 通过，917 项测试；真实 Codex gpt-6.1-sol low 验证两种规则草稿；演示页验证选项保存、刷新和关闭时隐藏，1440 / 390 无横向溢出，仅刷新 `rules.png`。附件降级回归显式关闭解析器，不再依赖机器上是否已安装转换器。

## 2026-11-06：远程浏览器关闭与窗口说明

- 显示窗口选项明确指运行 omem 的电脑桌面；补充说明默认仍能在当前远程画面里看和操作。
- `AadMcp.close()` 先调用并等待 `browser_close`，再结束标准输入并等待进程退出；`closeSession` 与打开失败的清理等待它完成，防止旧的 3 秒强制结束打断浏览器和资料释放。
- 回归：假 aad 的资料锁直到 3.2 秒关闭完成才释放，关闭接口返回后同一资料立即重开成功。aad 的崩溃残留锁恢复由 aad 自身处理，omem 不删除外部资料目录里的锁。

## 2026-11-06：从群历史核实其他机器人的提及身份

- `lark-people.ts` 的 `resolveMention`：普通成员列表没有命中且没有明确的普通联系人身份时，再用发送应用读目标群最近 200 条消息的 mentions，拒绝混用个人采集应用的 open_id；按机器人和群缓存 10 分钟。
- 更新发消息技能与工具说明：优先传机器人名字，只有当前应用的历史也没有可核实的提及才需要本人补一次 @，不要求与助理在同一条消息里。
- 专项回归与真实 Codex gpt-6.1-sol low（假飞书接口）通过；完整类型、920 项测试与构建通过。

## 2026-11-06：目录导入不再占住 Web 主进程

- 起因：检索已在只读子进程，但仓库接入的 `syncDirectorySpace` 仍在主进程整批同步遍历、解析、写索引和解析引用，大仓库接入会使网页与其他请求等待。
- `sources/import-process.ts` / `import-worker.ts`：目录同步与普通目录导入走独立进程，同一应用串行；每批进度先暂停工作进程，让主进程记录进度、转发原件变化并失效向量缓存。超时或关闭服务时停止工作进程，保留已提交文件。权限仍由调用工具核对，工作进程不提供独立接口。
- HTTP 响应、增删、取消、原有仓库与调用图专项回归通过。1200 文件规模对照：总耗时 7217.1 → 7489.3 ms，主进程最长停顿 7219.4 → 12.4 ms，导入数量一致。

- 完整检查：159 个测试文件、922 项测试、类型与构建通过。

## 2026-11-06：机器人检查只留扫码更新，订阅可立即重试

- `lark-setup.ts` 的 `LARK_BOT_ADDONS.scopes.user` 加上 `FEATURES.lark` 里各功能的权限（去重），扫码更新一并申请成员连接飞书要的用户身份权限；以前只有个人采集那一套，扫完成员那一行还缺三项。
- `summarizeCheck`：应用信息没给事件订阅时用线上版本的事件；“未发布”只在两边都有时比较。设置页去掉权限的“一键申请”（多项逗号分隔在飞书权限页搜不出来）和“去事件订阅页面”，说明改成扫码更新后发布新版本；扫码链接只在浏览器拦下新页面时显示。
- 远程命令 `lark-bot-permissions` 加 `raw`（`rawAppInfo`：应用信息和线上版本的权限、事件原样）；新的 `lark-doc-subscribe`（`link` 订阅一篇，`retryFailed` 重试被拒的，`retryFailedSubscriptions`）。每天的批量订阅里没试过的优先，被拒的三天后再试（以前一周）。
- 真实应用的线上版本里 `events` 是显示名（“文件编辑”“接收消息”），事件键在 `event_infos`：`eventKeys` 从里面取出 `xx.yy_v1` 形式的键当作已订阅的事件；`raw` 也带上 `event_infos`。
- `lark-bot.ts` 给 SDK 的客户端一个只写一行的 logger：失败的接口调用不再把整个请求和响应打进服务日志（订阅被拒的那批每篇几十行），只留方法、路径、状态和飞书的错误码。
- 成员连接飞书的“表格与多维表格”“让助手写文档”改用飞书现在的细分权限（`sheets:spreadsheet:read`、`base:*:read`、`docx:document:write_only`），旧的 `sheets:spreadsheet:readonly`、`bitable:app:readonly`、`docx:document` 新应用申请不到，机器人检查一直显示缺这三项、扫码也补不上。

## 2026-11-07：文档变化规则订阅不了时定时查

- `lark-doc-events.ts` 的 `pollRuleDocs`（main.ts 每分钟调一次）：启用的文档变化规则列出的文档里，订阅被拒的（或一个月里没收到过文档事件时的全部）按 `trigger.pollMinutes`（默认 30）用本人 lark-cli 只读查最后修改时间（`lark-docs.ts` 的 `docMetas`，原来的 `lastEdits` 改由它实现，带修改人），第一次只记下；改过就走和事件一样的 `flush`（重新读、逐行比较、交给规则），变化内容注明定时检查发现。`lark_doc_subscriptions` 加 `polled_at`、`modified_ms`。规则保存后的检查不管订阅成没成都给只被规则盯着的文档存 `snapshot`。规则页加“机器人订阅不了的，每 N 分钟用我的登录查一次更新”。

## 2026-11-07：设备拉取可选内容和目标目录，附件只传缺的

- `omem peer pull`：数据库总会拉；知识库、附件、代码仓库、编码工作区可选（`--only`，在终端里用勾选列表逐项问，列出对方存储页扫到的大致大小）；`--to <目录>` 合并进另一个数据目录（不存在就新建，设备配对仍读当前目录）；`-y` 不询问。`--overwrite` 总是完整拉取，不能和 `--only` 一起用。
- 传输：`GET /api/peer/snapshot` 认 `parts`、`strip`、`files=separate`；SSH 快照程序收同样的选择作第三个参数。没选的仓库和工作区不打包；合并时不传 `chunks`、`chunks_fts`、`symbols`、`code_refs`（合并会重建；常驻服务器 8.7 GB 的库里约 6.7 GB 是这些）。附件先列名字（`GET /api/peer/files`），只请求本机没有的，每批 500 个（`POST /api/peer/files`）；覆盖时跳过的附件从备份复制回来。
- 兼容：旧设备忽略参数、发来全部内容，`mergeLibrary` 先删掉没选的部分再合并。快照里既没有知识库也没有附件时 tar 不再因为结尾的空 `-C` 失败。
- 回归：`test/peers.test.ts`（经中间节点只拉附件：只传缺的一个、快照无索引、合并后重建）、`test/pull.test.ts`（旧设备全量快照按选择合并）；本机起一台临时 omem 用 CLI `--only files --to <新目录> -y` 实测。

## 2026-11-07：连接其他平台（身份与能力两类连接器）

- 内置插件 `plugins/connect`：运行时读 npm 包 `@nangohq/providers`（Nango 的平台目录，ELv2，不复制进仓库），把全部 OAuth 2 平台和可采集分组（文档、聊天、邮件日程、会议、代码、工单）里用 API Key / 账号密码连接的平台注册成连接器；`china.ts` 补微信扫码登录、QQ 互联、微博、钉钉、抖音、Gitee、百度网盘、阿里云盘、语雀。通用引擎 `engine.ts` 处理授权参数、Basic / JSON / GET 换令牌、参数改名、响应路径、令牌放请求头或 query。
- 两类：`identities.ts` / `china.ts` 里有“我是谁”的是身份（可登录、绑定，按平台永久 id 记 identities），其余 `identity: false` 是能力：登录流程只接受 connect，回调只存令牌。
- 宿主：`LoginProvider` 加 `identity`、`credentials`、`appFields`、`sign`、`group`、`docs`，`apiBase` 可以是函数，授权三函数可选；`src/auth/apps.ts` 存主人填的应用配置（`secrets/connector-apps.json`）；`auth.connectors` 是开放给成员的平台；`POST /api/auth/connections/:provider/credentials`、`PUT /api/auth/providers/:id/app`；插件 `api.appConfig`、`api.fetch`、功能可为函数、`ctx.saveSource`（`saveSourceFor`，按调用者可写的空间，uri 作 origin_key）。
- 工具 `connect_list`、`connect_request`（只读：GET；POST 只放行搜索、查询、GraphQL query 和少数已知只读接口）、`connect_save`；档案 `connect-collector`、技能 `platform-capture`。
- 网页：设置 → 成员 → 平台应用（`ProviderApps.vue`：搜索、用途与范围筛选、填配置、复制回调、开放）；登录方式只列能登录且已设置的；账号页可搜索、用 key 连接。
- `test/connect-plugin.test.ts`；没有用真实平台应用走过授权。

## 2026-11-07：平台包（读取器与定时同步）

- `src/plugins/platforms.ts`：`api.platform` 注册平台包：功能（替换连接器原来的，`overrideFeatures`）、读取器（`read` 读一项成 Markdown，`changes` 列出容器里某位置之后改过的）、同步间隔。`platform_watches` 存盯着的内容；定时任务 `platform-sync`（每 20 分钟）按盯的人的连接同步，只写能写的空间，一轮 50 项，失败时位置不前进。原件 uri `<平台>:<类型>/<id>` 兼作 origin_key。
- 内置平台包：figma、notion、github、google（云盘、Gmail、日历）、slack、atlassian（Jira、Confluence）、linear。`src/sources/html.ts` 的 HTML 转 Markdown 经 `api.text.html` 给插件用。
- 连接插件加 `connect_read`、`connect_watch`，`connect_list` 列出能读的类型和盯着的内容；账号页列出盯着的内容（立即同步、不再同步）。登录流程记下申请的 scope，平台没回报时按申请的记。
- `test/platform-packs.test.ts`。

## 2026-11-07：插件启用开关、第三方插件安装、权限声明

- `plugins.disabled`：停用的插件不加载代码、档案、页面和侧栏入口；设置页切换立即生效（`setPluginEnabled`），`omem plugin enable|disable` 改配置、重启生效。
- `src/plugins/install.ts`：`npm:包@版本` 或 `github:owner/repo#tag`（必须 tag 或提交）装进数据目录，不跑安装脚本、依赖 `--ignore-scripts`，来源记在 `.omem-install.json`；拒绝和内置或本人手放的插件重名。接口 `POST /api/plugins/install`、`/:id/update`、`DELETE /api/plugins/:id`、`PUT /:id/enabled`；命令 `omem plugin list|install|remove|enable|disable`。
- 清单 `permissions`（`write`、`connectors`、`platforms`）：数据目录插件的代码注册超出声明的会被拒；`describePlugin` 带 `permissions`（信任前取声明，运行后取实际），设置页和信任确认里列出。
- `test/plugin-install.test.ts`。

## 2026-11-07：插件隔离运行

- `src/plugins/sandbox.ts` / `sandbox-runner.ts`：数据目录插件信任时默认隔离运行。fork 一个带 `--permission` 的 Node 进程（读插件目录和 omem 包，写 `plugin-data/<id>`，不能起子进程），环境变量不带 omem 的；工具（宿主用插件给的 JSON Schema 列出，`Tool.jsonSchema`）和平台包读取器注册为代理。进程的请求（fetch 经连接、`store`、`saveSource`、`watches`、`service.ensure`）按正在进行的调用的 ToolContext 回答，令牌不出 omem。内容块、新连接器要选在 omem 里运行。
- `trust.ts` 记 `mode`（isolated / inprocess；以前的记录算 inprocess），`POST /api/plugins/:id/trust` 带 `mode`；加载失败或超出声明时撤回信任。设置页显示运行方式，“在 omem 里运行…”单独确认。
- `test/plugin-sandbox.test.ts`。

## 2026-11-08：设置页分组；平台工具只给连了平台的人

- 设置拆出“连接”（`tab=connect`）：本人的飞书文档与个人消息采集（从“渠道”移来）和其他平台（`ProviderApps.vue` 自己加载、虚拟滚动、每行有说明：授权页连接要建应用，填 key 连接的由成员各自填 key，开放后才出现在账号页）。“渠道”只留机器人与聊天渠道（OneBot 卡片改名“QQ / 微信 机器人”）；“成员”去掉平台应用，登录方式链接到连接页；网页地址移到“设备”。设置页跟随 `?tab=` 变化切换标签。国内平台的用途分组改成社交媒体、聊天与通讯。
- 内置角色的技能和工具改成叠加设置：`updateRoleMeta`（挂技能、批准的增减工具建议）只写 `_roles/<名>.overlay.yaml`，`loadRole` 叠在源码或自定义副本上，源码更新不用合并；改说明正文或其他字段才复制。启动时 `simplifyRoleCopies` 把“和它所基于的版本只差技能 / 工具”的旧副本转成叠加设置并删掉副本。`RoleState.overlay`。
- 工具 `available`（`dropUnavailable` 在 runner 里按这次运行的人去掉）；插件工具 `whenConnected`（含隔离运行的插件）：连了本插件某个连接器才给。`TOOL_GROUPS` 加 `connect`（由同名插件填充，说明 `skills/omem/references/connect.md`），主助手带 `group:connect`；连接插件去掉侧栏页，`connect-collector` 留作档案。

## 2026-11-07：网页版 VS Code 打开交办工作区不再问信任

VS Code 的信任记录存在浏览器里、按路径算，交办每次换工作区就要再点一次信任。`proxyIde` 在返回工作台页面时，若 `folder` 是编码交办自己的目录（`codeRunsAt`），把页面配置的 `enableWorkspaceTrust` 改成 `false`（`trustWorkbench`）；其他文件夹不变。配置 `ide.web.trustCodeFolders`（默认开）。实现：`src/server/ide-web.ts`；回归：`test/ide-setup.test.ts`；本地开发实例用真实 serve-web 对照过（交办工作区无受限模式，无关目录有）。

## 2026-11-07：检查结果交给评审，评审不再重跑测试

- 宿主的检查记下跑在哪个提交、改动起点和用时，命令带 `OMEM_BASE`（`src/agents/code.ts`）；评审材料的“检查结果”写明这些和编码工作区位置，没设检查命令时写明没有复核（`review-chain.ts`）；逐项验证也带“检查结果”（`code-overlap.ts` 的 `verifyChecks`）。
- `roles/_common.md` 新增“评审时的测试和检查结果”（只给评审）：核对结果是否完整有效，不重跑整套测试，只为具体问题跑最小范围；`roles/coder.md` 要求写原样的验证命令和结果。
- 运行页检查一节显示提交和用时，没设检查命令时提示；设置 → 空间 的检查命令说明 `OMEM_BASE`。
- `test/code-checks.test.ts`；设计在 docs/v2/review.md §4.5。

## 2026-11-07：交办工作区的预览

- 仓库空间设置加“预览命令”（`previewCommands`，一行一个“名字: 命令”）。交办视图“预览”（`web/src/components/WorkPreview.vue`）在这次交办的工作区里运行它，列出它和子进程监听的端口；`src/agents/previews.ts` 管起停、同一仓库一个、没有连接超过 `preview.idleMinutes` 分钟或工作区收回时停、重启后停掉遗留进程；`src/core/listening.ts` 查进程树监听的端口与连接数（Linux `/proc`、macOS `lsof`、Windows `netstat`）。
- 按原端口号看：`omem peer open` 的本机进程处理 `/api/local/forwards`，在同样的端口号上监听，每个连接经 `tunnelConnect`（`Upgrade: omem-tcp`，`/api/previews/:id/tcp`，加进 `tunneled`）原样接到那台机器的端口，所以把 localhost 端口写死在开发配置里的多应用项目不用另配；接口与隧道在 `src/server/preview-http.ts`，只对本人。
- 设置页 `?tab=spaces&space=<id>` 直接打开那个空间的设置。
- `test/preview.test.ts`；设计在 docs/v2/preview.md。
- 预览启动前，工作区没准备过依赖（比如交办应用后单独建的目录）或锁文件变了时，先跑仓库的准备命令（`setupCommandFor` / `setupKey` / `setupDone`，和编码前同一规则），状态“准备依赖”；命令在开出端口前结束时，原因写明“没有开出端口（看输出）”。在常驻服务器上第一次试时，应用后的目录里没有依赖，两个 dev 都起不来，才补上这一步。
- 修复：预览命令在 `spawn` 时就被拒（命令里有空字符）时，记录留着进程号 -1、状态停在“启动中”，下一次启动按“同一仓库一个”去停它，`killPid(-1)` 退到 `process.kill(-1)`，给这个用户的所有进程发了 SIGTERM（在常驻服务器上实际发生过一次）。`killPid` 现在拒绝 ≤1 和自身的 pid；`spawn` 失败时预览直接以“命令没能运行”结束，不留占位 pid。`test/preview.test.ts` 覆盖。

## 2026-11-07：升级用 osdk 安装依赖，npm 源由 osdk.toml 指定

- 常驻服务器的 `.npmrc` 指向公司镜像，镜像里没有 `@nangohq/providers@0.72.2`，pnpm 11 的发布时间检查（minimumReleaseAge）因此拒绝安装，远程更新停在“安装依赖”。
- `osdk.toml`：`[settings.precedence] npm = "osdk"` 和 `[registries.npm] default`（公开源）；osdk 给 pnpm 注入 `npm_config_registry` / `pnpm_config_registry`，覆盖 `.npmrc` 和 `pnpm-workspace.yaml` 的源，scope 和认证仍按原生配置。osdk 对写了自定义 `run` 的依赖不选源（`deps_cmd.rs` 只在 `run` 为空时注入），所以 `[deps.pnpm]` 另用 `env` 带上同样的两个变量，指向同一个源。`[deps.pnpm]` 的命令加 `--config.confirmModulesPurge=false`（没有终端时 pnpm 不会停下来问）。
- `scripts/upgrade.ts`：有 osdk 时 `osdk trust osdk.toml` → `osdk install --no-deps`（工具；常驻服务器上全局 `omem` 同时挂在 node 和 npm 的前缀里，osdk 生成 shim 时报冲突，所以只提示不中断）→ `osdk deps` → `osdk run build`，之后还原本机改写的 `osdk.lock`（部署用的检出保持干净，下次 `git pull --ff-only` 不被挡）；没有 osdk 时照旧直接用 pnpm。

## 2026-11-07：中间设备转发任何升级请求；预览说明文件监听上限

- 经 `--via` 中转时，中间设备以前只转发 `tunneled` 列出的升级路径，预览的隧道（`/api/previews/:id/tcp`）在旧版中间设备上被回 404。现在中间设备对本人令牌的升级请求不看路径原样转发，由最后那台设备鉴权和判断路径（`src/server/http.ts`）；以后加新的隧道，中间设备不用跟着更新。
- 预览输出里出现 `EMFILE … watch`（inotify 实例数）或 `ENOSPC`（监听数）时，`previewHint` 给出原因，交办视图的预览面板显示在状态下面。常驻服务器上主应用崩过一次就是这个：同一用户 128 个 inotify 实例被别的程序占满，两个开发服务器各只占 1 个。
- `test/preview.test.ts`：经一个不认识预览的中间设备打开预览端口；按真实报错格式测提示。
- 预览命令不再继承 omem 后台服务的 `NODE_ENV=production`（`previewEnv`）：常驻服务器上 `rsbuild dev` 因此按生产模式构建，页面引用 `//undefined/undefined/static/js/…`，白屏。端口刚开时 `/` 可能还是 404，启动后 3 分钟内判定为“不是网页”的端口会再探测。
- 修复：经设备隧道转发的连接，一端结束时会立刻销毁另一端，慢链路上排队待写的数据被丢掉。常驻服务器上主应用的代理（`Connection: close`）转来的子应用脚本因此被截断（`ERR_INCOMPLETE_CHUNKED_ENCODING`，curl 报 “transfer closed with outstanding read data remaining”），Garfish 加载子应用失败。三段转发（本机、中间设备、目标设备）改用 `splice`：结束时先写完再关，出错才同时断开。

## 2026-11-07：运行产物；编码前检查

- 运行产物（`src/agents/artifacts.ts`、表 `run_artifacts`）：编码 Agent、编码助手、宿主的检查命令、外部 Agent 的 `code_workspace` 命令带 `OMEM_ARTIFACTS`，宿主在 `finish_task`、一轮结束、命令跑完时收走，`T<编号>/` 归到那一项；`attach_artifact` 和 `code_workspace` 的 `attach` 按路径交；文件按路径里的密钥给出（`/api/artifacts/<id>.<key>/…`，`src/server/artifact-http.ts`），网页和报告带 CSP sandbox；中间设备转发时带上 Range 和这些响应头；交办视图“产物”标签（`RunArtifacts.vue`）和修改项上的数量；评审材料和逐项验证列出文件路径。设计在 docs/v2/artifacts.md。
- 编码前检查（`src/agents/pre-check.ts`、`roles/business-analyst.md`）：新交办第一轮编码前查影响面、以前的问题、回归清单，`submit_brief` 交结果，编码 Agent 的任务和阶段评审的材料里多一节；`code_history`（`src/agents/code-history.ts`）按文件列需求点、交办、评审问题和提交，历史评审也用；`agents.autoAdvance.preCheck`、`delegate_code` 的 `pre_check`；“概览”里的卡片（`PreCheckCard.vue`）。设计在 docs/v2/pre-check.md，review.md 5.2 的业务简报以它落地。
- `test/artifacts.test.ts`；测试里默认关掉编码前检查（`test/helpers.ts`），这个文件里打开。

## 2026-11-08：同步暂存只认本工作区的

- Git 的 stash 是整个仓库共用的：以前任何一个工作区留下“同步前未提交的改动”，别的工作区都被当成同步没做完，新交办就不把复用的工作区切到分支最新提交，接着把远端合进上次留下的旧提交。现在 `src/agents/code-sync.ts` 暂存时把这条 stash 的提交记在本工作区自己的 Git 目录（`git rev-parse --git-path omem-sync-stash`），`hasSyncStash`、放回、放弃同步都只认这一条。`test/code-sync.test.ts` 加了两个工作区的用例。

## 2026-11-08：界面块第一阶段（表单提问与展示块）

- 设计在 `docs/v2/interactive-ui.md`。`src/agents/ui-blocks.ts`：展示组件（markdown、heading、table、chart 含 pie、metric、compare、timeline）和输入字段（text、textarea、number、choice、multi、scale、date、datetime、toggle、pick、checklist，`required`、`show_if`）的 zod schema，`normalizeAnswers` 检查回答，`summarizeAnswers` / `viewText` / `fieldsText` 给 Agent 和文字渠道读。
- `ask_owner` 改名 `ask_user`（不保留旧名），加 `fields`、`view`、`submit_label`；`asks` 加 `ui`、`value` 两列，`answerAsk` 收 `value`，`describeAnswer` 给逐行摘要和 JSON。新工具 `show` 写 `ui_views`（同步表，`delivered_at` 本机），网页和插件页画在回复下面；飞书等渠道在 `showSuggestions`（回复发出后）收到文字版和 `#/ui/<id>` 链接。接口 `GET /api/ui/views?conversation=`、`GET /api/ui/:id`，`POST /api/asks/:id/answer` 收 `value`。
- 飞书提问卡片（`lark-asks.ts`）：带表单的提问列出字段和“打开填写”按钮，不在卡片里填。
- 插件：删 `src/plugins/generic.ts`（`plugin_form` / `plugin_chart`）；`PLUGIN_TOOLS` 改成 `plugin_query`、`plugin_put`、`ask_user`、`wait_answer`、`show`；`sessionView` 把会话的提问和展示列成 `ask` / `view` 块，`submitBlock` 对提问转给 `answerAsk`；提问和展示变化时发 `plugin` 事件（`nudgePlugin`）。渲染器 `packages/plugin-sdk/blocks.ts` 重写：`renderView`、`renderBlock`（`ask` / `view`）、`fieldVisible`、`initialValues`。
- 网页：`UiView.vue`（SDK 渲染器 + Markdown 组件）、`UiFields.vue`（omem 控件的表单）、`AskCard` 带表单、问答页的表单跟在回复下面、`views/UiItem.vue`（`#/ui/:id`）。
- 角色：`_common.md`“问本人、给本人选项”讲什么时候用表单、`pick`、`checklist` 和 `show`；`coder.md`、英语陪练改用新工具。`skills/omem/references/owner.md` 同步。
- 同一次运行里再交一张表单（重答的一轮、改过的表单）会取消还没填的旧表单，避免会话里挂两张。真实 Agent（codex-cli）试过：团建这类要问好几项的问题，一张表问完（日期 `date`、人数和预算 `number`、方案 `pick` 带要点和代价），提交后下一轮照着值排了日程和预算。

## 2026-11-08：界面块第二阶段（飞书卡片里直接填表、卡片里的表格和图表）

- `lark-asks.ts`：`cardFields` 把提问的字段映射成卡片表单（输入、下拉、多选下拉、日期、日期时间、勾选；`pick` 下拉，`checklist` 每条下拉加备注框，超过 12 条或卡片超过约 24 KB 退回网页链接），`valueFromCard` 把表单值转回字段值（日期 “2026-11-15 +0800” → `2026-11-15`），`handleAskAction` 先用 `normalizeAnswers` 检查，错了只弹提示。
- `lark-ui.ts`：`viewCardBlocks` 把表格、图表画成卡片的 `table`、`chart`（VChart）元素，其余转文字；`viewTarget` 找会话所在的群或话题。`asks.ts` 加 `addViewSink`，飞书注册后 `show` 的内容在回复后发成一张卡片（`viewCard`），失败退回文字。`lark-send.ts` 的 `CardBlock` 加 `element`（宿主自己拼的元素）。

## 2026-11-08：界面块第三阶段（交互页）

- `src/agents/ui-pages.ts`：`savePage` / `getPage`（表 `ui_pages`，每版一行，同步表），`pageDocument` 在页面最前面放 `<meta>` 安全策略（`PAGE_CSP`：`default-src 'none'`，只许内联脚本样式和 data: 图）、基础样式和桥（`window.omem`：`submit`、`draft`、`onInit`、`onTheme`、`open`，高度自动上报）。`asks` 加 `draft` 列，`saveDraft` / `draftOf`。
- 工具 `ui_page`（`ask` 分组，`coder` 也有）：`html` 或工作区里的 `.html` 文件（同 `attach_artifact` 的目录范围），`page_id` 出新版。`page` 组件放进 `show` / `ask_user` 的 `view`（宿主补标题；和 `fields` 不能同在一个提问）；`answerAsk` 收页面交回的值（最多 20000 字符）。接口 `GET /api/ui/pages/:id?version=`、`POST /api/asks/:id/draft`。
- 网页 `UiPage.vue`：`srcdoc` + `sandbox="allow-scripts"`，只认这个 iframe 发来的消息，发主题 token（浅色深色切换时更新）、存草稿、提交回答、只放行 `#/` 链接，全屏和版本切换；问答页里带交互页的提问跟在回复下面。飞书卡片里是一行说明加“打开交互页”。
- 外部 Agent 编码（`code_workspace`）在游离 HEAD 上的提交要等它 `finish` 排的那一轮结束才放回分支；以前那一轮开头的 `placeOnBranch` 把工作区切回分支最新提交（分支在别处检出时），提交就留在了外面，检查和评审跑的是没有改动的代码。现在本次交办自己的工作区里在分支之上还没放回的提交会保留（分支没在别处检出时直接快进分支），刚借来的工作区仍从分支最新提交开始（`src/agents/code-branch.ts`，`test/code-sync.test.ts`）。

## 2026-11-08：界面块第四阶段（飞书网页应用入口）

- `web/lark/index.html` + `web/src/lark/`（`main.ts`、`LarkApp.vue`、`LarkHome.vue`）：Vite 第二个入口（`web/vite.config.ts` 的 `rollupOptions.input`），只有它加载飞书 JSSDK；登录：`tt.requestAccess`（103 退回 `requestAuthCode`）→ `POST /api/auth/lark/app`（`AUTH_PUBLIC` 放行）→ `login.ts` 的 `larkAppLogin`（`lark.ts` 的 `exchange` 在没有 `redirectUri` / `verifier` 时不带这两个参数）；不在飞书里跳回主站。
- 配置 `lark.webApp`，`/api/auth/session` 返回 `larkApp`；`asks.ts` 的 `larkAppLink`，`uiLink` 在打开后给 `applink.feishu.cn/client/web_app/open?…&mode=sidebar&lk_target_url=…`。设置 → 渠道的开关写明开发者后台要填的主页和可信域名。测试 `test/lark-webapp.test.ts`。

## 2026-11-08：界面块第五阶段（排序、可编辑表格、问别人、页面截图）

- `ui-blocks.ts`：字段 `rank`、`table`（`normalizeAnswers`、摘要、文字版）；`lark-asks.ts` 的 `cardFields` 遇到它们返回 null（退回网页）。网页 `UiFields.vue` 用上移 / 下移和带 `UiSelect` 的表格；SDK 渲染器同样支持。
- `ask_user` 的 `to`（`tools.ts`）：本人自己会话里 `kind = ask` 的一轮、对方能读空间才行；提问 `context` 记 `askedBy` / `toName`（`Ask` 上的同名字段），`asks.ts` 的 `show` 只通知对方和发对方的飞书私聊（`lark-asks.ts` 的 `targetFor`），`describeAnswer` 用对方的名字，`deliverAnswer` 以提问人的身份回到原会话；`/api/asks` 和 `/api/ui/:id` 带 `askedByName`，`AskCard` 显示是谁的助手在问。
- `lark-ui.ts` 的 `preparePageShots`：有 Playwright 时发卡片前给交互页截图并上传，`kv` 的 `ui_page_shot:<页>:<版>:<机器人>` 记图片 key，`viewCardBlocks` 放截图。测试 `test/ui-ask-others.test.ts`。

## 2026-11-08：评审卡片改用组件块

- `review-chain.ts`：`askPlan` 的 `ui.view` 是指标（评审档、最多轮数、评审项数）+ 表格（评审项、阻塞级别）+ 编码说明和理由；`askDone` 的“默认要改的问题”是表格（最多 50 行），正文去掉编号列表。处理逻辑（`review-plan` / `review-done`）不变。

## 2026-11-08：卡片画不了的只给链接

- 去掉交互页截图（`lark-ui.ts` 的 `preparePageShots`、`kv` 的 `ui_page_shot:*`）：要服务器装浏览器，流程也绕。`viewCardBlocks(app, view, { linked })`：有链接时交互页不进卡片，由调用方放“打开交互页”按钮；没链接时写一行说明。
- `lark-asks.ts`：卡片放不下的表单只放“打开填写”按钮，不再把字段列成文字；只有没设网页地址时才列字段让人回复文字。`show` 的卡片里有交互页时按钮是“打开交互页”。链接仍由 `uiLink` 决定：开了 `lark.webApp` 给 AppLink，否则是普通网页链接。

## 2026-11-08：测试结果挂到需求点，技能挂到空间

- `src/items/req-tests.ts`：表 `req_tests`（运行、交办、轮次、提交、用例名、文件、状态、方式、说明、产物 id）；`recordTests` 后 `pruneTest` 让同一个测试（点、文件、用例名）只有最近 3 次结果留着产物；`testState`、`testsText`（阶段评审材料的“测试结果”一节）。
- 工具 `report_tests`（新分组 `code-results`，`attach_artifact` 从 `code-handin` 移过来；`ROLE_TOOLS`、`PEER_REVIEW_TOOLS`）：校验需求点 id 和空间，产物按 `attachPath` 收（`req` 指向那个点），不填 `commit` 时取唯一仓库工作区的 HEAD。外部 Agent 带 `run_id`（`peerHandIn`）。`roles/coder.md` 加“测试结果”。
- 空间设置 `skills`（`specs.ts` 的 `spaceSkillNames` / `spaceSkillsText`）：`runner.ts` 按 `workRepos`（交办的 `repos` 或工作区，沿 `codeRunId` / `helperOf` / `continueFrom` 找）把本空间、所属业务、改到的仓库挂的技能单独列一节，`skillIndex` 不再列挂在别的空间上的技能；改到的仓库的 SPACE.md 也进说明；`code_workspace` brief 同样。
- 产物（`artifacts.ts` 的 `take`）：记内容哈希 `run_artifacts.sha`，同样内容再交时硬链接到已存的文件；没有扩展名的文件按开头字节认出 png / jpg / gif / webp / webm / mp4 / mov / pdf 并补扩展名。
- 网页：需求树标“测试通过 / 失败 N”，节点详情“测试结果”（`RunArtifacts` 支持直接给 `items`）；设置 → 空间“这个空间的技能”。接口 `GET /api/requirements` 带 `testState`，`GET /api/requirements/:id` 带 `testState`、`testResults`。

## 2026-11-08：在交办之外做完的编码自动收尾

- `code-branch.ts` 的 `settleCodeWorks`（每小时随 `item-sweep` 跑，`POST /api/items-expiry/sweep` 也会跑）：没在编码、评审和 Git 同步、一小时没动的交办，每个有提交的工作分支都已在 origin 上（`fetchBranch` 后本地分支是 `origin/<分支>` 的祖先，且不是 omem 自己推过的那个提交：`output.pushed`、`work.delivered`）时记成已确认（`appliedAt`、`settled: "pushed-outside"`，`pushed` 带 `outside: true`），留下的项照常由同一分支的下一次交办接上；否则同一分支上有在它最后一次动静之后开的交办时记 `supersededBy`，没做完的项标 `wontdo` 并写明去处。两种都取消这几轮的宿主卡片、归还工作区。
- `code-works.ts`：`supersededBy` 显示“由新交办接着做”；本人停下的交办先于“等你决定”显示为“你停下的”。
- 检查命令和外部 Agent 命令的输出在宿主收的时候去掉终端颜色代码（`util.ts` 的 `stripAnsi`，预览日志共用）；交办视图显示旧记录时也去掉。

## 2026-11-09：规则里的主助手可以把触发交给别的 Agent

- `runner.ts`：环境里的“已有的 Agent 档案”按这次运行实际有的工具写用途：有 `run_agent` 写可交办，只有 `ask_agent`（规则运行的主助手，`rules/actions.ts` 的 `assistantScope` 去掉了交办工具）写“不能交办，用 ask_agent 请教”，都没有就不列。之前规则运行的主助手看到“可用 run_agent 交给它们”去找交办入口，找不到就调 `report_rule_failure`，规则显示为失败。
- `tools.ts` 的 `ruleHandoff`：规则运行里调 `run_agent` 时，新运行沿用父运行的 `rule`、`lark`、`threadId`、`replyAt`、`silent`、`hideThinking`、`conversationId`，`denyTools` 去掉交办与请教，任务里附上父运行的原始任务；`rules/actions.ts` 的 `assistantScope` 不再拒绝 `run_agent`。静默排查时被交办的 Agent 在话题里发言，跟进记录记在交办它的运行上（`handoff`），话题里的回复回到主助手。回归：`test/rule-handoff.test.ts`。

## 2026-11-09：Codex 不再为每次 omem 工具调用请求审批

- 起因：常驻服务器上 codex-acp 2.5.0 的每次 omem 调用都先发一次“MCP tool call approval”，11-07 起平均每次 30～40 秒，有的一直没有发出（规则运行因此报失败）。omem 的工具不带 MCP 注解，Codex 把它们当作有破坏性、会访问外部，只要不是“完全访问”模式就每次都问；`acp.ts` 每次选“允许一次”。
- `mcp-server.ts`：列工具时都加 `destructiveHint: false`、`openWorldHint: false`（权限仍由 omem 每次调用时检查）。`acp.ts`：MCP 工具审批有“本会话允许”时选它。回归：`test/rule-handoff.test.ts` 的 MCP 注解一项；真实 codex-acp 下是否不再询问，部署后看运行事件里还有没有这类审批。

## 2026-11-09：做梦轮查存量、关联候选记住判断无关的、错过的定时任务补跑

- 起因：常驻服务器上 10-30～11-08 应跑 10 晚，2 晚计时器没触发（`last_run_at`、`dream_at` 都没动，日志无报错，同一秒的 heartbeat 照常），1 晚 Agent 启动即 EPIPE；跑完的 6 晚每晚只改 1～4 处：任务只给当天变化（每天新记忆个位数），digest 经验按“同一原件”分组几乎凑不出组（364 条里只有一个原件有 2 条），关联候选把 `view` 当依赖（`includes` 子串匹配，命中 preview）且没有否决记录，4 晚重复核对同一对。croner 10 在假时钟里 30 天每天都触发，没找到漏跑的根因。
- `scheduler.ts`：触发包进 `fire`（更新 `last_run_at` 也在 try 里）；`catchUpSchedules` 每分钟一次（`restartScheduler` 里的 unref 定时器），上一个时间点过去 90 秒～6 小时、`last_run_at` 早于它的补跑并写日志；一小时内会再跑的和从没跑过的不补。
- `jobs.ts` 的 `agent()`：EPIPE / ECONNRESET / connection closed，两分钟内且还没有工具事件时重试一次（运行里记一条状态）。做梦报告用 `replyOf`（最后一条消息）。
- `dreamStockBatch`：每晚取 80 条上次做梦前就有的有效记忆（按 created_at、id，kv `dream_stock_cursor`，到头从头再来），`sameTopicPairs` 找相近的对，单独一节列给 dreamer（去掉和当天那节重复的对）；只有存量对时也会跑。
- `digest-merge.ts`：按同空间、同档案的向量分组（以种子为中心，成员都和种子相近），组可以跨原件；没有向量时按同一原件。`DigestGroup` 改为 `memories[].sourceId` + `sources[]`。
- `space-candidates.ts`：`dependsOn` 按清单类型整词匹配依赖名；多个空间发布同名包的不算；表 `space_relation_declines`、`declineRelation`，候选去掉被判断无关、且没有新一类依据（数字归一）的对。工具 `relate_spaces` 加 `decline`（note 写原因）。`roles/dreamer.md` 第 00、1、7 条跟着改。

## 2026-11-09：规则运行设了唤醒时保留它的后端会话

- 起因：常驻服务器上一次报警规则运行设了 5 分钟后的 wake_later 接着查，运行结束 45 秒后它的会话就被清理，唤醒时恢复失败（Internal error），新会话拿不到上一轮的执行结果，只记了一笔就结束。`releaseRuleSessions` 只看排队中的 `resumeSessionId` / `resumeFromRun`、同一 lane 和跟进中的话题，没看排队中的唤醒（`kind='wake'`，原运行在 `target.resumeRunId`）。
- `session-cleanup.ts`：排队中的唤醒和待触发的消息唤醒（临时规则的 wake 动作）指向的运行，会话保留到唤醒结束。回归：`test/session-cleanup.test.ts` 的唤醒一项。

## 2026-11-09：规则和档案的“完全访问”

- 起因：报警规则用的内部命令行工具在 Codex 只读沙箱里起不来（读网卡 EPERM、不能联网），每条命令都要走沙箱外执行的审批，一轮二三十次；codex-acp 2.5.0 偶尔把审批请求压几分钟才发出（这次 4 分钟，Agent 先报了失败，命令在它结束后才跑）。omem 本来就批准所有非编辑类命令，沙箱对这类运行只多了等待。
- 规则的 agent 动作和 Agent 档案加 `fullAccess`（规则页、Agent 页的开关，默认关）。`runRole` 只在规则运行、档案打开时生效，评审检查、复盘、对比运行、访客不用；`acp.ts` 选 `full-access` 模式（`agent-full-access`、`bypassPermissions`、`danger-full-access`、`yolo`），没有时记一条状态照旧运行，此时审批也放行编辑；`cli.ts` 的 codex 用 `--dangerously-bypass-approvals-and-sandbox`，claude 用 `--permission-mode bypassPermissions`。后台会话池的键带上它。规则交给别的档案（`RULE_DELIVERY`）、唤醒续轮（`wakes.ts`）沿用。
- 只有本人能打开：`saveRule` 非本人保存时新开的 `fullAccess` 返回 403，漏写的保留原值；`saveAgentSpec` 非 user 保存保留原值，`PUT /api/agents/:name` 只认本人的。检测结果记下后端的模式（`ProbeInfo.modes`），网页 `fullAccessHint` 按它说明当前后端支不支持。回归：`test/full-access.test.ts`、`test/rule-handoff.test.ts`。

## 2026-11-09：内置角色和访客的完全访问

- 起因：网页对话里的主助手跑要联网的命令时同样一条条等审批（常驻服务器上一次数据对账 13 轮，几乎每次唤醒都是“先 functions.wait 某个 cell”），规则和档案的开关管不到它。
- 判断集中到 `prepareRun`（`PreparedRun.fullAccess`）：运行自己的值（规则的开关、回答访客那一轮的访客开关）优先；否则本人的运行用档案或内置角色叠加设置（`_roles/<名>.overlay.yaml` 的 `fullAccess`）的值；别的用户的运行、评审检查、复盘、对比运行不开。规则运行在 `jobs.ts` 里总是给明确的值，不跟角色或档案走。
- 内置角色：`setRoleFullAccess`、`PUT /api/roles/:name/full-access`（只认本人），改技能和工具时保留；`guest`、`gatekeeper` 不设，改在 `lark.guests.fullAccess`（设置 → 渠道 → 访客提问，默认关），`lark-guest.ts` 的回答访客运行和 `threadTurn` 里含访客消息（`meta.asker`）的那一轮用它。会话复用键带上它，访客一轮和本人一轮不会共用同一个完全访问的进程。
- 访客提问的“也回答私聊”从勾选框改为开关，和上面的开关一致。回归：`test/full-access.test.ts`。

## 2026-11-09：规则动作“转发到”

- 本人要把通知机器人私聊自己的消息转到别的群，目标是人时建群转发。规则原来只能在触发的会话里发言、只能把机器人拉进触发的群。
- `rules/forward.ts`：`forward` 动作（`to: { chatId, name, kind: group | p2p }`、`note`），机器人发出，uuid 由规则、消息、目标算出去重。群：`chatBots` 里没有 omem 的机器人就 `inviteOwnBot`。私聊：对方取采集到的最近一条 `sender_kind='user'` 的发送人，以本人身份 `im +chat-create --as user --users <对方> --bots <app_id>`，群 id 存 kv `rule_forward_group:<私聊 id>` 复用。只用于“新消息”触发；非本人保存时新加或改动目标返回 403。AGENTS.md 的本人身份写操作清单加上这两处。
- 规则页“转发到”从采集过的会话里选目标（`rule-options` 的 chats 带 `chat_mode`）。回归：`test/rule-forward.test.ts`。

## 2026-11-09：对话里指定转发目标；补充消息直接交给进行中的一轮

- 转发目标：`save_rule` 在回答本人自己消息的那一轮（`ownerAskedThisTurn`）可以新加或改动 `forward` 的目标，`chatId: "current"` 换成本会话的飞书群，名字和类型从 `lark_cursors` 补；`saveRule` 的 `opts.ownerAsked`。规则草稿（`compile.ts`）认识 forward。
- 中途接收：常驻服务器上一轮在跑命令行时，本人的补充消息要等它下一次调用 omem 工具才能交进去，看上去像在排队。codex-acp 2.5.0 有扩展方法 `_session/steering`（`idleBehavior: "promptRequired"` 时没有进行中的一轮返回 `promptRequired`），本机实测 `injected` 且这一轮的回复包含补充内容；直接再发 `session/prompt` 只会排成下一轮。`AcpHandle.steer`；`steer.ts` 拆成 `claimSteering`（先看）+ `commit`（交出后再移走）；`inbox.ts` 收到消息后 `steerLiveTurn`，交不进去（后端不支持、这一轮已结束、发送人不同）就照旧等工具调用。回归：`test/steer-live.test.ts`（假 Agent 的 `FAKE_STEER`）、`test/rule-forward.test.ts`。

## 2026-11-09：会议结论发在私聊里而不是上次的话题；下一步卡片可以直接写

- 会议结束后的结论投递到本人和机器人的私聊会话（`ownerChatThread`），飞书发送跟着会话的 `lastTopicId` 回复，本人上一条消息在私聊的某个话题里时结论就进了那个话题。会后那一轮的输入带 `topLevel`，`jobs.ts` 投递时带上（会后那一轮也带着拉机器人入会的规则，走的是规则那条投递分支，两条分支都要带；第一次只改了一条，部署后又进了话题），`lark-bot.ts` 的发送直接发到私聊本身，并把会话的 `lastTopicId` 清掉、`lastMessageId` 换成这条（下一步卡片跟着它）。回归：`test/lark-answers.test.ts`（两项：发送本身，和带规则的会后运行走一遍真实投递）。
- 下一步（suggestion）卡片在飞书上一律带输入框和“按我写的做”：选一项时写的话接在那项后面一起说，不选只写也行（`answerAsk` 合并 `option.message` 和文字）。回归：`test/asks.test.ts`。

## 2026-11-09：规则的快速检查、“等某个会话的新消息”、转发回触发的会话

- 本人要的场景：有人在群里 @ 或私聊要验证码，5 分钟内验证码机器人发来新码就自动发给他。原来私聊和没有机器人的群只靠采集（常驻服务器上每 10 分钟），赶不上；规则也不能等另一个会话的消息。
- `rules/fast.ts`：`pollFastRules`（`main.ts` 每分钟；只在有勾了 `trigger.fast` 的启用规则时搜，`+messages-search` 群里 @ 本人 + 私聊，`--query` 取条件里 `message.text contains` 的词，kv `rule_fast_since_ms`，往前多看 2 分钟，`dispatchRuleEvent` 加 `only` 只交给这些规则）；`waitThenAct`（`wait-message` 动作排 `rule-fire` 运行，每 10 秒 `+chat-messages-list` 读目标会话，触发之后第一条符合的作为 `RuleEvent.awaited`，`fireAfterWait` 接着做后面的动作；超时按 `onTimeout`）。
- `forward`：`awaited` 时转发等到的那条；`to.kind=origin` 回到触发的会话（群：机器人回复在触发消息下，必要时以本人身份拉机器人；私聊：对触发消息的发送人以本人身份建群并记住）。保存检查：`checkWaitRule`、`origin` 也算转发目标（非本人要求的一轮不能新加）。规则页：快速检查勾选、“等某个会话的新消息”编辑、“回到触发的会话”。AGENTS.md 的本人身份写操作清单跟着改。回归：`test/rule-fast.test.ts`。

## 2026-11-09：主聊天里的消息变成话题根后，后续消息不再跟进那个话题

- 起因：常驻服务器上本人和机器人私聊的主会话 `lastMessageId` 指着一条已经用 /topic 拆成独立话题的消息。往主会话投递（唤醒、交办结果、会议结论）时 `lark-bot.ts` 的发送在主聊天里“回复”这条消息，飞书把对话题根的回复放进那个话题，于是发到了为别的任务开的话题里。多 Agent 工作话题、规则在消息下开话题同样会让主聊天的消息变成话题根。
- `lark-send.ts`：回复带 `reply_in_thread` 且飞书返回 `thread_id` 时，发送记录带 `topicRoot`；`lark-bot.ts` 的 `releaseTopicRoot` 把同一个聊天主会话里还指着这条根消息的 `lastMessageId` 去掉（之后发到聊天本身），开话题的那个会话（或运行所属的会话）保留——编码进度卡片在请求下开的话题，结果本来就该回到那里。回归：`test/topic-root.test.ts`。已经指着话题根的旧会话不迁移：本人在主聊天里再发一条消息就换掉了。

## 2026-11-09：套餐额度纳入自动选择

- 原来只有额度用完（报错）后才避开那个账号。现在读本机登录账号的剩余额度：Codex 起 `codex app-server` 调 `account/rateLimits/read`（Pro 套餐只有周窗口，没有 5 小时窗口，窗口按长度认），Claude 在 claude-agent-acp 的会话里发本地命令 `/usage`；都不耗额度。对话和运行里 Claude 报的限额事件随时更新。存在 kv `agent_quota`（`src/agents/quota.ts`）。
- 快用完的账号（`agents.capacity.quotaAvoidAbove` 默认 90%，`quotaPerDayBelow` 每天剩余百分比默认不看）在角色运行的候选里排到最后；`list_ai_backends` 带 `quota`；设置 → AI → 并行 显示额度、阈值和“现在读取”；`peer call <设备> agents` 带 `quota`。回归：`test/quota-limits.test.ts`。

## 2026-11-09～10：决策模型支持 Cloudflare Clef；检测账号里的模型

- 提供方新增 `cloudflare`（`config.ai.providers[].accountId` 填账号 ID），决策走 Workers AI 的 `…/accounts/<账号>/ai/run/@cf/cloudflare/<模型>`，格式同 Jev 的 System One，默认 `clef-flash`；返回包在 `{result}` 里也认（`src/core/decision.ts`）。
- `decide` 可带 `media`（图片、音频、视频的 data URL）；`decisionMedia`（`src/core/ai-keys.ts`）给出模型能读的媒体：`clef-flash` / `clef` 读图片，`clef-omni` 还读音频和视频，其他模型只读文字，带了读不了的媒体直接报错。设置页决策的状态行写明能读什么。
- 读提供方的模型列表（`refreshModels`，`cache/ai-models.json`，添加 key、检查通过或过一天时刷新）：设置页的图片、语音、转写、委托、决策模型改成下拉选，可手填；留空用列表里版本号最大的模型（`newestOf`，列表为空时用内置默认）。图片的内置默认改为 `gpt-image-2.6-flare`。

## 2026-11-10：运行前自动选 AI；后端出故障时换后端

- 选 AI 收成一处（`src/agents/choose-ai.ts` 的 `chooseAI`）：没指定 AI 的运行开始前，从“按原来的设置”和任务选型的候选里挑一个，材料是任务、谁来做、现在时间、总体偏好，每个选项带适用说明、占用、账号额度和最近的故障。有决策模型时用它（`decide` 的 choice），`always` 档在没有决策模型或它出错时问通用模型（`askModel`）。按运行类型设置：`agents.routing.choose` 的 `conversation`（新开 Agent 会话时选，记在 `threads.settings.auto`）、`rules`（规则交给的 Agent）、`tasks`（交办和后台任务，编码、评审除外）。
- 原来 Agent 档案的运行（规则交给的、交办出去的）只用档案的后端，不换；现在没指定 AI 时和角色运行一样按 `failoverProfiles`（选中的、原来的、角色在其他后端的模型、兜底、任务选型的候选）换。
- 原来只有排队、限流、额度用完和“还没开始就失败”才换后端。现在后端本身出故障（`isBackendDown`：进程退出、连接断开、看门狗判定没有活动）也换，已经做了一半也换：接手的后端在任务前面看到上一个已做的写入（`retry.ts` 的 `partialAttemptNote`），出故障的后端 15 分钟内排到最后（`capacity.ts` 的 `markDown`）。对话也一样：看门狗超时不再在同一个后端重开会话，接手的后端拿到会话背景（原来只拿到新消息），下一轮留在它上面。

## 2026-11-10：远程使用 CLI 与 MCP；鉴权插件；按邮箱预建账号

- 设计与实现：docs/v2/remote-clients.md。`omem tool` / `omem mcp` 加 `--url`、`--remote`（`OMEM_URL` 同样），不用配对就以自己的身份连远程 omem；凭据取记下的远程地址（`~/.omem/client.json`，`omem remote add|list|default|rm`）、`OMEM_TOKEN`、`OMEM_AUTH_CMD`（`src/remote-client.ts`）。只有 `OMEM_TOKEN` 没有地址时仍连本机服务，omem 运行里的 Agent 行为不变。
- `omem login <地址>`：确认码 + 浏览器确认（`#/cli-login`）换一个标签 `cli:<主机名>` 的 API 令牌（`src/auth/cli-login.ts`，表 `cli_logins`，`api_tokens.client`）；账号页“命令行与 MCP”列出和撤销。`omem open [页面]`：用命令行的凭据换一次性登录链接，登录后回到那一页。
- `/api/tools`、`/mcp` 除了运行令牌也认用户凭据（`src/auth/external-tools.ts`）：工具是设备外部 Agent 那套（`peer-agent.ts` 从只给本人改成按用户：空间 `accessibleSpaces`、工具按全局权限裁剪，不能交办编码的去掉评审交付工具），会话信息在 `x-omem-*` 请求头（URI 编码），运行带 `user_id` 和 `via`。新全局权限 `tools.external`，内置管理员、成员、访客都有。设备交办（`run_agent` / `ask_agent`）排出的运行记在调用的人名下。
- 鉴权插件 `api.authenticator`（`src/auth/authenticators.ts`）：只在 omem 进程里运行、要在清单 `permissions.authenticators` 声明；请求先经 `checkBearer` 验证，结果按凭据哈希缓存到过期（最多 10 分钟），`resolveAuth` 读缓存。认出的身份经 `bearerLogin` 找账号或认领预建账号，都没有时按 `auth.signup` 建等待批准的账号并通知一次。
- 按邮箱预建账号：`POST /api/users`、成员页“按邮箱添加成员”、`omem user add --email [--login-any]`，`PATCH /api/users/:id` 可改邮箱；邮箱一律存小写（迁移时转换），建账号和改邮箱时查重。`claimByEmail`：飞书登录（`verifiedEmails`：企业邮箱优先，再是邮箱）和鉴权插件（`emailVerified`）按邮箱认领唯一的预建账号，多个时不认领并通知。飞书登录和绑定都申请 `contact:user.email:readonly`、`contact:user.employee:readonly`（`identityScopes`），只为这两项拿到的令牌不当作连接保存；机器人检查列出缺的这两项。
- 修复：名字以非拉丁字符开头又带字母数字时（“用户 u200”）生成的用户 id 带前导连字符，个人空间对不上而建账号失败。

## 2026-11-10：复用已有分支的交办只比较自己的改动

- 修复：在已有分支上交办（`fromBranches`）时，比较起点是选分支时本地的旧提交；首轮同步把 origin 的新提交拉进来后，运行详情、diff 统计、评审输入、检查点 0（“全部改动”）、检查命令的 `OMEM_BASE`、临时索引都把这些公共提交算成交办的改动。
- `WorktreeRef.diffBase`（`code-branch.ts`）：规划时先 fetch，取本地分支和 origin 的共同祖先；拉取 origin 时（`code-sync.ts` 的 `nextDiffBase` / `settleDiffBase`），只要 origin 没有这次交办的提交，就推进到拉进来的 origin 提交（冲突停下的同步处理完才生效）；origin 已经有交办的提交（推送过）时不动。`changeBase` 对较早的检查点取 `merge-base(diffBase, 终点)`。合并别的分支（`onto`）不改变比较起点。
- 旧交办（没有 `diffBase`）读取时按“本地分支与 origin 的共同祖先”补上（`withDiffBase`，不写库，下一轮随工作区保存）；origin 已含它某一轮编码检查点的提交时保留原起点。保存的补丁、统计在能确定该轮终点（检查的提交或该轮检查点）时按新起点重算（`codeDiffView`，运行详情和评审共用）。首轮单项误记进修改项的公共提交在读取时排除（`ownCommits`）；首轮的提交归属从同步后（`syncHead`）算起。
- 整段压缩、回到检查点：范围里有交办开始前分支上已有的提交（本人未推送的）或 origin 上已有的提交时拒绝，提示按修改项回退（`assertOwnRange`）；多仓库压缩在任何写入前先检查全部仓库。

## 2026-11-11：网页版 VS Code 认本人的登录；实时连接按需建立；可选 HTTPS（HTTP/2）

- **网页版 VS Code 在网页地址上打开**：`ideAllowed` 认本人的登录会话（`omem_sid`，本人、非受限、同源），omem 重启或直接打开 `/ide` 后不再 401；转发给 serve-web 时去掉登录 cookie；未登录打开 `/ide` 页面时给出登录入口。
- 分享页“一直在加载”是浏览器在 http 下每个地址 6 条连接被各标签页的实时连接占满。实时连接改为按需建立（`web/src/lib/live.ts`：分享页、登录页不建）、后台 45 秒断开、冻结或进入往返缓存时立即断开、回前台重连并通知页面刷新（`onServerResync`）。
- 新增可选 `https` 配置（`src/server/secure.ts`：`port`、`cert` / `key` 或 `selfSigned`、`hosts`），在原 http 端口之外再开一个 HTTPS 端口，浏览器在上面走 HTTP/2；`http2Compat` 补 Host、移走伪首部、去掉 HTTP/2 禁止的连接级首部。

## 2026-11-11：飞书消息的加粗与引用编号；需决定的卡片统一收尾

- 飞书发送统一经 `src/channels/lark-markdown.ts` 规范加粗：中文标点紧邻 `**` 时按 CommonMark 的规则不成立（`**建议：**先…`），发出前把句读移到加粗外、括号引号外侧补空格、去掉标记内侧空格；代码不动。
- 句末引用编号改为 `(n)`（`citations.ts` 的 `citationMark`）：⑪ 以后的带圈数字在常用中文字体里缺字形，回退到别的字体后大小不一。
- 需决定的卡片（提问、批准、草稿确认、规则脚本审批、访客审批、入会确认）收尾统一为 `decidedBlocks`：谁、何时、决定，一句结果，工具的原始输出放进折叠的“完整输出”。

## 2026-11-11：“有人找你”和渠道分开；规则先于它

- 流程搬到 `src/mentions/`（`mentions.ts` 预筛、等待、每日上限、处理与兜底、`reply_to_asker` 的检查；`triage.ts` 分诊；`channel.ts` 渠道接口 `MentionChannel`）。飞书实现接口：`src/channels/lark-mentions.ts`（挑出找本人的消息、读消息和引用、已读、前后聊天、发送人、盯群和机器人直接回答、规则键 `lark:<id>`），`mention-reply.ts`（在飞书上回复和草稿卡片）。`src/channels/mention-triage.ts` 移到 `src/mentions/triage.ts`，前后聊天和发送人改由渠道提供。运行类型、`input.mention`、`handled_messages` 的 `lark-mention` 不变；`input.mention` 多了 `channel`（没有的按飞书）。
- 设置从 `lark.mentions` 移到顶层 `mentions`，回复方式按渠道放在 `mentions.reply.lark`（`group` / `p2p` / `p2pVia`）。读取配置时把旧位置迁过去（`config.ts moveOldSettings`，保存时对文件里的旧位置同样处理），之后可删。设置页文案不再只说飞书。
- 和规则的先后：规则在这条消息上触发过（不论动作类型，跳过也算），或认领后正在等（`rule-fire` 运行排着或在跑），“有人找你”让开；规则还在判断（`dispatchRuleEvent` 进行中，`rules/store.ts rulesJudging`）时等一分钟，和等 ingest 合计最多 8 次。判断在 `rules/store.ts ruleClaim`。原来只在规则带“交给 Agent”动作时让开，只通知、只转发的规则会和这里各提醒一次；带等待的规则等待比 `delayMinutes` 长时两边都处理。
- 规则页列表最后一条“没有规则处理的、找你的消息 → 有人找你”（不能删除，显示开关和今天的次数，点进去到 设置 → 渠道）；新接口 `GET /api/mentions`。docs/v2/mentions.md 加“消息先经过谁”“渠道”，“和规则的关系”重写；docs/v2/rules.md 加“和‘有人找你’的先后”。

## 2026-11-11：有人找本人时先分诊再处理

- “预筛 → 决策模型分诊（`roles/mention-triage.md`）→ 按需交给主助手或档案 → 可选回复对方”（现在在 `src/mentions/`，见上一节；设计 docs/v2/mentions.md）。新运行类型 `mention`；处理是带 `input.mention` 的 `agent` 运行，最后的回答作为提醒，卡片关联运行以便接着聊。
- 新工具 `reply_to_asker`（只给这类运行，目标固定，按 `mentions.reply.lark` 变草稿卡片或直接发，写 `audit_events`）；AGENTS.md “渠道”新增这一处以本人身份写。
- `notify()` 对 6 小时内已提醒过的同一批聊天消息返回 409，要求用 `replaces`（原因：实时采集和轮询各排一个 `ingest`，读同一批行各提醒一次）。新设置 `mentions`（原为 `lark.mentions`；`guidance`、`noDecision`、`perDay`、`reply`）。

## 2026-11-11：编码交办里要本人定的问题先交给助手；精简评审

- 编码 Agent 的 `report_task`(owner)、评审负责人的 `rule_review` / `rule_dispute` owner 和方案分歧都先进“等助手处理”（`code-tasks.ts` 的 `toDecide`）；助手可以 skip 驳回或 later 放下还没做的评审项，用 `settle_code_task` 的 `add` 新增需求漏掉的项（不经本人每次交办最多 5 项），定不了才 owner 发卡片。去掉 `existing_authorization`，卡片发出后只等本人；同一处助手放下两次后评审再提直接问本人；卡片因助手转达关闭时注明。起因：编码 Agent 的问题直接发给本人，同时被叫醒的助手又在后台把它处理掉，卡片只显示“已失效”。
- 精简评审在补丁堆起来的地方自动加上（`code-loop.ts` 的 `simplifyDue`）：改动到 200 行代码而它还没看过，或它看过之后又出现“修过的地方又修”。`coder`、`reviewer`、`review-arch`、`review-simplify` 的说明加了不写防御性补丁、判断在边界上处理一次的要求。
- 设计稿 docs/v2/coding-plan.md（方案与变更说明，未实现）。

## 2026-11-11：一件事的后续消息跟着它最近在哪里聊

- `src/agents/home.ts`：一件事是按 `parent_id` 连起来的一串运行，归属位置记在最上面那个运行的 `output.home`。唤醒、协调回复、编码汇报按它投递；本人在别处回复这件事的消息，或在别处用写工具操作它的运行，归属就迁到那里。
- 飞书会话本身只引用这件事自己的上一条消息，没有就不引用；唤醒那一轮开的工作话题挂在这件事自己的消息下。原话题发不进去时退回本人私聊，并写明是哪件事的后续。

## 2026-11-11：后端出错、换后端的顺序与选型记录

- 上游流中断（stream disconnected、empty stream、RST_STREAM、502 / 503 / 504）算后端故障并按模型冷却；`stay_quiet` 之后后端对空的最终回复报错按完成处理（`runner.ts` 的 `quietAfterAll`）。
- 点名的 AI 不可用时按 `agents.routing.pinnedFallback`（默认 unavailable）换并写明。所有换后端的地方都按选型说明排的顺序：运行前选型时决策模型给出整个排序，没经过选型的运行第一次要换时问一次（`fallbackOrder`，缓存 10 分钟），没有决策模型才用静态兜底顺序；记录里写明顺序来源。
- 每次运行记一条带 `choice` 的状态事件（选了谁、理由，或为什么没选），换后端带 `failover`。
- 按模型的每日额度：“今日额度用完”类错误只把那个模型排除到次日零点；设置 → AI → 并行 的单独上限加“每天最多”；ACP 探测保存每个模型的说明（`modelNotes`）。按修改项推进的交办续轮时保留新指定的 AI。

## 2026-11-11：规则——电子表格按行比对、发到群、“这个群”、所属空间

- 文档变化规则可指定“发到”会话（auto / draft），Agent 在那个群里回复指定消息或话题并 @ 修改人。
- 电子表格存快照、逐行比对，每个新增或改动的行一个事件（`change.sheet` / `change.row` / `change.action`）；多维表格按记录分发（`change.recordId` / `change.tableId` / `change.action`）。新增条件字段 `change.byOwner`、`change.editorId`。规则运行用 `lark_write` 回写后 5 分钟内，只由本人造成的变化不再触发同一条规则（`src/rules/own-writes.ts`）。
- `save_rule` 的条件 `chat.id` 和“发到”支持 `current`。规则页列表显示所属空间或“全局”，所有类型的规则都能改所属空间；规则换空间时挂在它上面的工作文件一起移过去，共享的工作文件可在原件页换空间（`moveWorkFile`）。

## 2026-11-11：命令规则

- 命令规则（docs/v2/command-gate.md）：配置 `security.commandRules`（仅本人经 `GET/PUT /api/security/command-rules` 修改）。`command-gate.ts` 在 `<home>/bin/guarded` 生成同名包装，放在 Agent 进程 PATH 最前；`POST /api/command-gate`（本机连接 + 运行令牌）按规则放行、拒绝或建审批（`asks`，`context.handler="command-gate"`），长轮询等 `waitSeconds`，之后才有结果的用 `fireWake` 唤醒。审计 `command.allow|ask|approve|reject|deny|pending|expire`。防误操作，拦不住绝对路径调用。

## 2026-11-11：主线程卡顿监测；向量快照

- 主线程卡顿监测（`src/core/loop-monitor.ts`，`diag` 的 `eventLoop`）：延迟超过 500 ms 记日志，带当时的 SQL / git 同步步骤。
- 向量变更记录 `vector_log`（触发器）加量化快照（`cache/vectors`）：检索进程重启后读快照再重放记录，不再每次整份重读；向量通道空闲 30 分钟才退出，载入不会因超时被杀。
- `page_cites` / `symbols` 加索引（`list_pages`、`find_symbol`）；网络 git（fetch / ls-remote）改为异步。

## 2026-11-11：Wiki 规划接受目录说明页、案例页和空计划

- `submit_plan` 的页面类型原来只有 guide / concept / howto / reference / topic，而规划角色被要求给新目录计划 `<目录>/index`（kind=index），已有空间里又多是案例页（case）：带这两类的计划被参数校验拒绝，运行以“规划没有提交页面计划”失败。现在类型和 `write_page` 一致；现有页面够用、这次只移动页面时可以提交空计划，运行按完成结束。
- 常驻服务器上实际失败的那几次是另一种情况：助手用 `generate_wiki` 让规划去改一页已有页面，规划自己用 `write_page` 改完了、没有可计划的页面，运行却按“没有提交计划”记为失败。现在规划没交计划但自己写过或移动过页面时按完成结束；`generate_wiki` 新增 `pages`：只改已有的几页时不规划，每页直接交给写作（`src/wiki/generate.ts`）。

## 2026-11-11：交办结束后清理它留着的后端会话

- 评审项在按修改项推进的交办里各留一个会话（`persistSession`），编码 Agent 也留一个；交办确认或丢弃后没有任何地方释放它们，豆包这类把会话记在账号历史里的后端会一直留着。现在每分钟的清理（`session-cleanup.ts` 的 `releaseRuleSessions`）把已确认或已丢弃的交办留下的会话标为可清理；交给 Agent 的工作（`agentWorkId`）里两天没有新运行的会话同样释放。

## 2026-11-11：同一批聊天消息只整理一次

- 机器人实时收到和本人身份轮询各自为同一个会话排整理（ingest），说明文字不同所以不合并，而且都从同一行读起：同一批消息被读两遍。现在已经在排队的运行里有这个原件时，不看说明直接并进去；整理运行开始读时记下读到第几行（kv `ingest_to:<原件>`），之后再为同样的行排队就跳过，新的运行从上次读完的下一行开始（不再从“最后一次追加的位置”开始，中间追加的行不会漏）。

## 2026-11-11：拉人进群

- 新工具 `lark_invite`（分组 `lark-owner`，`src/channels/lark-invite.ts`）：以本人身份把人或机器人拉进本人的群，一批群一次调用。`resolveInvites` 一次列出全部问题：群读名字、拒绝单聊；人按 `lark_people` 的 `cli_open_id`、`contact +search-user` 完全匹配，重名列候选，`ou_` 取不到名字的拒绝，查到的 `rememberPerson`；机器人按 `self`、`lark.bots`、kv `lark_known_bots`（`chatBots` 读到时写入）、`bots_seen_in`。
- 有人时整次 `held` 审批，参数存成只含 id 的规范形式，相同参数在等批准时不再发卡，卡片固定发到本人私聊、全文不截断（超 20 KB 要求分次）；只拉认得出的机器人默认直接执行，新配置 `lark.invite.botApproval`（设置 → 渠道 → 拉人进群）打开后机器人也审批，只拉 `self` 且 `ownerAskedThisTurn` 的那一轮除外。
- `runInvites` 人 50、机器人 5 一批 `chat.members create --succeed-type 1`，逐群写结果和 `audit_events`（`lark.invite`）。`inviteOwnBot` 移到这里共用 `addChatMembers`；`set_chat_watch` 去掉 `invite_bot`；lark-cli 用户 scope 补 `im:chat.members:write_only`；经 `--peer` 的外部 Agent 和“有人找你”的处理不给这个工具。

## 2026-11-11：方案与变更说明（docs/v2/coding-plan.md）

- 新对象“方案”（`designs`、`design_revisions`，`src/designs/`）：一组决定（`add` / `change` / `remove` / `refactor`，各有栏目，每栏 `brief` 加展开的 `text` / `code` / `table`），加事实、整体行为表、不一致和意见（`problem` / `risk` / `improve` / `question`，状态 open / resolved / dropped）。来历 `own`（交办前写，本人确认）、`external`（别人的技术方案，提取加评估）、`derived`（编码 Agent 事后交的变更说明）；按来历校验，id（`D<n>`、`C<n>`）各版本稳定，重新评估必须交代上一版每条意见。
- 工具：`submit_design`（`code-handin`，只有 `designer` 能写 own / external）、新分组 `design`（`read_design`、`assess_design`、`settle_design`）；角色 `designer`；运行类型 `design`（评估别人的方案，结果回到发起的对话，网页发起的发通知）；设置 `agents.design.mode` / `confirm`。
- 交办：`submit_brief` 多 `design: { needed, why }`；`delegate_code` 多 `design`（auto / always / never）和 `design_id`；方案阶段在编码前检查之后（`src/designs/work.ts` 的 `designStage`），等确认时这一轮以 `awaiting-design` 结束（交办阶段 `design`），确认走 `decideDesign`（卡片 handler `design-confirm`、`POST /api/designs/:id/decide`、`settle_design`），通过后同一轮重新排队；`continue_code_run` 表示不等方案直接编码。`plan_tasks` 每项可带 `decision`，`finish_task` 可带 `deviation`、`simpler`；`submit_review` 的问题可带 `decision`（新列 `review_findings.design_decision`）。
- 分支评审：`review_branch` 多 `design_id`（不传取事项上最新的 own / external 方案）；有方案时拆分用 `submit_change_points` 的 `decisions: [{ decision, files }]` 只写归属（`attributeFiles`，其余进 `outside`），`rule_review` 多 `decisions`（`done`、`deviation`、意见状态）；没有方案的照旧。
- 接口与网页：`/api/designs`（列表、详情含 `changes` / `outside` / `runId`、发起或重新评估、`decide`、`concerns/:cid`、`diff?decision=`，补丁结构同 `task-diff`）；`/api/code-works/:id` 多 `design`（没交的变更说明不算）；方案变化发 `changed` 事件（entity `design`）。网页 `DesignView`、`#/design/:id`、`#/designs`、交办视图“方案”标签、事项页“方案”一栏、设置 → AI → 方案先行、仓库空间“总是先写方案”。

## 2026-11-11：没交结果的交办也能看改动；VS Code 插件按决定看改动

起因：外部设备的 Agent 编码（`code_workspace`）在 `finish` 之前不保存补丁，网页“变更”只读保存的补丁，所以一直显示“这一轮没有改动”；插件的看改动接口只认按修改项推进的交办，这类交办连“和分支比较”都用不了。

- `workPatches` 多一种取法 `work`（`GET /api/runs/:id/task-diff?work=1`）：每个仓库从 `changeBase` 到工作区现在的样子。工作区有没提交的改动时，用索引的一份副本（`GIT_INDEX_FILE`）`add -A` 后 `diff --cached`，新文件也在，工作区自己的索引不动；`to` 是 `worktree`。都提交了就是两个提交之间的差异。分支评审是 `base` 到 `tip`。`core/git.ts` 的 `git()` 多一个可选的环境变量参数。
- `task-diff`：不按修改项推进的交办不带参数就是 `work`，`base=` 同样可用；只有 `tasks` / `from` / `to` / `since` 还要求按修改项推进。`file-at` 的 `rev=worktree` 读工作区里现在的文件（路径不出工作区、不进 `.git`、不跟出去的链接）。
- 网页 `CodeWork` 的“变更”：最新一轮没有保存的补丁、交办没结束时，打开标签读一次 `work=1`，带“刷新”。
- 方案：`designDiff` 在分支评审时给补丁带上 `from` / `to`；交办没有修改项时（外部 Agent 编码的、只有变更说明的），决定的补丁是它列的文件在全部改动里的那几段。
- 插件：`tasks.ts` 的 `showPatches`（原 `showChanges` 拆出来，任何来源的补丁都能打开）；`design.ts` 的“方案”视图（`omem.hasDesign`）；命令 `omem.work.changes`、`omem.design.diff`、`omem.design.openWeb`；`omem.work.compareBase` 不再限于按修改项推进的交办。测试数据加了一份方案和一次没交结果的外部编码。

## 2026-11-11：盯群和 @ 不再各答一遍、回答里的 @、会后说明、巡检知道本人在哪

常驻服务器上一天里看到的几件事，原因和改法：

- 盯着的群里有人 @ 机器人，同一条消息起了两个运行：盯群的那一路（`lark-watch` 会话）和当场回答的那一路（群或话题的会话），各回一遍，还各开话题。现在 @ 机器人、会被当场回答的消息不再交给盯群（`lark-watch.ts` 的 `answeredDirectly`，在 `handled_messages` 记 `direct`，本人身份的采集晚些看到也不再送）；当场回答的那一轮在上下文里带上本人盯这个群要什么（`watchPurpose`）。盯群的说明加了两句：同一件事的后续回在原话题里，@ 机器人的消息不会送到这里。
- 一条回复里 @ 同一个人两次：群里的回答由宿主在开头 @ 提问的人，模型又在正文开头写了 `@名字`。现在正文里的 `@名字` 换成真正的 @（提问的人、消息里 @ 到的人、被引用消息的发送人），每人一次，开头不再重复加（`lark-bot.ts` 的 `toAsker`）。助手的角色说明加了一条：结论是给谁的就 @ 谁（本人让帮某人看、本人回复了某人的消息时也 @ 那个人），同一件事不再用 `lark_send` 往同一个群发一遍。
- 机器人没能入会的会议也收到“没有记录”的纪要和建议：`meetingEnded` 在没有任何转写和会中聊天时不写原件、不起会后运行。会后运行的说明重写：本人自己在会上，不复述、不罗列别人的待办；落到本人头上的事逐件推进，主要是听的会只写要点，临时沟通只写结论，没有要说的用 `stay_quiet`。旁听窗口只记事实，不写建议。
- 巡检在本人开会时发了会上正在讲的内容，还夹带了早就发生的安排：巡检的任务和“有人找你”的分诊材料里多了“本人此刻”（`src/agents/owner-now.ts`：正在开的会、今天开过的会、最近一小时说过话的会话），`roles/heartbeat.md` 加了“本人在场的不用提醒”“只说新的、只说这件事”。
- “有人找你”的处理只给一句建议回复：处理说明改成先把事情往前推（要过后做的事写进事项并把提醒定在该动手的时候），提醒里写做了什么、还差本人哪一步；“收到，会处理”这类话不写。分诊材料多了“本人在这个会话里”（近 14 天发言数、这里 @ 助手问过什么）。
- 运行页“所在会话与关联”把结果只是发到那个会话的运行（有人找你的处理、会后说明）也当成会话里的一轮，列出了整个主会话的几十轮对话：现在只有本身是对话轮次的运行才列，长会话只列前后 9 轮；别的运行那一行写“结果发到”。
- 本人在话题里说“换另一个 AI 再试”，助手对自己这一轮调用 `switch_run_ai`：这一轮被停下重排，但对话轮次按会话的后端运行，不认运行上的选择，重排后还在原来的后端上，续接的旧会话里工具令牌也已失效。现在目标是对话轮次时改的是会话的后端、模型和强度并放掉旧会话，重排的这一轮和之后的轮次都在新的 AI 上（`tools.ts` 的 `switch_run_ai`）；角色说明写明这种要求不另外交给别的 Agent。
- 系统自动发的通知卡片被整理成待办并定时提醒，本人直接忽略：`roles/ingest.md` 写明这类卡片默认不建事项、不设提醒。

## 2026-11-11：内置角色合并不再因为 tools 那一行冲突；正文可以重新跟随源码

起因：一个只挂了技能的内置角色，每次源码更新都要手动合并，还总有冲突。合并后的基线是会前移的（干净合并和模型解决冲突后都把基线设成新源码）；反复冲突的原因有两个：frontmatter 的 `tools` 是一整行，副本里这一行和基线不同（早期合并把分组里已有的工具名也摊开写了，还多一行 `skills`），源码一动这一行就必然冲突；模型解决冲突时倾向把两边都留下，源码已经删改的旧段落留在副本里，正文越走越远，所以“只多挂了技能”的副本也没法自动变回叠加设置。

- `mergeRole`：frontmatter 按字段合并，`tools` 和 `skills` 按集合（源码现在有的，加上本人加的，去掉本人去掉的；分组已经带上的工具名不再单独列），只有正文按文本三方合并。合并或模型解决冲突之后，副本如果只剩技能和工具的差别，自动变回叠加设置。
- `followRoleSource`（`POST /api/roles/:name/follow-source`，Agent 页“正文跟随源码”）：放弃副本的正文，保留副本比源码多的技能和工具（源码特意排除的工具不带回来），之后源码更新直接生效。
- 模型解决冲突的说明：源码删掉或改写、本人没改过的段落按源码，不把旧写法和新写法并排留着；frontmatter 已合并好，不改。
## 2026-11-11：工作近况与人物卡（docs/v2/work-state.md）

- 新内置角色 `work-state` 和定时任务 `work-state`（默认每晚 02:50，打开）：宿主把最近 `workState.days`（默认 21）天的事实写进任务（本人发言多的会话、打开过或发过链接的文档、编码交办、打开的事项、会议、本人找助手做的事），角色在 personal 空间改 `state/work`（摘要 / 在推进的事 / 最近活跃 / 要追踪的对象 / 本人补充），再给有新消息的常打交道的人写人物卡 `people/<名字>`（每晚最多 `workState.people`，默认 8）。没有新材料时不调用模型。
- 页面里 `## 本人补充` 一节归本人：`write_page` 由 Agent 写入时恢复成原文（`keepOwnerSection`）。要追踪的内部对象的查法写成数据目录的技能。
- “最近打开的文档”：`captureRecentDocs` 记下新进入最近打开第一页的文档（kv `lark_doc_opened:<url>`）。
- 注入集中在 `owner-now.ts` 的 `ownerContextParts`：主助手本人的对话轮次（新会话背景；近况页改过后的第一轮再带一次；群里带有人物卡的人）、巡检、有人找你的分诊材料（“发送人”带人物卡那句话）和处理任务、会后说明。设置 `workState.inject` 关掉。
- 角色说明：`_common.md` 新增“本人近况与人物卡”（只给有 `recall` 的运行，访客没有），`assistant.md` 写清处理不了的事查人物卡、向本人提出拉谁进来（照旧经 `lark_invite` 和本人批准）。
- 设置 → 定时任务 里这一项下可改天数、每晚人物卡上限和是否注入。
## 2026-11-11：多 Agent 工作的过程消息收敛、思考气泡三档、交办时借工具

起因：在飞书话题里交给另一个档案做的一件事走了 5 轮，每轮有协调回复、唤醒轮和几个思考气泡，话题里十几条中间消息本人并不需要；那个档案没有读写表格的工具，每轮都回头找主助手代做。

- 新设置 `agents.progress`（设置 → AI → 过程消息）。`messages`：`milestones`（默认）/ `all`。`thinking`：`all` / `own`（默认）/ `off`。
- “只是接着推进”的判定（`agent-work.ts` 的 `onlyMovedOn`）：这一轮排出了下一轮（`queueAgentRound` 记 `queuedBy`，`run_agent` / `continue_agent_work` 都带）、这一轮没有 `asks`（提问或审批）、回答的消息里没有本人自己的话、工作不在等本人。满足时 `deliverCoordination` 只把回复存进工作会话（`meta.progressOnly`），不发；工作会话里的唤醒回合同样处理（`jobs.ts`）。协调出错、到自动推进上限、没再交办（做完）都照常发。
- 进度卡：`src/channels/lark-work-progress.ts`（`watchWorkProgress` 由主机器人注册），按运行状态变化 0.5 秒、步骤 8 秒合并更新；卡片写第几轮、谁在做什么、最近一个工具或状态、运行记录链接，消息 id 和内容指纹存在发起 ask 运行的 `output.workProgress`，内容不变不更新；话题开出来之前不发；`all` 模式不发。
- 思考气泡：`lark-agent-cot.ts` 的 `showThinking` 统一判断，两处起气泡的地方都问它：`lark-bot.ts` 回答消息时（本人自己发的、不是访客或机器人的消息才算 `own`），`startReplyProgress` 多 `bubble` 参数，关掉时只加“处理中”表情，不起气泡、不发兜底卡片；后台运行（交办的轮次、请教、协调、编码交办结果、规则）只有回答本人自己消息的 ask 轮在 `own` 下显示。
- 借工具：`run_agent` / `continue_agent_work` 多 `extra_tools`（最多 12 件）。`tools.ts` 的 `lendTools`：必须是发起这次交办的运行令牌里有的工具（被禁用的、本人没权限的本来就不在里面）；`LEND_DENIED` 不借以本人身份写飞书（`lark_write`、`lark_invite`、`lark_doc_create/update/move/copy/authorize`）、发消息（`lark_send` 等 lark-msg 里发送的）、再交办（`run_agent`、`continue_agent_work`、`ask_agent`、`delegate_code`、`review_branch`、`continue_code_run`）、`stay_quiet`、`report_rule_failure` 和 `ROLE_TOOLS`；从别的设备或规则运行里交办不能借。借出的记在这一轮的 `input.extraTools`，`runAgentTask` 去掉这次运行被禁用的再交给 `addTools`，任务末尾写明借到了什么；`prepareRun` 照常按本人权限裁剪，空间范围不变。
- `roles/assistant.md`、协调说明（`sessions.ts` 的 `coordinationNote`）：交办前看对方档案的工具，缺的自己做或借；只是接着交办的那一轮回复写一两句记录。设置页加“过程消息”一节（两个 `UiSegmented`）。
- 测试：`test/agent-work-progress.test.ts`、`test/agent-work-lend.test.ts`，`test/agent-work.test.ts` 多一条默认设置下的循环。验收 17a–17d。

## 2026-11-11：会话与运行互相知道（docs/v2/awareness.md）

起因：同一个群里两路同时处理同一件事各回一遍；后台在查的事本人中途插手了，后台照发过时的结论；一件事在几个会话里进行，各会话只看眼前。改法：

- 运行的范围键：表 `run_scope`（迁移），`src/agents/run-scope.ts` 的 `recordRunStart` 在 `runs.ts` 认领运行后从输入得出（会话、飞书群和话题、触发消息、事项），事项工具（`read_item`、`upsert_item`、`settle_items`、`propose_item_update`、带 `entity_id` 的 `notify`）运行中补上。`relatedNote` 生成“同时在办的相关工作”（进行中或 30 分钟内结束，最多 6 条），`runner.ts` 的 `runRole` 和 `sessions.ts` 的 `threadTurn` 接在任务后面（`awareness.ts` 的 `awarenessNote`）。
- 发出前复核：`awareness.ts` 的 `preSendCheck`（`tools.ts` 的 `runTool` 里，`notify`、`lark_send`、`lark_card`、`lark_send_file`、`reply_to_asker`）和 `recheckAnswer`（`jobs.ts` 的 `ask` 处理和 `runAgentTask`，最终回答）；只对 `mayStayQuiet` 的后台运行，每次运行一次（`output.awareness.recheckedAt`）。`ownerMoves` 收集运行排队后本人在范围里说的话。通知闸门的已读、表情、之后回复并进同一个检查；`lark-bot.ts` 推送时对复核过的运行不再拦（`checkedBeforeSend`），夜间攒下的照旧检查。
- 运行中送达：`ownerNews` 接在 `tools.ts` 的 `steering` 后面，后台运行下一次工具调用的结果末尾附“本人刚说了”，每条一次。
- 一件事跨会话：`src/items/places.ts`。会话和群聊是事项材料；`upsert_item` 写事项时自动关联运行所在的会话或群（`linkRunPlaces`）；“这件事还在这些会话里进行”（`itemPlacesNote`）；候选事项（`placeCandidates`，引用、链接或单号、人、共同的词、时间）；`read_item` 多返回 `places`、`runs`；`GET /api/items/:id` 多返回 `places`、`runs`（只给事项的主人）；事项页“在这些会话里进行”（`ItemPlaces.vue`）。
- 接手：新工具 `take_over_run`（分组 `delegate`），停下同一个人的后台运行并返回它最后的文字、工作文件、碰过的事项和已发出的消息。
- `roles/_common.md` 新增“同时在办的工作”；`skills/omem/references/items.md`、`agents.md` 同步；测试 `test/awareness.test.ts`（假 Agent 新增 `FAKE_MODE=aware`）。
## 2026-11-11：经豆包以本人身份发私聊

起因：有的企业禁用了 lark-cli 以本人身份发私聊消息的权限，“有人找你”的私聊回复（`p2pVia = signed`）和 `/ai` 都发不出去；豆包 OpenAPI 的云端会话以本人身份运行，能发飞书私聊。

- 设置：`mentions.reply.lark.signedVia` 和 `lark.commands.signedVia`，`lark-cli`（默认）或 `doubao`。设置 → 渠道 → 有人找你（私聊“以你的身份回”下面）和 私聊指令 各有一个选项；选了豆包时显示能不能用（`GET /api/lark/doubao-send`，没授权、缺权限、授权过期写原因）和“给自己发一条测试私聊”（`POST /api/lark/doubao-send/test`，只有本人）。命令行 `omem doubao send-test`。
- 发送：`src/channels/doubao-send.ts` 的 `sendViaDoubao`。每条消息建一个新豆包会话（`runBackend` 的豆包后端，临时档案 `doubao-send` 只带 `DOUBAO_APP_ID`），提示里只有定稿全文（含署名）和收件人（`recipientOf`：`lark_people` 里的姓名、邮箱、user_id，私聊 chat_id，lark-cli 下的 open_id），要求原样发、只回一行 `OMEM_SEND_RESULT: OK` 或 `FAILED <原因>`（`parseDoubaoReport`，同时有 OK 和 FAILED 算失败）。会话用完删，删不掉进 `session_cleanup` 重试。
- 核对：lark-cli 只读那个私聊（不知道 chat_id 时读本人这段时间发出的单聊消息），去掉空白和 Markdown 标记后比对。结果 `verified` / `unverified`（豆包说发了、私聊读不了）/ `mismatch` / `failed`；后两种不算成功，单独通知本人（原因加全文）。会话建起来以后这次处理就记为已回复，不再发第二次。
- 草稿点发送后卡片立刻变成“正在经豆包发送”（卡片回调等不了几十秒），结果另发提醒；自动档核对上时写在处理运行的提醒里。`Replied` 多可选的 `ok`、`problem`，处理运行的提醒在 `ok === false` 时写“回复对方没有成功”。审计 `lark.mention-reply` / `lark.command-reply`（新）/ `lark.doubao-send.test`（新），带结果、豆包的回报（截断）、会话 id 和应用。
- AGENTS.md 渠道一节写进了这条以本人身份写飞书的路径。提示原文和真机待验的点在 docs/v2/mentions.md “经豆包发送”。验收 19a–19e（文末一节）。

## 2026-11-11：首页“等你回答”不再撑出栏；过期的提问自己失效；网页通知以飞书为准

起因：首页左栏的待回答卡片里有很长的链接、宽表格和不换行的代码块时，卡片撑出左栏、盖住右边的“后台运行”“最近保存”；“需要你回答”越积越多，其中不少本人已经在飞书上接着说了别的，或者那件事已经结束；通知都推到飞书了，网页上的未读数仍然越积越多。

- 首页样式：`Home.vue` 的两栏（`.col`、`.block .stack`）用 `minmax(0, 1fr)` 和 `min-width: 0`，内容再宽也不撑开栏；`AskCard` 本身限宽 `min(760px, 100%)`、长文字换行，表格和代码块在卡片里横向滚动，表格单元格不再一字一行地断数字。同一个组件也用在问答页、`#/ui/:id` 和插件会话里，一起修好。1440 和 390 宽度都没有横向溢出。
- 提问失效（`src/agents/ask-expiry.ts`）：
  - 本人在同一个会话里接着说话（`answerFromMessage` 之后）：那里更早的、提问那一轮已经结束、也没有 `wait_answer` 在等的问题失效；还在等的由那一轮的 Agent 自己决定，新工具 `withdraw_ask` 撤回自己的问题（`roles/_common.md` 加了一句：本人改了主意或给了别的指示，先撤回还开着的问题）。
  - 交办确认（不是部分应用）或丢弃时（`applyCodeRun`、`discardCodeRun`），它各轮和各轮评审还开着的提问失效；事项关闭时（`upsertItem` 变成 done / cancelled / expired），为它做的运行还开着的提问失效（还有别的未关闭事项要它的除外），这个事项的通知记为已读。
  - 放了 `asks.staleDays` 天（默认 7，0 表示不限）没人回答的失效。宿主自己的决定卡片（评审计划、规则启用等）在它的工作还在进行时不按天数失效（取消了也会再问一次），只跟着工作结束；命令审批和交办修改项的卡片各有自己的收尾（`command-gate.ts`、`code-loop.ts` 的 `reconcileWaiting`），这里不动。
  - `sweepStaleAsks` 把上面这些规则用在库里已有的数据上：每次启动（升级后第一次启动就清掉积下的）和每次巡检各跑一次。
  - 失效的提问记下原因（`context.lapsed`），飞书卡片更新成“需要你回答 · 已失效”和原因，没有按钮，交互记录关闭，再点提示已经处理过；`wait_answer` 返回“已失效：原因”。飞书卡片上点“拒绝”或选项本来就是回答，网页同步不再列出，没有改。
- 网页通知（`core/notify.ts`、`channels/notify-read.ts`）：
  - 推送记在通知上（`pushed`：渠道、时间、飞书消息 id）：通知卡片、事项卡片、每日汇总、夜里攒下的一次补发都记；按免提醒规则或本人已经处理而没有推的记 `quiet`（后一种同时记为已读）。
  - 网页的未读数和小红点只算没推到任何渠道的（`countsAsUnread`：没读、没推、没被有意不推、不是只在应用内的 `silent`）；通知页仍列全部，推过的标“已发到飞书”，没推的标“没有推送”。网页收到新通知后过几秒再取未读数，不再直接加一。
  - 变成已读：本人引用回复了通知卡片（`inbox.ts`）、点了通知卡片上的按钮（`lark-actions.ts`）、事项关闭；巡检时 `syncNotificationReads` 查最近 7 天推过还没读的：卡片上有本人的表情、有引用它的回复，或 lark-cli 的已读状态（一次最多 50 条，一批一次调用）说读过。
  - 升级后第一次启动 `backfillPushed` 把以前推过的（记过卡片 id 的、有事项或汇总卡片交互记录的）补记为已推送，只跑一次（`kv.notify_pushed_backfill`）。
- 没有在真机上验证：lark-cli 的 `+messages-read-status` 能否读到机器人发给本人的卡片的已读状态（读不到时不改，靠表情、回复和事项关闭）。

## 2026-11-11：口语练习并入英语练习；`omem peer open` 下插件页面加载失败

起因：设置 → AI → 语音加进来时，网页多了一个单独的“口语”页（`Speaking.vue`、导航项、`/speaking`），评价由宿主的 `speaking-coach` 角色写，按钮是浏览器原生样式，和英语练习是两套东西。另外在一台电脑上 `omem peer open` 打开经中间设备转发的设备网页时，英语练习页控制台报 `blocked by CORS policy`，页面空白。

- 宿主给插件页面的语音会话：清单 `voice: true`；`GET /api/plugins/:id/voice`、`POST …/voice/realtime/secret`、`POST …/voice/live/sdp` 带插件的 `instructions`（最多 6000 字），不带 omem 工具，也不进 `voice_sessions`（`core/voice.ts` 的 `VoiceSpec`）。外壳 `Plugin.vue` 收到页面的 `voice-start` 后用 `lib/voice.ts` 拿麦克风、建 WebRTC，只把转写和结束时的记录转给页面；要求页面里刚有点击（`navigator.userActivation`），进行中顶上显示“正在使用麦克风”和“结束”，不替页面转发 `voice/…`（临时凭证不进沙箱）。SDK 加 `omem.voice()` / `voiceStatus()`。
- 英语插件：内容块 `speaking`（场景、想练的说法），页面工具 `english_speaking_start`、`english_speaking_brief`（按口语等级、薄弱短语、口音写给语音模型的说明），提交时存 `speaking` 记录并把对话记录交给陪练；陪练按插件技能 `english-speaking`（由原 `speaking-assessment` 改写）用 `english_speaking_grade` 交等级、四项分、评价和知识点，进同一份画像（`PROFILE_SKILLS` 多了 speaking，`snapshot.speaking`）。页面“新练习”里“做题 / 口语对话”并列，口语卡片 `SpeakingCard.vue` 用 omem 的样式；没配语音模型时说明去哪里配。
- 删掉：`web/src/views/Speaking.vue`、导航项和 `/speaking` 路由、`roles/speaking-coach.md`（`roleNames` 同步）、`speaking-review` 的评价逻辑（旧的排队运行直接结束）、`voice_sessions` 的练习写入（表保留，旧的 `practice` 行不再列出）。已经播种到数据目录的 `speaking-assessment` 技能不会被删，不再有角色用它。
- CORS：问题在第一跳，`omem peer open` 的本机代理。沙箱 iframe 以 `Origin: null` 按 CORS 方式取 module script 和样式表，本机代理的本机信任检查（`trustedLocal` → `sameOrigin`，10-30 起）把 `Origin: null` 当作别的网站，直接回 403，没有跨域头，浏览器就报 CORS。直接访问目标设备时不经过这层所以正常。现在本机代理对 `Origin: null` 只放行插件页面的文件（`pluginPageFile`：`/plugins/<id>/…`、`/plugins/_sdk/…`，只允许普通路径字符、不含点段和 `%`，免得 `..` 在转发时被解析成别的路径），并在响应上自己补 `access-control-allow-origin: *`，所以中间设备是 11-07（d25fbf62）之前的版本、转发时丢掉这个头也没关系；只需要更新运行 `omem peer open` 的那台电脑。插件页面的流（`/api/plugins/<id>/streams/…`）加进本机代理的原始隧道（`PLUGIN_STREAM`），中间设备 11-07（6050f807）起原样转发本人的升级请求。`test/peer-plugin-page.test.ts`：三台 omem 两级转发，以及一个丢掉跨域头的旧中间设备。

## 2026-11-12：原件页的仓库目录、筛选和滚动加载

起因：业务空间挂了十几个仓库、一万多份原件时，原件页顶部一排仓库按钮换了七八行，关注程度和类型两排一样的按钮挨在一起，筛选区占了半屏；目录树滚到底会闪、反复加载。

- 滚到底反复加载：目录树（非仓库空间）和仓库路径树自己取数据，但列表栏的滚动监听仍按平铺列表的分页判断：平铺列表是空的，总数却是目录树报上来的整个空间的份数，于是每次接近底部都去取 `/api/sources` 的下一页（这一页根本不显示），底部的“加载中…”一出一没又改变了高度和滚动位置，接着再触发。现在只有平铺列表（没选空间）分页，判断抽成 `web/src/lib/sources.ts` 的 `shouldLoadMore`（某页返回空就停，即使总数说还有）；底部那一行在还有下一页时一直占位，只换文字。
- 仓库进目录树（`SourceTree.vue`）：业务空间名下的仓库作为顶层目录，展开是从仓库空间加载的路径树（节点 key 加 `@<仓库>@` 前缀，设关注程度时按仓库空间写）；6 个以上收进一个“仓库”目录。份数并进标题旁的总数。仓库行的菜单显示本地路径和“单独打开”。顶部的仓库按钮去掉，仓库空间里留“属于 业务空间”的返回链接。
- 筛选：关键词 + 类型下拉一行，关注程度下拉（选项带份数）+“待复核”一行；“待复核”打开后变成“回到目录”。标题行的整理、知识库在列表栏里是图标按钮，手机上显示文字；手机上没选原件时列表占满屏。
- 验证：`test/sources-web.test.ts`；本地演示数据（5000 份、15 个仓库）在 1440 / 1060 / 390 宽度截图，没有横向溢出。验收 25a–25g。

## 2026-11-12：代码索引有了基线，分支和交办的索引按需用、自动过期

起因：本人问代码问题，助手拿之前某次交办分支上的代码回答。两条路都会这样：仓库的索引就是 `rootPath` 目录检出的样子（目录停在功能分支或交办检出的分支上时，那就是“仓库的代码”）；`space: "*"` 或不限空间的检索把所有交办工作区（`wt-…`）和分支索引（`br-…`）都带上，而且这时分支版本不替代仓库同名文件，各个版本并排出现。另外 `repo-sync` 默认关、从没跑过；交办续轮的 `wt-<轮>-<仓库>` 只删了第一轮或被应用那一轮的；按提交 sha 建的分支索引永远解析得到、永远不删。

- 基线（`src/sources/code-baseline.ts`）：仓库空间的 `settings.codeIndex`（`mode` baseline / directory、`ref`、`branches`）。按基线时用 `git ls-tree` + `cat-file --batch` 从提交里读，按 blob id（`meta.blob`）只重读变了的文件，基线提交没变就什么都不读；子目录空间路径相对子目录，已检出的子模块按记录的提交读。状态写 `settings.codeIndexState`（ref、提交、提交时间、索引时间、拉取时间、错误、跟的分支的错误），网页保存空间设置时不覆盖它。原件仍按“空间 + 路径”定 id，切换和更新后 `src:` 不变。已有空间不自动切换（按目录，也记下当时检出的分支和有没有未提交改动），新接入、有 origin 的仓库第一次同步就按基线。
- 定期更新（`src/sources/code-index.ts`）：`repo-sync` 改成 `repoSyncTick`，默认开，从没运行过的库启动时打开一次（kv `repo_sync_default_on`）。按 Git 仓库（common dir）分组，每组一次 fetch（只拉基线和跟的分支），按目录的空间看 `HEAD` + `git status` 指纹，变了才排 `sync` 运行；然后刷新跟的分支和最近用过的分支索引、清理过期索引。
- 叠加索引：`search.ts` 的 `withOverlays` / `overlays` 选项，不列空间的检索排除所有叠加索引（全文、符号、向量），列了空间时只加允许的；`tools.ts` 的 `search`、`find_symbol`、`scan` 跟着改，运行属于某次交办或分支评审时自动带上那次的工作区索引（`worktree-index.ts` 的 `runOverlaySpaces`）。`worktreeSpacesOf` 按整次交办找所有轮次。`indexBranch` 记 `usedAt`、`committedAt`，相对仓库的基线比较，子目录仓库用 `--relative`。
- 过期（`expireOverlays`）：交办应用、确认、丢弃、被接替时删每一轮的工作区索引，14 天没动静也删；sha 分支索引 3 天、没登记跟的分支索引 14 天没用就删；`repo-sync` 每小时和启动时清理。
- 版本说明：`search` 头部、`find_symbol` 末尾、`read_source` 头部写“代码来自”（`codeVersion`）；`roles/_common.md` 加一条：回答代码问题说明依据的分支，问分支或交办的事带 `branch`。
- 接口（`src/sources/code-index-http.ts`）：`GET/PUT /api/spaces/:id/code-index`、`POST /api/spaces/:id/code-index/refresh`、`GET/POST/DELETE /api/code-index/hook`（变更通知令牌，存 kv `code_hook_token` 的哈希）、`POST /api/code-index/notify`（独立令牌或本人凭据；按 git remote 或空间匹配，后台拉取刷新）。网页仓库设置的“代码索引”（`web/src/components/CodeIndexPanel.vue`），业务空间的仓库列表显示索引到哪个提交。设计 `docs/v2/code-index.md`。
## 2026-11-12：材料从个人空间归位

起因：个人空间堆了大量业务文档和工作记录（一台实际使用的机器上三千多份文档、一百多份工作文件，业务页面引用个人空间原件七十多处）。archivist 只看正文、一判定终身、“不确定就留个人”；主助手在个人空间里为业务事项写的工作文件留在个人空间；协作者打不开业务页面引用的个人空间原件。设计在 docs/v2/archive-routing.md。

- 旁证（`src/sources/homing.ts` 的 `archiveEvidence`）：知识库位置和本人归入的空间、同目录文档的去向、引用它的其他空间的页面 / 事项 / 记忆（含合并前旧 id）、贴过它的群和群的空间、手动定的关注程度、工作文件的事项或规则。`archive` 运行把它和重判原因（`again`）一起交给 archivist。`roles/archivist.md` 改为：旁证指向同一业务空间就归过去，矛盾或只有弱旁证时留下记“判断不了”，日常个人内容记“确实个人”。
- `classify_source` 加 `verdict`、`candidates`；`source_routes.verdict` / `suggested`，`source_moves.mode` / `detail`（迁移）。`archive.autoMove`（默认开）关掉时 AI 的判断只记成建议。
- 重判：`archive_evidence` 记判断时的旁证指纹，`archive_recheck` 是队列；`collectRecheck` 找新旁证、空间或归档规则变化（第一次只记状态）；每晚 `archive-sweep`（01:40，`archive.nightly` 默认 60）按优先级交出，规则能定的直接移，没有待判的不跑。理由“有新旁证，重新判断”的原件不跟随同一会话的旧判断（`archive.ts` 的 `REJUDGE`）。
- 工作文件：`write_file` 在本人个人空间里、运行范围只指向一个业务空间时写到那里（`matterSpace`，同路径旧版本一起移），挂在业务事项或规则上的旧工作文件每晚跟过去（`followWorkFiles`）。
- 网页：归档规则页左侧“从个人空间归位”（`ArchiveHoming.vue`）：自动移走的及依据、移回并记住、等你定的批量指定、读者打不开的引用、两个设置。接口 `GET /api/archive/homing`、`POST /api/archive/homing/{return,assign,sweep}`、`GET /api/spaces/:id/citation-reach`、`POST /api/spaces/:id/citation-reach/recheck`。
- 引用可达性（`src/sources/reach.ts`）：按空间读者和 `sourceVisible` 判断，不写死个人空间；只有本人能读的空间不报。
- 群里再贴一次已移走文档的链接时，一天内读过的不再重读（`importLinkedDocs` 认 `source_locations`）。
- 测试：`test/homing.test.ts`、`test/homing-agent.test.ts`（`FAKE_MODE=archive`）。验收 26a–26l。

## Wiki 生成时的检查与核对（2026-11-11）

起因：一次对夜间自动生成页面的审核，发现首页丢了目录入口、同一主题在几个相关空间各写一遍且不一致、流程步骤和代码不符、规划了的页面没写也没提示、“未取得”其实原件里有、业务页引用个人空间和临时分支的原件、代码空间索引过期只能写纯文本、页面过长和过程性语言。本人没时间逐页核对。设计在 docs/v2/wiki-verify.md。

- 宿主检查（`src/wiki/checks.ts`，`write_page` 调用）：首页和目录页改写丢了仍然存在的页面入口时退回，同一运行再缺补在页尾；引用不存在、已删除、行号超出退回；共享空间页面引用个人空间、交办分支索引、部分读者无权限空间的原件退回，并给出本空间或相关业务空间里的同一份；能唯一对上索引的 `路径:行号` 和 `` `符号` `` 写成纯文本时退回并给出 `src:` 写法；超过 12000 字退回。新页面和相关空间页面标题相近时提示链接。
- 代码索引：规划和每页写作前，相关代码空间的索引落后于仓库 HEAD 就先同步（`refreshCodeIndexes`）。
- 规划：任务里列出相关空间已有的页面；`submit_plan` 新增 `overlap`（本空间另写的理由）和 `reuse`（链接过去的主题），同名主题两样都没有时退回。
- 核对（`src/wiki/verify.ts`、新角色 `wiki-checker`、工具 `submit_page_check`）：写作运行里计划的那一页先存草稿（`read_page` 读到草稿），核对角色用自己的 AI（`runRole` 的 `ownAI`）逐条核对并交结构化结论，写作者改或反驳，最多 3 轮后发布；核对记录存 kv，`GET /api/wiki/:space/page/*` 的 `checks`，网页右栏“核对”（`WikiChecks.vue`）。空间设置 `wikiVerify: false` 关闭。
- 生成对账：规划的各页和 `generate_wiki` 的 `pages` 记成一次生成（kv `wiki-gen:<id>`），每个写作运行结束时 `settleWikiRun` 判断；没写成的重试一次，都结束后发一条通知（有未解决时普通通知，否则 silent），规划运行的输出带 `report`。
- 角色说明与技能：`wiki-planner`（相关空间同主题、保留首页入口、调查入口写到代码）、`wiki-writer`（按代码数步骤、写“没有”前先找、引用只用业务空间、代码写成引用、6000 字以上拆、核对意见怎么处理）、`wiki-linter`（同样的写入规则）、技能 `wiki-writing`（事实上最常出错的几处、自查项）。
- 测试：`test/wiki-checks.test.ts`、`test/wiki-verify.test.ts`；假 Agent 的 wiki 模式加了核对角色（`FAKE_WIKI_CHECK_FILE`：pass / once / always）和按核对改写。

## Wiki 写法：过程性与防御性语言、拿不准的问本人、只放知识、图表（2026-11-12）

本人看了一批自动生成的页面后提的四件事，设计补在 docs/v2/wiki-verify.md 的第 9–12 类。

- 过程性和防御性语言：核对角色新增 `wording` / `hedge` 两类，逐句给出改后的句子；技能 wiki-writing 加了“整理过程、防御性的话：改写对照”表和自查项，要点取自开发用的表达检查技能里对知识页面适用的几条（整理过程、写给审稿人的话、退路、先立误解再推翻、冒号前的提示语、起手式），不改小标题编号、“这意味着”、句子长短。宿主不堆正则。
- 拿不准的不写进页面：`write_page` 加 `questions`（写作运行的草稿上，跨版本保留），核对角色的 `unsure` 带 `question`；页面里不留“待确认/还没查清”小节（技能、写作、distiller、`_common.md` 的案例页结构同步去掉）。一次生成结束把问题合成一张表单（`handler: wiki-questions`，不单独通知，链接在那条通知里），本人填了的按页面排一次 `generate_wiki` 的 `pages` 补进去。
- Wiki 只放知识：规划、写作、技能写清知识和流水记录的区别，核对角色新增 `log`；超过 6000 字的页面每轮由宿主自己记一条 length，发布前一定退回去拆。
- 图表：`write_page` 用 mermaid 自己的解析器在 Node 里检查语法（DOMPurify 补上不做事的方法），语法错的拒写并给出行号。网页上带箭头的流程图之前一张都没渲染：DOMPurify 删掉了值里含 `-->` 的 `data-mermaid` 属性，现在属性里放编码后的源码；`import("mermaid")` 失败不再缓存；画不出来的图显示原因、靠左的源码和“重试”；切页面时动态分块取不到（服务更新后）自动刷新一次，页面内后加载的部分取不到时提示刷新。
- 目标空间里同一地址的原件已经删除（只剩墓碑）时，移动仍被“已有同地址原件”拒绝：`moveSource` 和 `moveWorkFile` 现在让墓碑让位（清掉墓碑再移入），没删除的仍然拒绝。

## Wiki 未决问题：拿不准的点存在页面之外，先由 Agent 查，少量问本人（2026-11-12）

起因：真实使用的库上 784 页里 711 页带“还没查清”一类的小节或过程性、防御性语言，大多是旧模板要求的页尾一节。设计在 docs/v2/wiki-verify.md 第 5、6 节。

- 新表 `wiki_questions`（迁移加表，登记进 `pull-data.ts`）：按空间和页面存问题、为什么拿不准、引用、来源、状态、重要度、回答。`src/wiki/questions.ts`。页面移动时跟着走。
- `write_page` 的 `questions` 可以带 why 和 refs，不论是否在写作运行里都记进表；核对的 unsure 也进表。新工具 `settle_wiki_question`（wiki 分组，写作角色）。
- 处理顺序：写作运行先查这页挂着的问题；一次生成结束先排一次 `wiki-resolve`（最多 20 个）让 Agent 查，查不清的才问本人，一次最多 5 个（一张表单，其余留在清单）；回答后按页面写回，发布时关掉问题。
- 网页：页面右栏“未决问题”、目录上方入口和按页面分组的清单（回答、不用管、让助手先查、重新核对已有页面），只对有写 Wiki 权限的人显示；对应接口都要 `wiki.write`。
- 存量迁移 `src/wiki/migrate.ts`：升级后启动时排一次，按标题识别“还没查清”等一节，逐条拆成问题（保留引用），只删这一节、保留其余引用状态、Git 留历史；每批 200 页，可重入，进度记在 kv。正文中间的过程性语言不动，留给重新核对（`recheckPages`，一次 10 页、最多 50 页）。
- 约定和模板：wiki-writer、distiller、wiki-linter、`_common.md`、技能 wiki-writing 的“还没查清”都改成交 `questions`。
- 测试：`test/wiki-questions.test.ts`、`test/wiki-verify.test.ts`（假 Agent 的调查运行）。

## 2026-11-12：从个人空间归位不再占住服务

第一版的“现在检查”在一个真实大小的库上把服务卡死：`collectRecheck` 对几千个候选逐个算指纹，每个都对事项、记忆的 `source_refs` 做 `json_each` 全表展开、按 `json_extract(meta)` 扫整张 `sources`，全部在主线程同步执行；判断时每份原件还对 `lark_messages.content` 做 `like '%token%'`。

- 指纹按集合算：几条（分页）查询建出“原件 → 引用它的空间”“目录 → 已在的业务空间”“知识库 → 目标空间”，在内存里比对；一批原件的旁证一次算（`archiveEvidenceFor`）。
- 检查在后台跑，每 30 毫秒让出事件循环，同一时间一个，总时长上限 5 分钟，到了停下次接着；`POST /api/archive/homing/sweep` 立即返回，进度在 `kv.archive_sweep_progress`，网页显示进度和上次用时。
- 新表 `lark_doc_links`：采集消息时写入，已有消息由检查分批补（游标 `kv.lark_doc_links_backfill`）；“贴过它的群”只查这张表。
- 可达性检查按“读者 × 空间”算一次，分批让出；批量指定空间逐份让出。
- 迁移：表达式索引 `sources_wiki_parent`、`source_moves_source`、`source_routes_verdict`，表 `lark_doc_links`。
- 规模测试 `test/homing-scale.test.ts`（3000 份个人空间原件、12000 份其他、引用 20000、消息 60000）：一次检查从约 28 秒同步变成约 1 秒、主线程最长约 0.1 秒；一批 40 份的旁证从约 2 秒到约 0.06 秒。验收 26m–26o。
- 一对一私聊不再参与自动归位：真实使用里，放宽后的归属判断把十几个和同事、和机器人的私聊判成业务材料移进了业务空间，那个空间的成员就能读到。现在由宿主确定性地挡住（`archive.ts` 的 `isPrivateChat`：采集时不交给归属判断、不跟随同会话的旧判断，重判队列不收，`classify_source` 拒绝把它移到别的空间），只有本人手动、会话绑定或归档规则能移；`roles/archivist.md` 写明原因。

## 时间按本人时区显示（2026-11-12）

- 运行页“排队中：定时，… 开始”、唤醒列表、盯群到期、事项过期候选、编码交办里本人补充的时间等原来直接截 UTC 的 ISO 串，服务器在 UTC 时区时就显示成 UTC。现在统一用 `core/util.ts` 的 `localStamp(时间, config.timezone)`；交给模型转述的材料（会话列表、事项时间线、需求版本、复盘上下文、规则的讨论记录）也一样，规则讨论记录原来写死 +8，改为按配置时区。命令行输出按本机时区。
- 不变的：存进原件的聊天行时间（飞书、onebot 采集、会话日志）仍按 UTC 写，`notify-gate` 按 UTC 解析它们。
- 网页：原件归位“上次检查”、插件默认页的会话时间、运行页分支日期改用 `fmtTime`（浏览器时区）。
- Wiki 目录栏：空间名较长时顶部一行（名字 + 四个按钮）把目录栏撑宽、出现横向滚动条；现在名字缩成省略号，目录栏不横向滚动，右侧给滚动条留出位置；页面标题里很长的英文词会折行。

## 换 AI 后接着回、验证码等待、规则卡片、授权卡片、有人找你的条件（2026-11-12 晚）

- `switch_run_ai` 停下进行中的一轮另排新运行时，旧运行的 output 记 `replacedBy`；聊天渠道等这一轮回答的地方（`channels/common.ts`）跟到新运行，飞书收起旧气泡、给新运行开气泡。原来新运行做完没人发，飞书只看到“已终止”。
- 规则的“等某个会话的新消息”：飞书消息时间只到分钟，原来从触发的毫秒时刻起算，同一分钟里先到的验证码被滤掉。现在从触发那一分钟的开头再往前 1 分钟（`WAIT_LOOKBACK_MS`）起算，取符合条件的最新一条；等待时长仍从触发时刻算。
- 卡片点击：卡片没绑会话、但记着发它的 Agent 运行（规则的 Agent 在触发消息话题里发的卡片）时，同一个 Agent 带着原任务接着它的会话处理这次选择（`resumeAgentFromCard`），不再提示“找不到对应的会话”。
- 通知加 `tone`：`warning`（要本人去做的事，橙色）、`done`（办好了，绿色）；`notify` 工具可传，更新一张 warning 卡片时不传也按 done；宿主自己的飞书授权提醒用它，完成后改原卡片。
- 有人找你：`mentions.skipWhen.{read,reacted,replied}` 分别决定已读、回表情、回复算不算本人已处理（默认都算）。
- 问答页底部“等你回答”区的卡片不再被压缩（内容原来会溢出卡片框）。
- 豆包 CLI 只在整轮结束后输出回复，没有过程事件：运行期间宿主把它经 `omem tool` 调的每个 omem 工具同时记成过程步骤（`tool` 事件，`shellToolRuns`），思考气泡和运行页能看到它在调什么、成没成功；它自己的思考和本机 shell 命令仍看不到。给它的工具说明加了一句：说“没有工具”之前先 `omem tool help` 查（一次真实运行里它没调任何 omem 工具就说改规则的工具没开放）。
- 命令行后备的过程：`codex exec --json` 的思考摘要（reasoning）记成思考，命令、MCP 工具、改文件的结束状态（成功 / 失败）也记下；`claude -p` 的 `tool_result` 把对应工具标为完成或失败。原来两者都只有“开始”，工具一直显示进行中。
- 规则“分别回复”模式下的一波触发：已有同一规则的运行在排队时，新触发并进这个排队的运行（不并进正在跑的），它开始时一起处理，每条仍独立做完、分别回复，先处理最紧急的（`triggerNote` 的 separate 写法）。原来一条一个运行，报警连发时后面的要等前面的全部做完。
- 编码交办接上同一分支之前交办留下的修改项时，原来“在等本人”的那项由助手发起时先交给助手（`carryTasks` 的 `viaAssistant`），旧交办上那张卡片标为失效；拆修改项和交办任务的说明写明：挂回事项、写工作文件这类事归助手，不写成编码 Agent 的完成标准。
- 规则的“完全访问”不勾时跟随那个 Agent 自己的设置（原来不勾就一定在沙箱里，助手开了完全访问也不算）。
- `read_run` 加“过程”：每个工具步骤的结果、命令输出末尾（ACP `tool_call_update` 结束时留最后 3000 字）、omem 对权限请求的回答、运行结束时还没跑完的步骤。`_common.md` 写明权限请求由 omem 当场回答、没有要等的审批，醒来先看 `read_run` 的过程。
- 盯群预筛：配了决策模型时，盯群的每批消息先由它按盯群的目的（note）和群里的场景判断有没有助手能有效介入的事（不限于找本人的：替别人解答、查东西也算），不用看的不起完整运行，会话里留一条“预筛跳过”（`prefilterBatch`）；@ 本人或机器人的消息不筛，模型出错照常交给处理者。总开关 `lark.watchPrefilter`（默认开，设置 → 渠道 → 盯群），单个群用 `set_chat_watch` 的 `prefilter` 显式开关。
- 决策模型的材料：盯群预筛加上本人在这个盯群会话里说过的话、条件里点名这个群的规则（`rulesNaming`）、相关的记忆（含偏好和经验）、这一批之前的群聊和本人在这个群的习惯；“有人找你”的分诊加上点名这个会话的规则和 7 天内在这个会话里的处理结论。
- 访客提问的空间：开放给访客的业务空间（和群所在的业务空间）连同它下面的仓库一起可读，和成员权限一致；原来要把仓库单独加进去。
- 有人找你在群里回复对方时，正文里每个“@名字”都去群里核对成员，认得出的都换成真正的 @（原来只处理被回复的那个人，@ 第二个人时那个是纯文字）；对方本人只 @ 一次。

## 2026-11-13：远程浏览器占用与后台显示环境

- 长期资料也可勾选关闭占用它的浏览器；先结束同一人的旧远程会话，再把 `close_running` 交给 aad。浏览器启动失败时保留最初错误，只对没有安装的浏览器继续尝试。
- aad 配套修复：核对锁的主机、PID 和进程归属，关闭验证过的占用浏览器、清理确认已退出的本机进程锁；错误指出仍在运行但不匹配的 PID。本次浏览器启动失败和正常关闭也释放本次 PID 的残留锁。提前退出报告 stderr；Linux 窗口模式没有 DISPLAY 时在操作资料和关闭旧浏览器前拒绝。
- 后台服务显式保留启动终端的桌面环境与 `OMEM_TOOL_*` 程序；远程页提示无桌面环境并禁用显示窗口，无窗口浏览器仍可用。
- 验证：`LANGUAGE=C pnpm run check` 通过（230 个文件、1359 项测试）；最后的 PID 展示和服务环境改动另跑对应专项、类型检查与构建。真实 Edge 占用独立资料时核对旧 PID 退出，新浏览器可打开；同一资料关闭后立即重开、已退出 PID 的锁恢复、无 DISPLAY 时保留原占用浏览器均通过。网页在 1440 / 390 宽度可勾选关闭，无桌面时窗口模式禁用，无横向溢出。aad 的 CDP / CLI 测试与 Clippy 通过；MCP 原有的 `an_agent_can_keep_what_it_worked_out` 因 `secret_input must be savable` 失败，其他 MCP 回归通过。

- 机器人发到会话里的 Markdown 统一在 `sendLark` 里把“@名字”换成真 @（`setMentionResolver` → `lark-people.ts` 的 `realMentions`：先认这次对话里已知的人，再核对群成员；名字后面紧跟着字时按前缀核对；代码和邮箱里的 @ 不动；同一个人只 @ 一次）。原来机器人回答、话题后续、规则 Agent 回答、有人找你的回复各自处理，覆盖的人不同，常留下纯文字 @。
- 卡片也一样：新发的卡片和更新卡片（进度卡片收尾时写进回答）里每段 Markdown 的“@名字”都换成真 @；同一会话里核对过的名字缓存 10 分钟。

## 2026-11-13：一件事一条消息

- 有人找你的“草稿”档：`reply_to_asker` 只把草稿记在运行上（`mentionReply.pending`），处理结束时随提醒一起发（`notify` 的 `replyDraft`，飞书在同一张卡片里放提醒和可编辑的回复，`draftMentionReply` 带 `head`，点了之后提醒正文保留）；处理 `stay_quiet` 时草稿作废（`mentionReply.dropped`）；处理自己 `notify` 过时草稿单独一张卡片。原来草稿卡片一拟好就发，之后再来一条提醒，处理决定不提醒时草稿卡片也已经发出去了。夜里攒下的通知超过 3 条合成一张列表时，带草稿的仍单独发。
- `ask_user` 之后的回答：飞书上这一轮的回答紧跟在它自己还没回答的提问卡片后面、在同一个群，回答只是指向卡片（30 字以内）或四字片段有四成以上在问题里出现时，不另发，并进卡片里折起来的“这一轮的说明”（`foldIntoAsk`，卡片按钮仍绑在原来的交互上）。`ask_user` 的工具结果和 `_common.md` 也写明问完不要再写一遍。
- 编码交办停下后交给助手的那一轮：宿主已经发给本人的卡片和通知（`hostToldOwner`：这一轮的宿主提问、交办的通知）列进任务，汇报只写卡片上没有的，有这些卡片时可以 `stay_quiet`；同一会话里一个提到这一轮或这次交办运行 id 的唤醒在这一轮结束后汇报过，就不再起交给助手的那一轮（`reportedSince`）。
- 唤醒说明（`WAKE_NOTE`）：只有要本人做或决定的事、或者事情有了结果才写给本人，别人还在跟、排了下次复查这类进展记进事项后安静结束。

## 2026-11-14：远程页

- 去掉录制卡片上的“回放”和 `POST /api/remote/recordings/:id/replay`（本人不用）；录制转出的 `workflow.yaml` 仍随技能保存。
- 地址栏换页：aad 只对完整的页面快照放行输入，omem 只取 20 个节点，真实页面都被截断，`control_act navigate` 报 “truncated observation cannot authorize input”（回放先回起始页也卡在这里）。快照被截断时改用浏览器调试端口的 `Page.navigate`，等 `Page.loadEventFired`（`devtoolsNavigate`）。
- aad 的查看页连接断开后只显示“已断开”，不重连：远程页（同源）盯查看页的状态行，断开时按 1、2、4…秒（最长 30 秒，最多 8 次）重新 `view` 并重新加载查看页，会话已结束就去掉标签；地址栏旁（桌面会话在画面上方）加“刷新画面”。
- 过程气泡（`RunActivity`）：命令很长时“进行中 · N 步”和转圈被挤成一字一行；标签不换行、不收缩，只让命令那段截断。
- 录制整理成技能：请求按形态分出噪音（`src/remote/requests.ts`：资源类型、事件批次请求体、监控样子的路径和主机、不变的反复 GET），剩下的按“方法 + 主机 + 路径”合并、写操作在前；`read_recording` 概要列“调用的接口”，`part=requests` 默认不列噪音（`noise=true` 全列），steps 里也不列噪音请求。技能只带 `recording/requests.md`（`save_skill` 的 `recording_requests` 挑接口，不填时是去噪后的全部），不再带 `workflow.yaml` 和 aad 的完整操作说明。原来 `requests.md` 是录制的前 100 个原始请求：常驻服务器上一次 1152 个请求的录制，前 100 个里 63 个埋点、14 个扫码轮询、4 个预检，真正配置接口的请求一个都没进去。`skill-from-recording` 写明录制不是剧本，先从试错里找出真正完成这件事的步骤和接口。
- Windows 上找 aad：PATH 上只有 osdk 的 `aad.cmd` 垫片时，原来照样返回 `aad`，不经 shell 起进程报 ENOENT，而且这个错误没人接，整个 omem 退出。现在 Windows 上先找 PATH 上的 `aad.exe`，没有就用 osdk 安装目录里的（`exeOnPath`）；aad 起不来时请求返回“aad 没能启动”，`aad mcp` 已退出时后续请求立刻失败，不再等 30 秒超时。

## 2026-11-14：展示组件的版式、引用原件的排版

- 展示组件（`src/agents/ui-blocks.ts`）：新 `callout`（tone、title、text）；`metric` 加分组 `title` / `note`，每项加 `trend`、`good`、`note`、`spark`（`metricTrend` / `metricTone` 按 change 开头的符号判断方向、按 good 定好坏）；`chart` 加 `area`、`hbar`、`stack`、`goal`，饼图最多 8 块、不能有负数。
- 飞书卡片（`src/channels/lark-ui.ts`）：指标画成等宽分栏里的灰底块，结论是浅灰底的 `interactive_container`，只有图标库图标按语气着色，方案对比是并排的列；表格有表头样式、数字格式、宽表冻结首列；图表显式写 8 个系列色、细柱圆角、平滑折线、`markLine` 目标线，饼图把占比写进名字；卡片头只有结论是需要关注或故障时才是橙、红色，`config.summary` 写标题加结论（`buildCard` 的 `summary`）。
- 网页（`packages/plugin-sdk/blocks.ts`）：图表重画——整数刻度、一个轴一种写法、平滑折线和淡色面积、柱状整格高亮、横向条形、圆环饼图带合计、目标线、悬停提示列出所有系列、方向键逐个看；指标卡按个数排成整齐的几行，变化只给文字着色，带走势小折线；结论块是浅灰底、只有图标着色。系列色换成一套 8 个颜色（靛蓝、青、珊瑚红、琥珀……，从六套候选里选定），浅色、深色各一套、色相一致，按 omem 的面板做过色觉区分和对比度校验。`UiView.vue` 把组件里的 Markdown 交给 omem 自己的 Markdown 组件画。
- Agent 说明：`roles/_common.md` 和 `skills/omem/references/owner.md` 写了报告的顺序（先结论、再指标、再图表和明细）和图表类型怎么选；`show` 工具的说明同步。
- 原件页：带引用行号打开的文档（飞书文档、Markdown）不再退回原文行号，按排版显示并把引用的段落标出来、滚到中间；引用落在飞书的提示块或分栏里时整块标出，两边不留半个容器（`web/src/lib/cited-document.ts`，引用抽屉同样受益）。

## 2026-11-14：学本人怎么回、知识库的文档归位、表格与提示块、触发人、设置页

- 有人找你（`src/mentions/reply-learn.ts`，表 `reply_samples`）：每条进到这个流程的消息记一个样本——对方问了什么、助手拟了什么、本人怎么处置（照发 / 改后发 / 没发和原因）、本人之后自己在那个会话里回了什么或没回（`MentionChannel.ownerSaid`，飞书按 `lark_messages` 里本人的消息，24 小时内，带 `/ai` 署名的不算）。分诊材料多一行“本人以往回不回”（`habitLine`），处理运行的任务多一节“本人以往怎么回”（`replyHabits`：同一个人、同一个会话的例子在前）。草稿卡片的“不发”换成带原因的四个按钮（`DROP_REASONS`）；`reply_to_asker` 对远长于本人平时的回复拒一次（`typicalReplyLength`）。草稿档的说明改成“有能直接给对方的结论才拟，一两句”。设计见 docs/v2/mentions.md“学本人怎么回”。
- 知识库的文档归位（`src/sources/kb-home.ts`，表 `wiki_node_homes`，索引 `sources_wiki_space`）：知识库归入业务空间后，它的文档不管从哪个入口进来都落在那个空间——`prepareArchive` 对自动采集按它归属，`importLarkDocument` 对跟着链接读进来的文档按它落位（已有的未固定副本移过去）；本人手动移动过的不动（`pinned`）。目录可以单独归到别的空间（`setDirHome`，原件目录树的行菜单）。存量：`kbStrays` / `rehomeKb`（移动，目标已有同一篇就并成一份，`duplicates.ts mergeSources`），入口是知识库页的“收回”、`/api/lark/kb-home`、远程命令 `lark-kb-home`，每晚的归位巡检也先做这一步（`archive.autoMove` 开着且待归位的不超过 50 份时；更多的等本人点“收回”）。归入个人空间的知识库不适用。
- 文档排版（`web/src/lib/doc-layout.ts`）：`sizeTables` 给每张表按内容算列宽（文档带宽度时用文档的），比正文宽的在 `.table-wrap` 里横向滚动；`layoutCallouts` 把飞书高亮块排成图标在左、文字在右；`docBlocks` 把另一种导出格式（`<lark-table column-widths>`、`<quote-container>`、`<callout emoji>`）转成普通 HTML。`styles.css` 补了 `.doc-callout`、`.doc-grid`、`.doc-col` 的样式（之前没有）；采集时带上高亮块的颜色（`lark-docs.ts calloutColor`）。
- 虚拟列表（`web/src/components/VirtualList.vue`）：每次更新重新找滚动容器，滚动事件在 window 上捕获。之前只在挂载时找一次：面板当时还没溢出就认了窗口，之后在面板里滚动不再补行，下面留一大段空白。
- 运行的触发方式和触发人（`src/core/run-trigger.ts`，列 `runs.trigger` / `trigger_by`）：对话、访客提问、有人找你、规则、定时、同伴设备、成员操作；人是 omem 用户（`user:<id>`）、飞书上的人（`lark:<open_id>`）或别的机器人；创建运行时给出，或从输入读出，或沿用上一级运行的；定时任务的执行器里建的运行带上是哪个定时（`withTrigger`）。`GET /api/runs?by=` 按人筛选，`GET /api/runs/triggerers` 列近 30 天的人。运行页列表显示触发人，头部多“触发人”下拉。迁移回填了访客、有人找你和对话三类旧运行。
- 设置页（`web/src/views/Settings.vue`、`components/HelpText.vue`）：分类移到左边分组显示，右边是当前分类的卡片目录；长说明用 `HelpText` 收成一行，全文在 ⓘ 的悬浮层里。约定写进 `.agents/skills/omem-design`。
- 组网的名片与请教（`src/core/mesh.ts`，表 `peer_grants`）：`nodeCard` 按调用方给出这台有什么（本人设备全部，服务账号只有授权的），`refreshCards` / `startMesh` 每十分钟取配对节点的名片，`meshNote` 写进本人助手的常驻说明；`fedAsk` / `fedAnswer`（`/api/fed/ask`）让别的节点请教这台的 Agent（别人的服务问主助手时走访客角色，只读、限共享的空间、有每天次数），`askPeerAgent` 是 `ask_agent` 的 `<档案>@<节点>`，回答里的引用经 `peerRead` 落到本机；`consultAgent` 多了 `input` / `trigger` / `onStart`。设置 → 设备 显示名片、按对象开放 Agent。
- 借出 AI（`src/core/mesh.ts` 的 `lendAllowed` / `lentToday`，`src/server/http.ts` 的 `/api/peer/acp` 升级鉴权）：服务账号有 `ai:<后端>` 授权时可以打开这台的 ACP 后端，按连接计每天次数；名片的 `ai` 带剩余次数和 `as`（这台怎么看对方）。`/api/peers/:id/status` 读不到对方设置时用名片上的 `ai`。空间设置 `local`（仅本机）：`setShares` 拒绝，`runner.ts` 换后端顺序里跳过 `lentByOthers` 的后端。
- 镜像上的写入转给主（`src/core/mesh-write.ts`，表 `fed_outbox`）：`callTool` 在执行 `remember` / `supersede` / `forget` / `save_note` / `write_page` 前看目标空间是不是镜像（`forwardToHome`），是就把参数里的本机 id 换成主的 id、调主的 `/api/peer/tool`，再同步这个订阅；主连不上时进发件箱，`syncAll` 先 `flushOutbox`。`placementOf` 给出空间是主、仅本机还是镜像。
- 自动备份（`src/core/peer-backup.ts`，设置项 `backups`，定时任务 `peer-backup` 每 20 分钟）：到期的备份先问对方在不在（`/api/diag`），在就在子进程里跑 `omem peer pull <设备> --to <目录> --only … -y`，状态记在 `kv` 的 `peer_backup:<设备>`；`omem peer backup`、`/api/peer/backups`、设置 → 设备 的“自动备份”。`omem serve --no-background` 不启动定时任务、渠道和采集。
- 拉取的快照（`src/core/pull-snapshot.ts`）：`strip` 模式改成在一次读事务里按表拷进新库（`chunks` / `symbols` / `code_refs`、设备表、全文索引表只建空的），不再 `vacuum into` 整库；`since`（`PullSelection.since`、`/api/peer/snapshot?since=`）时 `sources` 和 `run_events` 只带那之后变过的，没带的原件写进 `pull_source_keys`，`prepareData` 用它补 id 映射。清单 `pull-manifest.json` 多 `takenAt` / `since`；`omem peer pull` 成功后把 `takenAt` 记在目标库 `kv` 的 `pull_since:<机器>`，下次减一小时作为 `since`，`--full` 不用。
- 向量紧凑存储（`src/search/vector-codec.ts`）：`pack` / `unpackInto` / `toFloats` / `isPacked`；`embedPending` 写入 `pack(v)`，`vectors.ts` 的 `push` 和 `sampleMatches` 两种格式都读（`quantize` 挪到 codec）；`packStoredVectors` 按分块 id 顺序每批 500 行改存（游标 `kv.vector_pack_cursor`，做完 `vector_packed = 1`），`main.ts` 启动 20 秒后每秒一批；迁移重建 `vector_log_update` 触发器，同一向量从 float32 改成紧凑格式不记变更。`omem db [status|vacuum]`。记忆的向量（`memories.embedding`）仍是 float32，条数少。
- docs/v2/mesh.md：组网运行（名片、问对方的 Agent、借 AI、按空间定主从与发件箱、租约）和助手的设计，各节写了实现到哪。
- 助手（`src/agents/assistants.ts`）：`lark.bots` 的机器人加 `userId`（谁的助手）、`name`、`description`、`dailyRuns`；`botSender` 把建机器人的人认成它的主人（成员），`botRoster` 写明是谁的助手；`overDailyLimit` 在 `inbox.receive` 里拦超过每天次数的轮次；`/api/assistants`；`AssistantsSettings.vue` 用在账号页（我的助手）和 设置 → 渠道（全部助手，替换原来的“其他机器人”列表），可以“用飞书创建机器人”（`scanNewAssistant`，`registerLarkBot` 的确认链接）或填已有应用。
