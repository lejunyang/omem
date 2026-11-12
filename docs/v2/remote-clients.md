# 远程使用：CLI、MCP 与外部身份（设计稿，未实现）

状态：已实现（2026-11-10），`test/remote-clients.test.ts`、`test/auth.test.ts`；没有连真实飞书核对邮箱字段（第 11 节）。和设计稿不同的地方已改进正文：运行类型沿用 `peer-agent`，记忆来源档案沿用 `peer:<主机名>`；邮箱只在账号没有时补上，不随每次登录更新；邮箱不加唯一索引（旧数据可能重复），查重放在建账号和改邮箱时。和 [multi-user.md](multi-user.md)（账号、登录、权限）一起看。

## 1. 要解决的问题

1. 别人（不只是本人）要在自己的电脑上用 `omem tool` 和 `omem mcp` 连一台远程的 omem，以自己的身份、在自己能看的空间里用工具。他们不一定装了 omem 服务，也不和那台机器配对。
2. 有的组织已经有自己的登录体系，命令行或环境变量里拿得到一个 JWT，里面有邮箱。要能用它证明“我是谁”，但这类内部系统的细节不能进仓库，只能写成数据目录里的插件。
3. 主要登录方是飞书时，只用 JWT 的人也要能正常用；本人要能按邮箱提前建好账号、分好空间，等他们以后用飞书登录时，飞书身份直接挂到这个账号上。

## 2. 现状

| 凭据 | 谁拿 | 能用在哪 |
| --- | --- | --- |
| `om_` API 令牌（`api_tokens`，只存哈希） | `omem user token <用户>`；`omem peer invite` 给本人设备的 `peer:` 令牌 | `/api/*`，按 `src/auth/routes.ts` 的权限 |
| `ot_` 运行令牌（只在内存） | omem 自己启动的 Agent（`OMEM_URL` + `OMEM_TOKEN`） | 只有 `/api/tools` 和 `/mcp` |
| `omem_sid` 会话 cookie | 浏览器登录 | `/api/*` |

缺口：

- `/api/tools` 和 `/mcp` 只认 `ot_`（`src/server/http.ts` 的 `toolBackend`），成员拿着 `om_` 调不了工具。
- `omem tool` / `omem mcp` 不带 `OMEM_TOKEN` 时直接打开本机的库，当作本人；`--peer` 走 `/api/peer/tool`，只给本人（要先配对）。
- 成员没有地方自己领令牌，只能请本人在服务器上跑 `omem user token`。
- 验证身份的只有 OAuth 跳转式的登录方（`LoginProvider`），没有“请求里带着凭据、验证后就认人”的扩展点，`resolveAuth` 是写死的。
- 账号只按平台 id（飞书 union_id / open_id）认人，`users.email` 只是资料，从不参与匹配；飞书登录只要基本信息，多数情况下拿不到邮箱。

## 3. 结论

1. **客户端**：`omem tool`、`omem mcp` 支持直接写远程地址（`--url` / `OMEM_URL`），凭据按顺序取：`OMEM_TOKEN`、`OMEM_AUTH_CMD`（执行一条命令拿令牌）、`omem login` 存下的令牌。不需要配对，不打开本机的库。
2. **服务端**：`/api/tools` 和 `/mcp` 除了 `ot_` 也认用户凭据（API 令牌、插件认出的 JWT），按这个人的空间和一套“外部 Agent 工具”开放，每个会话记成他的一条运行。做法沿用现有的 `peer-agent.ts`，从“只有本人”放开成“按用户”。
3. **鉴权插件**：新增 `api.authenticator()`。插件拿到 Bearer 凭据后自己验证签名，返回身份（id、名字、邮箱），宿主照常经 `identities` 找到用户。内部 JWT 的签发方、公钥、字段名都写在数据目录的插件里。
4. **按邮箱预建账号**：本人在 设置 → 成员（或 `omem user add --email`）按邮箱建账号。任何能给出可信邮箱的身份（插件认出的 JWT、飞书本企业的账号）第一次出现时，挂到邮箱相同的预建账号上，不再新建待批准的账号。
5. **飞书登录申请邮箱**：登录时固定申请 `contact:user.email:readonly` 和 `contact:user.employee:readonly`，拿到 `email` 和 `enterprise_email`。
6. **主要登录方的规则不变**：它只管网页会话。命令行凭据（API 令牌、JWT）从来不受它限制，这一点保持不变。

