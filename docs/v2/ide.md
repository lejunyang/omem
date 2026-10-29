# 编码与评审接入 IDE

目标：交办编码不用每次重装依赖、改动按提交留在工作分支上；评审时能在 VS Code 里直接打开交办的工作区，用编辑器自己的跳转、搜索、Git 面板看代码；最后由 VS Code 插件把发起交办、看过程、评审、应用和推送接到 omem。宿主仍只做数据、调度和权限，插件和网页一样只是客户端。

分三步做：工作分支与工作区、在 VS Code 里打开（桌面版和网页版）、插件第一版，都已实现。

## 一、工作分支与工作区（已实现）

以前的做法：交办在独立 worktree 里改，改动保持“未提交”，完了由本人“应用”成目标分支上的未提交修改，再在网页上提交、推送；复用工作区要在设置里填个数、填目录、开“在主目录里改”。实际用下来：几轮的改动堆在一起不好回溯，应用、提交两步手动，主目录要等应用才看得到，设置项多且容易填错。现在改成每个交办一条工作分支，Agent 自己提交，工作区由 omem 自动管（`src/agents/code-branch.ts`、`workspaces.ts`）。

### 分支

- 每个交办在每个仓库有一条工作分支：
  - 指定了 `from_branch`（已有分支）：在那条分支上接着提交；只在 origin 上有的，先建同名本地分支。
  - 指定了 `branch`（新分支名）：从仓库目录当前的 HEAD 切出这条分支（本地已有同名分支就当作 `from_branch`）。
  - 都没指定：从仓库目录当前的 HEAD 切出临时分支 `omem/<运行id>`，编码 Agent 按功能用 `git branch -m` 改成合适的名字，宿主在这一轮结束时读回分支名。网页的分支面板也能改名。
  - 起点是仓库目录的本地 HEAD，不 fetch：本地没推送的提交也包括在内。
- 编码 Agent 按功能分几次提交（遵守仓库的提交规范），不 push。一轮结束时，宿主把剩下没提交的改动（含检查命令改出来的）提交成一个“第 N 轮未提交的改动”。每轮至少一个提交，出了问题在后面的轮次再改，回溯看提交历史。
- 评审、diff、改动规模和检索都按“分支相对切出点”算：新分支是和切出时所在分支的分叉点，`from_branch` 是交办开始时的提交。
- 同一仓库里还没确认的其他交办（分支名、标题、状态）写进编码任务。分支是同一个仓库的，需要别的交办的改动时 Agent 可以 `git log` / `git cherry-pick`。

### 工作区

- 不再设置个数和目录。交办要工作区时，先借 omem 自建的空闲工作区（数据目录 `workspaces/<空间>/<n>`）；都占着就新建一个，最多 4 个；到了上限，就收回一个闲着的（借它的交办不在运行、工作区干净、HEAD 在某条分支上）。下一轮再借时，切到自己的分支接着做。全满时临时在 `runs/<id>/work` 下新建 worktree，用完删掉。
- 工作区归还时保留被忽略的文件（`node_modules`、构建缓存）。准备命令（`setupCommand`）不填时按锁文件自动选：`pnpm install --frozen-lockfile --prefer-offline`、`yarn install --frozen-lockfile`、`npm ci`、`bun install --frozen-lockfile`。命令和锁文件跟上次一样就跳过，填 `none` 表示不准备。
- 每轮开始时把工作区放到分支最新的提交上：分支没在别处检出，就直接检出它（Agent 的 commit 和改名都是普通的 Git 操作）；分支正在仓库目录或别的工作区检出（本人在那里跑服务验证），就以游离 HEAD 停在分支末端，Agent 照常提交。一轮结束，宿主把提交放回分支：
  - 分支检出在仓库目录：在那里 `merge --ff-only`。本人没提交的、和这些提交不冲突的改动会保留。快进不了的（本人在那里也提交了，或者改了同一批文件），通知本人，提交留在工作区；下一轮先把分支合并进来再改。
  - 分支没有检出：`update-ref` 移过去，带旧值校验。
  - 之后工作区回到游离状态，分支随时可以在仓库目录检出。
- 分支面板的“在仓库目录检出”把仓库目录切到这条分支（目录要干净）。之后每轮的提交都会快进到那里，可以直接在仓库目录启动服务验证。

### 确认

