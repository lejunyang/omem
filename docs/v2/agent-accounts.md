# 每个人用自己的 AI 账号（设计稿）

> 状态：第一期和第二期的登录页已实现（2026-11-20），还没在真机上跑过。和 [multi-user.md](multi-user.md) 的关系：那里写的是“成员的运行用本人配置的后端”，这份把它改成“可以用成员自己的账号”。
>
> 已实现：启动时检查 bubblewrap（`src/agents/sandbox.ts`，`omem diag` 的 `agentAccounts`）；Agent 目录的 `account` 字段（Codex、Claude Code、TraeX、豆包命令行，`src/agents/catalog.ts`），登录、检查、退出用的命令可以和 ACP 的命令不同（`account.cli`）；账号目录的建立和删除、`prepareRun` 按发起人选账号、设置 `agents.accounts`（`owner` / `own`，`src/agents/accounts.ts`）；ACP、命令行兜底、会话清理和归档、豆包命令行都经同一个 `launch` 进沙箱；后台会话池、对话会话的 key 和会话清理的记录带上账号；成员账号的运行不读、不记本人的额度，也不因本人额度用完而跳过。登录页：账号 → 我的 AI 账号（设备码 / 二维码登录、粘贴令牌、检查、退出），本人在 设置 → AI → 成员的 AI 账号 设规则、看谁登了什么、让人退出（接口在 `src/server/agent-accounts-http.ts`）。
>
> 和下文不同的：第 3 节的 `own-or-other` 没做，只有 `owner` 和 `own`；`own` 的后端在成员没登录时也从他的兜底链里去掉。额度按账号读、探测缓存按账号分、技能目录同步进账号目录（第 4 节）没做：成员账号的运行只是不碰本人的额度记录。用户自己加的后端（配置里的 profiles）还不能写 `account`。登录态放在 kv（`agent_account:<用户>:<后端>`，只在本机），令牌放在 `secrets/vault.db`（提供方 `agent:<后端>`）。成员的登录入口在“账号”页而不是“设置”页（成员看不到设置页）。删除用户时删账号目录没做（现在只能停用用户）；本人可以在设置里让他逐个退出。
>
> 没验证的：真实的 bubblewrap 启动（各后端在沙箱里完成一次 ACP 往返、自带沙箱能不能嵌套）、各家登录命令的输出能不能被 `account.login` 的正则认出来、Claude Code 用 `CLAUDE_CODE_OAUTH_TOKEN` 时 `auth status` 的结果、豆包命令行从本机安装的路径在沙箱里启动。单元测试只覆盖参数、环境、选账号和接口权限（`test/agent-accounts.test.ts`）。

## 要解决的事

omem 支持多人登录以后，同事在 omem 里提问、交办，背后跑的 Agent（Codex、Claude Code、TraeX、豆包命令行……）用的还是本人的登录。结果是：

- 额度、费用和服务端的使用记录全算在本人头上；
- 有的命令行登录后能读写这个人在平台上的东西（代码托管、文档、内部服务），用本人的账号等于把本人的权限借给了别人；
- 公司环境里，很多内部服务只认“是谁在调用”，必须用调用者自己的身份。

目标：每个成员在 omem 里登录一次各个后端，之后他发起的运行就用他自己的账号；没登录的按本人设的规则处理（借用本人的，或者拒绝并提示去登录）。

## 先看各家命令行怎么放登录态

主流命令行都把登录态放在 HOME 下的一个目录里，并且大多认一个环境变量来换这个目录。没有一家提供“同一个进程里切账号”。下表在一台 Linux 上用空目录实测过（2026-11-20：两个空账号目录同时启动，用文件跟踪看各自打开了哪些路径；都还没有用真实账号登录）。

