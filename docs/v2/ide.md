# 编码与评审接入 IDE

目标：交办编码不用每次重装依赖；评审时能在 VS Code 里直接打开交办的工作区，用编辑器自己的跳转、搜索、Git 面板看代码；最后由 VS Code 插件把发起交办、看过程、评审、应用和推送接到 omem。宿主仍只做数据、调度和权限，插件和网页一样只是客户端。

分三步做：复用工作区、在 VS Code 里打开（桌面版和网页版）、插件第一版，都已实现。

## 一、复用工作区（已实现）

每次交办在 `runs/<运行id>/work/<空间>` 新建 worktree，被忽略的文件（`node_modules`、构建缓存）不会跟着来，大仓库每次都要装依赖。仓库空间可以把几个长期存在的 worktree 借给交办用（`src/agents/workspaces.ts`）：

- **`pool`**：omem 自建的数量（0–8），第一次用到时在数据目录 `workspaces/<空间>/<n>` 下 `git worktree add --detach`。
- **`workspaces`**：本人已有的工作区目录（已经装好依赖的那几个）。必须是这个仓库 `git worktree add` 出来的（和仓库共用提交记录）；仓库主目录用下面的 `inPlace`。列进来的若是同一仓库（remote 相同）的另一份克隆，设置页标成“不可用”并给出“设为仓库目录”：交办的起点、分支和应用都在空间的仓库目录上，另一份克隆的提交记录对不上，所以要换就换掉空间的目录（`POST /api/spaces/:id/relink`，`repo-relink.ts`）。换目录时进行中的交办拒绝；没应用的交办在旧仓库里有工作区，列出来由本人确认丢弃后再换；omem 自建的复用工作区随旧仓库删掉，新目录从复用列表里去掉，代码重新导入。
- **`inPlace`**：仓库主目录本身，排在最前。主目录干净时借给交办，运行就在它当前的分支上改（`from_branch` 不同时先切到那个分支），不建 `omem/<运行id>` 分支；应用时改动已经在目标分支的目录里，不再打补丁，只交回租约、不重置；丢弃和别的工作区一样重置并回到原分支。主目录有改动、分支对不上或切不过去时，这次改用下一个工作区或新建。
- **`setupCommand`**：准备命令。编码前在每个工作区检查一次：命令和锁文件（`pnpm-lock.yaml`、`package-lock.json`、`Cargo.lock`、`go.sum`、`uv.lock` 等，按 Git 索引里的版本）与上次成功运行时一样就跳过，否则运行。新建的 worktree 没有记录，总会运行。失败不中止，编码 Agent 会收到失败输出。

借用过程：

1. 依次看候选目录：已有目录优先，然后是自建的。目录无效（不存在、不是工作区根目录、不是这个仓库）的跳过并在运行里说明。
2. 租约是工作区自己的 git 目录里的 `omem-lease.json`（运行 id、空间、借出前的分支），用排他创建写入。运行在原来的位置 `runs/<id>/work/<空间>` 得到一个指向它的链接（Windows 用 junction）；租约只在这个链接存在并指向它时有效，所以运行目录被删、上次没归还的租约都会自动失效。
3. 本人的目录有未提交改动（含未忽略的未跟踪文件）就不借；自建的目录直接清掉上次残留。
4. 在工作区里 `checkout -B omem/<运行id> <基线>`（评审分支则 `--detach` 到分支末端再 `reset --soft` 到分叉点），后面的同步、编码、检查、评审、diff、索引都和新建 worktree 一样。Agent、检查和准备命令的工作目录用真实路径，不经过链接。
5. 应用或丢弃时归还：删除链接，`reset --hard`、`clean -fd`（不带 `-x`，忽略的文件保留），回到借出前的分支（自建的回到游离状态），删除租约，再删 `omem/<运行id>` 分支。
6. 都被占用时照旧新建 worktree。

设置在“设置 → 空间 → 编辑”（仓库空间），下面列出每个工作区的状态：空闲、使用中（链到运行）、第一次用到时创建、不可用、有改动。接口 `GET /api/spaces/:id/workspaces`。助手用 `set_code_workspaces` 改同样的几项。

清理（`clean_code_runs`，`src/agents/code-cleanup.ts`）：列出没应用也没丢弃、工作区还在的交办（复用工作区和主目录给出真实路径和改动文件数），已应用交办在 `runs/<id>/applied/` 下的接收工作区（要求时），以及 `runs/` 下没有对应交办、或交办已应用 / 丢弃的遗留 worktree。先列清单，本人同意后按运行 id 只处理这些：丢弃走 `discardCodeRun`，接收和遗留的 `git worktree remove --force`，最后 `worktree prune`。进行中的不列入。

