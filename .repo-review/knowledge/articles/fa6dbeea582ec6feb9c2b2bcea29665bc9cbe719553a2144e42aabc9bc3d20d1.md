# 确定性模块依赖关系图

该 Vue 组件把模块及仓库内聚合的导入关系绘制成确定性 SVG：节点展示模块规模，连线表达关系数量与状态，选择事件交由上层处理。固定排序和坐标规则可避免重绘漂移，但 12 轮迭代不足以保证所有长链或循环图都符合依赖层级语义，缺失关系与边标签键盘操作也存在实现限制。

来源：gpt-5.6-sol 分析，gpt-5.6-sol 独立复核；模型解释仍可被原始证据纠正。

<a id="purpose"></a>
## 用途与展示内容

组件服务于代码架构浏览：模块作为节点，仓库内聚合的 import 关系作为边；输入包含模块名称、文件数、符号数，以及关系数量、状态和证据。它只负责绘制和选择，不负责分析源码或生成关系。参考 [关系图输入合同 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L14 "支持组件接收模块、聚合关系、状态、数量和证据等展示数据，并定义向上层发出的选择事件。")

输出采用带自适应 `viewBox` 的 SVG，并提供“模块依赖图”的无障碍名称。节点显示人读名称及规模信息，`selectedId` 决定选中类，样式以更粗的深色描边突出当前节点。参考 [SVG 图形结构 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L141 "支持 SVG 的无障碍名称、边与节点渲染、选中类绑定及模块规模文本展示。")、[节点选中视觉样式 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L205 "支持选中节点以更深且更粗的描边获得明确视觉强调。")

<a id="layout-flow"></a>
## 确定性布局与连线路径

布局先建立“导入方 → 被导入模块”的邻接表，排除 `missing` 关系和端点不在模块集合中的边。模块按 ID 固定排序，再反复更新层级：无仓内依赖者置于第 0 层，其他模块尝试放到其当前最高依赖层之上。参考 [邻接表与层级迭代 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L48 "支持缺失及未知端点关系被排除、模块固定排序、层级传播和最多迭代 12 轮的说明。")

更新最多执行 12 轮。这个上限既会截断循环图，也可能让需要超过 12 轮传播的无环长依赖链提前停止；因此实现保证的是相同输入下的确定性布局，并不保证所有输入都满足严格的依赖层级语义。随后组件按计算结果分桶，以固定列宽和行高生成节点坐标及画布尺寸。参考 [邻接表与层级迭代 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L48 "支持缺失及未知端点关系被排除、模块固定排序、层级传播和最多迭代 12 轮的说明。")、[分层坐标计算 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L84 "支持按层分桶，并以固定列宽、行高计算节点位置和画布尺寸的说明。")

边以三次贝塞尔曲线连接节点，计数标签放在两端中心的近似中点；任一端点缺少坐标时，路径为空，标签位置回退到原点。参考 [边路径与标签中点 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L107 "支持贝塞尔连线、标签中点计算，以及端点缺失时返回空路径和原点位置的说明。")

<a id="interaction-limits"></a>
## 关系状态、交互与限制

可解析关系先映射为状态类：候选关系使用虚线，过期关系使用较弱的短虚线，其余状态使用确认关系类；样式表定义了相应描边差异。参考 [关系状态类映射 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L127 "支持候选、过期和默认确认关系的类名映射，并表明没有 missing 专用类。")、[关系线视觉样式 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L184 "支持普通、候选和过期关系采用不同描边与虚线模式的视觉表现。")

节点可以点击，也能通过 Enter 或空格触发 `selectNode`；边的计数标签点击时触发 `selectEdge`。不过边标签的键盘事件复用了节点处理函数并传入边 ID，因此键盘操作实际发出 `selectNode(edgeId)`，与点击语义不一致。参考 [节点键盘选择 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L133 "支持 Enter 或空格会阻止默认行为并发出节点选择事件的说明。")、[边与节点事件绑定 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L153 "支持边标签点击触发关系选择、键盘复用节点处理器，以及节点点击和键盘选择的交互说明。")

类型和注释允许 `missing` 关系，但布局会排除它，渲染阶段仍遍历全部边。目标节点不存在时只会产生空路径和原点标签；当前类名映射也没有专门的 missing 样式，因此尚未实现注释所述的断裂桩线。参考 [邻接表与层级迭代 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L48 "支持缺失及未知端点关系被排除、模块固定排序、层级传播和最多迭代 12 轮的说明。")、[边路径与标签中点 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L107 "支持贝塞尔连线、标签中点计算，以及端点缺失时返回空路径和原点位置的说明。")、[关系状态类映射 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L127 "支持候选、过期和默认确认关系的类名映射，并表明没有 missing 专用类。")、[边与节点事件绑定 ↗](../../../packages/ui/src/components/OmRelationGraph.vue#L153 "支持边标签点击触发关系选择、键盘复用节点处理器，以及节点点击和键盘选择的交互说明。")