| 后端 | 每个账号要分开的 | 无界面登录 | 实测结果 |
| --- | --- | --- | --- |
| Codex | `CODEX_HOME`、`HOME` | `codex login --device-auth`（设备码） | 空目录下 `login status` 为未登录 |
| Claude Code | `CLAUDE_CONFIG_DIR`、`HOME` | `claude setup-token` 打印长期令牌，之后可用 `CLAUDE_CODE_OAUTH_TOKEN` 直接注入 | Linux 上凭据文件和配置都落在 `CLAUDE_CONFIG_DIR`（macOS 在钥匙串，不随目录变） |
| TraeX | `TRAE_HOME`（也认 `TRAECLI_HOME`）、`HOME`、私有的 `XDG_RUNTIME_DIR` 和 `TMPDIR`（0700） | `traex login --sso-device`（设备码） | 两个空账号同时完成 ACP 初始化，各自只查自己的登录文件；技能从 `$TRAE_HOME/skills` 读；目录不能是符号链接 |
| 豆包命令行 | `HOME`、`XDG_DATA_HOME`，**还要私有的 `/tmp` 和 PID 视图** | 二维码 | 只分开目录时，两份进程用了同一个 `/tmp` 下的服务 socket，后启动的连进了前一个账号的服务；用 bubblewrap 各给一个 `/tmp` 和 PID 命名空间后才各连各的。程序可以直接从本机安装的绝对路径启动，不用每人复制一份 |

所以 omem 能用同一个办法处理所有后端：**每个用户一个账号目录（当作他的 HOME），在沙箱里启动 Agent，把对应变量指向它**。差异写进 Agent 目录（`src/agents/catalog.ts`），运行时不按 Agent 名特判。豆包这一行也说明只换目录变量不够，沙箱（私有 `/tmp`、PID 视图）是必需的，不是加固项。

## 设计

### 1. 账号目录

- 位置：数据目录下 `accounts/<用户 id>/home/`，权限 0700，不允许符号链接。它是这个人在沙箱里的整个 HOME，各后端的目录（`.codex`、`.trae`、`.local/share/doubao_cli`……）都在里面，所以不靠各家的目录变量也能分开；`account.env` 只用来补那些不从 HOME 推目录的后端。本人不用这一层，照旧用本机已有的登录。
- 目录里放什么由后端决定，omem 不读不写里面的凭据，只负责建目录、设变量、删除。
- 删除用户、用户退出某个后端时删掉对应目录（先让后端自己 logout，失败也删）。

### 2. Agent 目录里的新字段 `account`

```ts
account?: {
  /** 启动时设的环境变量，{home} 是这个用户的账号目录（沙箱里的 HOME） */
  env: Record<string, string>;            // 例：{ CODEX_HOME: "{home}/.codex" }
  /** 要预先建好的子目录（0700），比如 socket 目录 */
  dirs?: string[];                        // 例：[".run"]，配合 env 里的 XDG_RUNTIME_DIR: "{home}/.run"
  /** 沙箱里要只读挂进来的本机安装（程序从本机的绝对路径启动，不每人复制） */
  mounts?: string[];                      // 例：豆包命令行的 app/current
  /** 无界面登录：命令、从输出里认出链接和验证码的正则、超时 */
  login?: { args: string[]; url: string; code?: string; timeoutMs?: number };
  /** 查登录状态：退出码 0 算已登录，输出里认出账号名的正则 */
  status?: { args: string[]; user?: string };
  logout?: { args: string[] };
  /** 能直接用令牌登录时：令牌放进哪个变量（存在 omem 的密钥库里，按用户） */
  tokenEnv?: string;                      // 例：CLAUDE_CODE_OAUTH_TOKEN
}
```

只有带 `account` 的后端才能按人分账号。用户手动加的后端（配置里的 profiles）也可以写这一段。

### 3. 运行时怎么选账号

`prepareRun` 已经知道这次运行替谁跑（`userId`）。在它决定后端之后：

