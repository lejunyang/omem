# 飞书与文档导入：保留原件，按结构阅读

更新：2026-10-05。输入页已有「PDF / Word」入口，支持文字 PDF 和 DOCX。飞书链接通过项目依赖中的官方 `@larksuite/cli@1.0.97` 获取正文，Docling 不负责登录或抓取飞书。

## 怎样使用

```bash
# 可选文件解析能力，首次显式准备
osdk run documents:prepare
# PDF 额外需要布局和表格模型；由 osdk 下载、锁定和校验
osdk run documents:models
osdk run dev
```

在「输入材料」选择 PDF / Word、选取文件、保存；解析时显示状态。完成后在「原始材料」阅读标题、段落、表格和原位置插图，下载固定版本的原件。文件最大 20 MB、200 页，解析文字最多 20 万字符。失败会保留选中的文件供重试；当前解析请求尚不是可跨服务重启恢复的后台任务。

飞书继续使用「飞书链接」。安装项目依赖后已包含官方 CLI，无需借用全局安装；它使用本机用户登录和文档权限。服务端与 CLI 命令入口都走同一个连接器。完整官方响应保存为附件，正文单独进入阅读和检索，块 ID、媒体和引用元数据不会作为一大段 JSON 混进正文。

当前机器已确认官方 CLI 能启动，但实际文档读取被 macOS 钥匙串访问阻止。需要本机允许 CLI 读取已有登录凭据后重试；没有改成明文凭据存储，也没有把安装成功算成飞书采集验证成功。飞书图片下载和内嵌表格展开仍需随后验证。

## 保存了什么，代码在哪里

| 层 | 当前实现 |
| --- | --- |
| 原件 | `imports/documents.ts` 将原字节按 SHA256 保存为附件，与 Source/Revision 关联；旧版附件不被新导入覆盖 |
| 解析 | `scripts/document-parser/convert.py` 使用锁定的 Docling 2.133.0；保存完整 DoclingDocument、顺序块、标题层级、表格、图片，以及 PDF 页码和坐标 |
| 阅读 | `DocumentReading.vue` 按原顺序渲染；图片请求受具体 revision 的附件清单约束，下载原件带用户会话认证 |
| 检索与写作 | Docling 导出的 Markdown 进入现有 Capture、结构切分和 RetrievalPort；不是建立第二个文件库。Agent 可继续读固定正文 |
| 飞书 | `connectors.ts` 解析项目内官方 CLI 的固定包路径，执行 `docs +fetch`，保留 URL、文档身份、修订和原始响应 |
| 环境 | Python / uv 由 osdk 管理；包版本由独立 `uv.lock` 固定；布局和表格权重由 `osdk.toml` / `osdk.lock` 管理。正常导入不下载依赖或权重 |

原件、结构附件与阅读文字用途不同。当前检索引用仍指派生文字的固定章节/行；页面坐标已保存，但尚未提供「点击引用直接框选 PDF 原页」的交互。解析失败不会创建一份空正文冒充成功；成功后才发布 Capture，失败原件也尚未形成独立的持久导入记录。

## 本轮实际验证与限制

- 本机真实转换了中文 DOCX 和文字 PDF。DOCX 的标题与表格保留；PDF 保留页码/区域，样本中无边框表格被识别成文字，不能声称所有表格都正确。
- 实际 `dev` 页面上传了明确标注为验收用途的 DOCX，原始材料页显示正文、表格和插图。
- OCR 当前关闭，纯扫描件会提示缺少可读正文；复杂版式、扫描件和跨页表格没有完成验收。
- 原文阅读保留结构不等于生成了易懂的 Wiki。后续知识组织仍应先明确页面问题，再由 Agent 选材、补背景和写作。

下一步扩展持久导入任务和 OCR，再把页码/区域接到引用阅读；不重新实现 Docling 的布局识别。上游的数据结构见 [DoclingDocument](https://docling-project.github.io/docling/concepts/docling_document/)，官方飞书工具见 [larksuite/cli](https://github.com/larksuite/cli)。
