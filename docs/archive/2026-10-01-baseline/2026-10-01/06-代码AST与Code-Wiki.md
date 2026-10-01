# 六、代码AST与高质量Code Wiki

## 6.1 下一步不是另建代码数据库

代码依据：[Capture到代码snapshot](https://github.com/lejunyang/omem/blob/94aafe934c6734aab346c6d73cf51dcec0c78d26/apps/server/src/code/sync.ts#L77-L267)、[AST visitor/SFC](https://github.com/lejunyang/omem/blob/94aafe934c6734aab346c6d73cf51dcec0c78d26/apps/server/src/code/parse.ts#L76-L311)、[typed edges与candidate](https://github.com/lejunyang/omem/blob/94aafe934c6734aab346c6d73cf51dcec0c78d26/apps/server/src/code/sync.ts#L272-L432)。

当前代码同步仍有repo identity `omem`及apps/packages/scripts等仓库范围假设；接更多代码库前应改为显式RepoRegistration与语言/根目录配置，保留每库权限和snapshot，不能把本仓库适配器直接说成任意仓库索引器。code_files/symbols/edges提供高效typed projection，每个节点都回到SourceRevision和Fragment/Selector。Code Wiki正文继续KnowledgeArtifact，代码背景/设计依据/测试和其他仓库资料使用同一Relation/EvidenceResolver/检索。review隔离DB是开发运行配置，不是独立生产知识authority。

优先修单文件AST caller归属，然后为TS/Vue构建受限workspace Program/TypeChecker；CompilerHost必须从固定Capture snapshot读取源码及已捕获配置，不能默认读正在变化的工作树；随后正确解析import alias、re-export、path mapping、函数/方法与静态可解析调用。动态dispatch/反射/运行时注入保留unresolved/candidate，不把“解析更多”伪装成完整运行行为。Vue template事件与脚本桥、宏/生成代码要单列覆盖度。

Tree-sitter适合需要多语言语法切片和增量parse时加入；SCIP可用于已有可靠indexer的大库符号导航/引用，不能默认它提供全语义call graph。何时引入取决于真实语言分布、索引正确率和维护成本。

## 6.2 增量与身份

repo revision包括commit/dirty digest；文件revision按blob，符号fragment固定于内容版本。Git diff与Capture内容hash共同选择变更文件（含dirty/new文件与非Git来源，不能只依Git diff），再根据export/API/type/依赖变化识别受影响邻居。对搬移/重命名，用稳定符号候选+AST结构+内容指纹映射并记录置信，不能直接沿用旧fragmentId。

AI重写范围按依赖粒度：局部实现说明、模块接口、跨模块流程、架构综述分别失效。只改注释不必重生成整个Wiki；公共接口变动则扩大到调用者说明和相关测试。生成缓存键要覆盖source digest、parser版本、角色prompt、模型、检索上下文及验证策略，模型相同不等于输入相同。

## 6.3 生成模板与真实质量

每份模块/流程说明应回答：职责与边界；入口/核心数据流；关键类型和状态；与需求/设计的对应；失败/恢复/并发/权限语义；测试证明了什么；未实现和待调查的限制。不要逐文件复述代码。面向实际问题生成如“飞书一条消息如何变成待办”“来源改变后哪些结论会过期”，跨代码/文档引用才有价值。

验证区分四层：定位合法、主张得到代码/原文支持、测试或运行证据存在、用户实际场景验收。AI解释“可用”不能来自函数名；测试文件存在不能等于测试已通过。verifier需要完整相关范围和反证，不仅320字预览；目前已有这一原则，应加主张级记录与抽样真实评测。

---

[返回目录](README.md) · [上一篇](05-RAG与记忆检索.md) · [下一篇](07-AI总结记忆治理与主动巡检.md)
