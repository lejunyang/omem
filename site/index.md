---
layout: home

hero:
  name: omem
  text: 住在飞书里、凡事有出处的个人与团队助理
  tagline: 把消息、文档、会议和代码收进同一个本地知识库。不自带模型，直接调度你已安装的 Claude Code、Codex、Gemini 等 Agent——每句回答都能点回原文行，工作线与事项自动跟进到收尾，交办编码经多维度独立评审闭环。
  actions:
    - theme: brand
      text: 安装与第一次使用
      link: /guide/getting-started
    - theme: alt
      text: 为什么选 omem
      link: /guide/what-is-omem
    - theme: alt
      text: GitHub
      link: https://github.com/lejunyang/omem

features:
  - title: 行级溯源，拒绝幻觉
    details: 每一句结论、每一条记忆、每一页 Wiki 都贴着原文行号引用。点击引用直接在侧栏展开群聊原话、文档段落或代码行，支持跨层继续下钻。
    link: /features/ask
    linkText: 问答与溯源
  - title: 文档、聊天、代码同一上下文
    details: 飞书聊天、云文档、会议妙记与 Git 代码仓库存在同一套原件体系里，按空间隔离领域。代码按 AST 符号切分并建调用图，跨材料一次查清。
    link: /features/sources
    linkText: 原件与空间
  - title: 飞书双身份原生协同
    details: 用你的个人身份只读采集消息、文档和知识库，用机器人身份发进度卡、提问卡、草稿确认和入会旁听。不用搬运材料，也不用离开工作群。
    link: /features/lark
    linkText: 飞书集成
  - title: 工作线与事项闭环推进
    details: 把几周推进的大事建成工作线，一屏看清现状、关键变化点线和下一步。随口说的承诺自动记成事项，按流程关卡推进，上线观察期满自动收尾。
    link: /features/work-lines
    linkText: 工作线与事项
  - title: 记忆有版本链，质量自检
    details: 约定被纠正时不覆盖旧记录，而是保留版本链，历史与现状都能答。写入前过确定性规则、写入后由独立模型盲评复核，夜里“做梦”自动合并去重。
    link: /features/memory
    linkText: 记忆治理
  - title: 不绑定模型，30+ 内置角色分工
    details: 直接复用本机或 API 配置的 Codex、Claude Code、Gemini、豆包等 25+ Agent。内置约 30 个专职角色各司其职，支持按场景自动选型、额度避让与故障切换。
    link: /features/agents
    linkText: Agent 与技能
  - title: 多 Agent 接力与一句话规则
    details: 复杂长任务单开工作话题，多个 Agent 分工接力、互相请教，中途随时插话。用一句话定义“遇到什么就做什么”，支持脚本预查与 90 秒快速通道。
    link: /features/collaboration
    linkText: 协作与规则
  - title: 云端交办编码，六维独立评审
    details: 交办任务在独立 Git worktree 中按修改项推进，功能、业务、架构、历史、规范、精简六个维度独立审查并验证修复；支持需求点映射与网页版 VS Code。
    link: /features/coding
    linkText: 编码与评审
---