1. 发起人是本人，或后端没有 `account` → 照旧。
2. 发起人是成员，且他在这个后端有账号（目录存在且上次 `status` 是已登录）→ 在沙箱里启动，HOME 是他的账号目录，合并 `account.env`（展开 `{home}`），令牌型的再加 `tokenEnv`。
3. 成员没有账号 → 看设置 `agents.accounts.<后端>`：
   - `owner`（默认，等于现在的行为）：借用本人的；
   - `own`：这个后端只能用自己的账号，运行失败，提示“在 设置 → 我的 AI 账号 里登录 <后端>”；
   - `own-or-other`：按任务选型换一个他有账号、或允许借用的后端。

访客（不是 omem 用户的人）不受影响：访客模式照旧用本人设的后端，它本来就只读。

### 4. 跟着账号走的东西

这些现在按“后端”区分，要改成按“后端 + 账号”区分：

- 后台会话池（`background-sessions.ts` 的 key）、会话续用（resume）：不同账号的会话不能互相复用。
- 额度（`quota.ts`）：每个账号单独读、单独记，选型时按发起人的额度避让。
- 会话记录目录（`sessionHistory.root` / `env`）、技能目录（`skills.read` / `write` 里的 `${CODEX_HOME:-~/.codex}` 这类）：按账号目录展开。omem 写进技能目录的说明（`agent-skills.ts`）在建账号目录时同步一份。
- 模型探测缓存：同一后端不同账号可用的模型可能不同（套餐不同），按账号缓存。

### 5. 登录界面

设置里加“我的 AI 账号”（每个人都能看到自己的）：

- 列出带 `account` 的后端，每个显示 已登录（账号名）/ 没登录 / 登录过期，以及本人对这个后端的规则（借用 / 必须自己的）。
- “登录”：宿主在这个人的账号目录里起 `login` 命令，从输出里认出链接和验证码显示在页面上（也可以发到他的飞书私聊），等命令结束后跑 `status` 确认。命令超时或失败就清掉进程，目录留着可以重试。
- 令牌型：粘贴令牌，存进 omem 的密钥库（`secrets/vault.db`，按用户），不进账号目录、不进配置文件。
- “退出”：跑 `logout` 后删目录。
- 本人在设置里能看到每个成员登了哪些后端（不显示令牌），能替他退出。

### 6. 插件提供登录方式

有的后端在公司环境里不走它自己的登录，而是用公司统一身份换来的凭据。插件可以给某个后端注册一个登录方式：

```ts
type AgentLoginContext = {
  userId: string;
  /** 这个人的账号目录（沙箱里的 HOME） */
  home: string;
  /** Agent 目录里 account.env 展开后的变量（例：TRAE_HOME=<home>/.trae）：凭据写到它们指的位置 */
  env: Record<string, string>;
  /** 宿主替插件按人保存的一份秘密（存在 secrets/vault.db，不进账号目录），比如刷新令牌 */
  secret: { get(): Promise<string | null>; set(value: string | null): Promise<void> };
  signal: AbortSignal;
};

api.agentLogin({
  backend: "traex",
  id: "company",                 // 同一个后端可以有几种登录方式，插件内唯一
  label: "用公司账号登录",
  // 引导这个用户授权（设备码或网页 OAuth），拿到凭据后写进 env 指的位置
  login(ctx: AgentLoginContext & { show(link: { url: string; code?: string }): void }): Promise<{ user: string; expiresAt?: number }>;
  // 可选：续签。宿主在 expiresAt 前（提前 10 分钟，最短 1 分钟一次）调用，也可以由“检查”手动触发；
  // 返回新的 expiresAt；返回 null 表示续不了，要这个人重新登录
  refresh?(ctx: AgentLoginContext): Promise<{ expiresAt?: number } | null>;
  // 可选：退出时清理（撤销令牌等）；宿主之后照常删目录
  logout?(ctx: AgentLoginContext): Promise<void>;
});
```

