# 安装、可选依赖与模型

先在服务机器安装 Node.js 24+。公开发布后，`npm install -g omem` 会安装运行依赖，包含网页服务、PM2、官方 lark-cli 和本地向量推理库；使用时无需克隆源码或安装 Bun。发布包不带 Docling Python 环境或模型权重。是否已经公开发布、在哪些平台实际验收，以项目当前进度为准。

```bash
npm install -g omem
omem setup
omem open
```

准备文档解析或模型前需按下节安装 osdk；只用基础功能无需 osdk，在向导中不勾选任何能力，回车后选择「只用基础功能」即可。向导完成后选择「启动或重启服务」，随后可打开网页；选择「稍后启动」会保存设置，服务需另行启动。成功的首次向导会创建个人配置，无需再执行 init。已有配置保留；基础功能不会安装可选环境或模型。

AI 调查、写作与编码需要另行安装并登录 Agent CLI。先用 `omem agent discover` 检测命令，在网页「能力与连接」选择服务机器可用的 Agent、模型和思考强度；完整步骤见 [Agent 设置](agents.md)。官方 lark-cli 随 npm 依赖安装，但本人仍需执行 `omem lark login`；它的登录与机器人绑定相互独立。

## 用一个 setup 选择能力

普通保存、全文搜索和网页不依赖 osdk、Python 或本地模型。PDF/DOCX 解析和本地模型由 osdk 管理，只有用户明确需要时才执行相应 setup。setup 在当前机器准备资源，不通过 `--url` 安装到另一台服务；远端部署需在服务机器运行。

