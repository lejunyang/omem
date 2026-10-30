---
layout: home

hero:
  name: omem
  text: 住在飞书里、凡事有出处的个人助理
  tagline: 消息、文档、会议和代码汇成同一份上下文。它替你记着约定和待办，拿不准时先问你；派出去的任务由多个 Agent 接力完成，编码有五个角度的评审把关。
  actions:
    - theme: brand
      text: 安装与第一次使用
      link: /guide/getting-started
    - theme: alt
      text: 都能做什么
      link: /guide/what-is-omem
    - theme: alt
      text: GitHub
      link: https://github.com/lejunyang/omem

features:
  - title: 深度集成飞书
    details: 消息、云文档、知识库、日程和妙记自动存下来；会议能旁听、记录和提醒；提问、进度、评审、确认都是可点的卡片。
    link: /features/lark
    linkText: 飞书
  - title: 拿不准先问你，答应的事记着
    details: 非你决定不可的事发卡片问你，答完同一轮接着做。随口说的计划、承诺、在等谁回复，自动记成事项，跟进到收尾。
    link: /features/items
    linkText: 事项
  - title: 文档、聊天、代码是一个上下文
    details: 三类材料放在同一个库里检索、互相引用，按空间隔开项目。代码按符号切分、有调用图，Wiki 自动整理并跟着原件更新。
    link: /features/sources
    linkText: 原件与空间
  - title: 每句话都能点回原文
    details: 回答、Wiki、记忆都引用到原文的行。引用里还有引用，一层层点开，从结论一直追到群里那句话、代码里那几行。
    link: /features/ask
    linkText: 问答
  - title: 会学习、会记忆、会进步
    details: 被纠正时保留版本链；写入前检查、写入后复核；纠正一次就成了它的规矩。每晚复盘，把提示词和技能的改进提给你采纳。
    link: /features/learning
    linkText: 学习与进步
  - title: 全面内置的多 Agent
    details: 编码、五个评审项、整理、Wiki 写作、记忆复核、复盘等三十个内置角色，各自能改说明、换模型、挂技能；也能自建档案和插件。
    link: /features/agents
    linkText: Agent 与技能
  - title: 任务自己往前走
    details: 长任务开独立话题，多个 Agent 接力，主助手决定继续还是找你。中途随时补一句，连发自动合并排队；规则让事件自动触发任务。
    link: /features/collaboration
    linkText: 多 Agent 协作
  - title: 云端编码，多角度评审
    details: 交给常驻机器去改，飞书里看进度，浏览器里开网页版 VS Code 看代码；功能、业务、架构、历史、规范分别审，循环修到通过。
    link: /features/coding
    linkText: 编码
---