宿主只负责调用、把链接和设备码显示给这个人（网页上，以及用机器人发到他的飞书私聊，写明是 omem 为谁、为哪个后端发起的）、超时取消、按 `expiresAt` 安排续签；凭据怎么换、写成什么格式由插件决定。续签失败或返回 null 时状态改成“登录过期”并通知这个人。插件要在清单里声明 `permissions.agentLogin: [<后端>]`，本人信任插件、并选“在 omem 里运行”时才生效。“我的 AI 账号”里，一个后端同时列出它自己的登录方式和插件提供的登录方式。数据目录里的公司插件就用这个让同事用公司账号登录 TraeX。

### 6.5 别人怎么做的

开源项目里，按人分账号大致有三种做法：

| 做法 | 例子 | 优点 | 缺口 |
| --- | --- | --- | --- |
| 只换各家的目录变量 | 各种多账号切换工具：每个账号一个目录，启动时设 `CLAUDE_CONFIG_DIR`、`CODEX_HOME` | 简单，不要权限 | Agent 执行的子进程（git、gh、shell）仍用原来的 HOME，能读到本人的配置和令牌；macOS 上 Claude Code 的凭据在钥匙串里，不随目录变 |
| 每人一个系统用户 | Clay：给每个成员建 Linux 账号，用 `setfacl` 管文件权限，Agent 进程用他的 uid / gid 启动 | 由内核保证互相读不到 | 要 root 或 sudo 建用户、切用户 |
| 每人一个容器或沙箱 | agent-fleet：每人一个容器（没有 Docker 时用 bubblewrap），家目录持久，各自 `/login` | 隔离完整，HOME 本身就是他的 | 要准备镜像或沙箱里的程序，后端自带的沙箱要能嵌套 |

可以借用的组件：Anthropic 开源的 sandbox-runtime（`srt`），Linux 上用 bubblewrap，macOS 上用 sandbox-exec，同时管文件和网络，能包住任意进程。

所以只换目录变量不够：Agent 跑的命令会继承真正的 HOME。omem 第一期就把**整个 HOME 换成这个人的账号目录**，并在 Linux 上用 bubblewrap 启动（不需要 root）：只读挂系统和程序，可写挂他的 HOME 和这次运行的工作目录，别人的账号目录和 omem 数据目录不挂进去。

### 6.6 支持哪些系统

- 第一期只支持 Linux，并且要求装了 bubblewrap、允许非特权用户命名空间（启动时检查一次）。
- 不满足条件的机器（macOS、Windows、没有 bubblewrap 的 Linux）不提供多账号：设置页不显示“我的 AI 账号”和各后端的规则，成员的运行照旧借用本人的后端。
- macOS 以后再看：钥匙串、豆包命令行的数据目录（`~/Library/Application Support`）、sandbox-exec 都要单独验证。
- Windows 以后再看，候选做法（都还没试）：
  - **每人一个本地 Windows 账号**，用那个账号的身份启动 Agent（CreateProcessWithLogon 一类）：文件隔离由系统权限保证，相当于 Linux 上每人一个系统用户。sandbox-runtime 在 Windows 上就是这样做的（还是 alpha）。要管理员建账号，并保存每个账号的登录凭据。优先试这个。
  - **AppContainer**：系统自带的轻量沙箱（浏览器渲染进程用的那种），进程只能访问显式授权的文件、注册表和网络。授权靠给目录加 ACL，Agent 要用的程序、Node、git 都要逐个放行，适配量大。
  - **受限令牌 + ACL**：能限制 Agent 执行的命令往哪里写，但不按人分开，只能作为补充。
  - **Windows Sandbox / Hyper-V 容器**：本质是虚拟机，要专业版或企业版，启动慢，不考虑。
  - 另外要实测各后端在 Windows 上把登录态放在哪（`%USERPROFILE%`、`%APPDATA%`，或凭据管理器）。

### 7. 隔离的边界（重要）

同一台机器、同一个系统用户跑所有人的 Agent 时，账号目录只能防止“串号”（A 的运行用了 B 的账号），**防不了一个能执行命令的 Agent 去读另一个人的账号目录**：它们的文件属于同一个系统用户。