## 4. 客户端：连远程地址

### 4.1 地址和凭据

`omem tool`、`omem mcp`（以及新加的 `omem login`、`omem open`）按下面的顺序决定连哪里、带什么：

1. **地址**：`--url <地址>` > `--remote <名字>` > `OMEM_URL` > `client.json` 的 `default` > 没有地址时照旧打开本机的库，当作本人、全部权限（和现在一样）。
2. **凭据**（有地址时）：
   - `OMEM_TOKEN`：原样作为 Bearer。omem 自己启动的 Agent 现在就这样带 `ot_`，行为不变；成员也可以放自己的 `om_`。
   - `OMEM_AUTH_CMD`（或 `client.json` 里这个地址的 `authCmd`）：执行这条命令（经 shell，和 git credential helper 一样），标准输出去掉首尾空白就是凭据。是 JWT 时按里面的 `exp` 缓存到过期前 1 分钟；收到 401 时重新执行一次再重试。命令失败时把它的 stderr 原样报出来。
   - `client.json` 里 `omem login` 存下的 `om_` 令牌。
   - 都没有时报错，并提示 `omem login <地址>`。

`client.json` 放在 `~/.omem/client.json`（权限 0600），只存客户端设置，和服务端的 `config.json`、数据库分开。只用客户端的人不会因此建出数据库：有地址时 CLI 不调用 `open()`。

```json
{
  "default": "work",
  "remotes": {
    "work": { "url": "https://omem.example.com", "authCmd": "sso-cli token print --audience omem" },
    "home": { "url": "http://192.168.1.20:4317", "token": "om_…" }
  }
}
```

`omem remote add <名字> <地址> [--auth-cmd <命令>]`、`omem remote list`、`omem remote rm <名字>` 管理这份文件。这只是在本机记一个地址，不和对方配对，对方也不需要知道这台机器。

### 4.2 `omem login <地址>`：用网页登录换一个 API 令牌

给没有 JWT、只能用飞书登录的人：

1. CLI 调 `POST <地址>/api/auth/cli/start`，拿到 `code`（一次性，10 分钟）和确认地址 `<地址>/#/cli-login?code=…`，在终端打印地址并尝试打开浏览器。
2. 浏览器里照常登录（飞书等），页面显示“允许 <主机名> 上的命令行以你的身份使用 omem？”和设备名。点“允许”时调 `POST /api/auth/cli/approve`，这一步要求完整会话（不能是受限或待批准的）。
3. CLI 轮询 `POST /api/auth/cli/poll`，批准后拿到一个新的 `om_` 令牌（标签 `cli:<主机名>`），存进 `client.json`。
4. 账号页“API 令牌”列出这些令牌，可以逐个撤销；停用用户时一起失效（`userForToken` 已经只认 active 用户）。

确认码是 `XXXX-XXXX`（不含容易看错的 0/O、1/I），终端和确认页都显示，本人核对一致再点“允许”。`code` 只存哈希，轮询要带 start 时拿到的另一半密钥（`secret`），防止别人知道 `code` 就能领走令牌。实现：`src/auth/cli-login.ts`，确认页 `web/src/views/CliLogin.vue`（`#/cli-login`，不带应用外框）。浏览器扩展（`chrome/`）连接 omem 时也走这一套，客户端名是「omem 浏览器扩展（Chrome）」，确认页的文案按「发起登录的地方（终端或浏览器扩展）」写。

### 4.3 `omem open`：从命令行打开网页

有凭据的命令行调 `POST /api/auth/link`，服务端用现有的一次性登录链接（`createLoginLink`，5 分钟、只能用一次）生成一条地址，CLI 打开浏览器。这让只有 JWT 的人也能进网页；会话是否受限按 §7.3 的规则。

### 4.4 MCP

- **stdio**（推荐）：`omem mcp --url <地址>` 或 `--remote work`。进程是一个桥：列工具、调工具都转到对方的 `/mcp`（或 `/api/tools`），凭据按 §4.1 取，JWT 过期自动换。`claude mcp add omem-work -- omem mcp --remote work` 这样配。
- **直接 HTTP**：支持自定义请求头的客户端可以直接连 `<地址>/mcp`，带 `Authorization: Bearer om_…`。JWT 会过期，不适合写死在配置里，所以 JWT 只建议走 stdio 桥。

