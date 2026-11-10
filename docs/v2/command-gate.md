# 命令规则：拦截 Agent 执行的命令，审批后放行

有些命令会改敏感数据（改线上配置、删数据、发布）。后端自带的命令审批只管它自己看得到的那一层：Agent 在脚本里起的子进程看不到，“完全访问”模式下后端干脆不问。命令规则在更低的一层拦：Agent 进程的 PATH 最前面放一个同名的包装，它先问 omem，按规则放行、拒绝或等人批准。

## 设置

设置 → 安全 → 命令规则（`security.commandRules`，只有本人能改：`GET/PUT /api/security/command-rules`；`PUT /api/settings` 不改它，Agent 的工具也没有能写它的）。每条规则：

| 字段 | 含义 |
| --- | --- |
| `command` | 命令名（经 PATH 查找的可执行文件名，不带路径；Windows 不分大小写） |
| `args` | 参数模式：正则，对按空格连起来的参数匹配；留空 = 任何参数 |
| `action` | `approve` 需要审批 / `deny` 一律拒绝 / `allow` 放行 |
| `approver` | `owner` 本人；`user:<id>` 某个 omem 用户；`lark:<名字或邮箱>` 某个飞书用户（解析方式同规则脚本审批）；`run` 由运行提名 |
| `approvers` | `run` 时可以被提名的人（同上的写法）；Agent 用环境变量 `OMEM_APPROVER=<名字、邮箱或 id>` 提名，不在名单里改由本人批准；提名别人时本人也收到通知 |
| `waitSeconds` | 包装阻塞等审批的时间，默认 90，最多 300（低于 Agent 的无活动看门狗） |
| `expireHours` | 卡片的有效期，也是批准后授权的有效期，默认 24 |
| `reuse` | `once`：批准一次放行一次；`window`：有效期内同样的命令都放行 |
| `note` | 给审批人看：这条命令会改什么 |

规则从上到下匹配，第一条命中的生效，都不命中就放行；`allow` 用来在更宽的规则前开口子（如先 `acmectl ^status\b` 放行，再 `acmectl` 需要审批）。命令名和参数模式是本人的配置，只存在数据目录里。

## 怎么拦

- 包装（`src/agents/command-gate.ts`）：每次启动 Agent 运行时按当前规则在 `<数据目录>/bin/guarded/` 生成每个受保护命令的同名包装（Unix 是 `#!/bin/sh` 脚本；Windows 是 `<名>.cmd`，另有一个给 Git Bash 用的无扩展名脚本），删掉不再受保护的；它们都去跑 `<数据目录>/bin/command-gate.mjs`（只用 Node 内置模块）。没有规则时不生成，也不改 PATH。
- PATH：`agentToolEnv`（runner 给所有后端的 Agent 进程，包括 `claude-cli` / `codex-cli` 后备）把拦截目录放在最前面，`withAgentPath` 加别的工具目录时也保持它第一；规则的 `script` 动作同样带上，并为这次脚本发一个不含任何工具的令牌，只用来让拦截认出是哪次运行。
- `command-gate.mjs` 把命令名、参数、目录、`OMEM_TOKEN`、`OMEM_APPROVER`、`OMEM_REASON`（Agent 可选填的原因）发给 `POST /api/command-gate`（只接受本机发起的连接和有效的运行令牌），按回答：
  - `allow`：在去掉拦截目录后的 PATH 里找到真正的命令并执行（继承标准输入输出，透传退出码和信号）；找不到就报错。
  - `deny`：退出码 126，打印原因。
  - `pending`（等了 `waitSeconds` 还没批）：退出码 126，提示“这条命令需要 <审批人> 批准，审批卡片已发出；批准后会唤醒你，届时原样重新执行这条命令。不要改用其他路径或方式绕过。”
  - 没有令牌、连不上 omem、看不懂回答：一律拒绝（fail closed）。

## 审批

- 服务端先看有没有已批准、还在有效期内、没用过（`once`）的授权：同一条运行链（同一个会话；不在会话里的按父运行一路找到最初那次）加同一个命令与参数的哈希。有就放行，`once` 的随即作废。
- 没有就建一个提问（`asks`，`kind = approval`，`context.handler = "command-gate"`）：网页上审批人的“等你回答”里能批；飞书由机器人给审批人发卡片（完整命令、目录、发起它的运行与链接、Agent 填的原因、规则说明），只有审批人和本人能点；同一条命令在同一条运行链里还在等时不再发第二张。批准、拒绝、过期都会把卡片改成结果。
- 等待期内有结果就直接回答包装。等待结束以后才批准：记下授权，并唤醒发起的运行（`wakes.ts` 的 `fireWake`：会话里的续一轮，Agent 档案的续上它的会话），说明“<审批人> 已批准命令 `…`，请原样重新执行”；之后才拒绝或过期也一样告诉它。运行不在会话里、也不是档案运行的，通知本人。
- 过期：每个提问建时设一个定时器，心跳也会扫一遍（定时器不跨重启）。
- 记录：每次放行、发出审批、批准、拒绝、超时返回、过期都写 `audit_events`（`command.allow|ask|approve|reject|deny|pending|expire`；detail 有命令名、参数哈希、目录、运行 id、审批人、结果，不存参数原文），并在该运行的运行记录里记一条状态，运行页能看到。

## 边界

能拦住经 PATH 查找的调用：shell 直接执行、shell 脚本、Python 的 `subprocess`、Node 的 `spawn` / `execFile`、Makefile 等。拦不住：

- 用绝对路径调用真正的命令；
- Agent 自己改 PATH、删掉或改写拦截目录里的文件、改数据目录里的配置；
- 直接调命令背后的 HTTP 接口或库；
- Windows 上不经 shell 的调用：Node 不带 `shell` 的 `execFile`、Python 列表形式的 `subprocess` 只找 `.exe`，真正的命令是 `.exe` 时会绕过 `.cmd` 包装（cmd、PowerShell、Git Bash 里按名字执行能拦住）；
- 已经在运行的 Agent 进程：PATH 在进程启动时定下，原来没有规则时，要等它重新启动（会话进程空闲释放或换会话）。

它防的是误操作和“默认路径”，不是对抗性的 Agent。`roles/_common.md` 要求被拦时按提示等审批、不要换写法绕过。更硬的边界是凭据代理：令牌不放在 Agent 进程能读到的地方，只在批准后由宿主注入给那一条命令——这不在这一版里。

## 测试

`test/command-gate.test.ts`：临时目录里的假命令 `acmectl`、生成的包装、真实启动的 omem 服务；覆盖未命中放行、等待期内批准 / 拒绝、超时后批准触发唤醒和重跑放行、`once` / `window`、`bash -c` / Node `execFileSync` / Python `subprocess` 里的调用、规则脚本、绝对路径绕过（边界）、没有令牌或连不上时拒绝、只有本人能改规则。Windows 上 Node 和 Python 的用例改用 `shell: true`（原因见上）。