所以成员的运行一开始就放进沙箱（见 6.5）：bubblewrap 里只有这个人的 HOME、需要的程序和这次运行的工作目录，其他人的账号目录和 omem 数据目录看不到。omem 的工具照旧经 MCP 回到宿主，权限仍按这个用户限定。要先验证各后端自带的沙箱在里面还能起来（TraeX 的 socket 目录、豆包沙箱需要的系统调用），起不来的后端不开放多账号。

以后如果有 root，可以换成每人一个系统用户（Clay 的做法），隔离由内核保证，也不再需要嵌套沙箱。

### 7.5 沙箱里的命令规则（以后）

[命令规则](command-gate.md)现在靠在 PATH 最前面放同名包装来拦，它自己写明了拦不住的几种：用绝对路径调用真正的命令、Agent 改 PATH 或改写拦截目录、直接调命令背后的接口。沙箱能把前两种堵上，第三种也能大幅收窄：

- **真正的命令不进沙箱**：受保护的命令在沙箱里只挂成包装（`--ro-bind <包装> <真实路径>`，绝对路径调用也落到包装上），真正的程序和它的配置、令牌（多半在本人的 HOME 下）都不挂进去。
- **批准后由宿主执行**：包装问 omem，放行时由宿主在沙箱外运行真正的命令，把标准输入输出和退出码转回来；工作目录在沙箱内外是同一个路径，所以命令看到的文件一样。这就是 command-gate.md 末尾说的“凭据代理”：令牌只在宿主那边，Agent 拿不到。
- **拦截目录和规则只读**：沙箱里看不到数据目录，包装文件是只读挂载，Agent 改不了。
- **还拦不住的**：Agent 自己带的代码直接调这些服务的接口。命令的令牌不在沙箱里，它多半没有凭据可用；要彻底管住还得过滤网络（sandbox-runtime 用宿主上的代理按域名放行），这一层另做。
- 成员的运行由宿主代执行时用的是本人的凭据，所以成员触发的受保护命令一律要审批，审批卡片上写明“以本人身份执行”。
- 本人自己的运行现在不进沙箱（要用本人的登录和本机的一切）。可以加一个开关，让本人的运行也在沙箱里启动：挂本人的 HOME，只把受保护命令的程序和配置目录挡掉。

前提是第一期的沙箱启动已经稳定；只在支持沙箱的系统上生效，其他系统照旧用 PATH 包装。

### 8. 不做的

- 不在宿主里替后端换凭据、刷新令牌：凭据由后端自己（或插件）管。
- 不把本人的登录复制给成员：刷新令牌可能是轮换的，副本一刷新本人的登录就可能失效。
- 不按用户限额：额度由各平台按账号算，omem 只显示。

## 分期

1. Agent 目录的 `account` 字段（TraeX、豆包命令行、Codex、Claude Code），账号目录（整个 HOME）的建立和删除，bubblewrap 启动和启动前的系统检查，`prepareRun` 按发起人选账号，设置 `agents.accounts`。后台会话池、续用、额度、探测缓存按账号区分。
2. “我的 AI 账号”页面：设备码 / 二维码登录、令牌粘贴、状态、退出；本人的总览。系统不支持时整页不出现。
3. 插件的 `api.agentLogin`（公司插件用它做 TraeX 的公司账号登录）。

## 要先验证的

- 每个后端在独立账号目录里能完成一次完整的 ACP 往返（初始化、建会话、一轮对话）。
- 同一后端两个账号目录同时运行互不干扰；同一个账号在两个目录里同时运行会怎样（有的后端限制单个共享服务）。
- 设备码登录的输出格式（链接和验证码能不能稳定地用正则认出来）。
- 沙箱里没有系统钥匙串（keyring）时，各后端的登录态能不能落在文件里、跨进程保留。有的命令行在没有钥匙串的环境里只把令牌放在内存里，换个进程就要重登。
