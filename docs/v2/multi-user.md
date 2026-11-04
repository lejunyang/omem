# 多用户、权限与连接器

> 状态：第 1 期（登录与会话）已实现（2026-11-05），其余在做。按文末“分期”一段一段做，每段过 `pnpm run check` 后提交，并同步 README、architecture.md 的实现状态表和 acceptance.md。

要做四件事：

1. 别人用自己的账号登录 omem，先支持飞书；登录后在设置里再连接别的平台。
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

所以文档内容按 `obj_token` 存一份，“谁能看到”另外记；开了高级权限的多维表格按读者分开存，不合并。不同人在不同时间采集同一篇，留 `revision_id` 较新的那份（原件只保留最新版）。

### 多台服务之间

现在拉取按“空间 id + URI”对齐，两个人各自的服务里空间 id 不同。需要一个平台原生的身份：给原件加 `origin_key`（`lark:doc:<obj_token>`、`lark:chat:<chat_id>`……，见下文）。消息本来就按 message_id 存，会自然合并。

## 一、账号与登录

### 账号和身份分开

- 账号是 omem 自己的 `users.id`，不拿任何平台的 id 当主键。
- 身份是 `identities` 的一行：（提供方, 租户, 外部 id）→ 用户。一个账号可以有多个身份。
- 登录方（`auth.providers`）：本人在设置里打开的提供方。每个都能登录，也都能新建账号（新账号先进待批准，见“注册策略”）。
- 主要登录方（`auth.primary`，可以不设）：设了以后，从别的机器打开网页只能用它登录（飞书还包括机器人登录链接），其他提供方只能在登录后到“设置 → 已连接的应用”里绑定。本人会把飞书设为主要登录方。
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
| API 令牌 | CLI、设备、外部 Agent | 现有的 `api_tokens`，不变。`omem peer invite` 配对的本人设备拿的是本人令牌，照旧当作本人。 |
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

AI 后端和额度暂时不限制，成员的运行用本人配置的后端和任务选型。`code.delegate` 和 `desktop.control` 只给本人，原因是它们在宿主机上动手，与额度无关。以后要按后端限制时，再加 `agent.backend:<id>`。

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
2. **工具声明权限。** 按 `TOOL_GROUPS` 给每组一个默认权限（`read` → `space.read`，`curate` → `memory.write` / `wiki.write`，编码交办 → `code.delegate`……），个别工具再覆盖。`scopeFor(app, userId, requested, perm)` 加一个参数，返回用户有这项权限的空间。建立运行的工具清单时就去掉用户没有权限的工具，不要等调用时才报错，免得 Agent 反复尝试。
3. **以谁的身份调用外部平台。** 现在 `ownerOnly` 保证只有本人的运行能以本人身份用飞书。改成 `asRunUser(ctx, "lark")`：用发起这次运行的用户自己的飞书连接；他没有连接就返回 403，并告诉 Agent“请用户在设置里连接飞书”。**不能**回落到本人的 lark-cli 登录，否则成员可以借 Agent 读本人的文档。写入规则不变（只放行 lark-cli 标为 write 的命令，不在用户自己的文件里时先经批准），批准人从“本人”换成“这个用户”。
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

- 令牌不进主数据库，放在 `secrets/vault.db`（单独的 SQLite，权限 0600），按连接 id 存 AES-256-GCM 密文，密钥在 `secrets/vault.key`。主库的 `connections` 表只存元数据：提供方、账号、scope、状态、到期时间、最近一次错误。
- `secrets/` 本来就不进快照，也不随拉取同步，所以连接只存在于建立它的那台服务上。别的服务要用这个人的平台能力，只能请这台服务代办（见“多服务连接”）。
- 刷新：调度器里一个任务，访问令牌到期前 10 分钟刷新；刷新令牌离过期不到 2 天时也主动刷新一次来续期。同一个连接的刷新串行执行（进程内锁），新令牌先写进 vault 再使用。飞书的刷新令牌只能用一次，刷新之后没存住就只能让用户重新授权。
- 刷新失败（被撤销、已过期）：连接标为“需要重新授权”，通知这个用户（机器人私聊卡片，附重新授权链接），相关采集暂停，不反复重试。
- 解除连接：删掉令牌，平台有撤销接口就调用，停掉这个连接的采集。已采的原件保留，用户可以选择一并删除。

### 飞书提供方

- 用机器人应用的 App ID 和 Secret（`lark.appId`，Secret 在 `secrets/lark.json`）。
- **scope 可以按需申请。** 授权页地址的 `scope` 参数写这一次要的权限（空格分隔）；用户同意后，新的 user_access_token 包含他此前授予过的全部权限，也就是增量授权。所以：
  - 登录只要基本身份信息（open_id、union_id、名字、头像），要邮箱再加 `contact:user.email:readonly`。要在后台采集还得加 `offline_access`，否则拿不到刷新令牌；只登录、不采集的人不用加。
  - 用户在“已连接的应用 → 飞书”里打开某个功能时，再跳一次授权页，只带这个功能的 scope。
