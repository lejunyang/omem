---
name: platform-capture
description: 从已连接的平台（Notion、GitHub、Google、Slack、Jira、钉钉……）读内容并存成原件：找接口、翻页、增量、正文怎么整理
---

# 从已连接的平台采集

工具：`connect_list`（本人连了哪些平台、接口地址、文档）、`connect_request`（只读请求，宿主带令牌）、`connect_save`（存成原件）。

## 先定范围

- 本人说了范围（某个 Notion 数据库、某个仓库的 issue、某个频道最近一周）就只采这个范围。
- 没说范围时先列一层目录（工作区里的页面、仓库列表、频道列表）给本人选，不要把整个平台搬进来。
- 二进制文件（PDF、图片、Office 文件）读不了正文：找平台导出文本或 Markdown 的接口（Google Drive 的 `files/{id}/export?mimeType=text/plain`、Notion 的块内容），找不到就跳过并告诉本人。

## 常见平台的入口

| 平台 | 列表 | 正文 |
|---|---|---|
| notion | `POST /v1/search`（body 里 `filter.value` 为 `page` 或 `database`） | `GET /v1/blocks/{id}/children`，逐层读子块拼成 Markdown |
| github | `GET /user/repos`、`GET /repos/{o}/{r}/issues?state=all&since=` | issue 正文和 `GET /repos/{o}/{r}/issues/{n}/comments` |
| google-drive | `GET /drive/v3/files?q=…&fields=files(id,name,mimeType,modifiedTime)` | 文档 `GET /drive/v3/files/{id}/export?mimeType=text/plain` |
| google-mail | `GET /gmail/v1/users/me/messages?q=` | `GET /gmail/v1/users/me/messages/{id}?format=full`，取 text/plain 部分 |
| google-calendar | `GET /calendar/v3/calendars/primary/events?timeMin=&singleEvents=true` | 事件本身 |
| slack | `GET /conversations.list`、`GET /conversations.history?channel=&oldest=` | 线程 `GET /conversations.replies` |
| jira / confluence | `GET /ex/jira/{cloudId}/rest/api/3/search/jql?jql=`；cloudId 先 `GET /oauth/token/accessible-resources` | issue 的 `fields.description`、Confluence `GET /ex/confluence/{cloudId}/wiki/api/v2/pages/{id}?body-format=storage` |
| linear | `POST /graphql`（query issues） | 同一个查询里带 description、comments |
| microsoft（outlook、teams、one-drive） | `GET /v1.0/me/messages`、`GET /v1.0/me/drive/root/children` | `GET /v1.0/me/drive/items/{id}/content?format=` 只对能转文本的类型 |

别的平台按 `connect_list` 给的文档链接找接口；Nango 的文档页会链到平台官方文档。

## 翻页与增量

- 跟着平台的游标走（`next_cursor`、`nextPageToken`、响应头 `link` 的 `rel="next"`），每页不要超过平台允许的上限。
- 采过一次的范围再采时，只读上次之后改过的（`since`、`modifiedTime >`、`oldest`）。上次的时间看 `list_sources` 里该平台原件的更新时间，或原件的 `platformUpdatedAt`。
- 一次最多存几百份；更多时先存一批，告诉本人还剩多少，等本人说继续。

## 存成原件

- `id`：平台上不会变的编号，带上足以定位的层级，如 `page/<uuid>`、`acme/app#123`、`C0123/1712345678.000100`。
- `title`：平台上的标题；聊天用“频道名 · 日期”。
- `text`：原文整理成 Markdown：标题层级、列表、表格、代码块照原样；评论和回复按时间接在正文后面，每条写“作者 · 时间”。不写摘要，不删内容。
- `kind`：文档、工单、邮件用 `doc`；聊天记录用 `chat`。
- `url`：平台上打开它的链接，`updated_at`：平台上的修改时间。
