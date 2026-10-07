# 中文快速决策：实际接入与选择规则

更新：2026-10-05。StartLux-Decision 0.8B、2B、4B 已在 Apple M2 Pro / 32GB 上以官方 BF16 / MLX 原生方式运行。**共用服务已经接到助手初始选材、原文页用途建议与个人飞书消息分流，仍不能把模型判断当事实写入、操作授权或安全证明。** 检索逐项结果见[同一份实验简报](../../.repo-review/knowledge/verification/fast-decisions.md)；消息的七维判断、低分与缺资源处理见[个人消息](personal-messages.md)。

## 本机结果

固定八条中文合成材料和六条真实 HTTP 检索结果，每段同时判断六个维度；三种大小使用同一输入和上游源码版本，顺序加载释放，没有针对结果调整问题或阈值。

| 大小 | 暖机单段中位耗时 | 六条实际材料合计 | 首次初始化 | MLX 峰值分配 |
| --- | --- | --- | --- | --- |
| 0.8B | 253 ms | 1.72 s | 38.9 s | 2.19 GiB |
| 2B | 576 ms | 3.96 s | 40.8 s | 4.04 GiB |
| 4B | 1469 ms | 10.15 s | 50.7 s | 8.39 GiB |

这里的 MLX 分配不是系统总内存，不能与进程 RSS 相加。设备其他程序负载未受控；14 个例子不代表中文总体准确率。

2B 改善了把攻击示例当实际注入的问题，仍漏判一段有用的选材步骤。4B 找回该段，但把另一段宽泛目的说明当成充分答案，部分无关材料也被判为部分覆盖。0.8B 还会把不同活动的规则误认作前提冲突。更大有局部收益，没有测出“4B 总能判断正确”。

## 现在接在哪里

`apps/server/src/decision/service.ts` 管理一个常驻子进程；`scripts/startlux/worker.py` 使用官方 `MLXDecision`，一段多问题、读取原生选项分布，不生成聊天文字。启动、失败、模型身份和耗时可查看；请求串行，避免同时载入两份模型。

| 判断 | 输出 | 当前消费者 |
| --- | --- | --- |
| 相关性 | 无关、仅话题、背景、答案/关键条件、未知 | 助手初始召回的阅读顺序 |
| 回答覆盖 | 无、部分、充分、未知 | 诊断保留，不据此自动快答 |
| 内容支持 | 明确陈述、条件性、讨论/示例、无支持、未知 | 联合判断明显无关项是否省略；来源版本仍由宿主校验 |
| 前提冲突 | 冲突、不冲突、未知 | 冲突候选保留给 Agent，不能当负面材料过滤 |
| 指令注入 | 普通、引用攻击示例、实际尝试、未知 | 当前只记录可疑标记，没有接成自动安全过滤器 |
| 父章节需求 | 需要、自足、未知 | 保留需要背景的候选；尚未按此结果自动二次补读 |
| 入库用途 | 日常安排、学习、代码、业务各自是/否/未知 | 原始材料页显示可同时成立的用途建议；不是持久分类或自动目录 |

`AssistantRuntime.retrieveContext` 在 RetrievalPort 召回后调用 `assessPassages`，再进入原有上下文装配。最多判断前 12 段、等待最多 8 秒；未评估候选保留。联合省略门槛为无关 ≥ .98、无回答 ≥ .95、无支持 ≥ .95，冲突、背景需求或不确定选项较高时保留；如果评估项全被省略，则退回原候选。门槛是保守初始策略，**尚未经大样本概率校准，不代表可靠错误率**。实际 HTTP 的 12 条判断没有触发省略，不能宣称已明显过滤噪声。

冷启动在后台预热，当前问答沿原候选继续；模型故障或切换耗时也不阻塞主流程。普通搜索列表未换排序，Agent 自主搜索仍能找回原候选。问答默认继续使用 Sol。近期对话的对象消歧仍由原有助手处理；此次没有把小模型接成所有请求的前置路由。

用途建议按固定 revision 自动读取，长文先看前 12,000 字符并明确标为摘录，只展示正向建议；缓存保留五分钟，原文版本、问题和判断模板属于输入身份。服务运行期间配置固定；模型切换后同一输入可能短期复用之前的结果，并带原结果模型身份，不把它冒充新模型输出。

## 负载如何选择

`decisions.mode` 支持 `off`、`auto`、`2b`、`4b`、`9b`。未配置时采用机会性 `auto`，无环境或权重则回到常规 Agent；运行不会下载。自动模式只选择 2B/4B，9B 必须显式选择，目前暂按可用内存 28 GiB 才准入，这个预算尚未通过真实 9B 推理校准。

