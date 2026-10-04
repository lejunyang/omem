# Agent 自主调查、写作与独立补查

更新：2026-10-04。原生 ACP 调查、写作与独立补查已接通；实际仓库生成状态见 progress.md。

## 改造前的限制

writePage 的 researcher 返回 requests，宿主最多三轮执行 MaterialResearch.search/read，随后 writer/verifier 读取同一批材料。每轮新建 ACP session；knowledge roles 的 skills 内联、工具关闭。底层已能携带 MCP，但未接知识工具。输出所有文本拼成 JSON，也会把正常过程说明判成输出错误。

## 已接通的实现

`knowledge/pipeline.ts` 的 ACP 知识任务默认开启 nativeResearch。研究者在一次 session/prompt 内按需读材料并用工具调查，再把 findings 交作者；作者也可以继续读取；verifier 独立新会话有相同材料范围和工具，自行补查。调查不再受宿主三轮门槛限制。保留旧 bounded-context 模式作为非 ACP/协议兼容；这不表示普通助手问答的上下文策略也已重做。

`knowledge/agent-research.ts` 把固定原文导出 originals/，保留安全相对路径，图片单独导出，catalog.json 记录 key、修订、文件、行数和出处。`research-snapshot.ts` 向隔离 SQLite 复制本次获准原件、历史与相关知识/记忆，复用版本仍匹配的检索投影和向量，封存后只读；不会复制个人会话、凭据或全部数据库。任务完成前不会因当前库变化而悄悄换原文。快照会话按需加载本地已安装的中文 BGE，未安装降级全文，不下载权重。派生文章和记忆仍标明背景来源。

官方 MCP SDK 提供 Streamable HTTP，只监听本机且每次任务有独立随机地址，生命周期随角色结束。工具如下：

| 工具 | 帮助 Agent 完成的调查 |
| --- | --- |
| list_materials | 按标题/路径/类型发现原件，分页取得完整目录 |
| read_material / read_section | 整篇、任意行段、完整章节或函数；目录保存父子节点，可按 contextId 向上补条件、向下读子话题；含来源、修订和图片 |
| search_materials | 共用修复后的混合检索；按明确 key/类型缩范围；弱匹配可为空 |
| search_knowledge / read_knowledge | 阅读已有解释和其引用，再回原文核对新增事实 |
| search_memories / read_memory | 找已有事实、经验、流程及其依据，提供背景 |
| code_navigation | 定义、import、候选调用位置、路由和测试；不是完整类型调用图 |
| related_materials | 显式关联及 confirmed/candidate/missing；不把 import 当业务关系 |
| material_history | 查看已捕获版本目录，按修订补读；历史正文只作背景 |
| read_image | 提供原始图片像素，另有工作区文件路径供原生读取 |
| submit_result | 校验最终候选；错误留在当前 Agent turn 内修正，成功仍由宿主发布 |

`agent-runtime/gateway.ts` 在原生知识模式跳过宿主输入/输出 token 预算，skills 按 canonical 名称原生加载；`agents.ts` 处理工具生命周期、计划与实际 usage，丢弃私有思考。候选提交经共享 Zod 合同及引用校验，因此聊天过程不用伪装成最终 JSON。实际 config/review-code-model.json 已移除三项预算配置；模型固有窗口、Traex 自动压缩、超时和取消仍存在。

正文依赖记录引用与实际工具读取的材料，而不是把导出目录中所有文件都算依赖。原生 shell 的 parsed_cmd 与 MCP 读取都保留记录；未被运行时识别的 shell 阅读不能宣称完整覆盖，引用依赖仍是最低保障。固定历史引用不会自动跳到新版。

真实小型验收使用代码路由、配置表和独立设计说明：研究、作者、复核都发生实际工具调用；作者形成含场景输入输出、流程图、概念区别和修改入口的五节页面；独立复核重新读取与搜索后通过。图像工具、历史版本读取和全库复杂调查还未单独做真实模型验收，不能继承为全部工具通过。

## 目标分工

omem 提供阅读目标、明确材料集合、可读快照、搜索/读取/导航、任务状态与最终发布。Traex 自带 harness 负责选择调查步骤、原生工具调用和上下文压缩。模型用足够材料写解释；独立新会话拿原件和草稿自行补查。复核不只看前一个角色选好的引文。

研究会话中不设置宿主输入/输出 token 预算，初始输入只给目标、材料目录与工具方法。原文导出 runtime 临时目录，代码/Markdown 保持可用文件结构，其他材料有可读名称和稳定路径映射。完整内容按需读取。没有人为 3 轮调查门；超时、取消和进程退出仍是任务生命周期能力。

## 工具范围

- 材料目录、类型与来源、标题/函数 outline；原文整篇、章节、行段、图片附件；固定版本和历史。
- 全文/符号/语义统一搜索，可选择类型、材料范围、时间；返回相关正文、路径、章节及补读入口，不自动扩散所有引用。
- 知识文章及章节搜索、读取、来源引用；记忆只提供背景和其依据，不重复算独立支持。
- 代码符号定义、结构依赖和候选调用；相关设计/测试关系明确 confirmed/candidate/missing。
- 最终产物提交：正文/引用和复核结论经宿主合同校验；过程中可自然说明进度，不能将所有文本拼接当最终 JSON。

原生 Read/Grep/Glob 用于快照文件；MCP 用于内部对象、检索与导航。角色 skill 指导从场景追流程、缺背景先搜索、区分事实推断未知，以及不同页面模板。工具应覆盖这些问题，避免列几十个重复动作消耗 Agent 上下文。

## Traex 集成依据

通过 lark-cli 读取用户指定的手册和 ACP 指南，完整响应保留 `.repo-review/runtime/research/`。重要边界：

1. `session/prompt` 是 Agent 完整运行 turn，可包含反复模型与工具调用。
2. `_meta.trae.options.skills` 使用 canonical 名称选择原生 skills；项目 skills 按会话 cwd 发现。
3. session/new 的 MCP 会与已有配置合并；工具作用在 Traex runtime，客户端 fs=false 不关闭原生读取。
4. 客户端消费 tool_call/update、plan 与 usage，不保存私有思考作为产品正文。
5. `exec --output-schema` 有明确文档；ACP 是否支持对应扩展须实测，不能猜字段。
6. 只读材料调查在本次任务已授权范围内自动运行；写发布由宿主负责，不默认授予外部消息或真实原件修改权限。

## 最终质量与验证

先改善检索，再向 Agent 提供。真实 traex / gpt-5.6-sol 验证必须看到工具实际被调用、补读超出初始材料、产物形成、独立审阅也自行读取，并记录实际失败。文章检查案例、必要概念、机制和操作入口；“工具调用次数多”不等于质量好。

保留旧有效文章和历史，不手改派生 JSON。实现检查通过单独提交，然后生成受影响实际知识再提交。实时工作目录不能被悄悄当生成时的固定原文。

## 工作区生命周期

全库实测曾因每个角色长期保留数据库与原件副本而占满磁盘，不能把“临时目录在 gitignore”当资源管理。当前角色结束或准备失败就回收原件导出、图片和 snapshot.sqlite；catalog.json、result.json 与 research.jsonl 仍保留，原始版本与历史在正式 Store，不随临时副本删除。作者只收到研究结论与缺口，操作 trace 单独留作审计，不成为写作输入。
