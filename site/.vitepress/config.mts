import { defineConfig } from "vitepress";

// Published to GitHub Pages under /<repo>/; the workflow passes the base (DOCS_BASE), local dev serves at /.
const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
  lang: "zh-CN",
  title: "omem",
  description: "个人记忆与助理：文档、代码、聊天放进一个知识库，带依据地回答，记住约定，跟进事项，交办编码并多维度评审。",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", href: `${base}logo.svg` }]],
  themeConfig: {
    logo: { light: "/logo.svg", dark: "/logo-dark.svg" },
    nav: [
      { text: "开始使用", link: "/guide/getting-started" },
      { text: "功能", link: "/features/sources" },
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
        text: "功能",
        items: [
          { text: "原件与空间", link: "/features/sources" },
          { text: "问答：带依据的回答", link: "/features/ask" },
          { text: "Wiki：多份材料写成一页", link: "/features/wiki" },
          { text: "记忆与事项", link: "/features/memory-items" },
          { text: "交办编码与多维度评审", link: "/features/review" },
          { text: "Git 同步、应用与推送", link: "/features/git" },
          { text: "引用与修改点", link: "/features/quotes" },
          { text: "规则与 Agent 档案", link: "/features/rules-agents" },
          { text: "飞书", link: "/features/lark" },
          { text: "多台设备", link: "/features/devices" },
        ],
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
