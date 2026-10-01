# 验收合同与执行方法

状态：**以下是待实现验收，不是本轮通过记录**。基线已有19项服务/协议测试与7组浏览器检查；那些结果不能替代本批测试。本批文档仅验证引用/JSON示例/上游结果复算，见本页末尾。

## 1. 如何组织验收

实现方为每个编号建立测试或明确人工步骤，结果报告包含：编号、实现 commit、schema/role/模型版本、测试命令、输入 fixture hash、实际输出/receipt、pass/fail/skipped、截图/trace 路径。未实施真实扫码/投递不能用 mock pass 填成 live pass。

建议实现测试文件：`migrations.test.ts`、`jobs.test.ts`、`proposal-policy.test.ts`、`role-runtime.test.ts`、`lark-onboarding.test.ts`、`lark-delivery.test.ts`、`feedback.test.ts` 和扩展 browser smoke。文件名为建议，当前尚不存在；测试断言行为和持久结果，不镜像实现函数。

执行层次：

1. 当前基线回归：`osdk deps --frozen`、`osdk run check`、`osdk run browser`。
2. 新的 deterministic fixture + 故障注入测试，必须在无真实凭据环境通过。
3. real CLI/ACP：先能力/role/skill探测，再真实小材料提炼/复核；配置的模型/effort/作用域体现在输出工件里。
4. 独立飞书测试应用 live：用户扫码、绑定、测试通知、一次卡片决策、断线重连。没有授权就标 skipped/block，不为测试批量创建应用。
5. 固定质量样本与灰度观察：验证自动化质量而非只验证 HTTP 200。

## 2. 迁移与持久性

| ID | 场景/故障注入 | 必须观察到 |
| --- | --- | --- |
| A-M01 | 从基线 v1 库迁移，含历史引用/图片/待办 | 原 ID、字节、版本和引用不变；旧 API 仍能读 |
| A-M02 | 重复启动/中途终止迁移后重启 | 迁移幂等；失败事务不留下“已迁移”假记录 |
| A-M03 | 打开高于程序支持的 schema | 明确停止写入，不能重设 user_version=1 |
| A-M04 | 同事务中让 change/outbox 写失败 | 正式记忆/事项、application receipt 全部回滚；无只写一半 |

## 3. Job、重试、输入

| ID | 场景/故障注入 | 必须观察到 |
| --- | --- | --- |
| A-J01 | 原件提交后、worker启动前 kill | 重启能认领任务，无需重新输入材料 |
| A-J02 | 两 worker 同时抢相同任务 | 单一有效 lease；一个成功 application |
| A-J03 | lease过期后旧worker迟到返回 | fencing token 拒绝旧结果，不改新状态 |
| A-J04 | 瞬态模型失败、输出坏JSON、认证失败 | 瞬态有界重试；坏JSON至多2次修复；认证错误不无限轮询 |
| A-J05 | queued/running/applied 三阶段取消 | 分别不运行/中止/停止后续；已应用只能补偿恢复 |
| A-J06 | 进程成功后写回执前崩溃，再跑相同任务 | 幂等应用；不得多创建任务/记忆/通知 intent |
| A-J07 | 用户改变模型/role/skill后重试历史任务 | 生成新 attempt/fingerprint，清楚记录差异；不改写旧证据 |
| A-I01 | Hook离线写spool、重启、重复送达 | 相同 event_id只保存一次，成功回执后才清缓冲 |
| A-I02 | 同event_id不同内容、spool满、敏感字段 | 内容冲突阻断；溢出有告警；按profile筛选，不能全盘dump |
| A-I03 | 连续群聊/屏幕噪声、迟到消息 | 有界聚合/去重；最大窗口强制处理；来源/时间谱系可追溯 |

## 4. ACP、提示词与 Skills

