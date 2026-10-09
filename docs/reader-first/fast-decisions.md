# 中文快速决策：实际接入与选择规则

更新：2026-10-09。StartLux-Decision 0.8B、2B、4B 已在 Apple M2 Pro / 32GB 上以官方 BF16 / MLX 原生方式运行。**共用服务已接到共享异步检索、原文页用途建议与个人飞书消息分流，仍不能把模型判断当事实写入、操作授权或安全证明。** 检索逐项结果见[同一份实验简报](../../.repo-review/knowledge/verification/fast-decisions.md)；消息的七维判断、低分与缺资源处理见[个人消息](personal-messages.md)。

## 本机结果

固定八条中文合成材料和六条真实 HTTP 检索结果，每段同时判断六个维度；三种大小使用同一输入和上游源码版本，顺序加载释放，没有针对结果调整问题或阈值。

| 大小 | 暖机单段中位耗时 | 六条实际材料合计 | 首次初始化 | MLX 峰值分配 |
| --- | --- | --- | --- | --- |
| 0.8B | 253 ms | 1.72 s | 38.9 s | 2.19 GiB |
| 2B | 576 ms | 3.96 s | 40.8 s | 4.04 GiB |
| 4B | 1469 ms | 10.15 s | 50.7 s | 8.39 GiB |

这里的 MLX 分配不是系统总内存，不能与进程 RSS 相加。设备其他程序负载未受控；14 个例子不代表中文总体准确率。

2026-10-09 的共享检索验收另记在[检索排序简报](../../.repo-review/knowledge/verification/retrieval-ranking.md)。当时真实 2B 因可用内存不足未获准加载，四题 HTTP 请求沿原检索返回，没有产生实际评分；不能沿用上表结果证明新入口的排序收益。当前独立仓库六题不启用 Decision，top-5 命中 2/6，独立 reranker 也未配置。

随后对当前 18,303 单元的只读阶段对照再次尝试原生 2B，仍因可用内存不足实际评分零条。BGE base 与 v2 均实际评分，能改善部分顺序；长代码与记忆重核验的核心实现未进入融合候选，Decision 也无法判断池外依据。模型分与宿主顺序已分别记录，完整结果及复现任务见[候选与评分简报](../../.repo-review/knowledge/verification/retrieval-candidates.md)。默认配置仍不启用独立重排器。

2B 改善了把攻击示例当实际注入的问题，仍漏判一段有用的选材步骤。4B 找回该段，但把另一段宽泛目的说明当成充分答案，部分无关材料也被判为部分覆盖。0.8B 还会把不同活动的规则误认作前提冲突。更大有局部收益，没有测出“4B 总能判断正确”。

## 现在接在哪里

`apps/server/src/decision/service.ts` 管理一个常驻子进程；`scripts/startlux/worker.py` 使用官方 `MLXDecision`，一段多问题、读取原生选项分布，不生成聊天文字。启动、失败、模型身份和耗时可查看；请求串行，避免同时载入两份模型。

| 判断 | 输出 | 当前消费者 |
| --- | --- | --- |
| 相关性 | 无关、仅话题、背景、答案/关键条件、未知 | 普通搜索、助手初始选材与调查工具的阅读顺序 |
| 回答覆盖 | 无、部分、充分、未知 | 诊断保留，不据此自动快答 |
| 内容支持 | 明确陈述、条件性、讨论/示例、无支持、未知 | 联合判断明显无关项是否省略；来源版本仍由宿主校验 |
| 前提冲突 | 冲突、不冲突、未知 | 冲突候选保留给 Agent，不能当负面材料过滤 |
| 指令注入 | 普通、引用攻击示例、实际尝试、未知 | 当前只记录可疑标记，没有接成自动安全过滤器 |
| 父章节需求 | 需要、自足、未知 | 保留需要背景的候选；尚未按此结果自动二次补读 |
| 入库用途 | 日常安排、学习、代码、业务各自是/否/未知 | 原始材料页显示可同时成立的用途建议；不是持久分类或自动目录 |