同一仓库的另一份目录（`connect_repository`）：按 `git remote` 认（https 和 ssh 两种写法、大小写、`.git` 后缀都算同一个）。已有空间时不新建，返回那个空间；`relink: true` 把空间改关联到新目录，前提是它没有进行中或没应用的交办（工作区属于原来的仓库），omem 自建的复用工作区一起删掉，下次在新仓库上重建。

`omem peer pull` 不需要改：快照按 `runs/*/work/*` 收集编码工作区，链接按真实路径读出，在另一台机器上恢复成普通目录；那台机器上没有对应租约，归还时只删目录。空间设置会随数据拉到别的设备，那里不存在的目录会被跳过。

## 二、在 VS Code 里打开工作区（已实现）

### 桌面 VS Code（已实现）

桌面版能连远程的方式只有几种：Remote-SSH、Remote Tunnels（`code tunnel`，经微软的中继，用 GitHub 或微软账号登录）、WSL、Dev Containers。omem 管不了 VS Code 的连接，只负责给出能直接打开的链接：

- 本机：`vscode://file/<工作区路径>`
- 远程设备：`vscode://vscode-remote/ssh-remote+<SSH 主机别名><工作区路径>`，要先在 `~/.ssh/config` 里能连上；需要跳板的用 `ProxyJump`。

编码运行的页头有“在 VS Code 中打开”（`web/src/components/OpenInIde.vue`、`lib/ide.ts`）。`GET /api/runs/:id/folders`（只对本人）给出能打开的目录：工作区还在时是工作区的真实路径（复用工作区就是那个目录，VS Code 的 Git 面板直接认得它），应用后是接收位置；还带上 `local`（请求来自本机回环且没带令牌，网页就在这台机器上）和这台机器的主机名。

- 网页在本机：直接用本地链接。
- 网页在别的电脑上（局域网链接、`omem peer open`）：第一次点时要填这台机器在那台电脑上的 SSH 主机名，存在那台电脑的浏览器里，按 omem 机器的主机名区分。主机名是看的人那边 `~/.ssh/config` 里的名字，所以不放在 omem 的配置里。
- 编辑器可选 VS Code、VS Code Insiders、Cursor，链接格式相同，只换协议名；本人打开了网页版时还可以选“网页版 VS Code”（见下）。

插件的运行列表也放同样的入口。

不建议依赖 Remote Tunnels：鉴权在微软那边，不归 omem 管，公司网络也常常拦。

### 网页版 VS Code（已实现）

用官方的 `code serve-web`，鉴权全由 omem 做（`src/server/ide-web.ts`）。编码运行的“在 VS Code 中打开”里一直有“网页版 VS Code”这一项（只对本人，不另设开关）。选它时齿轮面板里显示 omem 那台机器上要用的 VS Code 命令行（`GET /api/ide/cli`：配置的 `ide.web.command`，或自动找到的路径），可以就地填路径（存进配置）；找不到时面板里提示，打开时返回一句说明。

