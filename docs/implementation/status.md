# 第一批实现状态

2026-09-26。已从设计进入可运行代码。主链为：输入材料 → 固定版本/片段 → 引用阅读 → Agent CLI/ACP 追问 → 保存回答与依据 → 变更通知；另提供可关联证据的需求待办和到期提醒。

## 已实现

- Node/TypeScript 模块化服务，Fastify HTTP API；SQLite + 图片对象目录；Vue 3 阅读台。
- osdk Node 版本锁定、应用依赖闭包、项目任务与 osdk-guide 安装；正确仓库 lejunyang/one-sdk。
- 根 design.md、omem-design skill、8 个 Vue 公共组件：按钮/图标/徽章/面板/空态/引用/弹窗/布局。
- CaptureEnvelope 支持文本/图片/链接与应用、窗口、会话、事件等上下文；图片严格类型和预算校验。
- 文件、固定 Git commit 文件、lark-cli 文档导入；主动 HTTP/CLI 输入；opt-in TraeX hook 转发模板。
- 版本化材料与不可变片段；引用/反向引用；环跳回；恢复为新版本且拒绝覆盖后续修改。
- 持久变更/通知同事务；应用内即时提示或关闭逐条提示；待办状态、关联证据、UTC 到期提醒去重。
- 官方 ACP SDK 的 initialize/new/config/prompt/update/cancel/close；动态模型/effort、固定证据、图片、超时、输出预算、进程清理；过滤 thought chunks。
- Codex/TraeX/Claude CLI adapter 与显式 argv；不通过 shell 拼 prompt；CLI 图像暂不支持，明确报错。
- 真实 Vue API 页面：材料输入/目录/搜索/阅读/引用/追问/版本/待办/通知/历史/能力/组件展示。

## 实际验证

- `osdk run check`：TypeScript、Vue 类型检查、服务端测试、生产构建。
- **19 项服务端测试通过**，覆盖版本幂等、历史证据、恢复冲突、循环引用、图片拒绝、到期去重、搜索转义、访问令牌/来源检查、完整问答持久化、hook字段筛选、模型/effort协商、权限拒绝、超时/取消，以及真实文件/Git读取。
- 浏览器用真实 Fastify/SQLite 和协议 fixture：材料录入、递归引用/环、问答保存、旧版本读取、事项/通知、桌面与 390px 手机，以及真实 SQLite 中的 100 个固定片段连续下钻（7 组浏览器检查）。fixture 只在测试配置使用，产品没有模拟回答 fallback。
- **真实 TraeX ACP**：TraeCode CLI 0.207.1，发现 19 个 model 配置选项、4 个当前 effort 选项；用握手返回的 `gpt-6-astra / high` 显式设置后，一次真实问题返回 `12 件。`。不把这些值写成默认限定列表。
- **真实 lark-cli**：使用用户提供的 ACP Wiki 文档验证读取与 CaptureEnvelope 归一化（revision 15，12,245 字符，text+link），报告不保存正文。
- Docker/containerd：仅 doctor 实测；当前宿主不可用，未执行容器 pull/build。
- Codex/Claude CLI：核对本机 help 与 argv/协议实现；本轮未实测其登录后的真实生成，不将其宣称与 TraeX 同等验证。

## 明确的实现取舍

上一轮 Python + PostgreSQL + 多引擎是长期提案。根据个人优先、Vue、CLI/ACP 优先，本轮先采用统一 TypeScript + SQLite，减少启动依赖，保留 API/领域/adapter 边界。不是宣称已经具备多租户 ACL、分布式事务或 pgvector。

所有原件/回答可追溯，不等于每个 Claim 已由证据验证器证实。当前答案保存的 references 是“提供给本次模型的材料”，正式 supported_by 评估还未实现。模型输出不自动升级为现行事实，不自动产生可执行方法。

当前引用身份按每份规范化文本的段落生成；跨 revision 语义 Fragment 身份续接、精确选区 selector、原生飞书 block 映射、原文刷新依赖失效暂未实现。UI 没有冒称具备这些能力。

## 后续实施顺序

详细任务拆分、协议与验收已移交到 [batch2 文档包](batch2/README.md)。后续实现以该包和已确认需求为准；以下是范围概览，尚未实现。MemPalace 新增为本地检索独立 PoC 候选，见 [专项研究](../research/mempalace/README.md)。

1. 从真实材料/轨迹提炼 Claim、Episode、TaskProposal 的结构化输出；强制证据绑定、歧义/影响分类；高置信小范围自动应用并通知，其他形成可审阅决策。
2. 外部通知 sender + 投递幂等/回执/重试；用户配置飞书目标后接即时通知与摘要。完善 hook 本地 spool、断线补传和可配置字段脱敏。
3. ACP 长期会话复用、resume/context packing、结构化人工问题与权限决策 UI；目前问答每次新会话，权限请求只通知并拒绝。
4. 捕获源注册/增量刷新/并发游标、跨版本片段映射和依赖刷新；接群聊机器人和外部屏幕观察器。
5. osdk 管理 embedding/reranker 快照，加入语义检索基线；再对 WeKnora/Hindsight 进行 CLI provider 兼容性与资源 PoC。
6. 团队模式用 PostgreSQL、独立主体与逐证据 ACL；主动推进外部事项的执行器独立授权，不能沿用普通知识写权限。

项目 README 给出了运行方式；历史设计/原型保留用来解释目标，不能当本页的已交付清单。