需要可选解析或模型时，先按 [one-sdk 官方安装说明](https://github.com/lejunyang/one-sdk#install) 安装 osdk。官方提供 Linux/macOS 的 `install.sh` 和 Windows 的 `install.ps1`，安装器校验发布文件的 SHA256，并让用户选择 shell 与存储位置。也可从 [官方 Releases](https://github.com/lejunyang/one-sdk/releases) 取得对应平台版本。安装后重新打开终端，确认服务所在账户能找到命令。

```bash
osdk --version
omem setup
```

用户无需预先单独安装 Python 或 uv；相应 setup 会通过 osdk 准备锁定版本。

向导先显示个人库和配置位置，读取本机资源，再列出四种能力。用方向键移动，空格勾选，回车进入下一步。可以一次选多项，按需要下载；资源显示「已发现」只说明本机已有，不代表完整校验或推理通过。

不勾选任何能力时，下一步提供「只用基础功能 · 初始化个人配置，不安装可选能力」。执行后创建缺失配置，已有配置保持原样，再进入服务启动选择；无需记住 init 或准备 osdk。

| 向导选项 | 子选项与作用 |
| --- | --- |
| documents · 文档解析 | 只准备 Docling 解析环境用于 DOCX，或一起准备 PDF 布局与表格模型 |
| document-models · PDF 模型 | 准备完整布局与表格包，自动加入 Docling 解析环境；当前 OCR 关闭 |
| embedding · 中文向量 | 准备 BGE-small-zh-v1.5；可选准备后启用，或仅准备并保留当前设置 |
| decisions · 快速决策 | 多选 StartLux 2B / 4B / 9B；再选择固定模型、auto 或仅准备 |

决策模型默认预选 2B；可以只选 9B，也可以按需要选任意组合。auto 在已准备的 2B/4B 中按机器余量选择，不使用 9B，也不会临时下载缺少的模型。固定模式可选择本次准备或已发现的模型，实际可用性仍需校验和调用检查。

每个子选项都选好后，向导显示下载和配置计划。选择「返回调整」会保留刚才的选择；「退出」不安装或修改配置。确认执行后依次准备并校验资源，全部成功才保存所选设置。只准备会保留已有开关；首次没有配置文件时，成功向导仍创建默认配置。安装中断保留已完成资源，不保存新的功能设置。

明确启用中文向量会保存 `retrieval.enabled:true` 和 `retrieval.osdkModel:"memory-zh"`；当前已启用的自定义向量模型会在计划中提示切换，重排模型等其他设置保留。明确选择决策模式会保存 `decisions.mode`。配置不合法，包括存在当前版本不支持的字段，会停止并保留原文件；安装期间配置被另一个进程修改，也会拒绝覆盖，请重新运行向导核对选择。

最后可以启动或重启包内 PM2 服务，默认「稍后启动」。已有服务需重启才能读取新开关；由其他管理器运行的服务按原方式重启。PM2 不添加开机启动项，也不能阻止电脑休眠。服务启动失败时资源和已保存设置保留，先查询 `omem service status`，无需重新下载。

个人目录或配置文件可在命令前指定：`omem --data-dir /absolute/path/personal --config /absolute/path/config.json setup`。setup、后续命令和服务应使用相同目标，不在客户端准备后假定远端已安装。向导需要 stdin 和 stderr 都连接交互终端；没有终端时用下节显式形式，不会自动选择或创建配置。

Python 依赖下载使用系统信任证书，适配已在系统中信任公司代理证书的环境；仍会校验证书和锁文件摘要。遇到 `UnknownIssuer` 时检查系统证书是否正确安装；自定义 CA 可按 [uv 官方说明](https://docs.astral.sh/uv/concepts/authentication/certificates/) 设置 `SSL_CERT_FILE` 或 `SSL_CERT_DIR` 后重跑，不关闭证书校验。

StartLux 当前仅支持 Apple Silicon Mac。9B 已提供安装和显式选择，尚未完成本机推理验收；暂按可用内存 28 GiB 才允许加载，该预算还未通过真实推理校准。它不用于后台自动切换。Windows 的 Python 路径已适配，但 Windows/Linux 的全新安装仍需实际验收，不能把路径适配当作平台验证。未安装决策模型或资源不足时保留原流程，由常规 Agent 继续调查。

## 会占用多少空间

下表按当前锁定模型的文件清单估算下载体积。Python、Torch 等依赖和下载缓存另占空间，模型文件体积也不等于运行内存。

| 模型 | 当前模型文件体积 |
| --- | --- |
| 中文 BGE embedding | 约 23 MiB |
| Docling 布局 + 表格 | 约 367 MiB |
| StartLux 2B BF16 | 约 4.26 GiB |
| StartLux 4B BF16 | 约 8.70 GiB |
| StartLux 9B BF16 | 约 18.0 GiB（约 19.33 GB） |
| StartLux 2B + 4B | 约 12.96 GiB |

9B 的体积来自官方文件元数据，未为安装验证下载这份权重。三种都装会超过 30 GiB，另需预留运行环境和缓存空间。

模型来自随包 `config/models.toml` 声明的 Hugging Face 仓库与固定修订；osdk 保存文件摘要。Docling Python 包从锁定的 PyPI 文件安装；StartLux 运行代码从固定 GitHub commit 获取并校验摘要。正常启动、导入和推理不隐式下载。

## 文件放在哪里

安装版默认个人库为 `~/.omem`，`--data-dir` / `OMEM_DATA_DIR` 可更改。

| 位置 | 内容 |
| --- | --- |
| `<个人库>/config.json` | 功能开关、Agent 选择和个人设置 |
| `<个人库>/optional/` | osdk 模型声明、锁与 `.omem-managed.json` 包内资源基线，以及 Python 项目文件 |
| `<个人库>/optional/.osdk/runtime/docling/` | Docling 虚拟环境与 PDF 模型定位资源 |
| `<个人库>/optional/.osdk/runtime/decision/` | StartLux 虚拟环境及固定上游适配代码 |
| osdk 数据与缓存目录 | 共享工具安装、模型不可变快照和下载缓存，按 osdk 的安装设置保存 |

本机 macOS 的模型快照通常在 `~/Library/Application Support/osdk/models/`；Linux 默认数据根为 `~/.local/share/osdk`。用户可在安装 osdk 时选择位置，或按 [osdk 存储说明](https://github.com/lejunyang/one-sdk/blob/main/site/en/guide/storage-shell.md) 配置 `OSDK_DATA_DIR` / `OSDK_CACHE_DIR`。omem 的 `--data-dir` 不自动移动这份共享模型存储，备份个人库也不包含 osdk 安装与权重。

服务必须使用与 setup 相同的账户、osdk 目录及环境。只在另一终端修改环境变量，已经运行的服务不会跟着改变；需要用正确环境重启。不要把个人库或模型权重写进源码仓库。

## 检查与修复

```bash
omem doctor
omem doctor --local --json
omem doctor --local --verify-models --json
```

默认 doctor 检查命令、Python 环境和已下载模型的声明与文件元数据；模型被发现不等于已完整校验，也不等于已能推理。`--verify-models` 额外读取已下载模型文件，核对快照摘要，可能耗时；两种检查都不下载、不加载权重或调用模型。功能是否开启、资源是否安装、字节是否校验分别显示。

未启用且未安装的可选能力只提供准备指引；启用的向量或决策能力缺少资源，或已安装资源损坏，会报告异常。普通 doctor 同时检查服务；初次安装尚未启动服务时用 `--local` 跳过 HTTP，只检查本机资源。服务健康与可选资源状态分开查看，不能仅凭退出码判断模型损坏。

JSON 的 `optional.checks` 每项包含 `enabled`、`installed` 与 `state`。模型的 `discovered` 表示声明、文件清单及大小符合预期；`verified` 表示本次相应校验通过。`missing`、`stale`、`unsupported`、`error` 分别说明未准备、版本不符、平台不支持和需要修复；读取每项的 message / fix，不把 Python 模块导入通过误当作模型已经推理过。

| 遇到的情况 | 处理 |
| --- | --- |
| 找不到 osdk | 按官方说明安装，重新打开终端并检查 `osdk --version`；后台服务也要使用可见的 PATH |
| 解析器未准备 | 在服务机器运行 `omem setup`，选择 documents；需要 PDF 时选择完整解析与模型 |
| 下载失败或中断 | 保留已完成资源，检查终端中失败的来源后重跑同一 setup。不要因为失败就删除个人库 |
| 校验失败 | 依 doctor 显示的模型名与修复建议处理，再运行深度校验；不把损坏文件当作安装成功 |
| 模型已安装却功能关闭 | 重跑向导，选择该能力及准备后启用；已有资源会复用。仅准备与显式组件命令不会改开关 |
| StartLux 内存不足 | 保留常规 Agent 流程，关闭占用较大的应用，或在已安装 2B 时选用 `decisions.mode:"2b"`；不降低准入假装成功 |

## 脚本、Agent 与单项排障

自动化调用使用显式组件，不等待交互输入。这些命令沿用仅准备行为，不创建个人配置、不改变功能开关或启动服务；需要启用时由已授权的配置流程保存并重启。PDF 的显式形式仍需先准备 documents，再准备 document-models。

| 准备命令 | 内容 |
| --- | --- |
| `omem setup documents --json` | Python 3.12.14、uv 0.12.23 与锁定的 Docling 2.133.0 依赖 |
| `omem setup document-models --json` | 固定修订的 Docling Heron / TableFormer |
| `omem setup embedding --json` | 固定修订的 BGE-small-zh-v1.5 量化 ONNX，别名 memory-zh |
| `omem setup decisions --model 2b --json` | StartLux 运行环境和 2B 权重；不写 --model 时也只准备 2B |
| `omem setup decisions --model 4b --json` | StartLux 运行环境和 4B 权重 |
| `omem setup decisions --model 9b --json` | StartLux 运行环境和 9B 权重；仍需明确配置为 9b 才使用 |
| `omem setup decisions --model both --json` | 2B 和 4B |
| `omem setup decisions --model all --json` | 2B、4B 和 9B |

显式组件的 JSON 结果保持原有准备摘要，stdout 输出结果，stderr 输出进度。无参数 `omem setup --json` 仍需要交互终端，在 stderr 显示选择，结束后把计划、准备结果和配置变更写到 stdout；加 --json 不会自动决定选项。脚本不能用没有终端的无参数形式。

手动修改开关时用 `omem config path` 找到实际文件，保留其他设置，再 `omem config validate` 和 `omem service restart`。若显式准备 BGE 后启用，需同时设置 `retrieval.enabled:true` 与 `retrieval.osdkModel:"memory-zh"`；决策模式为 auto / 2b / 4b / 9b。setup 不登录 Agent 或飞书，也不开启消息采集。

## 更新安装

```bash
npm install -g omem@latest
omem service restart
```

npm 升级替换程序和随包资源，保留个人库。需要更新可选环境时重新执行 `omem setup` 并选择所需能力；脚本可重跑显式组件。沿用已完成的下载缓存，不必先卸载整个环境。setup 管理未修改过的包内声明与脚本，保留用户定制，遇到不能自动合并的冲突会说明保留项和新版候选的位置；按提示核对后再准备。不要直接覆盖整份 `optional/osdk.toml`，避免丢掉用户新增模型或下载配置。

模型某一项的任何字段被用户修改后，该模型声明整项保留；修改过的脚本也保留。新版候选固定写入 `optional/.omem-updates/osdk.toml` 和该目录中的 `scripts/`，核对需要更新的项，手动合并后重跑原 setup。已有旧目录没有管理记录时，setup 尝试识别已发布基线，无法识别的内容按定制保留。配置语法有误会停止并说明位置，不覆盖原文件。失败或取消同样保留已经准备的资源，使用 doctor 检查后重跑即可。

`omem skills install <新目录>` 复制当前包的使用技能及全部 references，已复制给其他 Agent 的旧副本不会随 npm 自动更新。使用新目录核对后替换，不覆盖用户定制。模型权重各自的许可证由上游决定，omem 的 Apache-2.0 不更改这些条款。