### 4.5 运行记录要的信息

客户端每次请求带这几个头，服务端用来归到同一条运行、在运行页上登记：

| 请求头 | 含义 | 默认 |
| --- | --- | --- |
| `x-omem-session` | 会话名，一个会话一条运行（值都按 URI 编码：请求头只能放 Latin-1，会话名常有中文） | MCP：每个进程一个；`omem tool`：`cli-<主机名>-<日期>` |
| `x-omem-client` | 调用方主机名 | `os.hostname()` |
| `x-omem-agent` / `x-omem-model` / `x-omem-effort` | 登记的 Agent、模型、强度 | `--agent` 等参数或 `OMEM_AGENT` 等环境变量 |
| `x-omem-spaces` / `x-omem-read-only` | 再收窄空间、只给读取类工具 | `--spaces`、`--read-only` |

和 `--peer` 的 `caller`、`session`、`agent` 是同一回事，`--peer` 以后也改成带这些头。

### 4.6 和 `--peer` 的关系

`--peer` 保留，给本人自己的设备用（配对、经中间节点转发、`peer call` 的那套命令）。`--url` / `--remote` 是给所有人的普通客户端，不配对，也不经中间节点。本人也可以用 `--url`，效果和 `--peer` 相同，只是不走配对令牌。

### 4.5 轻量客户端 `omem-cli`（2026-11-13）

只连远程的人不需要服务端：完整包 `omem-assistant` 带着向量模型（transformers / onnxruntime，约 840 MB）、tree-sitter、lark-cli、fastify、pm2 和网页。`packages/cli` 发成 `omem-cli`：

- 命令和完整版同名同参数：`omem login`、`omem open`、`omem remote …`，`omem tool` / `omem mcp` 只有远程这一种（`--url`、`--remote`、`OMEM_URL`、默认地址），没有地址时报错并提示装完整版；没有 `--peer`（要本机的库和配对信息）。
- 代码只有一份：入口 `packages/cli/src/main.ts` 直接用应用里的 `src/remote-client.ts`、`src/remote-commands.ts`（`remote`、`login`、`open` 三组命令和 `clientInfo`，完整版的 `cli-main.ts` 也调它）、`src/agents/mcp-server.ts`、`src/agents/tool-cli.ts` 的参数解析；数据目录 `omemHome()` 单独放在 `src/core/home.ts`，不带进配置的 schema。`test/omem-cli.test.ts` 检查入口的导入只到这几份文件。
- 用 Vite 打成一个文件（commander 和 MCP SDK 打进去，约 630 KB），包里没有依赖，Node 20 以上可用。两个包共用 `~/.omem/client.json`。
- 两个包的命令都叫 `omem`，同一台机器只装一个；完整版包含这些命令。

## 5. 服务端：工具接口按用户开放

### 5.1 认人

`/api/tools`、`/api/tools/:name`、`/mcp` 的顺序：

1. `ot_` 运行令牌、设备中继、内部令牌：和现在一样，用运行自己的上下文。
2. 否则走 `resolveAuth`（它在 §6 里多认一种插件凭据）：认出用户、用户是 active、不是受限会话，就用 §5.2 的外部上下文；认不出就 401。
3. 不认 cookie：工具接口只给命令行和 Agent 用，避免网页被别的站点诱导调用工具。

### 5.2 外部 Agent 的上下文

把 `src/agents/peer-agent.ts` 从只给本人改成按用户：

- **工具**：现有的 `peerToolNames`（内置分组里的工具，去掉 `PEER_DENY` 里对外发消息、交办、唤醒、改配置的那些），再按这个人的全局权限裁剪（`src/auth/tools.ts`，和他在网页里的问答一样）。`--read-only` 时只给 `READ_ONLY_TOOLS`。
- **空间**：`scopeFor(用户, 请求的空间)`；默认空间是他的个人空间（本人是 `personal`）。`x-omem-spaces` 可以再收窄，不能放宽。
- **写入**：照常走工具层的检查（`canWrite`、`wiki.write`），记忆的来源档案记成 `peer:<主机名>`（和配对设备一样），之后照常交给记忆复核。
- **运行**：沿用 `kind = 'peer-agent'`（运行页叫“设备的外部 Agent”），`user_id` 是这个人（本人为空），标题“<名字> 在 <主机名> 上的外部 Agent（<会话>）”，会话按（人、主机名、会话名）区分，`input` 里记 `caller`、`session`、`agent`、`model`、`effort`、`via`（`token` / 认证插件 id）。15 分钟没有调用就结束，下一次调用再开（沿用现有逻辑）。
- **权限**：新增全局权限 `tools.external`（“在自己的电脑上用 omem 工具（CLI、MCP）”），内置的 admin、member、viewer 都有（viewer 的工具按空间权限只剩读取类）。没有这个权限时返回 403 并说明。