- **启动**：第一次用到时启动 `serve-web --host 127.0.0.1 --port <随机空闲端口> --connection-token <随机> --server-base-path /ide`，数据放在数据目录的 `ide/`。CLI 依次找 `ide.web.command`、`code-tunnel`（桌面版 `code` 旁边的那个 CLI 本体；Windows 上的 `code.cmd` 会启动桌面程序）、`code`（服务器上的独立 CLI）。第一次打开页面时 serve-web 从微软下载对应版本的服务端，这段时间 omem 返回一个会自动刷新的等待页。
- **入口**：页面上是一个普通链接 `/api/ide/open?folder=<路径>`（不在本机时带令牌查询参数，和下载链接一样），新标签页打开。它只对本人开放：启动 serve-web，给浏览器一个 `Path=/ide`、HttpOnly 的会话 cookie，再跳到 `/ide/?folder=…`（Windows 路径换成 `/e:/…`）。
- **代理**：`/ide` 下的 HTTP（不解析请求体）和 WebSocket 升级都原样转给 serve-web。放行条件：会话 cookie 有效，或请求来自本机回环、没带令牌且 omem 没配令牌（和 API 的本机信任一致）。转发时去掉 omem 的 cookie 和 Authorization，加上 serve-web 认的 `vscode-tkn` cookie，所以 connection token 不出 omem。会话在内存里，omem 重启后从网页重新点一次。
- **进程**：WebSocket 任一端断开就关掉两端；停服时连同 serve-web 启动的服务端整棵进程树一起结束；pid 记在 `ide/serve-web.pid`，被强杀或被 watch 重启的 omem 下次启动前先结束遗留的那个（核对命令行确实是带 connection token 的 serve-web 才动）。
- **经 `omem peer open`**：`/ide` 和 `/api/ide/open` 不走 fetch 式的转发（它跟随跳转、只转部分请求头、不转 WebSocket），而是原样转发（`src/core/peer-tunnel.ts`）：本机的 `peer open` 把请求连同 WebSocket 升级发给路上第一台直连的设备，带配对令牌；中间设备在 `/api/peers/<id>/ide…` 上同样原样转给下一台（升级请求不经过钩子，单独核对本人令牌，最多 4 跳）。目标设备上本人令牌也能进 `/ide`。所以常驻服务器经中转也能用网页版。
- **地址**：serve-web 按请求的 Host 告诉浏览器 WebSocket 连哪里，omem 转发时要把 Host 改成它的回环端口，所以另带 `X-Forwarded-Host`（浏览器实际用的地址，经 `peer open` 时由第一跳加上、之后各跳不改）。少了它，浏览器会去连 `127.0.0.1:<serve-web 端口>`：在 omem 那台机器上碰巧能连上，换一台就是 1006 断开。
- **开发**：Vite 的 `/ide` 代理开了 `ws`。
- **限制**：
  - 网页 VS Code 自带终端和扩展宿主，等于这台机器的命令行，也限制不了只看某个目录。所以只对本人开放，成员、访客的接口白名单里没有它。
  - 浏览器语言是中文时，serve-web 从微软拉的中文语言包可能和服务端版本对不上，界面文字错位；是上游的问题，在 VS Code 里“配置显示语言”换成英文即可。
  - 设置和扩展不是桌面 VS Code 的：网页版的用户设置、主题、快捷键存在浏览器里（按地址分开，`peer open` 换了端口就是另一份），扩展装在 omem 那台机器的 `ide/server` 下。官方的办法是在网页版里登录同一个 GitHub 或微软账号打开“设置同步”（客户端里带着微软的同步服务配置；登录流程没有验证过）。

## 三、VS Code 插件（第一版已实现）

插件放在仓库的 `vscode/`（独立 package 和锁文件，和 `site/` 一样）。它只调 omem 的 HTTP API（运行事件用 `GET /api/runs/:id?after=` 轮询），缺的接口在宿主补，同样按 `scopeFor` 限定空间。

### 连接

- 设置项 `omem.connection` 选连接方式，每种只用到自己的那一两项；命令“omem：连接 omem…”（状态栏左下的 omem 也能点开）按方式一步步填，填完试连：
  - **这台机器上的 omem**（`local`，默认）：插件所在机器的 omem，只有端口（`omem.port`）。`extensionKind: ["workspace", "ui"]` 让 Remote-SSH / WSL / 容器窗口里的插件跑在那边，所以连到 omem 那台时也选这个，走本机信任；默认端口没人应答才问端口，omem 配了令牌才问令牌。
  - **粘贴配对码或链接** / **填地址和令牌**（`direct`）：另一台机器的 omem（`omem.url`）。`omem link` 的链接或 `omem peer invite` 的配对码整段粘贴，逐个地址试连，第一个能用的留下。令牌按服务地址存在 SecretStorage，换来换去各自保留。
  - **本机配对的设备**（`peer`）：从本机 omem 数据目录的 `secrets/peers.json` 里选（`omem.peer`；数据目录按 `omem.home`、`OMEM_HOME`、`~/.omem` 找），插件照 `omem peer` 的走法直接连：直连的设备用它的地址和配对令牌（当前地址不应答时试配对码里的其他地址），`via` 的设备发到中间设备的 `/api/peers/<id>/…`。本机 omem 服务不用开；这台电脑上没有数据目录时才经本机服务的 `/api/peers` 转发。网页链接这时改成提示用 `omem peer open`。
- 状态栏显示连上没有，悬停看连的是哪台；没连上时“交办”视图只显示“连接 omem”按钮。
- 路径：omem 给的是它那台机器上的路径。连本机时就是本地文件；Remote-SSH 窗口里换成该窗口的远程地址；连别的机器（`direct` / `peer`）时用 `omem.sshHost`（`~/.ssh/config` 的 Host）拼成 `vscode-remote://ssh-remote+<host>/…`，当前窗口已连在那台上时不用填。不在那台机器上的文件夹不会被认成交办的工作区。
- 当前文件夹对应哪个运行：`GET /api/code-runs/at?folder=<路径>`（`code.ts` 的 `codeRunsAt`），按工作区的链接路径、复用工作区的真实路径和应用后的接收位置反查，返回各轮运行。

