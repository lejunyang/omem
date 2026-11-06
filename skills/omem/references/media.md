# 图片生成（media）

- `generate_image`：用设置 → AI → 图片生成里配好的模型画一张图，只有配好之后才会出现在工具列表里。参数 `prompt`（画面内容、风格、要出现的文字）、可选 `size`（`auto`、`1024x1024`、`1536x1024`、`1024x1536`）、`quality`（`auto` / `low` / `medium` / `high`）、`background`（`transparent` 透明背景）。
- 图片存进数据目录，返回本机路径和网页地址 `/api/files/<名字>.png`：飞书里用 `lark_send_file(path)` 发，Wiki 页面和网页回答里写 `![说明](地址)`。
- 每张都要花钱、要几十秒：一次画一张，不满意先问本人哪里要改。怎么写 prompt、什么时候值得画，见内置技能 `image-generation`。