### 5.3 凭据不进日志

请求日志、运行记录和错误消息里不出现 Bearer 的值；`OMEM_AUTH_CMD` 的输出只在内存里用，不落盘。

## 6. 鉴权插件：`api.authenticator()`

### 6.1 接口

```ts
api.authenticator({
  id: "acme-sso",            // 必须以 <插件 id>- 开头；也是 identities.channel
  label: "公司统一登录",
  /** 这个凭据归不归我管：只看形状（前缀、JWT 的 iss），不发网络请求。 */
  claims(token: string): boolean,
  /** 验证签名和有效期，返回身份；不是有效凭据就返回 null，不抛错。 */
  async verify(token: string): Promise<{
    externalId: string;      // 稳定的用户 id（sub、工号）
    name: string;
    email?: string | null;
    emailVerified?: boolean; // 只有 true 时才能按邮箱认领预建账号（§7）
    expiresAt?: number;      // 毫秒；宿主按它缓存
  } | null>,
});
```

插件在数据目录里，带代码，要本人信任（现有的代码哈希机制）。公钥、JWKS 地址、`aud`、用哪个字段当邮箱，都由插件自己定，或者用 `appFields` 让本人在 设置 → 插件 里填。

### 6.2 宿主怎么用

`resolveAuth` 遇到 Bearer：

1. 前缀是 `om_` → 现有的 `userForToken`。
2. 否则依次问已注册的认证插件 `claims`，第一个认领的调 `verify`。结果按 `sha256(凭据)` 缓存到 `min(expiresAt, 10 分钟)`；`verify` 返回 null 也缓存 1 分钟，免得同一个坏凭据反复验证。
3. 拿到身份后：`identityOwner(id, externalId)` 找人 → 找不到就按 §7 用邮箱认领 → 还找不到就按 `auth.signup[<id>]` 处理，默认 `approve`：建一个待批准的账号、记上这个身份，通知本人一次（之后同一个身份再来不重复建、不重复通知）。
4. 用户停用或待批准时拒绝。待批准返回 403 `{ code: "pending", error: "你的 omem 账号（<名字>）在等 omem 的主人批准，批准后重试" }`；`omem tool` 原样打印这句并以非零退出，`omem mcp` 桥在列工具和调工具时都把它作为错误文本返回给 Agent，让 Agent 转告本人。停用返回 403 `disabled`，同样说明。
5. 结果是 `{ via: "token", provider: <id>, restricted: false }`。

只认 `Authorization: Bearer`，不认 cookie 或网关加的请求头。经网关的网页登录本期不做（§10）。

### 6.3 和 `api.connector()` 的区别

`connector` 是 OAuth 跳转：浏览器去授权页，回来换令牌、调“我是谁”，结果是网页会话，还可以保留令牌用来采集。`authenticator` 不跳转、不存令牌，每次请求自带凭据。一个插件可以两个都注册，用同一个 `channel`，这样同一个人从网页登录和从命令行来，都认到同一个账号。

### 6.4 不内置 JWT 校验

仓库里只做 `api.authenticator` 这个接口和宿主一侧的接入，不内置任何 JWT 校验（包括通用的 JWKS 校验）。各家的凭据常常不是标准 JWT：要先调内部接口换、要额外查一次用户状态、字段名嵌套在自定义结构里；具体怎么验证由数据目录里的插件决定，内部鉴权不写进本仓库。仓库的测试用一个测试里现写的认证插件（测试密钥签 JWT）覆盖接入流程。

## 7. 按邮箱预建账号与认领

### 7.1 预建

