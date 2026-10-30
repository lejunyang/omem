import { defineConfig } from "vitepress";

// Published to GitHub Pages under /<repo>/; the workflow passes the base (DOCS_BASE), local dev serves at /.
const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
  lang: "zh-CN",
  title: "omem",
  description: "深度集成飞书的个人助理：消息、文档、会议和代码同一个上下文，回答处处有出处，记住约定、跟进事项，多 Agent 协作完成任务，编码有多角度评审。",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", href: `${base}logo.svg` }]],
  themeConfig: {
    logo: { light: "/logo.svg", dark: "/logo-dark.svg" },
    nav: [
      { text: "开始使用", link: "/guide/getting-started" },
      {
        text: "功能",
        items: [
          { text: "飞书", link: "/features/lark" },
          { text: "知识与记忆", link: "/features/sources" },
          { text: "Agent 与自动化", link: "/features/agents" },
          { text: "编码", link: "/features/coding" },
          { text: "插件", link: "/features/plugins" },
        ],
      },
      { text: "命令行", link: "/guide/cli" },
      { text: "GitHub", link: "https://github.com/lejunyang/omem" },
    ],
    sidebar: [
      {
        text: "开始",
        items: [
          { text: "omem 是什么", link: "/guide/what-is-omem" },
          { text: "安装与第一次使用", link: "/guide/getting-started" },
          { text: "命令行", link: "/guide/cli" },
        ],
      },
      {
        text: "飞书",
        collapsed: false,
        items: [
          { text: "概览与接入", link: "/features/lark" },
          { text: "机器人与卡片", link: "/features/lark-bot" },
          { text: "消息、文档与知识库", link: "/features/lark-capture" },
          { text: "会议", link: "/features/lark-meetings" },
          { text: "群里的协作", link: "/features/lark-groups" },
        ],
      },
      {
        text: "知识与记忆",
        collapsed: false,
        items: [
          { text: "原件与空间", link: "/features/sources" },
          { text: "问答：带依据的回答", link: "/features/ask" },
          { text: "Wiki：多份材料写成一页", link: "/features/wiki" },
          { text: "记忆", link: "/features/memory" },
          { text: "事项", link: "/features/items" },
          { text: "学习与进步", link: "/features/learning" },
        ],
      },
      {
        text: "Agent 与自动化",
        collapsed: false,
        items: [
          { text: "Agent 与技能", link: "/features/agents" },
          { text: "多 Agent 协作与会话", link: "/features/collaboration" },
          { text: "规则", link: "/features/rules" },
        ],
      },
      {
        text: "编码",
        collapsed: false,
        items: [
          { text: "概览：云端编码", link: "/features/coding" },
          { text: "交办与评审", link: "/features/review" },
          { text: "工作分支与同步", link: "/features/git" },
          { text: "VS Code", link: "/features/ide" },
          { text: "引用与修改点", link: "/features/quotes" },
        ],
      },
      {
        text: "插件",
        collapsed: false,
        items: [
          { text: "插件", link: "/features/plugins" },
          { text: "英语练习", link: "/features/english" },
        ],
      },
      {
        text: "更多",
        collapsed: false,
        items: [{ text: "多台设备与多人", link: "/features/devices" }],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/lejunyang/omem" }],
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索", buttonAriaLabel: "搜索" },
          modal: { noResultsText: "没有找到", resetButtonTitle: "清除", footer: { selectText: "打开", navigateText: "切换", closeText: "关闭" } },
        },
      },
    },
    outline: { label: "本页" },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdated: { text: "更新于" },
    darkModeSwitchLabel: "外观",
    sidebarMenuLabel: "目录",
    returnToTopLabel: "回到顶部",
    footer: { message: "以 Apache-2.0 许可发布", copyright: "omem" },
  },
});
