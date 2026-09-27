# 外部工具集成可行性与环境准备评估（WeKnora / Hindsight / MemPalace）

核验日期：2026-09-27。范围：只读调研，未安装软件、未下载权重、未修改 `osdk.toml`、未发送任何 omem 数据到外部服务。本地源码快照见 [sources.json](sources.json) / [source-index.md](source-index.md)。运行环境判断见 [../implementation/environment.md](../implementation/environment.md)。

本报告按 **事实（附具体来源链接）/ 未测或不确定 / 建议** 三栏组织每个工具；不引用无来源的 star 数、内存估计或「必须先做 X」式结论。

## 0. 本机环境实测（2026-09-27，只读命令）

| 项 | 实测结果 | 来源 |
| --- | --- | --- |
| Docker | **未安装**：`docker --version` 报「无法将"docker"项识别为 cmdlet」；`osdk container doctor --json` 也报 docker 与 containerd 均 `status:"not-installed"`、client/daemon `unavailable`；`C:\Program Files\Docker` 不存在。不是 permission-denied，是可执行文件不存在。 | 本机 PowerShell + `osdk container doctor --json` 实测 |
| Node | 24.18.1（osdk 管理，lock 固定 win/linux 双平台 artifact） | osdk.lock |
| Python（osdk） | 3.12.14 已就位（`E:\osdk-data\data\installs\python\3.12.14`），但未在项目 `osdk.toml` 激活 | osdk 实测 |
| Python（PATH） | `python` 解析到 Doubao 沙箱 3.14.7；系统另有 `C:\Python311` 3.11.0 | 本机实测 |

> 旧版报告称「Docker permission-denied」来自 environment.md，与当前实测不符：当前是未安装。若未来安装 Docker，状态需重新实测。

## 1. 三工具对比（事实）

| 维度 | WeKnora | Hindsight | MemPalace |
| --- | --- | --- | --- |
| 定位 | 腾讯开源企业级 RAG/知识库框架（问答、Agent、Wiki/GraphRAG） | Vectorize 开源 Agent 记忆系统（retain 抽事实/建图，recall 四路召回+rerank） | 本地记忆检索研究（原文保留 + vector/BM25 hybrid 召回，检索路径无生成式 LLM） |
| 仓库 | https://github.com/Tencent/WeKnora | https://github.com/vectorize-io/hindsight | 专项研究快照见 [mempalace/README.md](mempalace/README.md) |
| 已核验 commit | `4364e61afa4b`（2026-09-25） | `a921929a0e0e`（2026-09-25） | develop 分支快照 |
| 许可证 | MIT（核心） | MIT | MIT |
| LLM 端点 | 至少一个 embedding + 一个 chat LLM；**官方文档明确支持本地 Ollama 与远程模型混用** | retain 需要一个支持 structured output 的 LLM endpoint；**支持本地 Ollama/LM Studio/llama.cpp/LiteLLM 或任意 OpenAI-compatible 端点**，默认示例用 Groq 但不强制 | 检索路径不需要生成式 LLM |
| Embedding | 可接本地模型/BGE/GTE API | 默认本地 `BAAI/bge-small-en-v1.5`（ONNX in-process，无需 API key） | ONNX 本地 embedding |
| 固定片段 ID 适配 | 已核验类型未见任意 external_id 字段，需投影层映射（未验证） | retain 接受任意 `metadata` dict[str,str] 且 recall 原样返回 → 可把 omem fragment ID 放进 metadata（已核验）；但 retain **不原文存储 content**，只存抽取后的 fact | MCP `tool_add_drawer` 无 external_id、按正文去重，需自行投影 |
| 部署 | Docker Compose 多容器（postgres/redis/docreader 最小核心） | Docker 单容器（内嵌 Postgres `.pg0`）或 `pip install hindsight-api` | 独立 Python 环境 + Chroma + ONNX，无需 Docker |

## 2. Hindsight

### 事实（附链接）

- **LLM endpoint 不强制外部供应商**。官方 configuration 页列出 `HINDSIGHT_API_LLM_PROVIDER` 取值含 `ollama`、`lmstudio`、`llamacpp`、`litellm`、`openai`（任意 OpenAI-compatible 端点）等 25+ provider；Ollama 示例为 `HINDSIGHT_API_LLM_PROVIDER=ollama` + `HINDSIGHT_API_LLM_BASE_URL=http://localhost:11434/v1` + `HINDSIGHT_API_LLM_MODEL=llama3`。来源：
  - https://hindsight.vectorize.io/developer/configuration （provider 枚举表）
  - https://hindsight.vectorize.io/developer/models （Ollama/LM Studio/OpenAI-compatible 配置示例）