自动模式用可用内存加当前模型可释放内存估算余量：余量至少 14 GiB 且一分钟 load average / CPU 数 < .85 时选 4B；至少 8 GiB 时选 2B，否则暂不运行。一次只驻留一个模型，正常切换间隔至少五分钟，内存压力可以触发提前降级；空闲三分钟释放。也可显式固定 2B/4B，但仍执行内存准入。

这是可调整的本机资源策略，CPU load 只是压力信号，不是 GPU 忙闲的精确测量，也不保证 macOS 不发生交换。没有做边运行所有应用边强制压力的实验；真实 HTTP 曾按当时负载选到 2B。

## 怎样准备和观察

安装版在服务机器准备 osdk 后运行 `omem setup decisions`，默认只下载 2B；`--model 4b|9b|both|all` 按需选择，both 为 2B+4B，all 为三种。当前仅支持 Apple Silicon Mac。配置 decisions.mode 并重启才启用，auto 只选择已安装的 2B/4B；9B 需显式配置 `"9b"`，尚未实际推理验收。安装、完整摘要校验与实际推理分开检查，详见[依赖与模型](../../skills/omem-cli/references/dependencies.md)。

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

模型、上游 Python 文件哈希和依赖分别固定在 `osdk.lock`、`scripts/startlux/upstream.json`、`scripts/startlux/uv.lock`。原生源码固定 `0e7a2e81b9c92756e26d8edd843a44d50e362669`。API `/api/decisions/status` 可读状态，`/api/decisions/search?q=...` 返回实际候选与多维结果；首次可能只启动预热，后续请求复用常驻模型。`/api/decisions/intake` 接收 revisionId，返回用途建议。

模型范围和接口见 [StartLux 官方仓库](https://github.com/StartLuxLabs/StartLux-Decision)、[2B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-2B)、[4B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-4B)和[9B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-9B)。权重 CC BY-NC 4.0、推理代码 Apache-2.0；实际验收过 Apple Silicon 的 0.8B/2B/4B 文本后端，9B 安装选择已接入但未实际推理验收，图片先由导入流程提取内容。

## 已有其他路径与后续

GLiClass multilingual mini、Qwen3.5-4B MLX Q4、Plumb-4B Q8/Q4 已实跑，结果及失败保留在同份简报与结构化结果，不重复模型清单试验。English-only 候选低优先级；不再测 Luna。原有 `decision:evaluate` / `decision:inspect` 仍是离线或只读试验入口。

助手可显式配置 `assistant.readingProfileId` 采用 Sol / low 先读作答，再由 `review_answer` 独立核对或 `handoff_to_research` 交回调查，复用同一材料快照。复杂仓库题曾遗漏关键条件，短生活材料有局部速度收益，仍未默认启用。小模型的充分性分数不决定快答或免复核。

下一步把建议变成可修正的持久分类，并接可编辑目录草案；父章节补读、更新候选和危险输入审查按实际消费者推进。记忆变更必须对照人物、项目、时间和新旧原文，最终仍经 MemoryService。不能仅因为某个选项最高就覆盖记忆，也不能让这些高影响用途一直阻挡低影响的排序和分类建议。

外部工具资料沿用同一个快速决策服务：`conversation_input_relevance` 同时给出任务相关性、证据/定位/错误/可疑用途，以及可复用材料/仅入口/诊断/不确定的保存建议。仅用就绪模型、最多等待 2.5 秒，未就绪交回主助手。它不触发 Capture；主助手选择后宿主复制原始内容。两轮外部材料保存/找回验收使用真实 Sol，关闭快模型，因此没有新增这组分类的准确率或提速结论。

开发准备也复用同一服务：`repository_diagnosis` 根据实际 Git 失败建议检查登录、网络、版本或本地状态；`project_setup_advice` 对一份项目说明给出用途、环境前提和操作副作用三维建议。都走就绪模型的 2.5 秒等待，冷启动或失败照常由主助手调查。它们不生成或批准命令；主助手仍需补读实际脚本，不能把小模型标为 local 当作可执行的安全证明。

2026-10-06 对三段合成中文开发说明尝试实际运行 2B，服务因可用内存不足未加载模型，全部返回不可用；没有分类准确率结论，没有强制降低准入或下载其他模型。主助手真实编码验收关闭快模型，不能据此宣称这些建议已经改善配置效果或耗时。

编码 Agent 可用 `development_change_advice` 对实际新旧需求建议“实现/背景/范围/不确定”与“改代码/补材料/澄清/保留”。同样只用已就绪模型，不可用则正常阅读决定；原交办权限与新验收仍由宿主和独立评审核对。本轮真实续做实验关闭快模型，没有新增这项分类准确率结论。