- 没有“应用”和“提交”这两步，只有最后的“确认”：可以先把这条分支压缩成一个提交（填提交信息），然后推到 origin 的同名分支并设成上游。已经推过、又压缩或变基过的分支，按上次拉取的远端状态带 lease 强推。确认后归还工作区，保留分支。没有 origin 时只在本地确认。
- 确认之前，分支面板上可以：改名、在仓库目录检出、压缩、合并或变基到另一个分支（排一轮同步，冲突交给编码 Agent，它解决不了再找本人，`code-sync.ts`）、丢弃。丢弃会归还工作区；分支是这次交办新建的、还没推送、也没在别处检出，就一起删掉。
- 交办挂的事项结束（完成、取消、过期）时，归还它没确认的交办占着的工作区，分支保留，之后还能再续。
- 接口：`GET /api/runs/:id/branch`（每个仓库的分支、切出点、提交、推送状态、检出位置）、`POST /api/runs/:id/branch`（`rename` / `checkout` / `squash`）、`POST /api/runs/:id/sync`（合并或变基到某个分支）、`POST /api/runs/:id/apply`（确认，可带 `squash` 提交信息）。助手用 `code_branch`（状态、改名、检出、压缩、合并 / 变基）和 `apply_code_run`（确认并推送）。

### 以前的交办

这次之前开始的交办（工作区里是未提交的改动）照旧：应用、接收工作区、网页上的提交面板、“移到目标分支最新提交”都还在，直到它们被应用或丢弃。它们借的本人目录和仓库主目录同样照旧归还。设置里的 `pool`、`workspaces`、`inPlace` 不再起作用。

### 其他

借用的细节没变：租约是工作区自己 git 目录里的 `omem-lease.json`，运行在 `runs/<id>/work/<空间>` 得到一个指向它的链接（Windows 用 junction），租约只在链接存在且指向它时有效。设置在“设置 → 空间 → 编辑”（仓库空间），那里只有仓库目录（可换目录）、准备命令和各工作区的状态。接口是 `GET /api/spaces/:id/workspaces`，助手用 `set_code_workspaces`（只设准备命令）。

清理（`clean_code_runs`，`src/agents/code-cleanup.ts`）：先列出没确认（或没应用）也没丢弃、工作区还在的交办，旧交办的接收工作区（要求时才列），以及 `runs/` 下没有对应交办的遗留 worktree。本人同意后，按运行 id 只处理这些。进行中的不列入。

同一仓库的另一份目录（`connect_repository`）：按 `git remote` 认。https 和 ssh 两种写法、大小写、`.git` 后缀都算同一个。已有空间时不新建，返回那个空间。`relink: true` 或设置页的“换目录”把空间改关联到新目录（`repo-relink.ts`）：进行中的交办拒绝；没确认的交办先列出来，本人同意丢弃后再换；omem 自建的工作区随旧仓库删掉。

