# 凭据：每人一次授权、出借、缺权限时找谁

状态：设计（2026-11-22）。分期见文末，做到哪一步记在 `docs/v2/status.md`。相关：[成员的 AI 账号](agent-accounts.md)（每人一个账号目录、沙箱、插件登录方式）、[操作规则与命令垫片](command-gate.md)、[多人](multi-user.md)。

## 要解决的事

omem 给一个团队用以后，Agent 跑的命令行工具（公司内部的命令行、代码托管、数据库查询……）需要“是谁在调用”：

- 成员发起的运行应该用成员自己的身份；现在只有 AI 后端能按人登录，别的命令行在成员的账号目录里没有登录态。
- 一个人往往要登好几样东西。很多环境里它们认同一个根凭据，应该授权一次就都能用，过期了有人提醒。
- 发起人没有权限的资源，团队里可能有人有。现在只会让本人去申请。

## 概念

**凭据种类**：由插件登记（`api.credential`），说明怎么登录、怎么续签、怎么检查、供给哪些 AI 后端和命令行、怎么认出命令失败的原因。宿主不认识任何具体的系统，只按声明办事。

**持有**：某个人对某种凭据的一份登录。成员的放在他的账号目录里（`accounts/<用户>/home`，见成员的 AI 账号）；本人的就是本机已有的登录，不复制。状态：没登录 / 有效 / 快到期 / 过期 / 登录中。

**出借设置**（每份持有一个，持有人自己定）：只给自己用 / 给指定的成员 / 给所有成员。成员默认只给自己；本人的默认给所有成员。

**出借方式**（管理员定，`credentials.lending`）：

| 值 | 含义 |
| --- | --- |
| `auto`（默认） | 按各人的出借设置直接借，不再问 |
| `confirm` | 不直接借：每次要用别人的凭据时，先问持有人，他同意才用（见“确认”）；出借设置在这一档表示“可以来问我”的范围 |
| `off` | 不借也不问，只用自己的；没有就提示登录或申请权限 |

**成员的 AI 后端用谁的登录**（管理员定，已有的 `agents.accounts`，补一个全局默认 `agents.accountsDefault`）：可以借（按上面的出借）/ 必须自己登录 / 自己没登录就换一个他登录过的后端。

## 插件登记一种凭据

```ts
api.credential({
  id: "corp",                       // 全名 <插件>:corp
  name: "公司账号",
  describe: "一次授权，供给 acme 命令行和 ×× 后端",
  required: true,                   // 接入清单里标成必做
  login(ctx, show): Promise<{ user: string; expiresAt?: number }>,   // show({ url, code? })：给这个人看的授权链接
  refresh?(ctx): Promise<{ expiresAt?: number } | null>,              // null：续不了，要重新登录
  check?(ctx): Promise<{ state: "ok" | "expired" | "missing"; user?: string; expiresAt?: number }>,  // 只读
  logout?(ctx): Promise<void>,
  provide?(ctx): Promise<void>,     // 登录和每次续签后调用：把凭据写到这个人账号目录里各工具认的位置
  provides: {
    backends: ["somebackend"],      // 这些 AI 后端的登录由它负责（等价于现在的 agentLogin）
    commands: [{
      name: "acme",                 // 可执行文件名
      install: ["~/.local/share/acme"],        // 只读挂进成员沙箱的安装目录
      state: [".local/share/acme/data"],       // 它要写的状态目录（相对 HOME）
      readOnly: [{ subcommand: ["db", "query"] }, { subcommand: ["log", "search"] }],   // 算只读的调用，匹配写法同操作规则的命令匹配
      resource: [{ match: { subcommand: ["db", "query"] }, key: "db:{option.instance}" }], // 这次调用碰的是哪个资源
      outcomes: {                   // 失败时怎么认原因；按顺序匹配，都不中算普通失败
        unauthenticated: [{ json: "$.code", equals: "AUTH_REQUIRED" }],
        expired: [{ json: "$.details.status", equals: "refresh_failed" }],
        denied: [{ json: "$.status_code", equals: 403 }],
        applyUrl: "$.details.apply_urls[0]",
      },
    }],
  },
  precheck?(ctx, req: { resource: string; user: string }): Promise<{ allowed: boolean | null; missing?: string; applyUrl?: string }>,
});
```

- `ctx` 同插件登录方式的上下文：`userId`、`home`、展开后的 `env`、按人保存的 `secret`、`signal`。回调在 omem 进程里执行，只读写这个人的账号目录和 `secret`。
- 清单声明 `permissions.credential: true`，本人信任插件并选“在 omem 里运行”才生效。声明里的 `install`、`state`、匹配规则都进信任指纹。
- 已有的 `api.agentLogin` 继续可用；新的插件用 `api.credential`，一种凭据供给多个对象。
- 宿主按 `expiresAt` 在到期前续签（沿用现有的十分钟提前量），续签后调 `provide`；每天对每份持有调一次 `check`。

## 运行时用谁的

发起人 R 的运行要用凭据 K：

1. R 自己的持有有效：用它。
2. 否则找出借给 R 的持有人（本人排最前，其余按最近一次成功使用排）：`auto` 档直接借，`confirm` 档先问。
3. 都没有：`agents.accounts` 是“必须自己登录”或没人可借时，给 R 发授权链接（见“什么时候登录”），这次运行等十分钟。

