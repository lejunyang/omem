---
name: omem-design
description: 修改 omem v2 的 Vue 网页（web/）时使用：阅读优先的排版、浅色/深色 token、引用抽屉、命令面板、移动端与无障碍要求。
---

# omem 网页实现

1. 页面在 `web/src/views`，公共组件在 `web/src/components`，样式 token 在 `web/src/styles.css`。新增颜色先加 token（同时给深色值），不要在组件里写死色值。
2. 用 `<script setup lang="ts">`，数据走 `web/src/api.ts`，全局状态在 `web/src/store.ts`。实时更新订阅 `onServerEvent`。
3. 正文用 `Markdown.vue` 渲染（marked + DOMPurify + highlight.js + 懒加载 mermaid）。`src:` / `mem:` / `msg:` 链接和 `path:行号` 会变成引用，点击后由 `CitationDrawer` 逐层展示；`[[slug]]` 是 Wiki 链接。
4. 阅读区限宽（正文约 760px），标题用衬线体，元信息小号灰色；按钮组用 gap。空状态说明现状并给一个能执行的动作。
5. 表单控件用 `components/UiSelect`（下拉）、`UiCheckbox`（勾选 / switch）、`UiSegmented`（少量互斥选项）、`UiDateTime`（日期时间），确认和输入用 `lib/dialog` 的 `confirmDialog` / `promptDialog`；不用原生 select、checkbox、datetime-local、confirm、prompt。弹层用 Teleport 到 body，自带键盘操作和 Esc。
6. 大列表和长文本（原件列表、长原件、聊天、运行、记忆）用 `components/VirtualList`（动态行高，跟随最近的滚动容器，`scrollToIndex` 定位）；加载中用 `components/Skeleton`，和“没有数据”的空状态分开。聊天类原件用 `components/ChatView`（解析见 `lib/chat.ts`）。
7. 浏览器直接加载的 `/api/...` 地址（`<img>`、下载链接）要经 `api.ts` 的 `authUrl` 带上令牌，否则从其他设备打开时加载不出来；普通请求走 `get` / `post`，401 时会提示填写令牌。
8. 所有可点击元素可键盘操作；弹层 Esc 关闭并归还焦点；不依赖 hover 才能看到关键操作。≤860px 侧栏折叠，≤760px 单列。
9. 改完运行 `pnpm run typecheck`，并用 `node scripts/screens.ts <url> <dir>` 截 1440 和 390 宽度检查，不能横向溢出。

同一页面的几类对象（Agent 档案 / 技能、任务规则 / 归档规则）用列表顶部的标签切换，不在侧栏加二级菜单。

确认弹窗保持短标题，详细说明放 `message`。`DialogHost` 内容区负责长链接换行和限高滚动，操作按钮留在内容区外；检查手机和较矮视口，不能靠横向裁切隐藏溢出。

Agent 档案和任务选型的后端、模型、强度使用 `AiDefaults`：可用后端排在前面，同等情况下 ACP 优先；模型与强度自动检测，有选项用 UiSelect，没有可选项再用输入框。检测明确不支持强度时显示“该模型不支持”。内置角色的默认 AI 在档案页设置，设置页管理后端和任务选型偏好。技能目录使用可折叠的文件列表，手机上放在编辑器上方并限高滚动；切换文件前处理未保存的修改。