`createRetrieval` 将共用 DecisionService 接入 `UnifiedRetrieval.search`。全文与向量结果合并符号召回，经过可选 cross-encoder 排序后，默认先取最多 40 个候选；请求数量更大时相应扩大。调用 `assessPassages` 后再做浏览去重和数量截断，同一原文的第三条事实也能参与判断。最多判断前 12 段、等待最多 8 秒；未评估候选保留。相关性中的答案/关键条件与前提冲突取较高分，再加 0.35 倍背景分，调整已评估候选的阅读顺序；原检索 score 保留，结果的 assessment 单独记录模型、priority 及各维度选项分布。联合省略门槛为无关 ≥ .98、无回答 ≥ .95、无支持 ≥ .95，冲突、背景需求或不确定选项较高时保留；如果评估项全被省略，则退回原候选。门槛是保守初始策略，**尚未经大样本概率校准，不代表可靠错误率**。此前实际 HTTP 的 12 条判断没有触发省略，不能宣称已明显过滤噪声。

冷启动在后台预热，当前搜索沿原候选继续；模型故障或切换耗时也不阻塞主流程。普通搜索、助手初始选材和 Agent 自主调查共享这一轮判断，助手及诊断接口不再重复评分。精确名称与显式 AST 导航直接定位，同步兼容端口仍只做确定性检索；独立仓库验收应用不传 DecisionService，不把该报告当作小模型排序验收。问答默认继续使用 Sol。近期对话的对象消歧仍由原有助手处理；此次没有把小模型接成所有请求的前置路由。

用途建议按固定 revision 自动读取，长文先看前 12,000 字符并明确标为摘录，只展示正向建议；缓存保留五分钟，原文版本、问题和判断模板属于输入身份。服务运行期间配置固定；每次请求先检查实际选模，缓存由 worker 按模型及固定修订区分；降级和释放模型时清除缓存。

## 负载如何选择

`decisions.mode` 支持 `off`、`auto`、`0.8b`、`2b`、`4b`、`9b`。未配置时采用机会性 `auto`，无环境或权重则回到常规 Agent；运行不会下载。自动模式只选择已安装的 0.8B/2B/4B，9B 必须显式选择，目前暂按可用内存 28 GiB 才准入，这个预算尚未通过真实 9B 推理校准。

自动模式用可用内存加当前模型可释放内存估算余量：余量至少 14 GiB 且一分钟 load average / CPU 数 < .85 时选 4B；至少 8 GiB 时选 2B；至少 4 GiB 时选 0.8B，否则暂不运行。一次只驻留一个模型，升级间隔至少五分钟，降级不等待；空闲三分钟释放。也可显式固定 0.8B/2B/4B，但仍执行内存准入。

这是可调整的本机资源策略，CPU load 只是压力信号，不是 GPU 忙闲的精确测量，也不保证 macOS 不发生交换。没有做边运行所有应用边强制压力的实验；真实 HTTP 曾按当时负载选到 2B。

0.8B 的 4 GiB 是保守初始预算，较短材料的旧实测峰值不能代表长输入。它只调整阅读顺序，保留全部候选；缓存命中同样先检查资源并记录本次模型，不能用旧 2B 结果冒充降级后的评分。

## 怎样准备和观察

安装版在服务机器准备 osdk 后运行 `omem setup`，勾选 decisions，再选择 0.8B、2B、4B 或 9B（可多选）以及准备后的运行方式。默认只预选 2B；全部准备成功后保存本人选择的模式，最后可重启服务。选择“仅准备”保留现有设置。当前仅支持 Apple Silicon Mac，其他平台的向导会说明不能选用的原因。auto 只选择已安装的 0.8B/2B/4B，9B 需明确选择且尚未实际推理验收。脚本和 Agent 仍可用 `omem setup decisions --model 9b`，模型选项为 0.8b、2b、4b、9b、both、all；显式命令只准备资源。安装、完整摘要校验与实际推理分开检查，详见[依赖与模型](../../skills/omem-cli/references/dependencies.md)。

