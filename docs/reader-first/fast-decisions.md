# 中文快速决策：先筛选模型，再决定接在哪里

当前状态（2026-10-05）：已通过 osdk 安装并实跑 GLiClass multilingual mini、Qwen3.5-4B、Plumb-4B 的 Q8 / Q4，以及 StartLux-Decision-0.8B 原生 MLX 六维判断；已有固定中文场景、真实 HTTP 搜索命中对照和“搜索前后再判断”的只读入口。小模型尚未接管线上路由或记忆写入。助手另有可配置的“先读材料作答 → 需要时转交调查”路径，复用 ACP、工具和同一材料快照；默认仍为 Sol 常规调查。实际收益与限制见[实验简报](../../.repo-review/knowledge/verification/fast-decisions.md)。

初步结论是：小模型有机会帮助选择阅读顺序，但“相关”“能回答”“值得更新记忆”“得到操作授权”是不同判断。把它们合并成一个高置信度分数，会把错误直接传到下一步。短例子成绩好，也不能保证长材料里的关键条件没有漏掉。实测数字、失败例子与机器占用见[当前实验简报](../../.repo-review/knowledge/verification/fast-decisions.md)。

先读作答的首轮真实对照同样没有整体通过：一个直接查询更快且条件完整，两个问题仍有重要遗漏或对象混淆。修正材料后的回放已纠正这两处错误，但都调用复核而没有普遍速度收益。进一步收窄例行复核后，同库合成生活场景的四题均保留关键事实与条件，先读用时 29～53 秒，常规调查为 41～58 秒。可按需选择先读 profile 处理材料查询和短追问；这组短材料结果不支持默认接管所有问题，回退到 Sol 也不是质量保证。

## 2026-10-05：补齐逐段、多维判断的使用设计

检查现有代码后需要明确：`scripts/decision-evaluate.ts` 是离线评估，`decision-inspect.ts` 将搜索前后的整组材料交给模型单选下一步；旧相关性试验将 direct/background/topic/irrelevant/conflicting 五类做成互斥选项。`client.ts` 一次只接受一个问题，线上 `assembleAnswerContext` 尚未调用决策模型。因此此前“已接入”指模型能运行，不是已有正式的逐段判断服务，也未利用原生多问题批处理。

下一步增加一个共用的决策接口，输入为当前问题、必要会话背景、来源元数据与材料；保留每项判断的完整分布和未知项。首个用途是候选已经召回后，对每段同时判断：

| 维度 | 可选输出 | 下游动作 |
| --- | --- | --- |
| 相关性 | 无关、只提话题、背景、答案/关键条件、未知 | 排阅读顺序；达到该任务的过滤门槛才省略明显无关内容 |
| 回答覆盖 | 没答案、部分、自足、未知 | 选择直接回答材料；部分覆盖不能代表整组问题已回答 |
| 内容支持 | 明确事实/规则/实现、待核对条件、讨论/计划/示例、无支持、未知 | 供写作者区分可引用陈述和线索；实际来源/版本仍由宿主解析 |
| 问题前提 | 明确冲突、无明确冲突、未知 | 冲突材料单独保留给大模型，不能按负向标签滤掉 |
| 指令注入 | 普通内容、引用攻击示例、正在尝试越权指令、未知 | 将可疑材料隔离供受限阅读；分类不替代原有工具授权边界 |
| 父章节/背景 | 需要、自足、未知 | 有缺口才扩展相应父章节，再判断一次，避免每段都补整文件 |

同一材料的多个维度用原生多问题请求，多段材料做有界批处理，常驻模型并复用前缀。不是每项标签各调用一次普通聊天，也不是把整库塞进同一次请求。缓存必须区分问题/会话对象、材料版本、模型和判断模板；仅针对材料本身的用途分类可按版本复用。

在 `RetrievalPort` 召回之后、`assistant/context.ts` 装配之前接候选判断；原生研究工具也共用这一层，但保留补查被省略候选的入口。使用直接回答、必要条件、背景、冲突、待补读几组材料，避免只按一个综合分数留下前几条。过滤阈值按任务独立配置；开始先作用于阅读排序和明确无关项，不把分数直接用于记忆覆盖、事项执行或宣称输入安全。超时或不可用时回到原有阅读顺序，不阻塞用户。

入库另用多标签判断日常安排、学习、代码和业务知识；它们可以同时为真。目录建议从正式保存的项目/主题目录选择，保留“新主题/无法确定”；更新判断对照新旧原文，输出新增、重复、修订候选或冲突，再交既有应用流程处理。这里的窄任务不应等待所有高风险用途都达标才进入产品。