- **需要一个 LLM endpoint**（retain 的事实抽取/实体链接在服务端调用 LLM），且模型需支持至少 ~65k 输出 token；Groq 免费档因 8k tok/min 不适用。但 endpoint 可为本地（Ollama/LM Studio），不必然是外部供应商。来源：https://hindsight.vectorize.io/developer/models
- **Embedding/rerank 默认本地**：`HINDSIGHT_API_EMBEDDINGS_PROVIDER=local`（BAAI/bge-small-en-v1.5）或 `onnx`（in-process CPU），无需 API key。来源：https://hindsight.vectorize.io/developer/models
- **metadata 字段可存 omem fragment ID**：retain 接受任意 `metadata` 键值对（示例 `{"source":"slack","channel":"...","thread_id":"..."}`），recall 结果每条 fact 原样返回 `metadata: dict[str,str]` 与 `tags`。来源：
  - retain：https://hindsight.vectorize.io/developer/api/retain
  - recall 返回字段：https://hindsight.vectorize.io/developer/api/recall
- **不原文存储 content**：官方 best-practices 明确「Retain ingests raw content…the LLM extracts facts, entities, relationships — raw content is never stored verbatim」。来源：https://hindsight.vectorize.io/best-practices

### 未测 / 不确定

- `pip install hindsight-api` 的「API only」路径是否仍需外置 Postgres（Docker 镜像内嵌 `.pg0`）；本机 Docker 未安装，未实测 pip 路径。
- metadata 中的 fragment ID 在经过 LLM 事实抽取后是否被原样保留在每条 fact 上（metadata 进入抽取 prompt，但是否每个抽取 fact 都继承该 metadata 未实测）。
- 本地 Ollama 模型是否满足 ~65k 输出 token 的 retain 要求（取决于所选模型）。

### 建议

- 隐私边界判断需修正：旧版称「retain 强制外部 LLM、与 omem 隐私约束直接冲突」。实际可配本地 Ollama，**若用本地端点则 omem 内容不出本机**；只有选远程供应商时才有外泄风险。是否接受外部端点仍需用户决策，但不是「强制」。
- PoC 时优先用本地 Ollama endpoint 验证 metadata 透传；omem 仍持原文权威，Hindsight 只做 fact 召回侧，recall 命中后用 metadata 里的 fragment ID 回查 omem 固定原文。

## 3. WeKnora

### 事实（附链接）

- **官方文档明确支持本地 Ollama**：「本地 Ollama 和远程模型可以组合使用，例如由本地模型生成向量、远程模型生成回答」。来源：https://weknora.weixin.qq.com/docs/03-features/06-models
- 仍需至少一个 embedding + 一个 chat LLM，但 endpoint 可直接填本地 Ollama，**不要求先自建统一推理 gateway**。来源：同上；https://deepwiki.com/Tencent/WeKnora/2.3-quick-start-guide
- 部署形态：最小核心 postgres + redis + docreader gRPC + Gin API + NGINX 前端；compose 列数十服务需按 profile 裁剪。来源：https://github.com/Tencent/WeKnora （已核验 commit `4364e61afa4b`）
- 它是带自己租户/RBAC/队列/前端的**完整平台**，不是可被 omem 当后端调用的轻量检索库；与 omem 单用户 SQLite 模型重叠。来源：已核验 `internal/router/router.go`、`internal/handler/{chunk,knowledge,knowledgebase}.go`。

### 未测 / 不确定

- 任意 external_id 字段（已核验类型未见，按正文归并行为未验证）。
- 本机 Docker 未安装，Docker Compose 路径未跑；源码路径需 Go 工具链 + Python docreader + postgres/redis，未尝试。

### 建议

- 旧版称「不能把 command=traecli 填进 OpenAI endpoint，需要先做统一推理 gateway 才能接 WeKnora」——**过度推断**。WeKnora 可直接对接本地 Ollama，gateway 不是前置条件。
- 主要成本是运维重（多容器）+ 完整平台重叠，而非 LLM endpoint 未就绪。Docker 未安装前不启动部署。

