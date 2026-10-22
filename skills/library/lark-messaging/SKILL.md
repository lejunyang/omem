---
name: lark-messaging
description: 用飞书机器人发消息和交互：回复/开话题、表情回应、Markdown、图片文件、带按钮和表单的卡片、限定处理人、处理卡片操作。需要通过机器人对外说话时先读。
---

## 什么时候用

- 本人让你“在 xx 群回复 / 通知 xx / 发个表单让大家填”。
- 你负责处理某个被监听的群（报警群、oncall 群等），需要回应消息。
- 需要别人做选择、填写信息、确认或认领时。

不确定该不该发时不发，先 `notify` 本人。草稿模式下（会话设置为回复需确认）你发的一切都会先变成给本人的草稿卡片，本人点“发送”才会真正发出；照常调用工具即可，不要重复发。

## 基本动作

| 想做的事 | 工具 | 要点 |
| --- | --- | --- |
| 表示“收到，在处理” | `lark_react`，emoji=OnIt | 处理完换 DONE；不需要的话可以不加 |
| 回复一条消息 | `lark_send`，reply_to=om_… | 群里默认 in_thread=true 开话题，避免刷屏；话题里的消息直接 reply_to 即在话题内 |
| 发新消息 | `lark_send`，chat_id=oc_… 或 user_id=ou_… | 私聊某人用 user_id（机器人需对其可见） |
| 富文本 | `lark_send` 的 markdown | 支持 **粗体**、*斜体*、~~删除线~~、[链接](url)、列表、代码块、表格、`<font color='red'>红字</font>`（red/green/grey/orange/blue…） |
| @人或已知机器人 | `lark_send` / `lark_card` 的 `mentions` | 填名字、邮箱、已核实的机器人应用侧 ID 或 `all`；正文里写“@名字”的位置会变成真正的 @，没写的放在开头。不要自己写 `<at>` 标签：聊天记录里看到的 id 属于另一个飞书应用，机器人用了 @ 不到人。姓名记录不明确时，工具核对目标群的完整成员列表；仍重名就拒绝。邮箱查不到时，可改用明确的群成员姓名。机器人不在群成员列表里，需用本应用已收到的 @ 中的名字或 open_id，不能用 app_id。 |
| 发图片或文件 | `lark_send_file`，path=本机路径 | 图片按图片发，其余按文件发，≤30MB |
| 卡片 | `lark_card` | 见下文 |
| 改一张已发的卡片 | `lark_update_card`，message_id | 传完整的新内容；常用于把按钮换成“已处理 by xx” |
| 加急提醒某人 | `lark_send` / `lark_card` 的 `urgent`（名字或邮箱） | 发出后对这些人做应用内加急。默认不能用：只有本人明确要求，或规则允许加急且写到这种情况时才用，只加急写到的人 |
| 只给群里某几个人看 | `lark_send` / `lark_card` 的 `only_to` | 以卡片发出，其他人看不到，不能回复在话题里，不能和加急一起用。同样只在本人要求或规则允许时用 |

消息里的 om_ / oc_ / omt_ id 在会话里都能看到（例如“（飞书消息 om_xxx，话题 omt_xxx，群「…」 oc_xxx）”）。

## 卡片

`lark_card` 用 blocks 描述内容，系统生成飞书 Card 2.0：

```json
{
  "reply_to": "om_xxx", "in_thread": true,
  "title": "告警：订单服务 5xx 升高", "color": "red",
  "blocks": [
    { "fields": [ { "label": "服务", "value": "order-api" }, { "label": "错误率", "value": "4.2%" } ] },
    { "markdown": "**初步判断**：14:02 发布后开始升高，集中在 /pay 接口。\n[看板](https://…)" },
    { "buttons": [ { "text": "我来处理", "value": "claim", "style": "primary" }, { "text": "误报", "value": "false_alarm", "confirm": "确认标记为误报？" } ] }
  ],
  "allowed": ["ou_oncall1", "ou_oncall2", "owner"]
}
```

- 颜色：blue wathet turquoise green yellow orange red carmine violet purple indigo grey；红=告警/失败，绿=完成，橙=待确认，灰=次要。
- blocks：`markdown`、`fields`（并排的小字段）、`buttons`（value 是你之后收到的动作名；带 url 的按钮只跳转）、`form`、`note`（灰色小字）、`hr`。
- 表单：

```json
{ "form": { "fields": [
    { "type": "select", "name": "category", "label": "问题类型", "options": [ { "text": "使用问题", "value": "usage" }, { "text": "故障", "value": "bug" } ], "required": true },
    { "type": "input", "name": "detail", "label": "补充说明", "multiline": true },
    { "type": "person", "name": "owner", "label": "指派给" },
    { "type": "date", "name": "due", "label": "期望完成日期" }
  ], "submit": "提交" } }
```

- `allowed`：只有这些人能点按钮或提交（open_id；"owner" 表示本人）。其他人点了会看到“只有 xx 可以处理”。不填则群里任何人都可以。
- 复杂排版（多列、图表、折叠面板）用 `raw_card` 传 Card 2.0 JSON。先读 `lark-cli skills read lark-im/references/card/lark-im-card-create.md` 和其中引用的组件文档；`"schema": "2.0"` 必须有。

## 收到卡片操作之后

有人点了按钮或提交了表单，会话里会出现一条新消息：

```
[卡片操作] 张三（ou_xxx）在卡片 om_card 上点击按钮「claim」
[卡片操作] 李四（ou_yyy）在卡片 om_card 上提交表单：category=bug；detail=…
```

按你的职责处理它（记录、通知、继续调查），通常再用 `lark_update_card` 把卡片改成结果状态（例如去掉按钮，写上“张三 已认领 14:05”），避免别人重复操作。

## 常见流程

**报警群**：收到告警 → `lark_react` OnIt → 按告警处理技能调查（看指标、查最近发布、找相关文档）→ 在告警消息下开话题回复结论和建议，必要时发认领卡片（allowed 为值班人）→ 处理完 DONE；需要本人决定的用 `notify`。

**oncall 群**：有人提问 → 先在知识库里查（search / read_page）→ 能回答就在话题里回复并附依据；不能确定就回复“已收到，稍后由同学跟进”，并 `notify` 本人或发一张带表单的卡片收集信息。

**代本人回复**：措辞贴近本人习惯（看本人在该群的历史发言），简短直接；涉及承诺、时间、金额的内容先让本人确认。
