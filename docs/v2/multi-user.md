# 多用户、权限与连接器

> 状态：六期都已实现（2026-11-05）。和下文不同的：连接的元数据也放在 `secrets/vault.db`；本人仍用 lark-cli 自己的登录；多维表格在 omem 里只存链接、不存内容，按读者分开存的是正文里带着别的文件内容（电子表格、同步块）的文档；向量按切块的正文和标题完全相同复用，不按块哈希。令牌接口、`user_info`、文档权限接口和 lark-cli 以成员身份调用，都用假凭据对真实飞书核对过返回格式和失败时的处理（失败是 `invalid_grant` 加错误码，坏令牌的 `user_info` 是 HTTP 200 加 `code`，lark-cli 被拒时是 `authentication` / `token_invalid`）；真正的授权登录、增量授权、刷新、lark-cli 以成员身份调用和权限判断的结果还要本人在真实租户上走一遍（acceptance.md 的第 1、3、6 期）。

要做四件事：

1. 别人用自己的账号登录 omem，先支持飞书；登录后在账号页“已连接的应用”里再连接别的平台。
2. 授权得到的令牌存下来，成为“连接器”：用来采集原件、给 Agent 调用，插件也能接新的平台。
3. 本人（owner）用“角色 + 权限”管住每个人能看什么、能改什么、能让 Agent 做什么。
4. 多个 omem 服务之间按选择共享内容，可以远端查询，也可以定时同步，不产生重复。

## 现状

代码里已经有的（`src/core/users.ts`）：

- `users`（owner / member）、`space_members`（reader / editor / owner）、`identities`（渠道 + 外部 id → 用户）、`api_tokens`（按用户发的令牌，设备配对也是一个令牌）。
- 大部分业务表带 `user_id`：会话、事项、记忆、卡片、运行、通知、插件记录。
- `accessibleSpaces` / `scopeFor` / `canWrite` 已经用在工具、检索和运行上；成员私聊机器人时会话进他自己的个人空间。
- HTTP：本机请求不带令牌就当本人；成员令牌只能访问 `MEMBER_ROUTES` 里列出的 6 类接口（`src/server/http.ts`）。
- 以本人身份用飞书的工具都经过 `ownerOnly`（`src/agents/tools.ts`），成员的运行用不了。

还缺的：

- 没有登录。网页靠本机信任，或手贴令牌（存在 localStorage）。
- 飞书的个人身份只有一份，就是 lark-cli 自己保存的那个登录。`lark-auth.ts` 的 scope 缓存是全局的，只能代表本人。
- 权限只有 owner / member 两档，成员能用哪些接口是写死的白名单。
- 设备配对发的是本人令牌，对端拿到全部权限；拉取按“空间 id + URI”对齐原件，两个人各自建的空间对不上。
- 采集时会沿用“这个聊天已有原件所在的空间”（`captureSpace`，`src/core/capture-space.ts`）。第二个人采集同一个单聊，会写进第一个人的个人空间。

## 先回答“会不会重复”

### 飞书消息

飞书的 id 分两类：

| 类别 | 例子 | 换一个人、换一个应用去读，是否一样 |
| --- | --- | --- |
| 对象 id | message_id `om_`、chat_id `oc_`、话题 `omt_`、文档 token、知识库节点 token、妙记 token | 一样 |
| 人的 id | open_id `ou_` | 每个应用不同 |
| | union_id `on_` | 同一开发者下的应用相同（企业自建应用就是同一企业） |
| | user_id | 同一租户内相同，要 `contact:user.employee_id:readonly` |

omem 现在按对象 id 存：结构化消息 `lark_messages` 的主键是 `message_id`，聊天原件的 URI 是 `lark:<chat_id>`，机器人收到的消息和 lark-cli 采到的消息已经落在同一行。换人读不会多出一条消息。

会出问题的地方在人的 id 和归属：

- 发言人和被 @ 的人记的是 open_id。机器人应用和 lark-cli 的应用不是同一个时，同一个人有两个 open_id，现在靠 `lark_people` 按邮箱对齐。所有用户都经机器人应用授权以后，新采集的 open_id 都在机器人应用的 id 空间里；跨应用比对改用 union_id。
- 一条消息只能属于一个聊天原件（`lark_messages.source_id` 是单值）。小王和本人的单聊，两人各自采集、各进各的个人空间时，同一条消息要出现在两个原件里。改法是内容存一份，行号放进关联表（见“多用户采集与去重”）。

### 同一篇文档

同一版本的文档，对所有有阅读权限的人内容相同，按 token 去重是安全的。例外有三种：

- 正文引用了读者没有权限的文档、表格或多维表格，这一块对他显示为无权限。
- 多维表格开了高级权限，不同人看到的行和字段不同。
- 知识库目录树，每个人能看到的节点不同（节点本身的内容不变）。

所以文档内容按 `obj_token` 存一份，“谁能看到”另外记；正文里带着别的文件内容（电子表格、同步块）的文档按读者分开存，不合并（omem 不存多维表格的内容，只存链接）。不同人在不同时间采集同一篇，留 `revision_id` 较新的那份（原件只保留最新版）。

### 多台服务之间

现在拉取按“空间 id + URI”对齐，两个人各自的服务里空间 id 不同。需要一个平台原生的身份：给原件加 `origin_key`（`lark:doc:<obj_token>`、`lark:chat:<chat_id>`……，见下文）。消息本来就按 message_id 存，会自然合并。

## 一、账号与登录

### 账号和身份分开

- 账号是 omem 自己的 `users.id`，不拿任何平台的 id 当主键。
- 身份是 `identities` 的一行：（提供方, 租户, 外部 id）→ 用户。一个账号可以有多个身份。
- 登录方（`auth.providers`）：本人在设置里打开的提供方。每个都能登录，也都能新建账号（新账号先进待批准，见“注册策略”）。
- 主要登录方（`auth.primary`，可以不设）：设了以后，从别的机器打开网页只能用它登录（飞书还包括机器人登录链接），其他提供方只能在登录后到“账号 → 已连接的应用”里绑定。本人会把飞书设为主要登录方。
  - 设主要登录方之前用别的提供方建的账号，下次用旧方式登录时只拿到一个受限会话，只能做“绑定飞书”这一件事，绑好以后恢复正常。
  - 要绑的飞书身份已经属于另一个账号时直接拒绝，交给本人处理（在成员页把它从那个账号解绑，或停用那个账号）。
- 不做账号合并，也不按邮箱或名字自动认人。两个账号是不是同一个人，只能靠同时证明控制了两边，猜错就会把别人的数据并进来。主要登录方设好以后，这种情况基本不会出现。

### 飞书身份

- 身份键用 `union_id` + `tenant_key`。机器人应用、lark-cli 的应用、`lark.bots` 里的其他机器人，看到的是同一个 union_id。
- 每个应用里的 open_id 记成这个身份的别名（`identities.kind = 'alias'`，带 `app_id`），`resolveIdentity` 按 open_id 查照样能命中。
- 第一次用飞书登录的人，如果 open_id 已经在 `identities` 里（存量的 `--lark ou_xxx`），或者等于 `lark.ownerOpenId`，直接认成那个账号，并补上 union_id。

### 登录方式