- **网页**：设置 → 成员 → “添加成员”：名字、邮箱（必填）、全局角色、空间与空间角色、“允许用主要登录方以外的方式登录”。建出来就是 active，有个人空间。
- **接口**：`POST /api/users`（`users.manage`；分配全局角色仍然只有本人能做，和 `PATCH /api/users/:id` 一致）。
- **命令行**：`omem user add <名字> --email <邮箱> [--space a --edit b]`。
- 邮箱统一转小写存。建之前检查：有别的账号（任何状态）已经用这个邮箱时拒绝，并指出是哪个账号。比如这个人已经用飞书登录过、正在待批准，这时应该批准那个账号，而不是再建一个。

### 7.2 认领规则

在 `login()`（网页登录）和 §6.2 第 3 步（命令行凭据）里，按 id 找不到人时：

1. 身份带着**可信邮箱**：
   - 认证插件返回 `emailVerified: true`；
   - 飞书：`tenant` 等于机器人应用所在的租户（本企业），`enterprise_email` 和 `email` 都用来认领，`enterprise_email` 优先：先按它找，找不到再按 `email` 找。飞书文档说明这两个字段是管理员导入的联系方式，不是用户本人验证过的；只在本企业内使用，信任边界就是本企业管理员。其他租户的飞书身份一律不按邮箱认领。
2. 找到**恰好一个**邮箱相同、状态 active、还没有这个渠道 login 身份的账号 → 把身份记到这个账号上（和绑定一样，`kind = 'login'`），审计记一条 `identity.claim`，通知本人“X 用飞书登录，已对应到预建账号 Y”。
3. 找到多个，或者那个账号已经有这个渠道的另一个身份 → 不认领，按“新人”处理（待批准），通知本人有冲突。
4. 账号不会合并：已经有身份的两个账号，即使邮箱相同也不会自动并成一个（multi-user.md 的原则不变）。

已经存在的账号：

- 登录时只在账号没有邮箱时补上（`enterprise_email || email`；邮箱已在别的账号上时不补）。不随每次登录更新：本人为了对上 JWT 手动改过的邮箱，不会被下一次飞书登录改回去。
- 账号上只存一个邮箱。JWT 里的邮箱和飞书给的对不上时（比如公司邮箱有两个域名的别名），本人在成员页手动改这个账号的邮箱（`PATCH /api/users/:id` 加 `email`，查重规则同 §7.1）。没改之前，JWT 这一路认领不到，会建出一个待批准的新账号；已有的账号和它的飞书身份不受影响。本人在成员页拒绝这个待批准账号并解绑它的 JWT 身份（只拒绝不解绑的话，身份还挂在停用的账号上，之后会一直提示“账号已停用”），改好原账号的邮箱，这个人下次带 JWT 来就认领到原账号。

### 7.3 和“主要登录方”的关系

先说清楚现在的规则（multi-user.md “登录方式”“注册策略”）：

- **主要登录方**（`auth.primary`）只决定**网页会话**是不是完整的。用别的方式登录（插件 OAuth、`omem open` 的一次性链接、机器人发的登录链接）时，如果这个账号还没绑主要登录方，拿到的是**受限会话**。
- **受限会话**：除了 `/api/me` 和 `/api/auth/*`（看自己、绑定、退出），所有接口都返回 403 `restricted`。网页跳到登录页，只显示“先绑定飞书”和“退出登录”两个按钮。绑定成功后这个会话立即变成完整会话。
- **`loginAny`**（成员页上的“允许用飞书以外的方式登录”）：对这一个账号关掉上面的限制，他用别的方式登录也拿完整会话。它看起来只管“怎么登录”，但网页上的一切操作都靠登录得到的那个会话，会话受限就什么都用不了，所以它实际决定的是这个人能不能在没有飞书的情况下用网页。
- **命令行凭据不受这两者影响**：`om_` 令牌和认证插件认出的凭据，`restricted` 总是 false。主要登录方管的是“网页上怎么证明你是你”；命令行凭据要么是本人或本人批准发出的（API 令牌），要么由本人信任的插件验证过签名，本身已经足够。

所以只有 JWT、没有飞书的人：

| 做什么 | 结果 |
| --- | --- |
| `omem tool` / `omem mcp` 带 JWT | 正常用（预建账号直接可用；没预建就先待批准） |
| `omem open` 进网页，账号没开 `loginAny` | 受限会话：只能绑飞书 |
| `omem open` 进网页，账号开了 `loginAny` | 完整会话 |
| 之后第一次用飞书登录 | 按邮箱认领同一个账号，飞书身份记上，以后飞书登录就是完整会话 |

