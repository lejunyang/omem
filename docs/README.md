# omem 系统设计交付

2026-09-26 · 设计提案 v0.1。为 Agent 自治、自学习的长期记忆系统设计；核心是可深入阅读的版本化证据引用。

已进入实现：先读 [当前实施状态](implementation/status.md) 和 [项目运行指南](../README.md)。设计系统为 [根 design.md](../design.md)。

第一轮设计参考：建议先打开 [交互原型](prototype/index.html)，再读 [design.md](design.md)。原型是单个自包含 HTML，可以复制后离线打开，无需安装依赖，也不发送网络请求。

| 文件 | 内容 |
| --- | --- |
| [design.md](design.md) | 产品定位、需求、关键取舍、架构、记忆分类、自治流程 |
| [research.md](research.md) | 开源研究、旧方案修正、组件复用边界、PoC 选择 |
| [implementation.md](implementation.md) | 模块、数据库、摄入、引擎一致性、API、部署、路线与验收 |
| [contracts/evidence-model.md](contracts/evidence-model.md) | 片段身份、固定版本、引用边、选区、递归 UI、问答与恢复合同 |
| [autonomous-learning.md](autonomous-learning.md) | 经历→事实/方法/使用策略的具体学习循环、反馈、遗忘与预算 |
| [interaction-design.md](interaction-design.md) | 信息架构、风格、逐层弹窗、原位追问、边界状态与体验脚本 |
| [decisions.md](decisions.md) | 最后统一确认的 5 组问题与当前默认值 |
| [research/source-index.md](research/source-index.md) | 17 个上游仓库的固定 commit、许可证与核验文件 |
| [research/sources.json](research/sources.json) | 文件 URL、commit 和 SHA-256，便于后续复核 |
| [prototype/index.html](prototype/index.html) | 可直接打开的离线交互原型 |
| [prototype/README.md](prototype/README.md) | 原型运行、修改、测试、演示范围 |
| [validation.md](validation.md) | 本次实际验证、结果与尚未验证的内容 |

所有公司故事、任务、规范和数值样本均为原型演示，不能作为真实业务政策引用。开源能力结论区分资料/源码核验与待 PoC 项，不承诺未实测的性能或生产可用性。