| 方式 | 用在哪 | 怎么做 |
| --- | --- | --- |
| 飞书 OAuth | 网页登录 | 授权码 + PKCE，用机器人应用的 App ID。回调地址 `<webUrl>/api/auth/lark/callback` 要先加进开发者后台的“重定向 URL”。回调是浏览器跳转，飞书服务器不会访问它，局域网地址也能用。 |
| 机器人登录链接 | 手机上，或者不想走授权页 | 私聊机器人“登录网页”，机器人回一张卡片，链接带一次性码（5 分钟有效、只能用一次、只认发消息的那个 open_id）。身份由飞书推来的事件本身证明，不需要 OAuth。 |
| 其他平台 OAuth | 没设主要登录方时用来登录和注册，设了以后只用来绑定 | 经连接器完成授权后，服务端拿令牌调这个平台的“我是谁”接口取身份，不信任浏览器传来的身份信息。 |
| API 令牌 | CLI、设备、外部 Agent | 现有的 `api_tokens`，不变。`omem peer invite` 配对的本人设备拿的是本人令牌，照旧当作本人。成员从自己的电脑用 CLI 和 MCP、鉴权插件（JWT）、按邮箱预建账号见 [remote-clients.md](remote-clients.md)（设计稿）。 |
| 本机访问 | 运行 omem 的那台机器 | 照旧：本机来的请求不用登录，当作本人。 |

**本机访问和本人设备保持现状。** 本机来的请求不用登录、当作本人（`trustedLocal`，`src/server/origin.ts`）；本人设备的配对令牌也当作本人。登录只给从别的机器打开网页的人用。

只补一处：打开多人登录（`auth.enabled`）后，经反向代理进来的请求不算本机。在同一台机器上放 nginx 或 Caddy 对外提供登录时，代理转进来的请求来源 IP 是 127.0.0.1；如果代理还把 Host 换成了上游地址（nginx 不配 `proxy_set_header Host` 时就是这样），外面的人不登录就成了本人。规则：带 `X-Forwarded-For`、`Forwarded`、`X-Real-IP` 任意一个的请求不走本机信任；`omem peer open` 的转发只加 `X-Forwarded-Host`，不受影响。部署说明里写明代理要传 `Host` 或 `X-Forwarded-For`。

### 会话

- 登录后下发 `omem_sid` cookie：HttpOnly、SameSite=Lax，https 下加 Secure。服务端只存哈希（`auth_sessions`：用户、创建 / 最近使用 / 过期时间、IP、UA、登录方式）。
- 30 天滑动过期。每个人在设置里能看到自己登录过的设备并逐个退出；本人可以踢掉任何人的会话；停用用户时他的会话全部失效。
- 非 GET 请求再查一次 Origin（沿用 `src/server/origin.ts` 的同源判断），防 CSRF。
- 从别的机器登录的网页不再把令牌存进 localStorage，粘贴令牌的入口留给旧用法。事件流、图片、下载会自动带上 cookie，不再需要 `?token=`。

### 注册策略

`auth.signup` 按提供方设置，默认 `approve`（本人已选）：

- `approve`：第一次登录的人进入“待批准”，本人在成员页批准并选角色，批准时通过机器人通知他。批准之前他只能看到“等待批准”。
- `closed`：只有本人建过或邀请过的人能登录。
- `open`：直接以默认角色（viewer）进入。

飞书企业自建应用只有本企业、并且在应用“可用范围”里的人能授权，企业外的人用不了飞书登录。主要登录方是飞书时，要给企业外的人用，本人可以在他的账号上打开“允许用其他登录方”（`users.settings.loginAny`，只对这一个账号生效），或者直接给他一个 API 令牌。

邀请：本人在成员页生成邀请链接（只能用一次，可以预设角色和空间，7 天有效），对方用主要登录方登录（没设主要登录方时用任一登录方；邀请上勾了“允许用其他登录方”时也可以）就建好账号，不用再批准。

### 绑定

绑定，指已经登录的状态下连接一个新的提供方：

1. 回调拿到身份 X。
2. X 还没归属：绑到当前账号。
3. X 已经属于当前账号：只更新令牌。
4. X 属于另一个账号：拒绝，提示“这个账号已经对应另一个 omem 账号，请联系本人”。本人在成员页能看到每个身份绑在谁身上，可以解绑。

解绑主要登录方的身份要本人操作；解绑以后这个账号就只剩受限会话（只能重新绑定）。

## 二、角色与权限

### 模型

- 权限是一个动作，分两层：全局权限（和空间无关）和空间权限（对某个空间生效）。
- 角色是一组权限，也分两层：全局角色（每个用户一个）和空间角色（每个空间成员一个）。
- 某人在空间 S 上有权限 P，当且仅当他的全局角色带 `P@*`（所有空间），或者他在 S 的空间角色带 P。
- 本人（owner）有全部权限，不能改角色、不能删、不能停用，系统里至少有一个 owner。
- 个人空间只属于空间主人。给其他人分配这个空间的角色会被拒绝，邀请也不能指定个人空间。要让成员共同读写，请把内容放在共享空间后授予读者、贡献者或编辑者角色。
- `@*` 不包括别人的个人空间。只有 owner 能看所有人的个人空间（现在就是这样），这一点在每个人的“设置 → 账号”里写明。
- 只做授予，不做“禁止”型权限，判断规则保持简单。
- Wiki 不做页级权限，要分开看的内容就分到不同空间。

### 权限清单

全局：

| 权限 | 说明 | 默认给 |
| --- | --- | --- |
| `users.manage` | 用户、角色、邀请、批准、身份解绑 | owner |
| `settings.manage` | 渠道、AI 后端、系统设置 | owner |
| `peers.manage` | 设备配对、对外共享、订阅 | owner |
| `agents.manage` | Agent 档案、技能、规则、定时任务（这些全库共用） | owner、admin |
| `spaces.create` | 新建空间（建的人是这个空间的 manager） | admin、member |
| `runs.read.all` | 看所有人的运行 | owner、admin |
| `code.delegate` | 交办编码和评审（在宿主机上跑命令） | owner |
| `desktop.control` | 操作桌面（aad） | owner |
| `connector.use:<provider>` | 能连接哪个平台 | member 及以上：lark |
| `share.external` | 生成对外分享链接 | member 及以上 |

AI 后端和额度暂时不限制，成员的运行用本人配置的后端和任务选型；Linux 上装了 bubblewrap 时，成员可以登录自己的 AI 账号，他的运行就在沙箱里用他自己的账号，本人按后端定没登录的成员借用本人的还是不能用，见 [agent-accounts.md](agent-accounts.md)。`code.delegate` 和 `desktop.control` 只给本人，原因是它们在宿主机上动手，与额度无关。以后要按后端限制时，再加 `agent.backend:<id>`。

空间：

| 权限 | 说明 |
| --- | --- |
| `space.read` | 检索，读原件、Wiki、记忆、事项 |
| `source.write` | 导入、移动、定级、标注原件 |
| `wiki.write` | 写页面、整理 Wiki |
| `memory.write` | 写记忆（个人偏好类记忆只写在自己的个人空间） |
| `capture.route` | 把聊天和文档的采集指到这个空间 |
| `runs.read` | 看这个空间里别人的运行 |
| `space.manage` | 成员、空间设置、空间关联、SPACE.md |

### 内置角色

全局角色：

- owner：全部。
- admin：所有空间的 manager，加上 `agents.manage`、`spaces.create`、`runs.read.all`；没有 `settings.manage`、`peers.manage`、`code.delegate`、`desktop.control`，也不能改 owner。
- member：`spaces.create`、`connector.use:lark`、`share.external`。
- viewer：只能读被加入的空间，可以提问，不能写。
- pending：待批准，什么权限都没有。

空间角色：

- reader：`space.read`
- contributor：reader + `source.write`、`memory.write`
- editor：contributor + `wiki.write`、`capture.route`、`runs.read`
- manager：editor + `space.manage`

现有的 reader / editor / owner 迁成 reader / editor / manager。本人可以复制内置角色，改成自定义角色（`roles` 表存权限列表）。

