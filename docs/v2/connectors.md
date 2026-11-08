# 连接其他平台

omem 自己内置飞书。其他平台（Notion、GitHub、Google、Slack、Jira、钉钉、微信……）由内置插件 `plugins/connect` 接入。插件把平台分成两类：

- **身份**：平台能说清“这是谁”，用它的永久 id（GitHub 的数字 id、Google 的 `sub`、钉钉的 `unionId`）记进 `identities`。可以登录、绑定账号，同时也能读取。
- **能力**：只保管令牌或 key，用来读取和采集。不登录、不绑定，不写 `identities`；账号页只显示它连的是哪个账号或工作区。

两类用的是同一份平台描述，区别只在于有没有“我是谁”的接口（`plugins/connect/identities.ts`、`china.ts` 里的 `who`）。

## 平台从哪里来

- **Nango 的目录**：运行时读 npm 包 `@nangohq/providers`（Elastic License 2.0，作为可选依赖安装，没有复制进仓库；npm 源里没有这个包时安装照常完成，只是没有 Nango 目录里的平台），由 `plugins/connect/nango.ts` 转换。收录全部 OAuth 2 平台，以及用 API Key 或账号密码连接、内容能变成原件的平台（文档与知识库、聊天、邮件与日程、会议与转写、代码、项目与工单）。
- **国内平台**：Nango 没有，写在 `plugins/connect/china.ts`，有微信扫码登录、QQ 互联、微博、钉钉、抖音、Gitee、百度网盘、阿里云盘、语雀。这些是按各平台公开文档写的，没有用真实应用验证过。
- **不收的**：OAuth 1、客户端凭据（应用身份）、两步换令牌、签名请求（支付宝、腾讯会议、AWS）、Nango 的 MCP 服务器，以及模板里用到占位符以外写法的平台。启动日志会打出能连接的数量，和因写法不支持而跳过的数量。

目录里每个平台的差异都由通用引擎 `plugins/connect/engine.ts` 处理：

- 授权页参数，scope 分隔符，PKCE 开关。
- 换令牌时 client 凭据放 Basic 头还是请求体，请求体是 JSON 还是表单，用 GET 还是 POST，参数改名（`appid`、`client_key`、`clientId`）。
- 响应里令牌的位置（Slack 的 `authed_user`、抖音的 `data`），出错时返回 HTTP 200 加错误码的写法。
- 调接口时令牌放在哪里：默认是 Bearer，也可以是自定义请求头（钉钉）或 query（微信、QQ）。

## 主人要做的

设置 → 连接 → 其他平台（列表只画出看得到的行，滚动查看，可以按名字、用途、范围筛选）：

1. 搜到平台，点“设置”。
2. 在平台的开发者后台建应用，把这里给出的重定向 URL（`<网页地址>/api/auth/connect-<平台>/callback`）填进去。
3. 把 Client ID、Secret 和平台要求的站点、租户填在这里。这些值存在 `secrets/connector-apps.json`，不进 `config.json`、快照和拉取，网页上只显示 secret 的后四位（`src/auth/apps.ts`）。
4. “开放”给成员（`auth.connectors`）。第一次填好时会自动开放。能当身份的平台填好后会出现在 设置 → 成员 的登录方式里，可以勾选用来登录，也可以设成主要登录方。

用 key 连接的平台（标“填 key 连接”，约 160 个，都是内容能变成原件的平台）不用建应用，所以大多没有要填的设置，行上只有“说明”。开放之后，每个成员在自己的账号页填自己在那个平台生成的 API Key（或账号密码），保存前 omem 用平台的检查接口试一次；之后助手以他的身份读那个平台。不开放就不出现在账号页，也没有人能连。少数要填站点（如 Confluence 的子域名）的，由主人在“设置”里填。

默认只申请只读权限。Google 各产品、Jira、Confluence、Slack、Dropbox、GitLab、Linear 在 `plugins/connect/server.ts` 的 `READ_SCOPES` 里预置了读取用的 scope；其他平台由主人在“额外的权限”里按平台文档填写。Slack 用 `user_scope` 申请，拿到的是成员本人的令牌，不是机器人令牌。

## 读取与采集

插件带几个工具（分组 `connect`，说明在 `skills/omem/references/connect.md`）和一个 Agent 档案（`connect-collector`，技能 `platform-capture`）。主助手的工具里有 `group:connect`；这些工具标了 `whenConnected`，只有这次运行的人连了这个插件的某个平台（连接正常）时才给（`Tool.available`、runner 的 `dropUnavailable`），没连平台的人和运行看不到它们。插件没有自己的侧栏页面，直接问主助手；大批量采集交给 `connect-collector`：

- `connect_list`：本人连了哪些平台，各自的账号、接口地址和文档链接。
- `connect_request`：以本人的身份读接口。宿主带上令牌，只能发往这个平台的接口地址。GET 随便用；POST 只放行搜索、查询（最后一段路径含 search、query）、GraphQL query（不能是 mutation），以及少数已知只读的接口（Notion 的 search 和数据库查询，Dropbox 的列目录）。二进制内容不读，返回大小和类型。
- `connect_save`：存成原件，`uri` 是 `<平台>:<平台上的编号>`，同一个编号再存就是更新。原件的 `origin_key` 也取这个值，不同成员采到同一个平台对象时能认出来。空间按调用者能写的范围检查（`saveSourceFor`）。

