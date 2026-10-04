# 中文快速决策：先筛选模型，再决定接在哪里

当前状态（2026-10-04）：已通过 osdk 安装并实跑 GLiClass multilingual mini、Qwen3.5-4B 和 Plumb-4B 的 Q8 / Q4；已有固定中文场景、真实 HTTP 搜索命中对照和“搜索前后再判断”的只读入口。小模型尚未接管线上路由或记忆写入。助手另有可配置的“先读材料作答 → 需要时转交调查”路径，复用 ACP、工具和同一材料快照；默认仍为 Sol 常规调查。实际收益与限制见[实验简报](../../.repo-review/knowledge/verification/fast-decisions.md)。

初步结论是：小模型有机会帮助选择阅读顺序，但“相关”“能回答”“值得更新记忆”“得到操作授权”是不同判断。把它们合并成一个高置信度分数，会把错误直接传到下一步。短例子成绩好，也不能保证长材料里的关键条件没有漏掉。实测数字、失败例子与机器占用见[当前实验简报](../../.repo-review/knowledge/verification/fast-decisions.md)。

先读作答的首轮真实对照同样没有整体通过：一个直接查询更快且条件完整，两个问题仍有重要遗漏或对象混淆。因此该配置用于继续实验，暂不建议默认开启；回退到 Sol 也不是质量保证。

## 为什么选这些模型

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

已接入可选的先读材料阶段，不是默认路径。写作者直接收到完整的初始摘录、既有解释、对话与事项，也能用同一套原生读取和 MCP 补读。它不接收一个小模型给出的“资料充足=true”，需要自己判断对象、时间和关键前提是否覆盖。足够时直接提交；跨文件机制、冲突、需要独立复核或用户交办时，调用 `handoff_to_research` 保存已查事实、来源和具体缺口，再结束该阶段。常规调查使用原来的材料快照继续工作，不再复制整库或丢失前文；交接笔记仍是待核对建议。

配置 `assistant.profileId` 为调查 profile，并选择 `assistant.readingProfileId`，例如示例配置中的 `traex-reader`（Sol / low）。不配置后者就保持原流程。模型和思考强度均经 ACP 发现、校验、回读；对照脚本的 `--reading-effort auto` 从模型实际提供的 none/minimal/low 中选最低项，不支持则报错。按此前停止 Luna 反复对照的要求，本轮先比较同一个 Sol 的 low 作答与 medium 调查。

先读阶段不提交事项变更；交办转入现有调查与 MemoryService 流程。用户取消时不会启动调查回退；先读阶段调用失败或没有提交时可以回到调查，阶段失败仍记录在 trace 中。总问答超时沿用原配置，两阶段不各获一份额外总预算。它没有减少原有材料快照的准备成本，也没有新增宿主 token 或工具次数限制。

```bash
osdk run assistant:compare --questions /absolute/path/questions.json --review --reading-model gpt-5.6-sol
```

在同一冻结材料上分别运行常规调查和先读后调查，按问题交替顺序；每种路径保留各自的追问历史。报告列出阶段、实际模型/思考强度、交接原因和总耗时。对照副本在结束后释放，报告沿用有界保留规则。

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