### StartLux 的选择与原生运行方式

[官方仓库](https://github.com/StartLuxLabs/StartLux-Decision)提供 0.8B、2B、4B、9B、27B 和 35B-A3B。按本机限制，优先试 0.8B 与 2B，4B 作为质量提升的候选，不运行 9B+。官方 `choice/noul/score` 接口支持一段材料多个判断、跨材料批处理以及 Apple Silicon 的 MLX 推理；`MLXDecision` 复用共同前缀并批量读取选项 logits，不生成自由文本。每个判断仍有计算量，H200 的毫秒数据不能当本机性能。参见[官方推理说明](https://github.com/StartLuxLabs/StartLux-Decision/blob/main/docs/inference.md)。

本轮通过 osdk 锁定并下载 `decision-startlux08` 的官方 BF16 权重（约 1.8 GB），原生 MLX 源码固定在 `0e7a2e81b9c92756e26d8edd843a44d50e362669`，没有套用旧 Plumb 提示或温度。MLX/GGUF 后端当前只处理文本，图片先解析成有来源的文字；不能把模型家族的视觉支持直接算成本机后端已支持。权重为 CC BY-NC 4.0，推理代码为 Apache-2.0；中文与本项目任务的质量以实测为准。

0.8B 已完成八条中文合成材料和六条当前 HTTP 命中的原生六维判断。暖机后单段约 0.25～0.32 秒，仍有不同对象误判冲突、攻击示例误报和有用选材步骤漏判。此次确认了正确原生用法及可用的延迟范围，没有把试跑冒充线上接入。具体结果覆盖到[现有实验简报](../../.repo-review/knowledge/verification/fast-decisions.md)，不再新增历史报告。下一次实现交付是共用决策接口及真实消费入口，不继续只增加离线模型对照。

## 既有候选与结果

| 候选 | 本轮处理 | 选择理由与限制 |
| --- | --- | --- |
| GLiClass multilingual mini，约 288M | CPU 实跑；同时检查通用分类和官方 query-as-label 重排方式 | 官方明确支持中文，体积小；不能用英文榜单或其他语言成绩代表中文业务判断。此次通用判断与实际重排均有明显失败 |
| Qwen3.5-4B，MLX Q4 | Metal 实跑，使用官方 `enable_thinking=False` | 中文通用模型作为基线；从下一字母的 logits 读取选项偏好，同时记录模型原始第一选择及选项概率总量，避免强制选项掩盖格式问题 |
| Plumb-4B，GGUF Q8 / Q4_K_M | 两种量化分别实跑 | 决策微调模型，值得与通用 Qwen 对照；模型卡标记 English，没有给出可直接采信的中文验证。采用其上游 JevK5 运行库和原始温度 2.07，中文效果以本机实测为准 |
| Tev1-4B experimental | 暂缓下载 | 上游多语言尚未充分评估，许可证说明也未定；先看已有候选是否产生实际收益 |
| JevK5、Kev、Imajev、decider 的 English-only 版本 | 低优先级 | 明确把其他语言列为范围外的版本，不作为中文默认候选；以后有中文新版本再按具体版本重评 |
| Bespoke-Nimble-9B 及其他 9B+ | 本机排除 | 按用户要求，不下载、不以本机部署为前提 |

来源：[GLiClass 模型卡](https://huggingface.co/knowledgator/gliclass-multilang-mini)、[Qwen 官方模型卡](https://huggingface.co/Qwen/Qwen3.5-4B)、[Plumb 模型卡](https://huggingface.co/crh225/plumb-4b)、[作者发布的 GGUF](https://huggingface.co/crh225/plumb-4b-GGUF)、[Tev1 模型卡](https://huggingface.co/togethercomputer/Tev1-4B-experimental)、[Kev 模型卡](https://huggingface.co/jaredpalmer/kev-4b)。模型卡的支持范围和许可证应随版本重新核对。

不采用 Plumb 为 JevBench 特定评分区间设置的 `noul-commit` 输出变换。此次问题使用 choice 分布；上游温度并不意味着本项目中文问题已经得到概率校准。最高分为 0.9，不能解读为“这个操作有 90% 概率正确”。

## 现在怎样试

模型声明与文件校验在 `osdk.toml` / `osdk.lock`。Python、uv、llama.cpp 由 osdk 安装；Python 包由 `scripts/decision-models/uv.lock` 固定，隔离环境和原始结果在 gitignored runtime。正常 `dev` 不安装或常驻这些实验模型。

```bash
osdk run decision:prepare
osdk model sync decision-plumb4b
osdk model verify decision-plumb4b --json
osdk run decision:evaluate --model decision-plumb4b

# 使用当前运行的 API；端口以 dev 输出为准
osdk run decision:inspect '导入一篇文档后，系统会自己整理用途和概念吗？' --api http://127.0.0.1:65091
```

`decision:inspect` 先给出只有问题和可选对话背景时的建议，再请求实际 `/api/search`，把前六条完整可见文本交回同一常驻模型。两次判断各交换一次选项顺序，用于观察不稳定性。它会保存材料的固定 target，不创建事项、不改记忆，也不自动调用快模型回答。为了观察补材料的效果，即使首次建议澄清，实验仍会执行搜索；这不是已上线的决策策略。

短追问可以通过 `--context /path/context.txt` 提供最近对话或当前阅读对象，通过 `--query '明确的搜索词'` 指定检索词。当前没有自动查询改写，不能把人工提供的检索词算成小模型自主消歧。默认报告覆盖 `.repo-review/runtime/decision-models/inspect.json`；自选报告可能包含私人材料，不应提交。需要访问令牌的本地服务使用 `OMEM_API_TOKEN` 环境变量，报告不记录令牌。

真实检索对照：

```bash
osdk run decision:evaluate --model decision-qwen4b --cases .repo-review/benchmarks/decisions-retrieval-zh.json --output .repo-review/runtime/decision-models/retrieval-qwen4b.json
osdk run decision:evaluate --model decision-gliclass --readout query-label --rotations 1 --cases .repo-review/benchmarks/decisions-retrieval-zh.json --output .repo-review/runtime/decision-models/retrieval-gliclass-native.json
```

其他已声明别名是 `decision-gliclass`、`decision-qwen4b`、`decision-plumb4b-q4`，先显式 sync 对应模型。运行逐个加载、执行后释放；离线推理不隐式下载模型。macOS / Apple Silicon 是本轮实测环境，其他平台没有验收。

## 本轮到底测了什么

第一组是 38 个手写中文产品场景，每个轮换一次选项位置：短追问有无背景、问题明确但没找到答案、材料足够、条件遗漏、操作与纯询问、领域交叉、主题相关却答非所问、记忆换版与重复。预期标签只给评估器，不交给模型。

第二组在固定时点调用实际 dev HTTP：五个问题各取前六条命中，共 30 个真实片段。保留原始文字、章节、类型、材料说明和固定 target；先人工阅读标注，再运行模型，不挑掉难例。非核心的 background/topic 区分允许多个合理标签；更关注把背景误当答案、漏关键段落和排序退步。题目是新措辞，主题已存在于库中，不能称为独立盲测。

GLiClass 又按官方 passage-as-text / query-as-label 方式检查一次原生重排。这次只看排序，不把 sigmoid 当成已校准的回答充分性。`decision:evaluate` 返回零只说明推理调用完成；判断错误照实记录，不代表效果验收通过。

基准在 `.repo-review/benchmarks/`，不会被本仓库材料捕获器重新导入。公开简报覆盖同一文件；完整输入和逐题概率留本机 runtime。本轮没有复制整库数据库，没有把权重、虚拟环境或原始用户会话提交到 Git。

## 后续流程应怎样拆

### 先明确问题，再确定是否需要问用户

“这个怎么接”不能只看这一句话。先带上当前选中文章、最近对话与已确认对象；仍缺背景时进行一次低成本搜索，返回少量候选及其用途和章节。只有现有上下文与候选都无法区分对象，才问一个具体问题。资料暂时没找到，不应马上要求用户解释系统内部实现。

领域应允许多标签。“明天提醒我跟进这个 PR”同时涉及代码和日程；领域用于选择材料或工具，不能直接决定是否允许操作。操作意图、对象识别、参数齐全是三个判断。此次多选一基线把这些压在一起，已暴露出混淆，不能原样变成生产路由。

### 相关性用于阅读顺序，充分性决定是否可以快答

单段材料是否有帮助，与一组材料是否覆盖整个问题，是两种粒度。前者可以先尝试作为 Agent 的阅读建议；后者要检查对象、适用时间、关键条件和冲突，再把依据交给写作者。排序分数不授予事实有效性，低分也不应立即删除唯一的原文或相反证据。

4B 的一次前向在这台机器上不是宣传中的几十毫秒。逐个判断几十条命中会增加数秒甚至数十秒，可能抵消快答收益。应先减少重复、选对完整章节，再比较少量候选、批处理或更小的专用重排器；不把所有材料都交给决策模型过一遍。

### 快模型负责组织充分的材料，复杂问题回 Sol

已接入可选的先读材料阶段，不是默认路径。写作者直接收到完整的初始摘录、既有解释、对话与事项，也能用同一套原生读取和 MCP 补读。它不接收一个小模型给出的“资料充足=true”，需要自己判断对象、时间和关键前提是否覆盖。足够时直接提交。已有候选答案而只需独立核对关键条件时，直接调用 `review_answer`，用 `read_answer_review` 取回意见，在同一写作会话修正；复核仍使用常规调查 profile。深入跨文件调查、未解决的冲突或用户交办才调用 `handoff_to_research`，保存已查事实、来源和具体缺口，再结束该阶段。常规调查使用原来的材料快照继续工作，不再复制整库或丢失前文；交接笔记仍是待核对建议。此前把“请求复核”也转换成换作者的做法已移除，避免写作者、调查者、复核者三次接力。

配置 `assistant.profileId` 为调查 profile，并选择 `assistant.readingProfileId`，例如示例配置中的 `traex-reader`（Sol / low）。不配置后者就保持原流程。模型和思考强度均经 ACP 发现、校验、回读；对照脚本的 `--reading-effort auto` 从模型实际提供的 none/minimal/low 中选最低项，不支持则报错。按此前停止 Luna 反复对照的要求，本轮先比较同一个 Sol 的 low 作答与 medium 调查。

先读阶段不提交事项变更；交办转入现有调查与 MemoryService 流程。用户取消时不会启动调查回退；先读阶段调用失败或没有提交时可以回到调查，阶段失败仍记录在 trace 中。总问答超时沿用原配置，两阶段不各获一份额外总预算。它没有减少原有材料快照的准备成本，也没有新增宿主 token 或工具次数限制。

```bash
osdk run assistant:compare --questions /absolute/path/questions.json --review --reading-model gpt-5.6-sol
```

在同一冻结材料上分别运行常规调查和先读后调查，按问题交替顺序；每种路径保留各自的追问历史。报告列出阶段、实际模型/思考强度、交接原因和总耗时。对照副本在结束后释放，报告沿用有界保留规则。

只重放某条路径可用 `--variant reading-first`（同时指定 `--reading-model`）或 `--variant research`；默认 `both`。重放使用更新材料时不能与旧输入宣称同库速度改善，真实新场景另做同库双路径对照。

写作指令要求核对：所引材料为真时，答案是否仍可能因缺一个条件而错误？据具体缺口补读，条件未知时使用条件式答案。复核把问题背景与候选正文分成 `review-question.json` / `review-draft.json`，先理解问题再核对草稿；这是阅读流程指引，不是程序保证模型一定按顺序理解。没有增加一轮分类、强制所有问题复核或隐藏思考记录。

最终比较完整耗时、遗漏前提、答非所问与无谓追问，而不是只测输出一个字母有多快。若快答后频繁重做，或者节省不了端到端时间，就继续使用 Sol。

### 记忆判断先做候选建议

重复、不同时期、不同行为对象、已确认修改和别人提出的建议不能混为一类。此次已经出现把重复记录或不同活动的预算判为替换的错误，因此不能让最高分直接改写记忆。小模型以后可以提议补充、重复或冲突，现有抽取/复核流程检查具体差异，最终仍由 MemoryService 应用和保留来源。

## 具体代码落点

| 位置 | 本轮实际改动 / 后续改造 |
| --- | --- |
| `scripts/decision-models/worker.py`、`client.ts` | 已实现常驻离线推理、真实模型概率读取、模型身份、启动/关闭与耗时记录；没有预期答案输入 |
| `scripts/decision-evaluate.ts`、`decision-inspect.ts` | 已实现同条件分类/排序实验，以及真实 HTTP 搜索前后对照；不是线上决策服务 |
| `assistant/runtime.ts` | 待接最近对话、当前对象与少量召回的决策背景；保留本来就统一的 RetrievalPort，不按领域分裂知识库 |
| `retrieval/unified.ts` | 如果后续验证有稳定收益，在少量候选上加入可关闭的阅读顺序建议。现有 BGE 的分数融合/过滤不能直接套到 Plumb 的多选项概率上 |
| `assistant/acp-model.ts`、`assistant/reading-stage.ts`、`assistant/research.ts` | 已接先读材料、事实笔记交接与同快照调查回退；初始摘录直接进入写作者上下文，trace 分开记录两阶段，固定引用和原有复核仍生效 |
| `learning` / `memory` | 决策模型只提供候选，不绕过 MemoryService，也不把模型置信度转换成直接写权限 |

当前没有证据支持“所有请求先过一次本地 4B 就会更快、更准”。下一步优先验证窄任务和完整问答链，而不是继续堆模型名字、融合权重或针对这份题目修改阈值。
