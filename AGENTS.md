# omem v2：开发约定

先读 README.md 和 docs/v2/architecture.md。docs/archive 是历史资料，其中的“当前”“进度”只对应当时。

## 产品原则

- 一个来源体系：文档、代码、聊天、笔记、网页都是原件（sources），按空间（spaces）隔离领域。代码有符号级切分和导航，但不形成第二个知识产品。
- 宿主只做数据、索引、调度和权限；理解、调查和写作交给 Agent。不要在宿主里为模型拼几十条规则的长 prompt、强制 JSON 输出或替模型做多轮检索规划——给它工具（src/agents/tools.ts）和清楚的角色说明（roles/*.md）。
- 模型没有直接写库权限：所有写入走工具，工具层校验空间范围和角色允许的工具清单，并记录在运行（runs）里。
- 派生知识（Wiki、记忆、事项）必须能回到原件。Wiki 正文引用格式 `[文字](src:<原件id>#L起-L止)`，页面链接 `[[slug]]`，记忆引用 `mem:<id>`。
- 记忆更正用 supersede 保留版本链，不覆盖；事项变化写时间线。原件只保留最新版，删除留墓碑。
- 通用代码不得按项目名、目录名或题集问法特判。分类与范围用空间和持久设置表达。

## 写给读者的内容

- Wiki 按读者问题组织，不按文件逐个生成。写作要求在 roles/wiki-writer.md；改写作质量优先改角色说明，其次才改代码。
- 文档和生成内容用中文，直接具体，避免套话。成稿可按 `.agents/skills/lieflat-less-ai-tone/SKILL.md` 检查表达，不改事实和结构。

## 界面

- Vue 3 + TypeScript，在 web/。公共样式与 token 在 web/src/styles.css（浅色/深色），组件在 web/src/components。
- 阅读优先：正文限宽、标题衬线、引用贴近论断。引用统一走 CitationDrawer（逐层返回，Esc 退一层，关闭归还焦点）。
- 采集来的内容一律经 DOMPurify；不直接 v-html 原始 HTML。
- 改界面后用 `node scripts/screens.ts <url> <dir>` 截 1440 与 390 宽度检查，不能出现横向溢出。

## 运行与依赖

- Node 22.18+ 直接运行 TypeScript（类型擦除），import 写 `.ts` 后缀，只用可擦除语法（不用参数属性、enum、namespace）。构建由 tsc 改写后缀到 dist/。
- osdk 管理工具链、依赖和可选模型（`osdk run dev/check`）；不强制本地大模型。向量模型可选，换模型会清空旧向量。
- 个人配置、数据库、原件、密钥、模型权重不进 Git。

## 验证与交付

- `pnpm run check`（类型、测试、构建）必须通过。test/fake-acp-agent.ts 走真实的 ACP + MCP 桥接路径，改 Agent 运行时后要保持它通过。
- 改检索后用 `scripts/eval-retrieval.ts` 在公开数据（如 T2Retrieval 子集）上对比 nDCG@10，报告实际数字和对照组，不要用少量自选问题代替。
- 改角色说明或工具后，用真实 Agent（Codex gpt-6.1-sol/luna 低 effort，或 Claude Code）跑一两个真实问题检查行为；不要为了验证批量生成知识。
- 每个完整功能切片通过检查后提交；不 push，除非用户要求。