<div class="tour">

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">飞书</p>
    <h2>它在你工作的地方工作</h2>
    <p>用你的身份只读地采集消息、文档和知识库，用机器人的身份回答、提问、发卡片。你不用把材料搬过来，也不用切到别的地方问它。</p>
    <ul>
      <li>群聊、私聊、话题、云文档、知识库、日程、妙记自动成为原件，文档里的图片、表格、附件一并存下</li>
      <li>入会时问你要不要把机器人带进去：记录转写和会中聊天，有人点你的名时提醒你，会后给纪要</li>
      <li>进度卡片、提问卡片、草稿确认、评审结果、事项清点……点按钮就是回答</li>
      <li>盯群、多个机器人分工、同事 @ 时先把关再回答</li>
    </ul>
    <p><a href="./features/lark">飞书 →</a></p>
  </div>
  <Shot src="meeting-rule-confirmation" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">统一上下文</p>
    <h2>一个问题，三类材料一起答</h2>
    <p>“退款金额现在怎么算？”需要需求文档里的规则、群里后来改的口径和代码里的实现。它们在同一个库里，回答把三处都引上，并指出哪处已经过时。</p>
    <ul>
      <li>引用贴在论断旁边，点开到原文那一行；Wiki 和记忆里的引用还能继续往下点</li>
      <li>按项目分空间，互相调用的仓库可以关联起来一起查</li>
      <li>原件分关注程度，过时的段落加标注，检索和回答都照着来</li>
    </ul>
    <p><a href="./features/ask">问答 →</a></p>
  </div>
  <Shot src="ask-citations" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">Wiki</p>
    <h2>材料自己整理成 Wiki</h2>
    <p>Wiki 按读者会问的问题组织，不是一个文件一页。需求、方案、讨论和代码对照着写，每个论断贴着出处；排查过几轮才解决的问题沉淀成案例页，下次能召回。</p>
    <p>原件变了，引用它的页面会被标出来，稳定半小时后自动检查，说法过时的由助理改写。</p>
    <p><a href="./features/wiki">Wiki →</a></p>
  </div>
  <Shot src="wiki-citations" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">记忆与学习</p>
    <h2>记得住，也改得对</h2>
    <p>事实、约定、决定、人物、偏好和经验都带来源，按目录分层。被纠正时旧版本留着并指向新版本，“以前怎么定的”和“现在是什么”都答得出。</p>
    <ul>
      <li>写入前确定性检查，写入后由另一个模型盲评复核</li>
      <li>“以后评审先看错误处理”：纠正一次，记成那个 Agent 的规矩</li>
      <li>给飞书里的回答点个 👍 或 👎 就是反馈；每晚复盘，把改进提成建议等你采纳</li>
    </ul>
    <p><a href="./features/memory">记忆 →</a> · <a href="./features/learning">学习与进步 →</a></p>
  </div>
  <Shot src="memory" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">事项</p>
    <h2>说过的事不会掉在地上</h2>
    <p>不用说“记住”。待办、承诺、在等谁回复，它回答时顺手记下，在回答末尾列出来。每次变化都写进时间线，没进展自动过期，有新消息再打开；每天一张清点卡片，要留下的点一下。</p>
    <p>拿不准的取舍，它先发卡片问你；你在卡片上选，或者直接回一句。</p>
    <p><a href="./features/items">事项 →</a></p>
  </div>
  <Shot src="items" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">多 Agent 与规则</p>
    <h2>派出去的任务，几个 Agent 接力做完</h2>
    <p>复杂的事开一个独立话题：每个 Agent 的思考过程显示在话题里，一轮做完交回报告，主助手决定继续、换人还是来问你。Agent 之间可以互相请教。</p>
    <ul>
      <li>任务进行中随时补一句，它在下一次调用工具时就收到，不用等这一轮结束</li>
      <li>几秒内连发的消息合并成一轮；每个会话串行、会话之间并行，后台任务不挤占对话</li>
      <li>规则一句话写成“遇到什么就做什么”：被 @、新消息、入会、定时都能触发</li>
    </ul>
    <p><a href="./features/collaboration">多 Agent 协作 →</a> · <a href="./features/rules">规则 →</a></p>
  </div>
  <Shot src="rules" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">编码</p>
    <h2>交办一次，改到评审通过</h2>
    <p>编码 Agent 在独立的工作分支里改完、跑过检查，功能、业务、架构、历史、规范五个评审项各自独立审查，评审负责人合并问题、决定改什么，再续一轮。</p>
    <ul>
      <li>在常驻机器上跑，不占你的电脑；飞书里一张卡片持续更新进度</li>
      <li>需求拆成变更点，点一条高亮对应代码</li>
      <li>浏览器里打开网页版 VS Code，评审问题挂在代码行上</li>
    </ul>
    <p><a href="./features/coding">编码 →</a></p>
  </div>
  <Shot src="review-overview" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <p class="tour-kicker">插件</p>
    <h2>一问一答装不下的，做成插件</h2>
    <p>插件把 Agent 档案、技能、工具、数据和一个页面放在一起。内置的英语练习按你的水平和薄弱点出题，一组一起交，当场判分点评。</p>
    <p>自己做一个只要一份清单和一个档案：默认页面里 Agent 能发表单让你填、画图给你看。带代码和常驻服务的插件，你确认信任后才运行。</p>
    <p><a href="./features/plugins">插件 →</a></p>
  </div>

  <Shot src="plugin-english" />

</div>

</div>