### 交互：网页的做法换成 VS Code 自己的

网页里选中文字会浮出“提问 / 加入修改点”，引用在侧边抽屉里逐层打开。VS Code 里不做浮层，用编辑器原生的位置：

| 网页 | VS Code |
| --- | --- |
| 选中文字浮出“就选中内容提问” | 选中后按 `Ctrl+Alt+A` 或右键“问 omem”：在这段代码上开一个评论线程（Comments API），在线程里输入问题，回答流式写回同一线程。问答挂在代码上，之后翻回来还在 |
| 选中加入修改点、修改篮 | 同一个菜单里的“加入修改点”：也是一个评论线程，标成“修改点”。侧栏“修改单”视图列出评审问题和修改点 |
| 评审问题列表，选“改 / 暂不改 / 不改” | 评审问题按 `文件:行` 显示成评论线程，线程标题上三个按钮；“不改”弹输入框写理由。修改单视图里同样能改，视图标题上“开始修改”（可附补充要求） |
| 引用抽屉，多处引用逐处跳 | 代码引用直接打开文件到行；一个论断对应几处时用 Peek（`editor.action.peekLocations`）。文档类原件用虚拟文档（`omem-src:` 协议）在旁边一栏打开 |
| 变更点树，点一组高亮代码 | 侧栏树视图，和网页一样可折叠；点一项给相关行加装饰，并 Peek 列出各处 |
| 改动文件树和 diff | 交办工作区本身就是 Git worktree，改动相对基线暂存着（分支评审也是），VS Code 的源代码管理面板直接显示，不另做 diff |
| 活动、各评审项的过程 | 每个运行一个输出通道显示流式过程；状态栏显示“第 2 轮 · 评审中”，点开运行概览 |
| 运行概览、结论 | Markdown 虚拟文档；长结论不放进树里 |
| 发起交办 | 命令“omem：交办编码”：仓库按当前文件夹预选，任务写在一个临时 Markdown 文档里（可以从代码里拖引用进来），文档顶部 CodeLens“提交交办”；档位、从哪个分支开始改用快速选择 |
| 补充、改评审档位、叫停 | 运行视图上的行内按钮，对应 `message_code_run`、`set_code_review`、`stop_code_run` 的接口 |
| 应用、提交、推送 | “应用到原分支”和“提交 / 推送”调现有接口；也可以在工作区里用 VS Code 的 Git 面板自己提交，推送完全自己控制 |

诊断（Problems 面板）默认不用：评审问题混进 lint 结果里不好分，按需打开。

### 第一版（已实现）

范围：运行列表（含打开工作区、在网页中查看）、评审问题评论线程与改 / 暂不改 / 不改、选中提问和修改点、开始修改、发起交办、状态栏与过程输出。上表里的引用 Peek、文档类原件、变更点树、补充 / 改评审 / 叫停、应用和推送还没做。

- 代码：`vscode/src`。`current.ts` 认出当前交办并把评审里的路径对到本地文件（几个仓库时路径可带空间前缀）；`review.ts` 是评论控制器和“修改单”视图（线程 contextValue：`finding` / `finding-<决定>`、`draft`、`asked`、`fixpoint`）；`runs.ts` 交办列表；`progress.ts` 状态栏和输出通道；`delegate.ts` 任务文档与 CodeLens。
- 评审问题取最新一轮（往前找到有评审的一轮），加上之前各轮标了“暂不改”的；合并掉的和负责人驳回的不显示。阻断、严重的线程默认展开。
- 提问：每个线程一个问答会话（`POST /api/ask`，带上文件行号、代码片段，在评审问题的线程里还带上问题本身），末尾附和网页同样的“关于交办运行……只回答”说明，所以网页的问答里也看得到；轮询会话等回答，写回线程。
- 修改点只存在这个窗口里，“开始修改”时连同标了“改”的问题 `POST /api/runs/:id/fix`，之后跟随新一轮。
- 交办只支持单个仓库空间；几个仓库一起改的仍在网页或问答里交办。
- 测试：`vscode/test/run.mjs` 用 `test/seed.mts` 起一个带演示交办和评审的 omem（假 ACP Agent），在真实 VS Code 里跑 `test/suite.cjs`：认出交办、问题挂在行上、标“改”、选中提问拿到回答、记修改点并开始修改、写任务文档交办。线程标题按钮、右键菜单这些界面贡献没有自动化覆盖。