## 4. MemPalace

### 事实（附链接）

- 依据 [mempalace/README.md](mempalace/README.md)（2026-09-26 核验）：Python 包，默认 Chroma 本地向量库 + ONNX 本地 embedding，检索路径无生成式 LLM，无需 Docker。
- 本机 Python：osdk 已装 3.12.14（实测），无需新下载运行时；项目 `osdk.toml` 当前未声明 python tool。
- 依赖闭包：Chroma、NumPy、tokenizers、huggingface_hub、ONNX runtime。
- Embedding 权重：默认 all-MiniLM-L6-v2（英文训练，中文需实测）；多语言选项 embeddinggemma（体积与效果需实测，不引用无来源的具体 MB 数）。

### 未测 / 不确定

- 中文语料实际召回差异；断网热运行是否零外网请求；实际磁盘/内存占用（需真实机器测量，本报告不估计）。
- `osdk model view hf-cache` 产出布局是否被 MemPalace 的 huggingface_hub 调用直接识别。

### 建议

- 维持 P0 PoC 定位：定位就是可替换 RetrievalPort 后端，薄适配器；omem 持原文权威，投影 outbox → 独立 Python worker → search 返回 candidate_id/rank → omem 回查固定片段。
- 硬门（摘自专项研究）：证据映射 100% 可回查固定片段；原件更新/撤回后旧候选可过滤；缓存预热后断网运行且无 LLM provider 调用。

## 5. osdk 能力评估

### 已实测

- 本机 osdk 已装 Python 3.12.14；Node 24.18.1 由 osdk 管理。
- osdk 支持 `[tools] python`、`[deps]`（uv/pip-requirements）、`osdk model pull/sync/path/verify`（hf 不可变快照）。来源：[osdk-guide/SKILL.md](../../.agents/skills/osdk-guide/SKILL.md) 与 reference/commands.md、configuration.md。

### 边界（准确表述）

- **osdk `[tasks]` 是前台一次性任务**（有 timeout 杀进程树、run_post 清理），**不是常驻 sidecar 进程管理器**——没有常驻服务的启动/停止/健康检查/自动重启循环。MemPalace/Hindsight sidecar 的生命周期必须由 omem 自己的 Node 进程 spawn/kill + 健康端点负责，或交给外部 supervisor。osdk 负责「环境可复现」，不负责「进程托管」。
- osdk `container` 只做宿主原生运行时 pull/doctor/cache/prune/mirror，不编排 Docker Compose。
- 当前 `osdk.toml` 只声明 `node = "24.18.1"`，无 python tool / Python deps / `[models]`。

### 建议

- MemPalace PoC：osdk 声明 `python = "3.12"`（复用已装 3.12.14）+ 项目内 pip/uv deps + `[models]` 锁 revision 权重；常驻 sidecar 由 omem Node 进程管理。

## 6. 推荐集成路线（修正后）

1. **P0 — MemPalace 本地检索 PoC**：与 v3 主线不阻塞；需用户授权改 `osdk.toml`、装 Python 依赖、下载 embedding 权重（体积二选一后实测）。
2. **P1 — 本地 LLM endpoint 就绪后再评估 Hindsight**：Hindsight 的 retain 需要一个 LLM endpoint，但该 endpoint 可为本地 Ollama（不是必须外部供应商，也不是必须先建 gateway）。前提是用户接受 retain 的事实抽取在本机 LLM 跑通、metadata 透传 fragment ID 实测通过。
3. **P2 — WeKnora**：Docker 未安装、且它是完整平台与 omem 重叠，优先级最低；其 LLM 可直接接本地 Ollama，无 gateway 前置。
4. 任何时候不把上游 benchmark 数字写成 omem 服务指标。

## 7. 未验证 / 需用户决策

**未验证（本任务未运行、未安装）**：见各工具「未测」节。

**需用户决策**：
1. 是否授权启动 MemPalace PoC（改 osdk.toml、装依赖、下权重）。
2. Embedding 模型倾向（多语言 vs 英文基准）。
3. Hindsight 的 LLM 边界：用本地 Ollama（内容不出本机）还是远程供应商——前者无隐私外泄，后者需用户授权。
4. 本机 Docker 未安装：是否计划安装，还是 WeKnora 只评估源码/pip 路径。
5. 后续 PoC 必须用脱敏语料，不发送 omem 真实数据。
