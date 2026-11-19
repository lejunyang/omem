# 数据：指标、采集和报表

本人工作上的数据由 omem 记下来、按时取、看变化：需求的埋点事件量、上线后的报错和使用量、迁移时旧平台和新平台的对比、本人关心的业务指标。各系统本身由技能去读（数据目录里的技能写着哪个系统、什么命令），omem 只存指标的定义和数值。

- `metric_define(name, query, source?, description?, unit?, item?, context?, schedule?, baseline?, threshold?, direction?)`：定义或修改一个指标（同名即更新）。
  - `query` 要写到另一个 Agent 照着能取到同样的数：技能名、命令或查询语句、参数、时间范围、取哪一列；只写只读的查法。
  - `source` 用数据源目录里的叫法；挂到事项（`item`）或关注（`context`）上，事项页和关注会话会看到它的变化。
  - `schedule`（none / hourly / daily / weekly）是后台多久取一次：到时间起一次只读的取数运行，取完用 `metric_record` 记下。
  - `threshold` 是相对变化（默认 0.3），`direction` 说哪个方向是好的（报错 down-good，使用量 up-good）。
- `metric_record(metric, points: [{value, at?, dims?, note?}])`：记下取到的值。`at` 写数据所属的时间（日数据写那一天），分维度的每个维度一条（`dims: {平台: "新"}`）。和基线（`baseline`，或前几次的中位数）比变化超过门槛时，宿主告诉本人，写进关联的关注会话和事项时间线。
- `metric_read(metric?, item?, context?, days?, dims?, chart?)`：不传 `metric` 列出指标和各自最近的变化；传了给出定义、最近的点和变化。`chart: true` 时附一段 ` ```chart ` 代码块（图的数据），写报表时原样放进工作文件或页面，网页上会画成图。

## 什么时候用

- 本人在做需求：按内置技能 `observation-plan` 写观测计划（要埋的点、上线后看的报错和使用指标、迁移的新旧对比和护栏指标），计划里的每个指标用 `metric_define` 定义到这个事项上；上线后把采集频率打开。
- 本人问“这个功能上线后怎么样”“新旧平台差多少”：先 `metric_read(item=…)`，没有的指标现查现定义，答完把值记下来，下次就有基线。
- 本人要数据报表：读相关指标，写成工作文件，结论在前，每个结论旁边放图和取数口径；定期的报表用规则（定时触发 + 交给 Agent）。
- 不知道某类数据在哪个系统：先看数据源目录（内置技能 `data-sources` 说怎么维护），没有就按技能盘点后补上。