没有平台包的平台，由 Agent 决定读哪些、怎么翻页、怎么拼正文。

## 平台包

结构复杂、又值得采集的平台，各有一个平台包（内置插件 `plugins/<平台>`）。平台包不管授权，授权仍用目录里的定义；它补三样东西：

- **功能**：每项对应要申请的 scope，替换目录里那一项笼统的“读取”。成员在账号页可以逐项打开。例如 Figma 拆成读设计稿、读评论、读项目和团队的文件列表。
- **读取器**：把平台上的一种东西读成 Markdown 原件。例如 Figma 文件读成“页面 → 画框”的大纲，带上画框里的文字和组件，评论挂在对应画框下。
- **增量**：容器类读取器（项目、仓库、频道、数据库）有 `changes`，列出某个位置之后改过的东西，并给出下一次的位置。

| 平台包 | 能读 | 能盯着（定时同步） |
|---|---|---|
| figma | 设计文件（页面、画框文字、组件、评论） | 项目、团队里改过的文件 |
| notion | 页面（块转 Markdown，含嵌套列表、表格、子页面链接） | 数据库、授权的全部页面 |
| github | issue 或 PR 和讨论、仓库里的文件 | 仓库里更新过的 issue 和 PR |
| google | 云盘文档（文档转 Markdown、表格转 CSV、幻灯片转文本）、Gmail 会话、日历日程 | 文件夹（三层以内）、Gmail 搜索条件、日历 |
| slack | 频道一天的消息（线程挂在原消息下，人名替换好） | 频道里有新消息的日子 |
| atlassian | Jira issue 和评论（ADF 转 Markdown）、Confluence 页面和评论 | JQL 搜索、Confluence 空间 |
| linear | issue 和评论 | 团队里更新过的 issue |

工具：

- `connect_read`：用读取器读一项，可以同时存成原件。
- `connect_watch`：盯着一项或一个范围。

盯着的记录在 `platform_watches` 表里：谁、哪个读取器、哪个对象、存进哪个空间、读到哪里。定时任务 `platform-sync`（每 20 分钟）按各平台包的间隔，用盯的人自己的连接把改过的读成原件，只写他能写的空间。一轮最多读 50 项，剩下的从最后一项的位置接着读；读失败时位置不前进，下次重试。成员在账号页看到自己盯着的内容，可以“立即同步”或“不再同步”。

原件的 uri 是 `<平台>:<类型>/<id>`，例如 `figma:file/K1`、`github:issue/acme/app#7`。它同时作为 origin_key，所以同一项不论被谁、用哪种方式采到，都认得出是同一个东西。

插件写平台包用 `api.platform({ provider, features, readers, syncMinutes, guide })`，见 docs/v2/plugins.md。

## 宿主为此加的

- 平台包：`src/plugins/platforms.ts`（注册表、盯着、同步），`api.platform` / `api.platforms` / `api.text.html`，`ctx.watches`；功能可以被平台包覆盖（`overrideFeatures`）。平台没返回授了哪些 scope 时，按申请的记（`auth_states.scopes`）。

- `LoginProvider`（`src/auth/providers.ts`）新增这些字段：
  - `identity: false`：能力连接器。
  - `credentials`：用 key 连接，带 `verify`。
  - `appFields`：主人要填的应用配置。
  - `apiBase` 可以是函数：接口地址依赖主人填的站点时用。
  - `sign`：令牌放在请求的什么位置。
  - `group`、`docs`：用途分组和文档链接。
- 授权流程方法 `authorizeUrl`、`exchange`、`whoami` 改为可选，用 key 连接的提供方没有它们。
- `canLogIn`：判断一个提供方能否登录、绑定；`offeredConnectors`：列出账号页可以连接的平台。
- 登录流程：能力连接器只接受 `connect`，回调时只存令牌，不调用 `bind`。
- 接口：`POST /api/auth/connections/:provider/credentials`（用 key 连接）、`PUT /api/auth/providers/:id/app`（主人填应用配置）；`GET /api/auth/providers` 和 `GET /api/auth/connections` 带上分组、身份、key 字段和配置项。
- 插件接口：
  - `api.appConfig(provider)`：读本插件连接器的配置。
  - `api.fetch`：宿主的 fetch，测试时可以替换。
  - 功能可以是函数：随主人的设置变化。
  - `ctx.saveSource`：插件工具存原件。

## 限制

- 一个人对同一个平台只有一条连接。Notion、Slack 这类按工作区授权的平台，连第二个工作区会替换第一个。
- 平台的站点、租户由主人统一填写。同一个平台的成员要在同一个站点上，例如同一个 Jira 站点。
- 用 key 连接的平台不确认身份，只当凭据用。
- 微信、QQ、企业微信要求回调域名备案，本机或局域网地址用不了。企业微信、腾讯会议、支付宝没有接入，它们要用应用身份或签名请求。