### 成员能力

| 全局能力 | 成员可以做什么 | 成员预设 |
| --- | --- | --- |
| `remote.view` | 看授权给他的远程会话 | 默认关闭 |
| `remote.operate` | 操作授权给他的远程会话 | 默认关闭 |

还需会话主人或本人发给该成员的同模式授权。期限和接口见[把会话交给成员](remote.md#把会话交给成员)。

事项和运行入口使用 `ownSpaceCaps`（含自己的对象），共享范围使用 `spaceCaps`。两份范围都随成员能力接口和 `/api/me` 返回。

`GET /api/capabilities` 返回各能力的中文名称、说明、区域、动作、作用域和预设。角色的旧权限仍用于目录以外的操作。网页只读观察者（`observer`）默认可在可读空间阅读工作线、事项、原件、规则、运行、编码、评审和指标，也能提问并查看自己的对话和通知。观察者的个人空间默认只读，项目的显式空间角色只叠加目录内映射的能力（成员接口返回 `spaceRoleGrants: catalogOnly`）。记忆和 Wiki 写入仍受旧权限限制。观察者可回答或关闭自己对话里的普通追问，带批准或其他动作的卡片继续受限。

#### 设置区域

设置分为知识（`knowledge`）、助手（`assistant`）、AI（`ai`）、渠道与协作（`channels`）、成员（`members`）、安全（`security`）和系统（`system`）。每区分别授予 `settings.<区域>.view` 和 `settings.<区域>.edit`。本人预设拥有全部；管理员沿用成员管理和 Agent 管理所覆盖的区域；协作者和观察者默认不读写设置。成员、安全和系统三区的 edit 只能由本人逐个授予。

- 打开设置时取 `GET /api/settings/sections`。返回的 `sections` 按区域列出 view 和 edit，`keys` 标出配置键及跨区子键，较具体的路径优先。例如 `agents.accounts` 属于成员区，`agents.autoAdvance` 属于助手区。按 view 显示标签，按 edit 开放编辑。对其他成员，`ownerOnly` 清单内的字段始终只读。
- 切换区域时取 `GET /api/settings?section=knowledge` 等。省略 section 返回全部可读区域；无可读区域时返回 403。配置在 `config` 中。服务令牌不返回，成员也读不到包含账号环境变量的 Agent 档案。
- 成员读取设置时省略 `notify.outlets` 和 `notify.outletAskGrants`。出口设置经 `/api/notify/outlets` 读写。
- 保存时向 `PUT /api/settings` 提交配置键，支持整区回传。只要有一项实际变化越权，整份更新返回 403；成功写入后可在审计记录按 `settings.update` 查看操作者、区域和改动键名。
- 本人身份回复（含豆包发送）、登录与对外访问、对等设备、账号隔离、启动命令及操作规则由本人管理。操作规则与网络策略仍使用各自的专用编辑接口。

成员管理沿用 `settings.members`，旧权限 `users.manage` 也提供这项能力。`settings.members.edit` 只用于修改成员区设置。列表、邀请、停用和能力覆盖统一按操作者与目标检查。给普通成员授权时只能转授自己在相应范围内拥有的能力。管理者不能借此修改本人或管理员、重置登录身份，或转授上述三个区域的 edit。成员页应按目标隐藏这些操作。

#### 设置标签的接口

下表的路径均以 `/api` 开头。普通成员通过区域能力读取状态。原来的 `settings.manage` 提供 AI、渠道、知识、系统区域的查看与编辑，`agents.manage` 提供助手和 AI 区域的查看与编辑。显式拒绝优先。本人专属配置及对应操作见 `src/auth/settings-sections.ts` 的 `ownerControls`。

| 接口 | 区域 | 原权限 → 现权限 | 成员响应 |
| --- | --- | --- | --- |
| GET ai、agent-registry、agents/:id/adapter | AI | settings.manage → view | 模型列表、提供方和密钥尾号。适配器省略路径、源地址和错误。公开注册表沿用原字段 |
| GET agents/load | AI | agents.manage → view | 当前负载和近期统计，省略账号额度 |
| GET plugins、plugins/:id；PUT plugins/:id/settings、plugins/:id/icon | AI | 读仍对登录用户开放，写由 settings.manage → edit | 列表、详情和改图标响应保留展示字段和权限摘要。服务清单和服务命令返回空数组，省略本机目录。插件偏好属于当前用户 |
| GET lark/bot-check、desktop | 渠道 | settings.manage、desktop.control → view | 机器人的缺失权限及事件。桌面工具返回安装状态 |
| GET lark/captured、lark/wiki-crawls | 知识 | settings.manage → view | 采集会话只列有权查看原件的最近 500 条，返回 chatId、name、spaceId、kind、lastMessageAt。爬取省略入口、错误和队列细节 |
| GET search/providers | 知识 | settings.manage → view | 提供者标识、名称、插件和延迟 |
| GET storage、media；POST storage/scan | 知识 | 原路由 settings.manage，处理函数限本人 → view / edit | 扫描时间、数据库与文件分类统计。省略目录、文件明细、日志。媒体返回工具状态和配置 |
| GET agents、mentions | 助手 | agents.manage → view | 档案的名称、说明、状态与模型。提醒返回用量，私人回复统计省略 |
| GET、PUT agents/:name | 助手 | 沿用 agents.manage | 详情与保存返回列表摘要。成员在档案页可改用途（`description`）和状态（`status`），后端、模型和强度只读。提交其他字段返回 403 |
| GET roles、roles/:name | 助手 | 沿用 agents.manage | 列表返回名称和说明。详情另含默认 AI（`defaults.agent` 和 `defaults.byBackend` 下的模型、强度）。角色正文、专属记忆、复盘建议、技能正文、用量和历史仅本人可读 |
| POST roles/:name/customize | 助手 | 沿用 agents.manage | 成员收到 `{ ok: true }`，本人收到自定义原文 `raw` |
| GET、PUT library-files/agent/:name | 助手 | agents.manage → 本人 | 档案原文含 MCP 和工作目录，成员请求返回 403。技能原文沿用 agents.manage |
| GET schedules、replays；PUT schedules/:id | 助手 | agents.manage → view / edit | 定时任务按空间过滤，省略运行参数，成员可改周期和启停。复盘返回状态和汇总 |
| PUT agent-role-model；GET review-settings、review-options，PUT review-settings | AI / 助手 | 已按对应区域 view / edit 授权 | 角色模型配置与评审表单沿用原字段 |
| GET auth/providers | 成员 | users.manage → view | 登录方式和回调地址，省略应用配置和诊断信息 |
| GET diag | 系统、设备 | settings.manage → 本人 | 整机诊断含私有失败运行、路径和对等设备地址，成员请求返回 403 |
| GET spaces、spaces/:id | 知识 | 登录及空间读取权限延续 | 空间列表省略仓库路径和内部设置，仅列可读空间 |
| 对等设备、外部访问、出网、操作规则、AI 账号和密钥、后端安装及插件信任 | 对应区域 | 专用管理权限或本人 → 本人 | 成员不接收凭据、启动命令或设备连接资料 |

实时读取本人的聊天、扫码授权、触发全局任务、复盘采纳、仓库目录操作和删除原附件会使用个人身份或改动全局资源。这些动作保留原操作权限或限本人。单独授予查看某一区域时，网页按表中的读接口渲染卡片。

#### 进度视图

运行和事项的 progress 接口加 `?summary=true` 后返回 `{ views, totalUsage }`。旧调用继续取得数组，页合计也在响应头 `X-Omem-Total-Usage`。独立评审运行计入评审块，共用编码宿主时，该轮用量归页面上的编码块。直接评审已有分支且没有编码块时，首轮用量归评审块。任务和尝试是明细，可以共用一次运行。页合计按实际展示的块去重，缺报运行计入 `missing`。

任务的 `href` 可用于跳转。修改项使用 `task`，阶段、方向、试验分别使用 `stage`、`direction`、`trial` 查询参数，页面需按参数展开对应条目。尝试上的 `local` 表示本机，`device` 是显示名。阶段证据的 `target` 含 `kind`、`id` 和 `title`，仅返回请求者可读的引用。

#### 工具和外部连接

成员从助手运行、`omem tool`、`omem mcp` 或远程 MCP 连接调用工具时，目录和执行都受发起成员的能力限制，还须满足运行的角色清单和空间范围。某个空间的显式拒绝优先于预设和允许项。已有连接上遇到权限拒绝应停止这次操作。主助手只能续办当前成员有操作权的自己的工作。专用档案和临时助手的下一轮沿用发起成员和本轮空间限制。

成员用 `agents.view` 读取技能、查看 Agent 档案和 AI 后端选项。普通成员默认有这项全局只读能力，观察者可单独授权。修改技能和档案仍需 `agents.manage`。

写操作按目标检查。下表里的路径都以 `/api/` 开头。

| 区域与动作 | 路由 | 原先 | 现在 |
| --- | --- | --- | --- |
| 原件 · 标注、调整单份关注程度 | `POST sources/:id/notes`、`PUT sources/:id/attention`、`POST source-notes/:id/review`、`DELETE source-notes/:id` | 路由标了 `sources.edit`，处理函数只让本人操作 | 来源空间的 `sources.edit` 和这份原件的阅读权限。成员标注记为 member，本人标注仍受保护 |
| 原件 · 整批调整、目录定级和复核 | `POST sources/attention`、`PUT sources/node-level`、`POST sources/node-level/review` | 处理函数只认本人 | 路由也标明本人专用。一次操作可能涉及目录内受限原件 |
| 事项 · 编辑内容及关系 | `PUT items/:id/parent`、`POST/DELETE items/:id/materials…`、`POST/DELETE items/:id/objects…`、`POST items/:id/split-requirements` | 调整上级仅本人可用，其他入口按登录身份先拦观察者 | 检查本人事项的 `items.edit`；调整关系还检查新旧上级。外部对象动作、拆需求保留各自的目标权限 |
| 助手 · 查看评审设置 | `GET review-settings`、`GET review-options` | 交办编码权限 | 只需 `settings.assistant.view` 即可从侧栏或 `#/agents?tab=review` 打开表单。持有 Agent 管理权的人从 Agent 页的“评审”进入。`GET settings?section=assistant` 提供表单用的模型选项。交办人从 `GET review-tiers` 取档位 id、名称和检查数 |
| 助手 · 编辑评审设置 | `PUT review-settings` | 交办编码权限 | `settings.assistant.edit` |
| AI · 修改角色模型 | `PUT agent-role-model` | 全局设置权限 | `settings.ai.edit`，读取模型配置另需 view |
| 远程 · 查看、导航 | `POST remote/sessions/:id/view`、`POST remote/sessions/:id/navigate` | 观察者先被通用写请求检查拦下 | 按会话所有权或有效授权决定；受托者需匹配的能力，导航需操作授权 |
| 流程 · 推进实例 | `POST/DELETE items/:id/flow…` | `flows.operate` 和事项归属 | 同前。修改共用流程定义仍限本人 |
| 运行 · 取消、重试、删除产物 | `POST runs/:id/cancel`、`POST runs/:id/retry`、`DELETE runs/:id/artifacts/:artifact` | `runs.operate` 和运行范围 | 同前。代码交办、Git 与发布操作另需原权限 |
| 规则 · 编辑 | `POST/PUT/DELETE rules…` | `rules.edit` | 同前。以本人身份发消息及启用规则的确认仍单独检查 |

跨空间移动原件会改变读者范围，批量归档还会改动多个空间；这些操作保留专用管理入口。工作线收尾可能同时关闭多个子事项，仍由本人处理。

升级前已有自定义角色使用 `observer` 时，系统为原角色换一个空闲标识，保留其权限、成员和邀请，再将 `observer` 用于内置预设。

具有 `settings.members` 的人可用 `GET /api/members/:id/capabilities` 查看预设、覆盖和有效权限来源。PUT 替换整份配置，省略的旧覆盖会撤销。例如：

```json
{
  "preset": "observer",
  "overrides": [
    {"capability":"runs.view","scope_kind":"space","scope_id":"project-a","effect":"deny"}
  ]
}
```

按空间授权始终要求成员可读该空间。全局覆盖适用于所有可读空间。全局和单空间的拒绝都优先于允许。操作事项限于自己的事项，操作他人的运行还需要旧权限 `runs.read.all`。运行记录检查该运行读取过的全部空间。成员的覆盖调整与审计在一个事务内保存。

`GET /api/me` 的 `caps` 用于全局入口，`spaceCaps` 用于各空间的入口。事项和运行详情的 `can` 给出当前对象的 `edit` 与 `operate`。规则只读视图提供名称、说明、触发类型和动作类型。

### 成员的线

事项链路的分组、计数和按事项读取的指标、指标工作文件沿用同一个可见子树。隐藏事项下面即使有同空间的子项，也不计入结果。

工作页对成员和观察者和本人是同一个页面，内容按人过滤（`src/items/member-work.ts`）：

- **哪些线**：自己的线（在自己能读自己事项的空间里），加本人放在有“看工作线”的空间里的线。别人个人空间里的线、别的成员的线不给。不另设“给谁看”：按线所在的空间和成员的空间角色。
- **线下面**：每件事项按它自己的空间和归属判断。自己的事项照给；本人的事项要在“看工作线”的空间里、对它有“看事项”，并且不是候选、等待、稍后。一件看不到，它下面的也看不到。看不到的不出现，也不算进变化条数、今天几条、观察中挡着的数。
- **整条线的文字**：现状一句、人、每周一句、线自己的下一步、收尾小结和结束原因，是对整条线写的，可能提到看不到的事。线下只要有一件看不到，这些都不给（`partial`），页面在现状的位置写“这条线有一部分你看不到”，只列能看的事项各自走到哪；按已结束的线搜索时也不按小结匹配。“需求到交付”和“数据”按整条线汇总，这时页面上也不显示。
- **能做什么**：有“改事项”的成员可以把自己的事项建成线、往线下挂自己的事项、写下一步（`POST /api/work/:id/next`），有“更新进展”的可以改阶段、“就这么做 / 不用”、“对我没用”。别人的线（包括同一空间里本人的线）都是只读，接口一律 403。
- **例行整理**：每天看线写现状和下一步、跟进群里的新内容、结束后的收尾都会起模型。成员的线默认不跑；成员在 账号 → 线的例行整理 打开（本人可以 `PUT /api/work/routine {"on":true,"user":"<id>"}` 替他开），并且他登录了自己的 AI 账号、这台机器能把成员的运行隔开时才排。这些运行带 `ownAccountOnly`，运行器只用成员自己的账号，不会借本人的登录（`src/items/member-routine.ts`、`src/agents/runner.ts`）。条件不够时不排，原因写在他的工作页上。成员自己点“更新”“就这么做”同样只用他自己的账号。
- **等我的**：右栏是他自己的待处理：他的提问和审批、他自己事项的流程阶段、候选、提议的更新和指标；档案、技能、草稿这些只属于本人的不出现。`GET /api/work/today` 是“今天”对他的内容，页面顶上可以展开；这一期不给成员发早上的卡。
- **流程**：不是自己的事项，阶段条和说明写“等 小王”，只有事项本人能定的块不出现。

### 助手替本人向成员要进展

`ask_member_progress(item_id, member, question)`（`src/items/member-progress.ts`）：只有本人的运行能用；对方要读得到这件事（工作页上的线，或对这件事有“看事项”），观察者不能问。默认先给本人一张确认，本人点了才发；本人这一轮在自己的消息里明确要问的直接发（和 `lark_invite` 同一个判断）。每次发出写 `audit_events`（`member-progress.ask`）。

提问归对方：在他的“等我的”里；他绑定了飞书时，omem 的机器人私聊他一张卡（用机器人身份，不用本人身份）。同一件事对同一个人还有没答的，再问是改那一条。他的回答原样经 `recordChange` 记成这件事的一条变化（来源“成员回答”，键是这条提问，重放不重复），在不急的通知里告诉本人；他选“现在说不了”的，三天内不再问他同一件事。

### 原件级可见性

默认情况下，空间成员能看到空间里的全部原件。这和现在本人把文档放进空间的做法一致，结果可预期。

需要收紧时有两种办法：

- **把单个原件设为受限**（`sources.visibility = 'restricted'`）：只有 `source_viewers` 里的人和空间 manager 能看到。用在“一段单聊被放进了项目空间”这种情况。检索、`read_source`、引用解析、分享快照都按它过滤。
- **空间设置“按来源权限过滤”**（只针对飞书文档）：读者打开原件、或者展开一条引用时，用读者自己的飞书连接问飞书“我对这篇有没有阅读权限”，结果缓存一天；没连接飞书的人看不到这类原件。适合整个知识库镜像进来、但里面权限参差不齐的空间。检索结果列表里只显示标题，正文要通过这个检查才给。

由原件派生的 Wiki 和记忆跟随所在空间的权限，不逐条追溯原件权限，写进共享空间的派生内容本来就是给空间成员看的。为此共享空间里的 Wiki 不能引用受限原件：`write_page` 发现引用了受限原件就拒绝，并说明原因。

### 运行记录

- 自己的运行总能看。
- 别人的运行，要在这条运行能读的**每个**空间里都有 `runs.read`（或者有 `runs.read.all`）才能看全文，否则只能看到标题、状态、耗时和用量。运行的事件里可能有它读过的任何空间的内容，只核对运行所在的那一个空间不够。运行建立时把 `scopeFor` 的结果记进 `runs.scope`，判断用它。
- peer-agent、规则、定时任务产生的运行，归建立规则或任务的那个人。

### 在哪里检查

1. **HTTP 路由声明权限。** 每个路由带 `config: { perm, space? }`（space 是从参数或 body 里取空间的函数），由一个 preHandler 统一判断，`MEMBER_ROUTES` 删掉。`test/route-perms.test.ts` 遍历全部 `/api/` 路由，要求每个都声明了权限；分享链接、登录回调这类公开路由显式标 `public`。网页版 VS Code（`/ide`）只给有 `code.delegate` 的人。
2. **工具声明权限。** 按 `TOOL_GROUPS` 给每组一个默认权限（`read` → `space.read`，`curate` → `memory.write` / `wiki.write`，编码交办 → `code.delegate`……），个别工具再覆盖。`scopeFor(app, userId, requested, perm)` 加一个参数，返回用户有这项权限的空间。建立运行的工具清单时就去掉用户没有权限的工具，不要等调用时才报错，免得 Agent 反复尝试。内置插件带来的工具（connect、各平台包；`src/auth/tools.ts` 的 `setPluginToolCapabilities`，加载时登记、卸载时去掉）按调用者自己算：只读的要“提问”（`ask.send`），会写入的要在本次运行的空间里有“改原件”（`sources.edit`），保存时宿主照旧按空间再核对。数据目录里装的插件是本人为自己信任的代码，在 omem 进程里运行时能做 omem 能做的一切，它的工具只给本人；平台对象的动作（`object-actions` 组）也只给本人。既不在覆盖表、也不是插件工具、也不在任何分组里的工具只给本人。
3. **以谁的身份调用外部平台。** 成员有 `connector.use` 权限时可用 `lark_read` 和文档的读取、新建、编辑、移动、复制工具。调用由 `asLarkUser` 绑定到发起成员自己的飞书连接。缺连接或缺授权时给他授权链接，关掉功能时提示他重新打开。共享文档按该成员的批准执行。本人的运行沿用本机 lark-cli 登录。`lark_write`、`lark_invite`、目录长期授权和文档工具的机器人身份仅供本人的运行。
4. **后台任务。** 规则、定时任务、做梦、复盘都带 `user_id`，按建立者的权限运行；本人建的照旧能用全部空间。
5. **审计。** 角色、空间成员、身份绑定、连接、共享的变化写进 `audit_events`（谁、什么时候、改了什么），在设置 → 成员里能看到。

### 界面

- 设置 → 成员：用户列表（角色、状态、最近登录、绑定的身份）、待批准、邀请、身份解绑；角色页（内置角色只读，自定义角色按权限分组勾选）。
- 空间设置 → 成员：加人、选空间角色、是否按来源权限过滤。
- 设置 → 账号（每个人都有）：自己的资料、登录设备、已连接的应用、API 令牌。
- 运行页、原件页、Wiki 里没有权限的部分显示“无权查看”，不显示成空列表。和加载中一样，“没权限”不能看起来像“没有数据”。

## 三、连接器

### 模型

- **提供方（provider）**：一个平台的接入定义，包括授权方式、换令牌和刷新、“我是谁”、功能与 scope 的对应、能提供哪些能力。
- **连接（connection）**：某个用户在某个提供方上的一次授权，包括账号、已授予的 scope、令牌、状态。一个用户在一个提供方上通常只有一个连接，同一平台多个账号以后再说。
- **功能（feature）**：用户看得懂的开关，每个开关对应一组 scope。现在 `lark-auth.ts` 里的 `USER_FEATURES` 就是它的雏形。
- **能力**：连接能用来做的事，包括登录、采集原件、给 Agent 的工具、给插件的 API 调用。

### 令牌保管

- 令牌不进主数据库，放在 `secrets/vault.db`（单独的 SQLite，权限 0600），按连接 id 存 AES-256-GCM 密文，密钥在 `secrets/vault.key`。连接的元数据（提供方、账号、scope、状态、到期时间、最近一次错误）也放在这里：连接本来就只属于这台机器（`src/auth/vault.ts`）。
- `secrets/` 本来就不进快照，也不随拉取同步，所以连接只存在于建立它的那台服务上。别的服务要用这个人的平台能力，只能请这台服务代办（见“多服务连接”）。
- 刷新：调度器里一个任务，访问令牌到期前 10 分钟刷新；刷新令牌离过期不到 2 天时也主动刷新一次来续期。同一个连接的刷新串行执行（进程内锁），新令牌先写进 vault 再使用。飞书的刷新令牌只能用一次，刷新之后没存住就只能让用户重新授权。
- 刷新失败（被撤销、已过期）：连接标为“需要重新授权”，通知这个用户（机器人私聊卡片，附重新授权链接），相关采集暂停，不反复重试。
- 解除连接：删掉令牌，平台有撤销接口就调用，停掉这个连接的采集。已采的原件保留，用户可以选择一并删除。

### 飞书提供方

- 用机器人应用的 App ID 和 Secret（`lark.appId`，Secret 在 `secrets/lark.json`）。
- **scope 可以按需申请。** 授权页地址的 `scope` 参数写这一次要的权限（空格分隔）；用户同意后，新的 user_access_token 包含他此前授予过的全部权限，也就是增量授权。所以：
  - 登录只要基本身份信息（open_id、union_id、名字、头像），要邮箱再加 `contact:user.email:readonly`。要在后台采集还得加 `offline_access`，否则拿不到刷新令牌；只登录、不采集的人不用加。
  - 用户在“已连接的应用 → 飞书”里打开某个功能时，再跳一次授权页，只带这个功能的 scope。登录页也可以勾几个功能（默认不勾），在登录的同一次授权里一起要（加上 `offline_access`）；新账号仍要等批准，批准前不采集、不用。
  - 授权只增不减：之后少勾、或只登录不勾，飞书给的令牌照样带着以前授过的全部权限；撤销要在飞书里取消对这个应用的授权。所以 omem 自己再记一份“关掉的功能”（账号页的开关，存在用户设置 `featuresOff`）：关掉的不采集，对应的工具拒绝并说明，飞书那边的授权不动；再打开立即恢复。2026-11-06 在真实租户上看到：本人之前给这个应用授过的 183 项权限，在只要身份的登录里全部回到了令牌里。
- **前提是 scope 已经在开发者后台为应用开通。** 没开通的 scope，用户授权时会遇到 20027 错误；企业租户里有的权限还要管理员审批、发版后才生效；一次授权最多 200 个 scope。所以开发者后台一次把所有功能用到的 scope 都开好（`lark-setup.ts` 的 `user` 清单已有消息、文档、日程、妙记、会议，表格和多维表格还要补），给用户的授权再按功能分几次要。
- 刷新令牌约 7 天有效（以返回的 `refresh_token_expires_in` 为准），只能用一次；授权码 5 分钟有效，也只能用一次。
- 功能与 scope 的初版对应（实现时以 lark-cli 每条命令要求的 scope 为准）：

| 功能 | 用途 | scope |
| --- | --- | --- |
| 登录 | 身份 | 基本信息不需要 scope；邮箱 `contact:user.email:readonly`（可选） |
| 后台访问 | 拿刷新令牌 | `offline_access` |
| 我的消息 | 采集自己的单聊和群聊 | `im:chat:read` `im:message:readonly` `im:message.group_msg:get_as_user` `im:message.p2p_msg:get_as_user` `im:resource` |
| 文档与知识库 | 读正文、搜索和采集最近打开的文档、浏览知识库与云盘目录、读取素材 | 正文 `docx:document:readonly` `docs:document.content:read`。搜索 `search:docs:read`。知识库 `wiki:node:read` `wiki:wiki:readonly` `wiki:node:retrieve` `wiki:space:retrieve` `wiki:space:read`。云盘及素材 `space:document:retrieve` `drive:drive.metadata:readonly` `drive:file:download` `docs:document.media:download` `board:whiteboard:node:read` `docs:permission.member:auth`（下载前核对当前用户的导出权限） |
| 表格与多维表格 | 读电子表格、多维表格 | `sheets:spreadsheet:read` `sheets:spreadsheet.meta:read` `base:app:read` `base:table:read` `base:field:read` `base:record:read` `base:view:read`（飞书现在的细分权限，旧的 `sheets:spreadsheet:readonly`、`bitable:app:readonly` 新应用申请不到） |
| 日程 | 采集日程 | `calendar:calendar:read` `calendar:calendar.event:read` |
| 妙记与会议 | 妙记、入会事件 | `minutes:minutes:readonly` `minutes:minutes.artifacts:read` `vc:meeting.meetingevent:read` |
| 让助手写文档 | 新建、编辑、移动和完整复制文档 | 读取操作对象 `docx:document:readonly` `wiki:node:read` `wiki:node:retrieve` `wiki:space:read` `drive:drive.metadata:readonly`。新建、编辑和插入素材 `docx:document:create` `docx:document:write_only` `docs:document.media:upload` `wiki:node:create`。移动、复制 `wiki:node:move` `wiki:node:copy` `space:document:move` |

- 「文档与知识库」会和其他功能一样带上 `offline_access`。已有旧版文档授权的成员若缺 `search:docs:read`，可在账号页重新打开这一项。已经能采集的连接可以继续按其现有权限使用。
- 成员请求完整复制知识库文档时，先核对读节点、读知识库和复制所需权限。只勾选「让助手写文档」即可申请这些权限。最近文档搜索与后台采集需要另选「文档与知识库」。同一轮发现还缺权限时，在原私聊卡片补上。

- **继续用 lark-cli。** lark-cli 可以从环境变量取应用和用户令牌（`LARKSUITE_CLI_APP_ID`、`LARKSUITE_CLI_USER_ACCESS_TOKEN`，1.0.98 里有；这时它的 `auth` 命令不能用），所以现有的采集、`lark_read`、`lark_write`、文档读写不用重写。做法是一个异步上下文：为某人做的事放在 `asLarkUser(app, 用户, …)` 里（`src/auth/lark-user.ts`；每次工具调用都这样包着），里面的 `larkCli` 就注入这个人的令牌（`lark-cli.ts` 的 `larkActor`）。本人照旧用 lark-cli 自己的登录。缺 scope（`LarkScopeError`）时：本人照旧收到设备码链接，别人收到“到账号页授权这一项”的通知（`asOwner` 里按上下文分开）。个人文档库这类缓存按人分开。
- 本人的 lark-cli 现在可能指向另一个应用，open_id 和机器人应用不同。迁移时提示本人把 lark-cli 也换到机器人应用（`lark-setup.ts` 已经支持），或者直接用飞书登录 + 连接代替 lark-cli 登录。

### 授权代理：飞书内置，长尾平台可选 Nango

Nango 的情况（2026-11 查证）：

- 许可证是 Elastic License 2.0：源码公开，自用和自托管可以，不能当托管服务卖给别人。
- 免费自托管只有 **Auth 和 Proxy**；Syncs、Webhooks、Actions、RBAC 等要企业版。
- 部署方式：免费自托管只有 Docker Compose（在一台虚拟机上 `docker-compose up -d`）；Helm（Kubernetes）和 BYOC 属于企业版。没有不用 Docker 的官方部署方式。
- 要跑的东西：Postgres（凭据、配置）、Redis（缓存、刷新令牌的锁、限流），以及 Server、Orchestrator、Jobs、Runner、Persist 五个 Node 服务；日志界面另外要 Elasticsearch 或 OpenSearch（可选）。
- 官方目录里没查到飞书 / Lark，要用的话得自己加提供方定义。

omem 需要的正好是 Auth + Proxy，同步、调度、索引本来就由宿主自己做，所以 Nango 免费版适合给长尾平台保管令牌。飞书是核心，要和 lark-cli 注入、增量 scope、机器人身份绑在一起，放进 Nango 反而多绕一层。

> 2026-11-07：长尾平台已经由内置插件 `plugins/connect` 接入，用的是 Nango 目录的数据（npm 包 `@nangohq/providers`），没有部署 Nango 服务，见 docs/v2/connectors.md。下面是当时的考虑。

**现在不部署 Nango**（本人已定）：它要 Docker 和一整套服务，比 omem 本身还重。先只做内置 broker，接口留好；以后接 GitHub、Google 这类平台时，单个平台的 OAuth 用内置 broker 写一个提供方定义就够，平台多到值得时再考虑 Nango。接口设计成：

```ts
interface AuthBroker {
  /** 开始授权：返回浏览器要打开的地址（内置：平台的授权页；Nango：Connect 会话）。 */
  begin(user: string, provider: string, scopes: string[], returnTo: string): Promise<{ url: string; state: string }>;
  /** 授权完成（回调，或 Nango 的 webhook）：返回连接。 */
  complete(state: string, params: Record<string, string>): Promise<Connection>;
  /** 当前可用的访问令牌，必要时先刷新。 */
  accessToken(connectionId: string): Promise<string>;
  revoke(connectionId: string): Promise<void>;
}
```

- `builtin`：omem 自己做 OAuth（授权码 + PKCE + state；state 存 `auth_states`，10 分钟有效、只能用一次），令牌放 vault。飞书走这个。
- `nango`：配置 `connectors.nango = { url, secretKeyEnv }`。`begin` 建 Connect 会话（end user 是 omem 的用户 id）；`complete` 拿到 connectionId，存进 `connections.broker_ref`；`accessToken` 向 Nango 取，刷新由 Nango 负责，令牌不落 omem 的库。
- 每个提供方在配置里选 broker。飞书默认 builtin；其他平台在没配 Nango、也没有插件注册时不显示。
- 不管哪种 broker，“我是谁”都由服务端拿令牌调平台接口得到。

### 插件扩展

插件清单加一项 `connectors`：

```yaml
connectors:
  - provider: github        # 内置的，或别的插件注册的提供方
    features: [repo-read]   # 用到的功能；用户没授权时，插件页提示去连接
```

- 插件服务端用 `api.connector({...})` 注册新的提供方（授权地址、换令牌、我是谁、功能与 scope）。公司内部系统的提供方只能这样写在数据目录的插件里，不进仓库（AGENTS.md：内部系统只进技能和数据目录）。
- 插件工具里 `ctx.connection("github")` 返回 `{ account, scopes, fetch(path, init) }`。`fetch` 由宿主带上**当前运行用户**的令牌发出，插件拿不到刷新令牌；没有连接时抛出一条看得懂的错误。走 Nango 的提供方，`fetch` 经 Nango Proxy 发出。
- 采集类插件写原件仍然走宿主的 `upsertSource`，必须给 `origin_key`，目标空间按用户权限校验。

### 文档采集的范围（2026-11-24）

- 每人一份：`users.settings.larkCapture.docs`（成员读不读最近打开的文档；没设过按打开算，和这项出现之前一样）和 `larkDocs`（`skipLibrary`、`exclude`）。本人的总开关仍是 `lark.capture.recentDocs`，不再管成员的。
- 排除项按链接认：`/docx|docs|doc/<token>` 单篇，`/wiki/<token>` 页面连同子页面（沿父节点往上找），`/wiki/space/<id>` 整个知识库，`/drive/folder/<token>` 文件夹（往下列五层、两千篇，半小时内复用）。个人文档库用 `my_library` 查到的空间 id 认，成员默认跳过，本人默认不跳。
- 生效范围：最近打开的文档、它们按层数跟随的链接和子页面（`ImportOpts.skip`），以及本人聊天里出现的文档链接。读不到节点信息时不跳过，按原来的方式读或失败。本人让助手读的、规则和监听指定的不受影响；已入库的不删。
- 登录页和账号页的连接链接可带 `capture=docs,group,p2p`：只对这次勾了的功能写入，存在 `kv` 的 `auth_capture:<state>`，授权回来时取一次（`src/auth/login.ts`）。

### 多用户采集与去重

1. **`origin_key`。** 原件加一列平台原生身份（不唯一，建索引）：

| 原件 | origin_key |
| --- | --- |
| 飞书文档、知识库页 | `lark:doc:<obj_token>`（知识库节点先换成 obj_token，`wiki_nodes` 里已有对应关系） |
| 带着电子表格、同步块内容的文档 | `lark:doc:<obj_token>#<用户>`，按读者分开；检索合并时去掉 `#` 后面的部分 |
| 聊天 | `lark:chat:<chat_id>`（历史归档的 `@YYYY-MM` 不变） |
| 会议、妙记、日程 | `lark:meeting:<id>`、`lark:minute:<token>`、`lark:event:<event_id>` |
| 网页 | 规范化后的 URL |
| 代码 | 远端地址 + 路径 |
| 上传的文件 | 内容哈希 |

`unique(space_id, uri)` 保留。docx 链接和 wiki 链接指向同一篇文档的重复（`sources/duplicates.ts`），以后在写入时就能按 origin_key 对上。

2. **采集前先查。** 用户 B 要采集某个对象时，如果 B 能读的某个空间里已经有同一 origin_key 的原件，就不再建一份，只在 `source_viewers` 里记上 B（附上 B 确实能在飞书里看到它的证据）。只有 B 要放进的空间里没有、而且 B 能写这个空间时，才新建。

3. **采集进哪个空间。** `captureSpace` 只能选采集者有 `capture.route` 的空间；“这个聊天已有原件所在的空间”只有在采集者能写它时才沿用，否则进采集者自己的个人空间。

4. **聊天。**
   - `lark_messages` 继续按 message_id 存一份内容。
   - 行号挪到新表 `lark_message_lines(message_id, source_id, line)`。同一条消息可以同时出现在小王个人空间和本人个人空间的两个聊天原件里，各有各的行号。
   - 一个群同一时间只由一个连接采集（`lark_cursors` 加 `capturer`）。机器人在群里就用机器人收到的事件，否则用第一个订阅这个群的人的连接。别人再订阅同一个群时，只要他能读原件所在的空间，就只登记为读者，不重复拉取。采集者断开连接时交给下一个订阅者。
   - 单聊各采各的，两边都进自己的个人空间。

5. **文档。** 按 origin_key 只读一次，记下 `revision_id`，没变就不再拉；不同人读到的版本，留较新的那份。带着别的文件内容的文档按读者分开存，不合并。成员的日程、妙记和最近打开的文档同样先查：他能读的共享空间里已有同一 origin_key 的，只记 `source_viewers`。

6. **向量。** 同一内容出现在两个空间时只算一次：切块的正文和标题完全相同、已经有向量的，直接复制（`chunks_text_head` 索引按长度和开头 80 个字找）；同一批里相同的输入也只算一次。

7. **检索。** 同一个 origin_key 的几份副本（各人的聊天副本、镜像、按读者分开的文档）只显示排名最高的一份，其余列在 `elsewhere`（工具输出“同一个聊天或文档另有 N 处”）。读者看不到的副本先去掉再合并，不会让他能看的那份被藏起来。

## 四、多服务连接

### 两种对端

| | 本人的设备（现状） | 别人的服务（新增） |
| --- | --- | --- |
| 配对码里的令牌 | 本人的令牌 | 一个服务账号的令牌 |
| 能做什么 | 全部：远程命令、拉快照、外部 Agent | 只能做共享授权里写明的事 |
| 同步方式 | 整库快照，手动 `omem peer pull` | 按空间订阅，增量同步 |

服务账号是 `users` 里 `kind = 'service'` 的一行，不能登录网页，没有个人空间，名字取对端的节点 id。它的权限是一个只有 `space.read` 的全局角色，加上共享授权。现有的 `peer:<label>` 本人令牌照旧代表本人的设备。

### 共享授权

```bash
omem peer invite --for 小王的服务 --share project-a:query --share handbook:sync:wiki,memory
```

`peer_shares`（服务账号, 空间, 模式, 内容类型）：

- 模式：`query`（只能远端检索和读取），或 `sync`（还能订阅变更）。
- 内容类型：`wiki`、`memory`、`source`（可以再细分 `doc`、`chat`、`code`……），默认 `wiki,memory,doc`，不含聊天。没共享的类型对端拿不到，引用到它时显示“原件未共享”。
- 受限原件，以及“按来源权限过滤”的空间里的飞书文档，一律不发给其他服务。
- 网页：设置 → 设备与共享，按对端列出共享了什么、最近一次被访问、撤销。

### 远端查询

- 订阅为 `query` 的对端会出现在检索范围里（检索框和 Agent 的 `search` 参数都能选）。本机检索时并发向这些对端发 `POST /api/fed/search`，超时 3 秒，结果带上对端标签后合并排序；某个对端不在线就跳过，并在结果里标出来。
- 对端只返回片段和元数据：标题、origin_key、更新时间、对端的原件 id。
- **引用时落地。** Agent 或用户引用一条远端结果时，宿主把引用的那几行连同少量上下文取回来（和分享快照的做法一样），存成本机的一个镜像原件（`meta.mirror = { peer, remoteId }`，带 origin_key），引用照常写 `src:<本机 id>`。这样不用新增引用格式，派生内容也总能回到本机打得开的原件；要看最新内容时再去对端打开。

### 定时同步

- 服务端：一张按节点自增的变更表 `change_log(seq, entity, entity_id, space_id, op, at)`，原件、页面、记忆、事项写入时追加一行（页面在 `writePage` 里写，其余用触发器）。这就是 architecture.md“多台设备”一节里预留的变更日志。
- 订阅端：`peer_subscriptions(peer, remote_space, local_space, kinds, schedule, last_seq, derive)`。调度器按 `schedule` 调 `GET /api/fed/changes?space=&since=<seq>` 分页拉取，服务端按共享授权过滤。
- 本机的镜像空间（`settings.mirror`）是只读的：本机用户可以读、引用、标注，不能改正文。对端删除时本机留墓碑。
- 镜像是单向的，不会出现两边同时改同一条。本人自己的两台设备都要写的双向同步，仍按 architecture.md 里的方向另外做。

### 怎样不重复

- 原件按 origin_key 对上。镜像来的飞书文档和本机自己采的是同一篇时：在同一个空间里只留一份，另一份做别名（已有 `source_aliases`）；在不同空间里各留一份，检索结果按 origin_key 合并，显示“另有 N 处”。
- 消息按 message_id 合并，`lark_message_lines` 记各自的行号。
- 镜像原件默认**不再交给 ingest 整理**（`derive: false`）。对端已经整理过，记忆和页面会一起同步过来，本机再整理一遍就会产生重复记忆。只镜像原件、没有共享记忆时，可以打开 `derive`。远端来的记忆带 `origin_node`，本机的做梦和记忆复核不去改它；本机写的新记忆可以用 supersede 更正它。
- id：远端原件的 id 在本机登记为别名（已有 `pull_aliases` / `source_aliases`），远端页面里的 `src:<远端 id>` 能解析到本机的镜像原件。

### 令牌和对外动作只留在本节点

- 平台令牌只存在于建立连接的那台服务上。远端查询和同步传的是内容，不传令牌。
- 采集、发消息、刷新令牌，只在持有连接的那台服务上做。用户在 A 服务上连接了飞书，就由 A 采集；B 服务要他的数据，就订阅 A。

## 五、数据表变化

| 表 | 变化 |
| --- | --- |
| `users` | 加 `kind`（person / service）、`status`（active / pending / disabled）、`email`、`avatar`；`role` 改为引用 `roles.id` |
| `roles` | 新表：id、名字、层级（global / space）、权限列表、是否内置 |
| `space_members` | `role` 改为空间角色 id（reader / contributor / editor / manager），owner 迁成 manager |
| `identities` | 加 `tenant`、`kind`（login / alias）、`app_id`、`display`、`verified_at`；`channel` 列沿用为提供方 |
| `auth_sessions`、`auth_states`、`invites` | 新表 |
| `connections` | 新表，只有元数据；令牌在 `secrets/vault.db` |
| `sources` | 加 `origin_key`（建索引）、`visibility`；新表 `source_viewers(source_id, user_id, evidence, at)` |
| `lark_messages` | `source_id` / `line` 挪到 `lark_message_lines`，旧列保留一段时间做兼容读取 |
| `lark_cursors` | 加 `capturer` |
| `runs` | 加 `scope`（运行能读的空间） |
| `audit_events` | 新表 |
| `peer_shares`、`peer_subscriptions`、`change_log` | 新表 |

新表里的业务数据加进 `pull-data.ts` 的清单。`auth_*`、`connections`、`peer_*` 属于本机，不参与拉取。

## 六、分期

每一期单独可用，按顺序做：

1. **登录与会话**：`auth_sessions`；登录方与主要登录方（`auth.providers` / `auth.primary`，受限会话只能绑定主要登录方）；飞书 OAuth 登录（只要基本信息）；机器人登录链接；邀请与待批准；经反向代理的请求不走本机信任；网页登录页和“设置 → 账号”。`identities` 升级（union_id、别名），存量用户和本人自动认领。本机访问和本人设备的配对令牌不变。
2. **角色与权限**：`roles` 和权限清单；路由声明权限并加测试；工具按权限裁剪；`scopeFor` 带权限参数；运行 `scope` 与可见性；成员与角色页；审计。删掉 `MEMBER_ROUTES`。
3. **连接器与飞书多用户**：vault；`AuthBroker` 的内置实现；飞书提供方与功能开关；lark-cli 按用户注入令牌；`asRunUser` 代替 `ownerOnly`；按用户采集（修正 `captureSpace`、`capturer`、`lark_message_lines`、`origin_key`、`source_viewers`）。
4. **插件连接器**：清单里的 `connectors`、`api.connector`、`ctx.connection`。Nango broker 先不做。
5. **多服务连接**：服务账号与共享授权；远端查询与引用时落地；变更日志与订阅；按 origin_key 去重。
6. **收尾**：受限原件、按来源权限过滤。

## 七、已定（2026-11-05）

1. 任何打开的登录方都能新建账号；可以设一个主要登录方，设了以后只能用它登录，其他提供方只用来绑定。本人用飞书作为主要登录方。
2. 新账号进入待批准。
3. 空间里的飞书文档默认对空间成员可见；“按来源权限过滤”是空间的可选设置。
4. AI 后端和额度暂时不限制；交办编码和操作桌面只给本人。成员用自己的 AI 账号见 [agent-accounts.md](agent-accounts.md)。
5. 不部署 Nango（免费自托管只能用 Docker Compose，还要 Postgres、Redis 和五个服务），只留 broker 接口。
6. 本人能看所有人的个人空间（保持现状），在成员的账号页写明。
7. 不做账号合并。绑定时身份已属于另一个账号就拒绝，交给本人解绑。
8. 本机访问不用登录、当作本人；`omem peer invite` 配对的本人设备当作本人。都保持现状，只加“经反向代理的请求不算本机”这一条。

## 八、需要实测

- lark-cli 用 `LARKSUITE_CLI_USER_ACCESS_TOKEN` 时，`--as user` 的命令（消息、文档、知识库）是否都能用，它的 scope 检查是否按这个令牌计算。
- 同一个日程在组织者和参会人那里的 event_id 是否相同；不同的话，日程的 origin_key 要换。
- “判断当前用户对某云文档是否有某项权限”接口的返回格式和限流。
- 飞书刷新令牌连续续期有没有总时长上限。
- union_id 在本企业多个自建应用之间（机器人应用、lark-cli 的应用、`lark.bots`）是否确实一致。
- 登录接口返回的基本信息（open_id、union_id、名字、头像）是否确实不需要额外 scope。

## 参考

- 飞书开放平台：[获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)（scope、增量授权、PKCE、`offline_access`）、[获取 user_access_token](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)（刷新令牌只能用一次、`refresh_token_expires_in`）。
- Nango：[自托管说明](https://nango.dev/docs/guides/platform/self-hosting)、[定价](https://www.nango.dev/pricing)（免费自托管只含 Auth 与 Proxy）、[仓库](https://github.com/NangoHQ/nango)（Elastic License）。