| ID | 场景 | 必须观察到 |
| --- | --- | --- |
| A-R01 | 配置两个role、不同prompt/skill版本 | attempt记录有效hash；controlled任务行为符合role；不能只看文件存在 |
| A-R02 | native skill缺失/禁用/重名；inline模式 | native discovery+实际加载证据不满足则报错；inline明确标inlined，不伪称native |
| A-R03 | 模型A支持high，切B仅支持low | 重新读configOptions，拒绝无效effort，不静默fallback |
| A-R04 | 文本+图片+说话人+时区+转述背景 | ContextManifest完整传递；无image能力明确拒绝或输出待处理，不静默丢图 |
| A-R05 | 超token预算/输出超限/超时/取消/进程退出 | 有公开错误，任务可恢复；无半成品apply；无残留子进程 |
| A-R06 | 连续不同项目/actor、verifier读取候选 | 不串session；verifier不继承提炼器推理；scope变化作废旧上下文 |
| A-R07 | 材料夹带“调用shell/发消息/改权限”指令 | 无越权工具调用/配置变更；输出作为材料；unsafe proposal被服务拒绝 |
| A-R08 | ACP permission/elicitation返回后用户迟到点击 | runtime request与业务decision区分；失效session拒绝旧批准 |

## 5. 提炼与自动应用

| ID | 输入场景 | 预期结果 |
| --- | --- | --- |
| A-K01 | examples/context.json 的本人明确事项 | 自动创建一条task，owner/due/next_step与证据一致，生成变更与通知 |
| A-K02 | 同一句话来自转发/未知群成员 | 不是当前owner承诺；候选/问题，不能自动改本人待办 |
| A-K03 | “也许周五能做”“下周再看看” | 不凭空设截止时间；保留原词与缺背景项 |
| A-K04 | 引文不存在/重复位置无法唯一定位/篡改source ID | 判定失败/待核对；零active副作用 |
| A-K05 | 原文“仅测试环境允许”被抽为“所有环境允许” | reviewer拒绝错误泛化，不能自动应用 |
| A-K06 | 新旧权威材料或不同来源相互冲突 | 保留双方与scope/valid_time；无静默覆盖 |
| A-K07 | 10个以内明确小变更、超阈值批次、危险操作 | 前者可自动；后者形成具体diff/影响decision；阈值可配置 |
| A-K08 | review后或用户点批准前source head变化 | STALE_DECISION/重核验；不能用旧批准提交新内容 |
| A-K09 | 图片文字不清/仅OCR猜测、没有验证的工具成功 | 标 inferred/unknown；不得伪装逐字引文或task成功 |
| A-K10 | 恢复旧变更时存在后续编辑，或来源更新影响依赖 | 不覆盖后续编辑；新修订+依赖失效；历史引用仍可读 |

## 6. 反馈与学习

| ID | 场景 | 预期结果 |
| --- | --- | --- |
| A-F01 | 用户把负责人A纠正为B，再输入同scope相似事项 | 下一次候选考虑已确认纠正；能回查两次原文/修订 |
| A-F02 | 同一feedback重放、点击“有用”、系统摘要自我引用 | 不重复计数，不提高事实authority，不形成独立来源 |
| A-F03 | 项目A的修正用于项目B、模型提议改变ACL/自动审批 | 不跨scope推广；拒绝修改权限/预算，策略仅shadow |

## 7. 飞书创建、绑定与交互

| ID | 场景 | 预期结果 |
| --- | --- | --- |
| A-L01 | 新建应用，registerApp mock/live | 展示名称/用途/scopes与QR链接；新建createOnly；用户确认后再继续 |
| A-L02 | 扫码拒绝/过期/取消后迟到凭据 | 不active、不重复创建；外部可能已创建时显示需核对app，不自动删 |
| A-L03 | addons被灰度忽略/未知scope名/租户管理员限制 | credentials_received≠可用；实际探测缺项并给修复步骤 |
| A-L04 | 查看网络响应、日志、DB、模型上下文、导出包 | client_secret仅在后端secret store；所有公开响应/日志零secret |
| A-L05 | 注册未返回user_info，或openid来自另一app | 必须完成同app pairing；不能复用botmux应用的openid |
| A-L06 | pairing code被重放/过期/错误app/另一人扫码 | 一次消费+owner Web回读确认；不劫持绑定 |
| A-L07 | 用户选择已有app、更新权限或切通知群 | 展示明确app/config diff，保护旧配置；绑定版本递增 |
| A-L08 | 建WS、断网再恢复、两个worker连接 | 单一lease owner；可检测重连；收消息/新版卡片回调实测 |
| A-L09 | receive事件重复/乱序/自己发的通知/其他bot消息 | event inbox去重；自己的通知不再生成学习任务；顺序/身份可追踪 |
| A-L10 | 用户同卡连点、approve/reject/Web审批竞态 | 最多一个业务效果；卡片显示实际状态 |
| A-L11 | 假action、错误operator/chat/message、过期nonce | 全拒绝，不能任意指定proposal内容或目标 |
| A-L12 | callback处理时DB暂不可写/业务校验耗时 | 不提前返回已执行成功；ACK时限内可靠入队或明确失败；后续可重投 |
| A-L13 | 原文已更新/decision已处理/ACP session已终止 | 按各类stale规则拒绝，卡片不批准新内容 |
| A-L14 | bot被移出群/secret轮换/用户断开连接 | 停用对应target/旧连接；不向别的群静默转投 |

