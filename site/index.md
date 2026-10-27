---
layout: home

hero:
  name: omem
  text: 带依据的个人记忆与助理
  tagline: 文档、代码、聊天放进同一个知识库。回答都能点回原文，约定被纠正时留下版本，事项自己跟进；要动代码时交给 Agent，再由几个评审项各看一遍。
  actions:
    - theme: brand
      text: 安装与第一次使用
      link: /guide/getting-started
    - theme: alt
      text: 看看都能做什么
      link: /guide/what-is-omem
    - theme: alt
      text: GitHub
      link: https://github.com/lejunyang/omem

features:
  - title: 每句话都能回到原文
    details: 问答、Wiki、记忆和事项都引用原件到行。点引用，逐层打开文档、聊天或代码，看到那几行原话。
  - title: 记忆有版本，事项会收尾
    details: 约定被纠正时旧版本保留并指向新版本；事项有时间线和期限，没进展会自己过期，有新消息再打开。
  - title: 文档、聊天、代码都是原件
    details: 保存、采集或接入仓库，按空间隔离。每份可以定关注程度，过时的段落加标注；代码按符号切分，有调用图。
  - title: 多份材料写成一页 Wiki
    details: 需求文档、技术方案、群聊和代码一起读，按读者的问题组织成页面，每个论断贴着它的出处。
  - title: 选中就能引用
    details: 在原件、改动或评审里选中几段，编号后一起提问，或攒成下一轮的修改点。
  - title: 交办编码，多维度评审
    details: 独立 worktree 里编码，跑检查，再由功能、业务、架构、历史、规范几个评审项分别审，评审负责人合并裁决。
  - title: 从需求走到代码
    details: 每次评审都把需求拆成变更点，大需求按页面或模块分组、像文件夹一样展开；点一条就高亮对应的代码。
  - title: Git 同步交给它
    details: 拉取、合并、变基，冲突先交给编码 Agent，拿不准的问你；应用时快进到目标分支，再推送到你选的分支。
  - title: 不自带模型
    details: 理解和写作交给你已安装的 Agent（Codex、Claude Code、Gemini CLI……），omem 管存储、索引、调度和权限。
---

<div class="tour">

<div class="tour-item">
  <div class="tour-text">
    <h2>问的时候，依据一起给</h2>
    <p>“之前怎么约定的”“现在是多少”“依据在哪”：回答按事实组织，引用就在论断旁边，指向聊天里那一句、需求里那一行、代码里那一段。</p>
    <p><a href="./features/ask">问答 →</a></p>
  </div>
  <Shot src="ask-citations" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <h2>记忆按目录分层，有版本</h2>
    <p>事实、决定、人物、偏好都带来源。被纠正时旧版本标记为“已被更正”并链接到新版本，“以前怎么定的”和“现在是什么”都答得出。</p>
    <p><a href="./features/memory-items">记忆与事项 →</a></p>
  </div>
  <Shot src="memory" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <h2>原件按空间放好，分清轻重</h2>
    <p>文档、群聊、代码、网页和笔记都是原件，按项目或领域放进不同的空间。每份可以定为重点关注、一般、仅检索或忽略；过时的段落加一句标注，写清以哪份为准，检索和回答都照着来。</p>
    <p><a href="./features/sources">原件与空间 →</a></p>
  </div>
  <Shot src="sources" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <h2>Wiki 的每个论断都贴着出处</h2>
    <p>一页 Wiki 同时引用需求文档、技术方案、讨论群和代码。点任意一个引用，右侧打开原件并高亮被引用的那几行。</p>
    <p><a href="./features/wiki">Wiki →</a></p>
  </div>
  <Shot src="wiki-citations" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <h2>选中几段，一起问</h2>
    <p>在原件、差异或评审里选中文字，加入提问；抽屉缩小成可拖动的图标，继续选别处，问题里用 [1]、[2] 指代。也可以攒成下一轮的修改点。</p>
    <p><a href="./features/quotes">引用与修改点 →</a></p>
  </div>
  <Shot src="review-quotes" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <h2>一次交办，五个角度的评审</h2>
    <p>编码 Agent 在独立工作区里改完、跑过检查后，功能、业务、架构、历史、规范几个评审项各自独立审查，评审负责人合并重复的问题、决定哪些要改，再续一轮。</p>
    <p>每个问题都可以选“改 / 暂不改 / 不改”，不改写一句业务理由，之后的评审不再提。</p>
    <p><a href="./features/review">交办编码与多维度评审 →</a></p>
  </div>
  <Shot src="review-overview" />
</div>

<div class="tour-item">
  <div class="tour-text">
    <h2>需求拆成变更点，点一下到代码</h2>
    <p>评审时自动把需求拆成变更点，标出“已实现 / 部分实现 / 没实现”和对应的代码行；需求大时先按页面或模块分组，像文件夹一样展开。点一条（或整组），代码高亮并滚到它的标记处；点行号旁的标记，回到需求原文。</p>
    <p>拆得不顺手，点“重新整理”或直接跟助手说“按页面重新分组”，它在原来的拆分上改，不重跑评审。</p>
    <p><a href="./features/review#变更">看变更 →</a></p>
  </div>
  <Shot src="review-change" />
</div>

</div>
