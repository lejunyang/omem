# 安装、可选依赖与模型

先在服务机器安装 Node.js 24+。公开发布后，`npm install -g omem` 会安装运行依赖，包含网页服务、PM2、官方 lark-cli 和本地向量推理库；使用时无需克隆源码或安装 Bun。发布包不带 Docling Python 环境或模型权重。是否已经公开发布、在哪些平台实际验收，以项目当前进度为准。

```bash
npm install -g omem
omem init
omem service start
omem open
```

AI 调查、写作与编码需要另行安装并登录 Agent CLI。先用 `omem agent discover` 检测命令，在网页「能力与连接」选择服务机器可用的 Agent、模型和思考强度；完整步骤见 [Agent 设置](agents.md)。官方 lark-cli 随 npm 依赖安装，但本人仍需执行 `omem lark login`；它的登录与机器人绑定相互独立。

## 只准备需要的能力

普通保存、全文搜索和网页不依赖 osdk、Python 或本地模型。PDF/DOCX 解析和本地模型由 osdk 管理，只有用户明确需要时才执行相应 setup。setup 在当前机器准备资源，不通过 `--url` 安装到另一台服务；远端部署需在服务机器运行。

先按 [one-sdk 官方安装说明](https://github.com/lejunyang/one-sdk#install) 安装 osdk。官方提供 Linux/macOS 的 `install.sh` 和 Windows 的 `install.ps1`，安装器校验发布文件的 SHA256，并让用户选择 shell 与存储位置。也可从 [官方 Releases](https://github.com/lejunyang/one-sdk/releases) 取得对应平台版本。安装后重新打开终端，确认服务所在账户能找到命令。

```bash
osdk --version
omem setup --help
```

用户无需预先单独安装 Python 或 uv；相应 setup 会通过 osdk 准备锁定版本。

Python 依赖下载使用系统信任证书，适配已在系统中信任公司代理证书的环境；仍会校验证书和锁文件摘要。遇到 `UnknownIssuer` 时检查系统证书是否正确安装；自定义 CA 可按 [uv 官方说明](https://docs.astral.sh/uv/concepts/authentication/certificates/) 设置 `SSL_CERT_FILE` 或 `SSL_CERT_DIR` 后重跑，不关闭证书校验。

| 能力 | 准备命令 | 下载内容与启用方式 |
| --- | --- | --- |
| DOCX / 文字 PDF 解析 | `omem setup documents` | Python 3.12.14、uv 0.12.23 与锁定的 Docling 2.133.0 依赖。DOCX 准备后可直接导入；PDF 还需下一行 |
| PDF 布局和表格识别 | `omem setup document-models` | 固定修订的 Docling Heron / TableFormer。无需修改功能开关，导入时读取本地模型；OCR 当前关闭 |
| 中文向量检索 | `omem setup embedding` | 固定修订的 BGE-small-zh-v1.5 量化 ONNX。设置 `retrieval.enabled:true`，再重启服务 |
| 快速决策 2B | `omem setup decisions` 或 `omem setup decisions --model 2b` | StartLux 运行环境和 2B 权重，默认只下载 2B。设置 `decisions.mode:"auto"` 或 `"2b"`，再重启 |
| 快速决策 4B | `omem setup decisions --model 4b` | 相同运行环境和 4B 权重。可设置 `decisions.mode:"4b"`；auto 模式仍受内存与负载准入限制 |
| 快速决策 9B | `omem setup decisions --model 9b` | 相同运行环境和 9B 权重。需显式设置 `decisions.mode:"9b"`；auto 不会自动加载 9B |
| 两种决策模型 | `omem setup decisions --model both` | 下载 2B 和 4B，auto 才能在已安装的两种大小之间选择；不会按负载临时下载缺少的权重 |
| 三种决策模型 | `omem setup decisions --model all` | 下载 2B、4B 和 9B；只按需要选用，9B 仍需明确配置 |

StartLux 当前仅支持 Apple Silicon Mac。9B 已提供安装和显式选择，尚未完成本机推理验收；暂按可用内存 28 GiB 才允许加载，该预算还未通过真实推理校准。它不用于后台自动切换。Windows 的 Python 路径已适配，但 Windows/Linux 的全新安装仍需实际验收，不能把路径适配当作平台验证。未安装决策模型或资源不足时保留原流程，由常规 Agent 继续调查。

修改个人配置时保留其他字段；用 `omem config path` 找到实际文件，`omem config validate` 检查结构。上述 setup 只准备资源，不自动打开向量检索、快速决策或消息采集。

```bash
omem config path
omem config validate
omem service restart
omem status --json
```

自定义个人目录时，setup、配置和服务使用同一目录，例如 `omem --data-dir /absolute/path/personal setup documents`。不要在客户端机器准备后，误以为远端服务已经具备解析能力。

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
| 解析器未准备 | 在服务机器运行 `omem setup documents`；PDF 再执行 `omem setup document-models` |
| 下载失败或中断 | 保留已完成资源，检查终端中失败的来源后重跑同一 setup。不要因为失败就删除个人库 |
| 校验失败 | 依 doctor 显示的模型名与修复建议处理，再运行深度校验；不把损坏文件当作安装成功 |
| 模型已安装却功能关闭 | 修改个人配置、验证并重启；setup 不替用户开启功能 |
| StartLux 内存不足 | 保留常规 Agent 流程，关闭占用较大的应用，或在已安装 2B 时选用 `decisions.mode:"2b"`；不降低准入假装成功 |

## 更新安装

```bash
npm install -g omem@latest
omem service restart
```

npm 升级替换程序和随包资源，保留个人库。需要更新可选环境时重新执行相应 setup；沿用已完成的下载缓存，不必先卸载整个环境。setup 管理未修改过的包内声明与脚本，保留用户定制，遇到不能自动合并的冲突会说明保留项和新版候选的位置；按提示核对后再准备。不要直接覆盖整份 `optional/osdk.toml`，避免丢掉用户新增模型或下载配置。

模型某一项的任何字段被用户修改后，该模型声明整项保留；修改过的脚本也保留。新版候选固定写入 `optional/.omem-updates/osdk.toml` 和该目录中的 `scripts/`，核对需要更新的项，手动合并后重跑原 setup。已有旧目录没有管理记录时，setup 尝试识别已发布基线，无法识别的内容按定制保留。配置语法有误会停止并说明位置，不覆盖原文件。失败或取消同样保留已经准备的资源，使用 doctor 检查后重跑即可。

`omem skills install <新目录>` 复制当前包的使用技能及全部 references，已复制给其他 Agent 的旧副本不会随 npm 自动更新。使用新目录核对后替换，不覆盖用户定制。模型权重各自的许可证由上游决定，omem 的 Apache-2.0 不更改这些条款。