`omem peer pull` 不需要改：快照按 `runs/*/work/*` 收集，链接按真实路径读出，在另一台机器上恢复成普通目录。

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
- **界面语言**（`src/server/ide-locale.ts`）：VS Code 的界面文字是一个按位置取的数组（服务端的 `out/nls.messages.json`，键在 `nls.keys.json`），每一版都不同。浏览器不是英文时，serve-web 的页面从微软的 CDN 取翻译好的数组（`www.vscode-unpkg.net/nls/<提交>/<版本>/<语言>/nls.messages.js`）。2026-10 的 1.143、1.144 两版，CDN 给的数组分别有 26299、27686 项，服务端是 24284、25233 项（市场上最新的中文语言包是 1.131），按位置一取，菜单、命令面板、对话框的文字全是别处的（“粘贴”显示成“剪切”，资源管理器的标题是一句提示语）。这和装没装语言包、语言包版本无关：没有和服务端同一版的语言包可取。现在 omem 改写 serve-web 的页面，不让它去 CDN 取，改成 `/ide/_omem/nls/<提交>/<语言>.js`：按 VS Code 自己生成服务端翻译的办法（`resolveNLSConfiguration`），对这一版的每个键取已装语言包（`ide/server/extensions` 里登记的、该语言最新的一个）里同一个键的翻译，没有就用英文。语言包比服务端旧，只是新加的文字是英文，不会错位；结果按服务端提交、语言、语言包版本缓存在 `ide/nls/`，服务端或语言包一换就重新生成。没装这个语言的语言包时页面是英文，VS Code 会提示装，装好刷新后生效。语言仍按 VS Code 自己的规则定（`vscode.nls.locale` cookie，否则浏览器的 Accept-Language）。
- **omem 插件**（`src/server/ide-setup.ts`）：每次启动 serve-web 前，把仓库 `vscode/` 的插件装进 `ide/server/extensions/omem.omem-vscode-<版本>`：用仓库里的 TypeScript 逐个文件转成 CommonJS（不做类型检查；没有 TypeScript 时用已构建的 `vscode/out`），带上 package.json、README、图标，按 VS Code 的格式登记进 `extensions.json`，清掉它扫描用户扩展的缓存。目录里记着源码摘要，摘要没变就不动，所以 omem 更新重启后第一次打开网页版时换成新的。serve-web 带着 `OMEM_URL`（这台 omem 的回环地址）、`OMEM_TOKEN`（配了令牌时）、`OMEM_HOME` 启动，扩展宿主继承这些环境变量；插件的“这台机器上的 omem”在没设 `omem.port` 时就连 `OMEM_URL`，令牌也从这里来，状态栏显示“打开这个网页版 VS Code 的 omem”。插件声明支持受限模式（`untrustedWorkspaces`），没信任文件夹时也能用。`ide.web.omemExtension: false` 不装。
- **沿用这台机器上的设置**：网页版的服务端设置文件 `ide/server/data/Machine/settings.json`（设置里的“远程”一栏，除了只能在应用级设的项，都对网页版生效）还不存在时，从这台机器上第一个有设置的地方拿一份：Remote-SSH 的 `~/.vscode-server/data/Machine/settings.json`（Insiders 同理），否则桌面 VS Code 的用户设置。去掉 `omem.*` 几项（那边怎么连 omem 和这里无关），来源记在旁边的 `.omem-seeded.json`。之后不再同步，网页版里改的是它自己的。`ide.web.reuseSettings: false` 不拿。
- **沿用扩展**（`ide.web.reuseExtensions: true`，默认关）：启动前把 Remote-SSH（`~/.vscode-server/extensions`）和桌面 VS Code（`~/.vscode/extensions`）登记的扩展里，平台对得上（通用或本机的 `<系统>-<架构>`）、`engines.vscode` 允许当前服务端版本、网页版里还没有的，各复制一份并登记。每个扩展只拿一次（记在 `ide/reused-extensions.json`），网页版里卸掉的不会再装回来。不直接共用那边的目录：两个不同版本的服务端会各自改 `extensions.json`、升级或清理对方要用的扩展。
- **遗留的服务端**：serve-web 被强杀时，它启动的服务端（`server-main.js`）不一定跟着退出（常驻服务器上见过只剩服务端在跑）。启动前按 `--server-data-dir <omem 的 ide/server>` 和 `--server-base-path /ide` 认出这类进程并结束。
- **终端**：终端经管理连接（同一条 WebSocket）走，第一次建终端时服务端才启动 pty host 并写 `ptyhost.log`。本机（Windows）直连和经 `omem peer open` 一跳转发都试过：新建终端、运行命令正常；文件夹没被信任（受限模式）时会先问一次，点“取消”终端照样打开。常驻服务器上之前的几次会话里都没有 `ptyhost.log`，也没有 pty host 进程，说明终端请求从没到过服务端；当时菜单和对话框文字全错位，找不到“新建终端”。`omem peer call <它> ide '{}'` 的 `logs.sessions` 能看到哪次会话建过终端。
- **限制**：
  - 网页 VS Code 自带终端和扩展宿主，等于这台机器的命令行，也限制不了只看某个目录。所以只对本人开放，成员、访客的接口白名单里没有它。
  - 快捷键、代码片段、主题这类用户数据，网页版存在浏览器里（按地址分开，`peer open` 换了端口就是另一份），服务端放不进去，omem 不复制。要和桌面一致，官方的办法是在网页版里登录同一个 GitHub 或微软账号打开“设置同步”（客户端里带着微软的同步服务配置；登录流程没有验证过）。
  - `omem peer call <它> ide '{}'` 列出这台机器上可沿用的来源：设置的键数、桌面版快捷键条数和片段文件名、各扩展的版本 / 平台 / 能不能用及原因（只有名字和数量，不含内容），以及界面翻译了多少条（`interfaceStrings`）、omem 插件是不是最新（`omemExtension`）。

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