- **前提是 scope 已经在开发者后台为应用开通。** 没开通的 scope，用户授权时会遇到 20027 错误；企业租户里有的权限还要管理员审批、发版后才生效；一次授权最多 200 个 scope。所以开发者后台一次把所有功能用到的 scope 都开好（`lark-setup.ts` 的 `user` 清单已有消息、文档、日程、妙记、会议，表格和多维表格还要补），给用户的授权再按功能分几次要。
- 刷新令牌约 7 天有效（以返回的 `refresh_token_expires_in` 为准），只能用一次；授权码 5 分钟有效，也只能用一次。
- 功能与 scope 的初版对应（实现时以 lark-cli 每条命令要求的 scope 为准）：

| 功能 | 用途 | scope |
| --- | --- | --- |
| 登录 | 身份 | 基本信息不需要 scope；邮箱 `contact:user.email:readonly`（可选） |
| 后台访问 | 拿刷新令牌 | `offline_access` |
| 我的消息 | 采集自己的单聊和群聊 | `im:chat:read` `im:message:readonly` `im:message.group_msg:get_as_user` `im:message.p2p_msg:get_as_user` `im:resource` |
| 文档与知识库 | 读文档和知识库目录 | `docx:document:readonly` `docs:document.content:read` `wiki:node:read` `wiki:wiki:readonly` `drive:file:download` |
| 表格与多维表格 | 读电子表格、多维表格 | `sheets:spreadsheet:readonly` `bitable:app:readonly` |
| 日程 | 采集日程 | `calendar:calendar:read` `calendar:calendar.event:read` |
| 妙记与会议 | 妙记、入会事件 | `minutes:minutes:readonly` `minutes:minutes.artifacts:read` `vc:meeting.meetingevent:read` |
| 让助手写文档 | `lark_doc_*`、`lark_write` | `docx:document` `wiki:node:create` 等 |

- **继续用 lark-cli。** lark-cli 可以从环境变量取应用和用户令牌（`LARKSUITE_CLI_APP_ID`、`LARKSUITE_CLI_USER_ACCESS_TOKEN`，1.0.98 里有），所以现有的采集、`lark_read`、`lark_write` 不用重写：`larkCli(args, { as: userId })` 在子进程的环境里注入这个用户的令牌。本人没有建立连接时，照旧用 lark-cli 自己的登录，兼容现状；本人建立了连接以后也走注入，lark-cli 的设备码登录只留作后备。`lark-auth.ts` 的 scope 缓存和待完成的授权改成按用户分开。缺 scope（`LarkScopeError`）时给这个用户发增量授权链接，不再给本人发设备码。
- 本人的 lark-cli 现在可能指向另一个应用，open_id 和机器人应用不同。迁移时提示本人把 lark-cli 也换到机器人应用（`lark-setup.ts` 已经支持），或者直接用飞书登录 + 连接代替 lark-cli 登录。

### 授权代理：飞书内置，长尾平台可选 Nango

Nango 的情况（2026-11 查证）：

- 许可证是 Elastic License 2.0：源码公开，自用和自托管可以，不能当托管服务卖给别人。
- 免费自托管只有 **Auth 和 Proxy**；Syncs、Webhooks、Actions、RBAC 等要企业版。
- 部署方式：免费自托管只有 Docker Compose（在一台虚拟机上 `docker-compose up -d`）；Helm（Kubernetes）和 BYOC 属于企业版。没有不用 Docker 的官方部署方式。
- 要跑的东西：Postgres（凭据、配置）、Redis（缓存、刷新令牌的锁、限流），以及 Server、Orchestrator、Jobs、Runner、Persist 五个 Node 服务；日志界面另外要 Elasticsearch 或 OpenSearch（可选）。
- 官方目录里没查到飞书 / Lark，要用的话得自己加提供方定义。

omem 需要的正好是 Auth + Proxy，同步、调度、索引本来就由宿主自己做，所以 Nango 免费版适合给长尾平台保管令牌。飞书是核心，要和 lark-cli 注入、增量 scope、机器人身份绑在一起，放进 Nango 反而多绕一层。

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

### 多用户采集与去重

1. **`origin_key`。** 原件加一列平台原生身份（不唯一，建索引）：

| 原件 | origin_key |
| --- | --- |
| 飞书文档、知识库页 | `lark:doc:<obj_token>`（知识库节点先换成 obj_token，`wiki_nodes` 里已有对应关系） |
| 电子表格、多维表格 | `lark:sheet:<token>`、`lark:bitable:<app_token>`；开了高级权限的加 `#<union_id>`，按读者分开 |
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

5. **文档。** 按 origin_key 只读一次，记下 `revision_id`，没变就不再拉；不同人读到的版本，留较新的那份。开了高级权限的多维表格按读者分开存，不合并。

6. **向量。** 同一内容出现在两个空间时，会各算一次向量。数量大了再按块的哈希复用向量，初版不做。

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
4. AI 后端和额度暂时不限制；交办编码和操作桌面只给本人。
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
