# 统一知识阅读

## 现在如何使用

启动 `osdk run dev`，打开终端给出的地址。日常助理、知识库、原始材料和事项都在一个应用中。本仓库作为个人库中的真实材料使用；不再切换到独立的 review 产品。

知识库默认从主题文章开始。目录可逐层展开功能与相关知识，中央保留完整叙述，页内导航定位章节。文章与原始代码是两个阅读层次：先读解释，需要依据时再点引用。来源变化的旧文章明确显示待更新。

- 独立证据链接放段末，小字号、浅色；作者写的“参考……”链接保持自然衔接。
- 引用代码默认只显示固定行范围，上下分别展开 20 行。
- 原始文档完整渲染标题、段落、表格和代码围栏；选择原文提问收在文档的辅助操作中。
- 菜单与面包屑使用同一份定义。飞书未启用是该页的连接状态，切换页面后不残留。

交互参考：[DeepWiki 的 VS Code 知识目录与文章](https://deepwiki.com/microsoft/vscode)。流程图使用 [Mermaid](https://mermaid.js.org/config/usage.html)，以严格模式渲染并过滤 SVG，失败保留文字描述。

## 数据与生成

`dev` 明确传入当前仓库根目录，依旧使用个人 Store、Source/Revision/Fragment 与 KnowledgeRepository。幂等捕获保留个人材料，按摘要恢复文章。历史原文从已有 `.repo-review/runtime` 补入，已保存文章的固定引用不随最新源码漂移。不存在的历史证据不能补造。

`.repo-review/knowledge` 继续保存真实生成与独立复核结果，生成和验收仍用隔离的运行目录。启动不调用生成式模型。写作角色要求中文功能标题、场景说明、必要的表格与流程图、句段末引用；只有重新分析并复核的文章会采用新规则。

## 验收记录

- `osdk deps --frozen`：退出 0。新增 Mermaid 依赖后使用锁文件安装。
- `osdk run check`：退出 0，60 个测试文件、352 个测试，类型检查与构建通过。
- `osdk run browser`：退出 0，保留个人工作流验收并增加真实 Markdown 表格、Mermaid 和过滤后的原文渲染。
- `OMEM_WEB_URL=http://127.0.0.1:65092 osdk exec -t bun -t node -- bun scripts/code-wiki-viewport.ts`：退出 0，七项检查覆盖统一目录、菜单/面包屑、飞书错误隔离、代码引用与上下展开、README、三个视口。截图位于 `.repo-review/runtime/browser`。

浏览器实测修复了一处弹窗 CSS 作用域错误；截图在完整文章加载后获取，不能用空态的 h2 冒充通过。真实 ACP 的受影响材料重生成与独立复核仍须完成，结果记录在 `.repo-review/knowledge/verification.json` 与覆盖记录。旧文章和未覆盖材料不因此算作全部完成。
