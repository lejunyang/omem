# 知识目录草案

用户想把一批文档和代码组织成可读知识时，先建立目录草案。草案让用户检查阅读路线，每页有明确目的，确认后才开始写作。不要直接为每个文件新建文章。

## 前提和选材

```bash
omem status --json
omem knowledge list --json
omem contexts list --json
omem knowledge outline --help
```

服务必须运行。确认 CLI 的 `--url` 指向用户要操作的库；文件从 CLI 本机读取，草案保存在目标服务的个人库。基础草案保存不需要模型，propose 和 apply 需要服务中已配置、已登录的 Agent。先读 [Agent 设置](agents.md)，不要猜模型或思考强度。

从 `knowledge list` 的 `materials` 复制真实 `key`，从 `contexts list` 复制正式项目或主题 `id`。`revisionId` 用来读固定原件，不能填入 materialKeys。按用户阅读目的选择来源；不要因目录名相似就扩大项目或私有材料范围。未完成的目标和选材可以先保存；发起调查或确认前，整个草案至少包含一份现有材料，或包含已有成员的项目/主题。

## 建立草案并调查目录

create 文件是完整 `KnowledgeOutlineInput`。可先把 `pages` 留空，让 Agent 调查后提出建议：

```json
{
  "title": "项目上手与修改",
  "reader": "第一次接触项目的开发者",
  "goal": "读懂一次功能执行过程，并找到需要修改的位置",
  "topicPath": ["工作", "项目学习"],
  "materialKeys": ["替换为 materials 中的实际 key"],
  "contextIds": [],
  "pages": []
}
```

```bash
omem knowledge outline create outline.json --json
omem knowledge outline list --json
omem knowledge outline show OUTLINE_ID --json
omem knowledge outline propose OUTLINE_ID --version CURRENT_VERSION --json
omem knowledge outline show OUTLINE_ID --json
```

OUTLINE_ID 和 CURRENT_VERSION 从实际返回值获取。propose 排队目录调查，返回 `planning`；随后读取 show，等待 `ready` 或 `failed`，不要把排队当完成。调查使用所选原件的固定快照，可搜索并补读代码和背景。没有宿主 token 配额或固定调查轮数，仍受 Agent 无活动超时与取消机制约束。

AI 的 `rationale` 说明阅读路线，`gaps` 记录背景缺口。检查建议是否回答整体目标，是否解释必要概念，以及案例和修改入口放在哪一页。范围缺资料时，说明缺口或补充用户授权来源，不要用泛泛的讲解填满目录。网页可“停止调查并编辑草案”，保留当前计划后改为手动编辑；CLI 保存当前草案也会取消旧调查。

## 编辑和保存

show 返回元数据和完整草案。save 文件使用 `{version,draft}`；draft 只取可编辑输入字段，不把 `id`、state、rationale 等服务字段放进顶层输入。

```json
{
  "version": 3,
  "draft": {
    "title": "项目上手与修改",
    "reader": "第一次接触项目的开发者",
    "goal": "读懂一次功能执行过程，并找到需要修改的位置",
    "topicPath": ["工作", "项目学习"],
    "materialKeys": ["替换为实际材料 key"],
    "contextIds": [],
    "pages": [
      {
        "id": "保留 show 返回的页面 id；新页面使用新唯一 id",
        "title": "一次操作如何经过系统",
        "kind": "explanation",
        "reader": "第一次接触项目的开发者",
        "goal": "能说明输入如何变成结果，并辨认关键实现入口",
        "scenario": "沿一个具体操作理解系统分工",
        "questions": ["用户从哪里开始？", "结果经过哪些步骤产生？"],
        "entryPaths": [],
        "topicPath": ["工作", "项目学习", "系统流程"],
        "materialKeys": ["替换为实际材料 key"],
        "contextIds": [],
        "existingKey": null
      }
    ]
  }
}
```

上面的 version 仅示例，必须替换成刚读回的版本。pages 数组顺序就是阅读顺序；移动页面改它的 topicPath。每页可分别选择 tutorial / explanation / how-to / reference，确认前需要至少一个问题。