源码开发与实验使用以下任务。

```bash
osdk run decision:native-prepare
osdk model sync decision-startlux2b
osdk model sync decision-startlux4b
# 启动后按需加载，不安装后台常驻服务
osdk run dev

# 复现固定六维中文对照；每种模型覆盖自己的临时结果
osdk run decision:native-evaluate --model decision-startlux2b
osdk run decision:native-evaluate --model decision-startlux4b
```

模型、上游 Python 文件哈希和依赖分别固定在 `osdk.lock`、`scripts/startlux/upstream.json`、`scripts/startlux/uv.lock`。原生源码固定 `0e7a2e81b9c92756e26d8edd843a44d50e362669`。API `/api/decisions/status` 可读状态，`/api/decisions/search?q=...` 返回实际候选、已保留候选的 assessment 与模型状态；被省略项及原因记录在 debug 日志。首次可能只启动预热，后续请求复用常驻模型。`/api/decisions/intake` 接收 revisionId，返回用途建议。

模型范围和接口见 [StartLux 官方仓库](https://github.com/StartLuxLabs/StartLux-Decision)、[2B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-2B)、[4B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-4B)和[9B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-9B)。权重 CC BY-NC 4.0、推理代码 Apache-2.0；实际验收过 Apple Silicon 的 0.8B/2B/4B 文本后端，9B 安装选择已接入但未实际推理验收，图片先由导入流程提取内容。

## 已有其他路径与后续

### 自然语言交办与执行检查

2026-10-08 开始迁移语义正则。新增的项目理解操作由 `request-interpreter` 在独立会话中判断完整请求、最近对话和候选项目，返回 `execute`、`decline` 或 `uncertain`，同时给出当前原话及对象依据。沿用已配置主助手的 CLI/ACP；只在拟执行项目理解操作时调用，普通查询和同一请求的回执重放不调用。没有模型、判断含糊或取消时不应用，也不回退到动词词表。实际代码入口是 `assistant/request-interpretation.ts` 和 `AssistantWork.applyRequested`。

首轮真实 Traex ACP / gpt-5.6-sol 通过六条表达，但在第七条把无上下文的“这个项目”按候选对象直接执行。修正要求对象依据来自当前或近期本人原话，也可以是已保存讨论范围；候选列表不能补出授权。随后九条真实请求通过，涵盖礼貌交办和混合否定，也检查了纯咨询、错误对象及中英文表达，以及同一句指代在不同上下文中的不同处理。每次独立调用约 9–17 秒，尚未进行大样本或 StartLux 替代模型对照。完整结果见[持续项目理解简报](../../.repo-review/knowledge/verification/context-views.md)，不把结构化输出或小样本通过等同于可靠准确率。

语义判断只说明用户表达的动作与对象；本人身份、私聊范围、实际对象、版本、请求去重和最终写入由程序核对。StartLux 当前仍提供机会性建议，没有接成操作批准器，选项分数也未经概率校准。

事项创建与状态变更也已移除语义词表，复用独立 `request-interpreter`；入口是 `AssistantRuntime.interpretTaskCall`。它核对完整本人请求、实际事项和近期原话；“刚才那条”还可以引用同一对话中实际保存的操作回执，候选列表和模型回答不能代替这份依据。未获批准时不保存任务原件、不修改事项；模型调用期间取消或事项版本改变也不能晚到覆盖。事项查询和同一请求重放不调用判断模型。随包用法见[自然语言交办](../../skills/omem-cli/references/task-requests.md)。

本轮真实 Sol 独立判定通过十条合成请求，覆盖礼貌创建、否定、咨询、混合请求中的错误候选、未完成否定、对象错配、无背景指代、实际回执指代、英文重开与中文改期。这里主助手候选是受控输入，独立判定、MemoryService 写入和版本是真实路径，每次独立调用约 11–15 秒。另用真实主助手和独立判定经 HTTP 跑通创建、只查询不改动、礼貌改期和上一轮任务完成四轮，核对了唯一事项、日期时区和保存版本。它们不能证明大样本准确率，也没有验收 StartLux 替代模型。

开发交办和材料时态仍有词表判断，继续按实际消费者迁移；日期/ID 格式、权限与版本规则保留确定性检查。旧 `detectTaskIntent` 曾把“帮我建个待办吧”漏判、把“不要提醒我”命中为创建，相关函数与测试已删除，没有保留关键词兜底。每步对照真实请求及上下文，分别统计误执行、漏执行、含糊保留和耗时，格式通过不能当语义准确率。

采用模型返回结构化选择的方式，可参考 [LangGraph routing](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)、[LlamaIndex selectors](https://developers.llamaindex.ai/python/framework/module_guides/querying/router/) 和 [Anthropic routing](https://www.anthropic.com/engineering/building-effective-agents)。它们支持这种组合方式，不证明本项目的中文意图识别已经准确；无需仅为替换词表迁移整个框架。

GLiClass multilingual mini、Qwen3.5-4B MLX Q4、Plumb-4B Q8/Q4 已实跑，结果及失败保留在同份简报与结构化结果，不重复模型清单试验。English-only 候选低优先级；不再测 Luna。原有 `decision:evaluate` / `decision:inspect` 仍是离线或只读试验入口。

助手可显式配置 `assistant.readingProfileId` 采用 Sol / low 先读作答，再由 `review_answer` 独立核对或 `handoff_to_research` 交回调查，复用同一材料快照。复杂仓库题曾遗漏关键条件，短生活材料有局部速度收益，仍未默认启用。小模型的充分性分数不决定快答或免复核。

下一步把建议变成可修正的持久分类，并接可编辑目录草案；父章节补读、更新候选和危险输入审查按实际消费者推进。记忆变更必须对照人物、项目、时间和新旧原文，最终仍经 MemoryService。不能仅因为某个选项最高就覆盖记忆，也不能让这些高影响用途一直阻挡低影响的排序和分类建议。

外部工具资料沿用同一个快速决策服务：`conversation_input_relevance` 同时给出任务相关性、证据/定位/错误/可疑用途，以及可复用材料/仅入口/诊断/不确定的保存建议。仅用就绪模型、最多等待 2.5 秒，未就绪交回主助手。它不触发 Capture；主助手选择后宿主复制原始内容。两轮外部材料保存/找回验收使用真实 Sol，关闭快模型，因此没有新增这组分类的准确率或提速结论。

开发准备也复用同一服务：`repository_diagnosis` 根据实际 Git 失败建议检查登录、网络、版本或本地状态；`project_setup_advice` 对一份项目说明给出用途、环境前提和操作副作用三维建议。都走就绪模型的 2.5 秒等待，冷启动或失败照常由主助手调查。它们不生成或批准命令；主助手仍需补读实际脚本，不能把小模型标为 local 当作可执行的安全证明。

2026-10-06 对三段合成中文开发说明尝试实际运行 2B，服务因可用内存不足未加载模型，全部返回不可用；没有分类准确率结论，没有强制降低准入或下载其他模型。主助手真实编码验收关闭快模型，不能据此宣称这些建议已经改善配置效果或耗时。

编码 Agent 可用 `development_change_advice` 对实际新旧需求建议“实现/背景/范围/不确定”与“改代码/补材料/澄清/保留”。同样只用已就绪模型，不可用则正常阅读决定；原交办权限与新验收仍由宿主和独立评审核对。本轮真实续做实验关闭快模型，没有新增这项分类准确率结论。