预建账号时可以顺手勾上 `loginAny`，给那些短期内不会有飞书的人。

### 7.4 飞书登录申请的权限

登录时固定加上（`src/auth/features.ts` 新增一个不显示给用户的 `identity` 项，`purpose = login` 和 `bind` 都带）：

| scope | 拿到的字段 |
| --- | --- |
| `contact:user.email:readonly`（获取用户邮箱信息） | `email` |
| `contact:user.employee:readonly`（获取用户受雇信息） | `enterprise_email`（企业要开通飞书邮箱才有）、`employee_no` |

这两项要先在开发者后台为应用开通并发版；设置 → 渠道 → “机器人权限与事件检查”把它们列进登录必需的权限。没开通时飞书授权页会报错，登录前先检查，给出“去开发者后台开通这两项”的说明。

## 8. 数据表变化

| 表 | 变化 |
| --- | --- |
| `users` | `email` 存小写（迁移时把已有的转成小写）；不加唯一索引，建账号、改邮箱时查重 |
| `api_tokens` | 加 `client`（主机名）；账号页按它显示 |
| `cli_logins` | 新表：`code_hash`、`secret_hash`、`user_id`（批准后填）、`client`、`created_at`、`expires_at`、`approved_at`、`token_issued_at` |
| `runs` | 不变：`peer-agent` 的运行带 `user_id` 和 `input.via` |
| `identities` | 不变；认证插件的身份用插件 id 作 channel |

## 9. 分期

1. **客户端与工具接口**：`--url` / `--remote` / `OMEM_URL`、`OMEM_TOKEN` 认 `om_`、`OMEM_AUTH_CMD`、`client.json` 与 `omem remote`；`/api/tools`、`/mcp` 认用户凭据，外部 Agent 上下文按用户；`tools.external` 权限；账号页 API 令牌列表与撤销；`omem login`（§4.2）。测试：成员令牌经 `/mcp` 只看得到自己的空间，没有 `PEER_DENY` 里的工具，运行归到他名下；`OMEM_AUTH_CMD` 过期重取。
2. **认证插件**：`api.authenticator`、`resolveAuth` 接入与缓存、待批准流程、`omem open`。测试：用测试密钥签的 JWT，坏签名、过期、停用账号都被拒。
3. **预建账号与邮箱认领**：成员页“添加成员”、`POST /api/users`、`omem user add --email`；登录和认证插件的邮箱认领；飞书登录加两项 scope 与检查。测试：假飞书返回本企业 / 外企业邮箱、重复邮箱、已绑账号各种情况。

每期都同步 README（命令行清单）、architecture.md 状态表、acceptance.md、`site/guide` 里的多人与外部 Agent 页面、`skills/omem/SKILL.md` 的接入一节。

## 10. 已定（2026-11-10）与待定

1. 只做插件接口，不内置 JWT 校验；内部鉴权以后经数据目录的插件接入（§6.4）。
2. 没预建账号的人第一次带凭据来：默认待批准（`auth.signup` 的 `approve`）；命令行和 MCP 调用时返回“等 omem 的主人批准”的错误（§6.2 第 4 步）。本人仍可以对某个认证插件设 `closed`。
3. 飞书的 `enterprise_email` 和 `email` 都参与认领，`enterprise_email` 优先（§7.2）。
4. 经公司网关的网页登录（网关在 cookie 或请求头里放 JWT）暂时不做。
5. 新的全局权限 `tools.external`（在自己的电脑上用 omem 工具：`omem tool`、`omem mcp` 连远程地址）内置的“访客”（viewer）也有：工具按他的空间权限裁剪，只剩读取类。本机不带地址的使用不经过这个权限，照旧当作本人、全部权限。

## 11. 需要实测

- 飞书授权页同时申请 `contact:user.email:readonly` 和 `contact:user.employee:readonly` 时，没开通飞书邮箱的租户 `enterprise_email` 是空串还是不返回；`email` 在常见租户里是否就是公司邮箱。
- Windows 上 `OMEM_AUTH_CMD` 经哪个 shell 执行（osdk 垫片会再解析参数，见本机说明），引号和 `>` 是否原样传过去。
- Claude Code、Codex 用 stdio 桥连远程 `/mcp` 时，单次工具调用 15 分钟的超时是否够用；JWT 在长会话中途过期时，桥自动重取对客户端是否无感。