每页 materialKeys 必须位于整个草案范围内，contextIds 也必须选自整体 contextIds。需要额外背景先扩充整体范围。`entryPaths` 只是范围内的调查入口。复用已有文章时，将 existingKey 设置为 `knowledge list` 返回的真实 key，并确认它具有普通知识页面计划；不能复用需求跟进页。

```bash
omem knowledge outline save OUTLINE_ID edited-outline.json --json
omem knowledge outline show OUTLINE_ID --json
```

保存会增加版本，并取消尚在规划的旧请求，迟到的模型输出不会覆盖它。已有页面 ID 应保持稳定，新页面分配新的唯一 ID；正式新文章 key 在 apply 时由宿主生成。合并重复草案页面时，保留目标页面 ID，合并双方的材料和问题并重写目标；不要删除已有正式文章。希望保留一份路线再重拟时，网页使用“另存为新草案”；CLI 则把可编辑内容通过 create 保存为新草案，再修改或 propose。

## 确认与写作

先向用户展示阅读路线和每页目的，用户已明确确认这份草案后执行：

```bash
omem knowledge outline show OUTLINE_ID --json
omem knowledge outline apply OUTLINE_ID --version CURRENT_VERSION --json
omem knowledge outline show OUTLINE_ID --json
omem knowledge list --json
omem knowledge show ARTICLE_KEY --json
```

使用确认后最新读取的 version；AI 完成规划也会更新版本。没有用户确认就保留草案，不将模型提议自动应用。apply 原子保存全部正式计划并排队写作，返回 `appliedPages` 中的实际文章 key/jobId，`pageStatuses` 中的逐页进展。`applied` 说明目录已确认，`published` 才说明对应页面完成；独立复核通过仍不代表用户已验收内容。

已有正文可继续阅读，固定历史不改动。确认目录可以先更新导航标题、分类和顺序，正文仍要等待重新整理。每页调查写作时固定当前材料；草案不锁定将来写作的来源版本。项目范围以后加入的材料进入后续调查，自动维护仍由正式页面的更新设置控制。

已确认草案不能再次编辑。需要调整可新建草案并指定 existingKey，网页也提供“复制并调整目录”，或使用文章的“调整材料与目标”。同一草案不能让两页更新同一篇文章。

## 错误、取消和删除

- 版本冲突：重新 show，比较服务状态与本地修改，再保存新版本；不能只改一个数字强行覆盖。
- `failed`：查看 error 和 `jobId` 对应 jobs show。模型调查失败保留已有 pages，可以编辑后 propose 重试。
- 原件或项目范围不可用：重新 knowledge list / contexts list，按用户意图修正范围；不要静默换成相似来源。
- 已有文章正在整理：apply 会拒绝，等本次写作结束后重新 show 并确认当前草案。
- 需要暂停目录调查：使用实际 jobId 执行 `omem jobs cancel JOB_ID`，再 show 读取最新状态；取消草案调查不等于取消正文写作。
- 正文写作失败或取消：读取 pageStatuses 和任务错误，在网页草案的每页进度中选择“重试整理”，也可按用户意图重试实际任务；有效旧文保留。

```bash
omem knowledge outline delete OUTLINE_ID --version CURRENT_VERSION --json
```

删除只清理草案，取消仍在规划的请求。已确认的文章和写作任务继续存在；不会删除固定历史。只删除用户要求移除的草案，不把它用作知识冷存储清理。

## 当前边界

草案最多 32 页，处理明确材料范围，全库自动分类与文章退役尚未实现。apply 会安排所有页面写作，目前没有仅改导航的选项。合并或移除草案页面不移除已有文章。

主助手自然语言 `work_action` 尚未注册草案操作。加载本技能且具有 CLI 能力的外部 Agent 可以代办，网页也可以编辑；不要宣称飞书机器人已能自动规划目录。既有复制的技能不会随安装包升级自动更新，新 reference 需通过 `omem skills install NEW_DIRECTORY` 复制，再按 Agent 的技能加载方式启用，不覆盖用户定制。
