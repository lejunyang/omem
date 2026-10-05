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

`decisions.mode` 支持 `off`、`auto`、`2b`、`4b`。示例配置启用 `auto`；旧个人配置未写此字段则关闭。没有安装运行环境或权重时回到原流程，运行不会下载。

自动模式用可用内存加当前模型可释放内存估算余量：余量至少 14 GiB 且一分钟 load average / CPU 数 < .85 时选 4B；至少 8 GiB 时选 2B，否则暂不运行。一次只驻留一个模型，正常切换间隔至少五分钟，内存压力可以触发提前降级；空闲三分钟释放。也可显式固定 2B/4B，但仍执行内存准入。

这是可调整的本机资源策略，CPU load 只是压力信号，不是 GPU 忙闲的精确测量，也不保证 macOS 不发生交换。没有做边运行所有应用边强制压力的实验；真实 HTTP 曾按当时负载选到 2B。

## 怎样准备和观察

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

模型范围和接口见 [StartLux 官方仓库](https://github.com/StartLuxLabs/StartLux-Decision)、[2B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-2B)和[4B 模型卡](https://huggingface.co/startlux-models/StartLux-Decision-4B)。权重 CC BY-NC 4.0、推理代码 Apache-2.0；本轮只验证 Apple Silicon 文本后端，图片先由导入流程提取内容。9B+ 本机排除。

## 已有其他路径与后续

GLiClass multilingual mini、Qwen3.5-4B MLX Q4、Plumb-4B Q8/Q4 已实跑，结果及失败保留在同份简报与结构化结果，不重复模型清单试验。English-only 候选低优先级；不再测 Luna。原有 `decision:evaluate` / `decision:inspect` 仍是离线或只读试验入口。

助手可显式配置 `assistant.readingProfileId` 采用 Sol / low 先读作答，再由 `review_answer` 独立核对或 `handoff_to_research` 交回调查，复用同一材料快照。复杂仓库题曾遗漏关键条件，短生活材料有局部速度收益，仍未默认启用。小模型的充分性分数不决定快答或免复核。

下一步把建议变成可修正的持久分类，并接可编辑目录草案；父章节补读、更新候选和危险输入审查按实际消费者推进。记忆变更必须对照人物、项目、时间和新旧原文，最终仍经 MemoryService。不能仅因为某个选项最高就覆盖记忆，也不能让这些高影响用途一直阻挡低影响的排序和分类建议。