<div class="tour">

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">核心差异 01 · 统一上下文与行级引用</p>
    <h2>一个问题，同时对齐文档、群聊与代码</h2>
    <p>普通知识库只能搜静态文档，编码工具只看得到代码仓库。而在真实工作里，“退款金额怎么算”往往分散在最初的需求文档、群里后来的改口和代码的实际分支里。</p>
    <ul>
      <li><strong>三类材料同库同查</strong>：需求规则、群聊讨论、代码符号在同一次检索中召回并互相印证，自动标出哪处文档已经过时</li>
      <li><strong>每句论断贴着原文行</strong>：点击引用在右侧抽屉直接高亮原话或代码行；Wiki 页面与记忆里的引用还能逐层点开</li>
      <li><strong>只读分享给同事</strong>：飞书回答里的内部引用自动生成免登录只读快照，只暴露被引用的那几行，安全可撤销</li>
    </ul>
    <p><a href="./features/ask">问答与溯源 →</a> · <a href="./features/sources">原件与空间 →</a></p>
  </div>
  <Shot src="ask-citations" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">核心差异 02 · 工作线与事项流程</p>
    <h2>从随口一句话，到多阶段交付的完整闭环</h2>
    <p>它不只是被动回答问题的聊天框，而是替你盯着事情往前走的助理。打开 omem 首先看到的是<strong>工作页</strong>：本月在推进的每条工作线一张卡。</p>
    <ul>
      <li><strong>工作线一屏总览</strong>：一句“截至今天”的现状、最近关键变化点线（改期、决定、风险、结果，各带出处）和虚线标出的下一步</li>
      <li><strong>需求到交付四栏对齐</strong>：需求点、研究发现、技术方案、编码交办与合并请求连成链路，鼠标悬停即可看清上下游关联</li>
      <li><strong>流程自动核实推进</strong>：你在群里拍了板或推了代码，助手核实依据后自动推进阶段；每天早上一张“今天”卡片集中处理待办与清点</li>
    </ul>
    <p><a href="./features/work-lines">工作线 →</a> · <a href="./features/items">事项与流程 →</a></p>
  </div>
  <Shot src="work-overview" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">核心差异 03 · 飞书双身份原生工作流</p>
    <h2>它在你工作的地方工作，不用搬材料</h2>
    <p>omem 用<strong>你本人的身份</strong>（lark-cli）只读采集你能看到的消息、文档和知识库，用<strong>机器人的身份</strong>在群里和私聊里与你交互。权限边界清晰，绝不越权代发。</p>
    <ul>
      <li><strong>全量素材本地化</strong>：群聊、话题、云文档（含内嵌图片、画板、表格）、知识库目录树、日程与妙记自动入库</li>
      <li><strong>有人找你先分诊再查</strong>：别人 @ 你或私聊你没及时看时，先免费过滤，再由小模型分诊、主助手查清背景，附上依据和回复草稿提醒你</li>
      <li><strong>会议旁听与实时协查</strong>：入会时按规则询问是否带机器人进会；会中有人点你名或呼叫助理时即时查资料，会后直接推进落到你头上的事</li>
      <li><strong>交互全用飞书卡片</strong>：提问选项、表单收集、方案对比、草稿确认、流程卡点，点一下按钮就在同一轮继续</li>
    </ul>
    <p><a href="./features/lark">飞书概览 →</a> · <a href="./features/lark-groups">群里的协作 →</a> · <a href="./features/lark-meetings">会议 →</a></p>
  </div>
  <Shot src="meeting-rule-confirmation" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">核心差异 04 · 云端编码与多维独立评审</p>
    <h2>交办一次，六个评审角色把关到通过</h2>
    <p>把编码任务交给常驻机器上的 omem，你的电脑可以合上。编码 Agent 在独立的工作区和分支里按修改项（T1、T2…）逐步开发提交，不再把一坨改动留到最后。</p>
    <ul>
      <li><strong>先查影响面、先出方案</strong>：编码前自动排查会碰到的现有功能与历史缺陷；大改动先出结构化方案卡片，你点头后再动手</li>
      <li><strong>六维独立评审与交叉验证</strong>：功能、业务、架构、历史、规范、精简按需介入，尽量换不同家族的模型独立审；谁提的问题谁验收，改坏自动回退</li>
      <li><strong>从需求点跳到代码行</strong>：评审自动把需求拆成变更点，点击变更点直接高亮对应代码；浏览器里一键打开网页版 VS Code 或转发本地端口预览</li>
    </ul>
    <p><a href="./features/coding">云端编码 →</a> · <a href="./features/review">交办与评审 →</a> · <a href="./features/ide">VS Code 与预览 →</a></p>
  </div>
  <Shot src="review-overview" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">核心差异 05 · 活的 Wiki 与版本化记忆</p>
    <h2>知识自己生长、自己纠错，记得住来龙去脉</h2>
    <p>传统笔记和 RAG 最怕资料过期、记忆混乱。omem 把整个知识库放在 Git 里维护，并为记忆和 Wiki 配备了完整的自动化质检闭环。</p>
    <ul>
      <li><strong>按读者问题组织 Wiki</strong>：先规划目录再逐页对照需求、讨论与代码写作；写完必须过 <code>wiki-checker</code> 核对才发布，原件变了自动巡检更新</li>
      <li><strong>记忆更正保留版本链</strong>：预算、排期改了，旧记忆标记为“已被更正”并指向新记忆，“之前怎么定的”和“现在是什么”都能准确回答</li>
      <li><strong>夜间抽检与回放复盘</strong>：每晚自动抽检 AI 写的页面和定级，把旧问题放回提问时刻做 A/B 回放盲评，用真实胜负检验记忆与技能有没有帮上忙</li>
    </ul>
    <p><a href="./features/wiki">Wiki →</a> · <a href="./features/memory">记忆 →</a> · <a href="./features/learning">学习与进步 →</a></p>
  </div>
  <Shot src="wiki-citations" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">核心差异 06 · 规则、录制技能与插件生态</p>
    <h2>一句话定规则，做一遍教技能，强交互装进插件</h2>
    <p>无论是日常值班盯群、跨系统查数，还是需要独立界面的专项练习，都能用最自然的方式扩展给助手。</p>
    <ul>
      <li><strong>一句话写规则 + 90 秒快速通道</strong>：把“遇到什么就做什么”编译成触发器；配合只读预查脚本与快模型，常规报障 90 秒内给出带依据的结论</li>
      <li><strong>操作一遍就能学会</strong>：用浏览器扩展或远程桌面做一遍网页操作、指一下关键元素，助手自动提炼可变参数，保存为可复用的技能或经验</li>
      <li><strong>插件与场景包</strong>：一份清单加一个档案就能拥有带表单和图表的专属页面（如内置的英语读写与实时口语陪练）；整套空间结构、技能和规则可一键打成场景包分享</li>
    </ul>
    <p><a href="./features/rules">规则 →</a> · <a href="./features/remote">远程与录制 →</a> · <a href="./features/plugins">插件 →</a></p>
  </div>
  <Shot src="rules" />
</div>

</div>