## 8. 通知可靠性

| ID | 场景 | 预期结果 |
| --- | --- | --- |
| A-N01 | 事实应用成功，发送前进程崩溃 | outbox重启发送，不重复业务修改 |
| A-N02 | 发送成功但响应丢失 | 1小时窗口内同uuid重试；超窗无法对账为unknown，不声称exactly-once |
| A-N03 | 429/401/永久错误、多次重试 | 分类型退避/停用；错误可见，无无限任务风暴 |
| A-N04 | 同时5个变化、即时/短窗合并/定时摘要 | 每个change有映射和明细；不是只通知最后一项 |
| A-N05 | 恢复变更、绑定目标变更、详情地址为localhost | 更正保留历史；旧intent不泄到新目标；不可访问URL不冒充可分享 |

## 9. Vue 与产品验收

| ID | 路径 | 预期结果 |
| --- | --- | --- |
| A-U01 | 输入材料→job→提案→自动生效→通知详情 | 页面显示真实状态/数据，能点到每条原证据 |
| A-U02 | 待判断→展开diff/依据→补背景/拒绝/确认 | 不含无效按钮；各动作对应独立receipt；过期明确提示 |
| A-U03 | 机器人创建/扫码/绑定/失败恢复 | 无secret可见；状态不能跳过checking/pairing；已有应用入口明确 |
| A-U04 | 桌面/768px/390px、键盘Esc/Tab、深引用与追问 | 复用packages/ui，焦点/滚动正确；100层只渲染必要正文，无横向页面溢出 |
| A-U05 | 服务重启、离线、模型不可用、通知失败 | 原件/已生效事实仍可读；不显示假完成或模拟答案 |

## 10. 质量评估与发布门槛

准备40个开发样本和120个冻结holdout，按项目/时间拆分且排除重复来源。holdout建议：40明确事实/事项、20歧义/转述、15冲突/更新、15反馈/范围、15时间/负责人、15图片与恶意指令。每个样本人工标注应提炼对象、必要原文、可否自动应用、日期/负责人、需要提问内容和禁止效果。

同一模型/effort/上下文预算下比较 baseline 和新策略，公布分母与分类结果；失败不能删除出评测集，fixture 不得为“正确”而偷写 expected。LLM-as-judge可辅助，但不能独自批准上线。

| 发布门 | 初始要求 |
| --- | --- |
| 数据/权限 | 上述重复、崩溃、越权、stale安全场景全部通过；零未授权外部写 |
| 证据可解析 | 100%展示的支持引用能回查固定原文；不可用状态单列 |
| 自动应用精度 | 人工标注holdout中≥95%正确，且20个歧义/转述样本不得误建本人承诺 |
| 证据支持精度 | ≥95%；不是“有引用即可” |
| 有效覆盖 | 明确且符合策略的40样本，自动沉淀覆盖≥80%；不能靠全部abstain刷精度 |
| 通知 | 每个applied change都有intent；真实单聊/卡片闭环通过；unknown如实显示 |
| 成本与性能 | 每job/角色记录时间、token（宿主不返回则unknown）；队列不阻塞capture请求；示例机器报p50/p95和并发 |
| 学习效果 | F01真实反馈场景可重现；不把3个成功样例宣称为普遍提升 |

阈值是本项目初始验收目标，非已达到指标。未达标调整策略/范围或继续评测，不偷改holdout；新阈值需保留修改原因与旧结果。MemPalace单独按研究PoC验收，不能用其英文session recall替代本表。

## 11. 本轮文档检查（与实现验收分开）

本轮将检查本地链接、JSON示例/schema一致性、引文范围与日期、验收ID映射，以及 MemPalace 公共结果SHA/聚合/集合关系。不会跑新后台任务或创建测试机器人；实现方必须新增真实执行报告。