每次借用在运行事件里写一行（借了谁的哪种凭据、为什么），并写 `audit_events`。

**AI 后端的借用**沿用现有做法：整轮运行在出借人的登录下启动（本人的是本机登录，成员的是他的账号目录），所以它只在 `auto` 档、并且出借人把这份持有开放给了 R 时才发生；`confirm` 档不借 AI 后端。

**命令行的借用是逐条命令的，只借只读的**：R 的运行照常在 R 自己的环境里；命令垫片拦到声明过的命令时问宿主，宿主决定这一条在哪跑：

- 在 R 自己的环境里跑（默认）；
- 在出借人的环境里跑：宿主在出借人的账号沙箱里（本人的是本机登录，开了本人沙箱就在沙箱里）用一个空的临时目录执行这条命令，把退出码和输出交回垫片。凭据本身不进 R 的进程。只有匹配 `readOnly` 的调用才能这样跑；输出过长按现有的命令输出上限截断。

什么时候换到出借人：R 没有有效的持有；或者这条命令在 R 这里以 `denied` 失败（或权限记录里已知 R 没有这个资源的权限），而某个出借人已知有、或还不知道。换了以后的结果写进权限记录。一条命令最多换两个人。

## 权限记录

表 `credential_access`：凭据种类、资源、用户、有 / 没有、什么时候得知、从哪次运行或哪次预检得知。来源是命令的结果（成功记“有”，`denied` 记“没有”）和插件的 `precheck`。记录三十天后算过期，过期的当“不知道”。

- 工具 `who_can(resource)`（只读，`read` 组）：返回已知有权限的成员、最近一次得知的时间、申请链接。助手在动手之前可以先查，回答里可以说“这个库小王能查”。
- 不用记忆存这些：它们要按人按资源查、会过期、要被宿主拿来做判断，模型不能改写。

## 确认

`confirm` 档下要用别人的凭据，或者 `auto` 档下出借人没有开放给 R 但权限记录显示他有权限时，宿主向持有人发一张确认卡：谁、为哪件事、要跑哪条只读命令（原样列出）、碰哪个资源。选项：这一次可以 / 这次任务里都可以（到这轮运行结束）/ 不行。同意后命令在持有人的环境里跑，结果交回 R 的运行；不同意或十分钟没答，R 的运行得到“持有人没同意”，并附申请链接。

卡片发到哪：

1. 请求来自群聊：在**那个群里**发，只有持有人看得见（渠道支持“仅某人可见”的卡片时）。持有人不在群里就先拉进来：先用机器人拉；机器人拉不了、并且本人打开了 `credentials.confirm.inviteAsOwner` 时，用本人的身份拉。拉不进来，或渠道不支持仅某人可见，退到机器人私聊。
2. 请求来自和机器人的私聊或网页：机器人私聊持有人。
3. 两处都同时进持有人在 omem 里“等我的”清单；任一处答了，另一处的卡作废。

以本人身份拉人进群是一条新的以本人身份写飞书的路径：只在这一个场景、目标只限持有人和触发的那个群、每次写 `audit_events` 并在本人的通知里说明；开关默认关。实现时把它加进 AGENTS.md “以本人身份写飞书”的清单。

## 什么时候登录、失效了怎么办

- **用到时**：R 的运行要用 K 而没人可借，机器人把授权链接私聊给 R（群里只说“已私聊你”），运行等十分钟。
- **第一次进来**：成员第一次登录网页或第一次 @ 机器人之后，给一张接入清单：`required` 的凭据标必做，其余可选；每项写清覆盖哪些工具。网页的账号页列出同样的清单，可以登录、重新授权、退出、改出借设置。
- **失效**：续签失败、每天的 `check` 发现过期或三天内到期、运行中命令以 `unauthenticated` / `expired` 失败，都把这份持有标成过期并通知持有人（走成员的通知出口；私聊不到的，在他下次 @ 机器人时先提醒）。正在跑的那条命令按“没有有效持有”处理（可以借就借）。

## 接口和设置

- `GET /api/credentials`（自己的持有和清单）、`POST /api/credentials/:kind/login`、`DELETE /api/credentials/:kind`、`PUT /api/credentials/:kind/sharing`；本人另有 `GET /api/credentials/all`（每个成员登了什么、出借给谁，不含凭据）和替成员退出。
- 设置：`credentials.lending`、`credentials.confirm.inviteAsOwner`、`agents.accountsDefault`，都只有本人能改，归“安全”区域。
- 成员沙箱里只读挂载声明过的 `install`；本人沙箱的默认可写清单加上声明过的 `state`。

## 分期

| 期 | 内容 |
| --- | --- |
| 一 | `api.credential`、持有和续签、`provide`、安装目录和状态目录的挂载、每天检查和到期提醒、接入清单、出借设置和 `credentials.lending`、AI 后端按出借选登录和 `agents.accountsDefault`、接口 |
| 二 | 命令垫片认失败原因、在出借人环境里跑只读命令、权限记录和 `who_can`、`precheck` |
| 三 | 确认卡：群里仅持有人可见、拉人进群、私聊的退路、“等我的” |
| 四 | 网页：账号页的清单和出借设置、设置 → 安全 的三个开关、成员页的总览 |
