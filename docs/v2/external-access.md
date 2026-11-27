# 外部只读访问：给聊天里的引用一个能打开的网页地址（设计稿，未实现）

状态：设计，2026-10-20。实现前先按本文核对，有变化改本文。

文末的[云端后端调工具](#云端后端调工具)已实现，可以独立启用。

## 1. 要解决的问题

助手在飞书里回复时，会引用代码、原件和运行记录。现在这些引用只有两种结果：

- 本机路径（`/data/…/repo/src/a.ts#L10`），在手机或别的电脑上打不开；
- omem 网页的内部地址（`#/sources/…`），只有本机或已配对的设备能打开。

2026-10-20 起，发到聊天里的本机路径会改写成“仓库 · 路径:行号”纯文本（`src/channels/common.ts` 的 `localPathLinks`），短代码直接贴在消息里，文件作为附件发送。剩下的缺口是**大段代码和长原件**：需要一个在飞书里点一下就能打开、只读、到期失效的网页地址。

## 2. 结论

给每条要外发的引用签一个**只读分享链接**：

```
https://<对外地址>/s/<分享令牌>#L120-L140
```

- 分享令牌只授权**一个对象**（一份原件、一个 Wiki 页面或一次运行）的只读查看，有到期时间，可撤销；
- `<对外地址>` 由本人配置（自定义域名），没配时自动用本机可达地址（IP:端口）；
- 打开后是精简的只读页面：原件按行号高亮、代码带语法高亮和所在文件路径，不加载完整的 omem 界面，不暴露其他数据。

## 3. 设计

### 3.1 对外地址：`config.web.publicUrl`

按顺序取第一个可用的：

1. `config.web.publicUrl`：本人配置的完整前缀，例如 `https://omem.example.com`。支持带路径前缀（反向代理挂在子路径下）。
2. `config.web.publicHost`：只配主机名或 IP 时，补上协议和当前监听端口。
3. 自动探测：取本机网卡地址里**非回环、非链路本地**的第一个 IPv4（与配对码选地址的逻辑相同，见 `src/core/peers.ts`），拼成 `http://<ip>:<port>`。只在服务监听在 `0.0.0.0` 时可用；监听 `localhost` 时不生成外链。

`omem setup` → 渠道里加一项“对外访问地址”，显示探测到的地址、让本人填自定义域名，并用一次 HTTP 请求自检（访问 `/s/_health`）。

自定义域名的 HTTPS 由本人的反向代理（Caddy、Nginx、公司网关）负责，omem 不管证书。文档里给一段 Caddy 配置示例。

### 3.2 分享令牌：`shares` 表

```sql
create table shares (
  token_hash text primary key,     -- sha256(令牌)，库里不存明文
  kind text not null,              -- source | page | run
  target text not null,            -- 原件 id / 空间:slug / 运行 id
  lines text,                      -- 'L120-L140'，可空
  user_id text not null,           -- 谁的权限签出的
  created_at text not null,
  expires_at text not null,
  revoked_at text,
  views integer not null default 0,
  last_view_at text
);
```

- 令牌 `os_` + 24 字节随机数 base64url，与 API 令牌（`om_`）、工具令牌（`ot_`）分开前缀，不能互换使用。
- 默认有效期 7 天，`config.web.shareDays` 可改；本人可在网页“设置 → 对外分享”里看到所有分享、访问次数，一键撤销。
- 同一对象同一行段在有效期内复用同一个令牌，避免一次回复生成一堆链接。

### 3.3 谁来签链接

在 `resolveCitations`（发往聊天渠道的最后一步）里统一处理，不让模型自己拼地址：

| 引用 | 现在 | 有对外地址时 |
| --- | --- | --- |
| `src:<id>#L…`，原件本身是网页或飞书文档 | 原始 URL | 不变 |
| `src:<id>#L…`，代码或本地原件 | 纯文本标签 | `/s/<令牌>#L…` |
| 仓库内的本机路径 | “仓库 · 路径:行号” | 能对上已索引原件时同上；对不上保持纯文本 |
| `/tmp`、数据目录下的生成文件 | 文件名纯文本 | 不签链接，仍要求作为附件发送 |
| `[[wiki]]` | 纯文本 | `/s/<令牌>` 页面 |

签发时用**本次回复所属用户**的 `accessibleSpaces` 检查对象是否可读，读不到就保持纯文本。也就是说，分享链接不会比签发者本人能看到的更多。

### 3.4 只读页面 `/s/:token`

- 服务端路由，不走前端 hash 路由，也不需要登录；只认分享令牌，不认 API 令牌和 Cookie。
- 返回一个独立的小页面（服务端渲染的 HTML + 少量 CSS，代码高亮用已打包的 highlight 资源），内容只包括：对象标题、空间名、更新时间、正文（原件按行号，指定行段滚动到位并高亮）。
- 不提供：搜索、其他原件的链接、记忆、事项、运行详情里的工具调用和补丁以外的数据。运行分享只展示任务、结论和 diff。
- 所有采集来的 HTML 内容照网页约定过 DOMPurify；代码与纯文本按文本转义输出。
- 响应头：`Cache-Control: private, no-store`、`X-Robots-Tag: noindex`、`Referrer-Policy: no-referrer`，防止被缓存和收录。

### 3.5 安全边界

- 现在的规则保持不变：没有配置令牌时，API 只信任本机请求。`/s/` 是唯一对外开放的入口，其余路由的鉴权不放宽。
- `/s/` 按 IP 限速（例如每分钟 60 次），令牌错误不区分“不存在 / 过期 / 撤销”，统一 404。
- 原件被删除（墓碑）或对象所在空间对签发者不再可读时，链接失效。
- 多台设备：分享只在拥有原件的那台机器上签发和提供；`peer open` 的转发不经过 `/s/`。

## 4. 不做的事

- 不做公开发布（无期限、无令牌的页面）。需要长期公开的内容应写成飞书文档。
- 不做外部用户的登录体系；只读分享就是令牌即权限。
- 不替本人申请域名、证书或打通公网；内网 IP 能访问就够了，跨网络访问由本人的网关负责。

## 5. 实现顺序与验收

1. `config.web.publicUrl` / `publicHost` 与地址探测，`omem setup` 自检。验收：配置与不配置两种情况下都能给出地址或明确说明不可用。
2. `shares` 表、签发与撤销函数、网页“对外分享”列表。验收：过期、撤销后访问返回 404。
3. `/s/:token` 只读页面（原件、Wiki、运行三种）。验收：1440 与 390 宽度无横向溢出；行段高亮正确；页面里没有指向其他对象的链接。
4. `resolveCitations` 接入，带权限检查。验收：飞书里引用代码原件得到可点开的链接；其他用户的会话里引用不了本人私有空间的原件。
5. 同步 README、状态表（`docs/v2/status.md`）、acceptance、wiki changes。

## 云端后端调工具

无 MCP 的云端会话默认只收到宿主选好的材料。想让它自己核对原文，先把 `webUrl` 配成云端能访问的公网 HTTPS 地址。反向代理使用路径前缀时，把前缀也写进去。

云端就跑在同一个内网里时（实测豆包 OpenAPI 的云端沙箱能访问公司内网 IP），本人可以打开“允许内网地址”（`agents.cloudTools.privateAddress`），`webUrl` 用内网的 http 地址，例如 `http://10.0.0.5:4317`。凭据会以明文在内网里传；探测照样要通过、要本人确认。

可选的工具除了读材料的 `search`、`read_source`、`read_page`、`read_item`，还有研究交结果用的 `read_ledger`、`propose_directions`、`trial_report`、`record_finding`、`close_direction`。签发凭据时取“设置里选的”和“这次运行本来就有的”交集，所以后几个只在研究自己的阶段里可用，别的运行拿不到；写入照样经过工具层对事项本人和空间的校验。

公网入口只转发探测和云端工具请求。下面的 Nginx 配置适用于独立域名、路径从根开始的部署。把 `map` 放进 `http` 块，把 `location` 放进该域名已有证书的 HTTPS `server` 块。带头工具请求必须携带云端运行凭据，宿主再检查有效期、次数和本轮权限。

```nginx
map "$request_method:$uri:$http_authorization" $cloud_tools_allowed {
    default 0;
    "~^(GET|POST):/api/cloud-tools/challenge/[a-f0-9-]+:(Bearer probe-[a-f0-9-]+)?$" 1;
    "~^GET:/api/tools:Bearer oct_[A-Za-z0-9_-]+$" 1;
    "~^POST:/api/tools/[a-z_]+:Bearer oct_[A-Za-z0-9_-]+$" 1;
    "~^GET:/api/tools/turn/oct_[A-Za-z0-9_-]+(/[a-z_]+)?:$" 1;
}

location / {
    access_log off;
    error_log /dev/null;
    if ($cloud_tools_allowed = 0) { return 403; }
    proxy_pass_request_headers off;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Content-Type $content_type;
    proxy_pass http://127.0.0.1:4317/;
}
```

全局 HTTP 令牌在本机配置文件中管理。通用设置接口省略该字段，保存其他设置时保留本机的值。

状态、探测、确认、撤销和云端选项的修改需要本人的 API 令牌或已登录的本人会话。本机 CLI 未配置全局令牌时，会在本机库中登记一次性探测凭据的哈希。服务端只在发起探测时接受它，收到请求就核销。CLI 中途退出时，尚未使用的凭据也会在签发后 60 秒失效。从主干库首次升级到云端工具时，原有手工令牌继续有效。升级前已有 `cloud_tool_usage` 表的库会一次性撤销旧探测命令可能遗留的本人 API 令牌。这些库的旧记录只标有名称 `cloud-tools probe` 且客户端为空，手工创建的本人令牌若也符合这两个条件，升级后需重新签发。

1. 运行 `omem cloud-tools probe <后端档案 ID>`。宿主开一个临时会话，验证后端能带 Authorization 测试头发 GET、POST JSON 并读回回执（`header`）。做不到时，后端可另试无头 GET，沿响应里的 next 地址提交 JSON 查询参数并读回回执（`url`）。两种都失败时返回原因。测试值没有库权限，会话用完即清理。
2. 本人核对结果，向 `POST /api/cloud-tools/probe/confirm` 提交 `{"backend":"档案 ID","id":"这次探测的 id"}`。换公网地址或重新探测后需要重新确认。
3. 在配置的 `agents.cloudTools` 里设置下列选项。通过 API 修改时，在已有设置上更新，使用 `PUT /api/settings` 保存。下一轮生效。

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| enabled | false | 本人控制总开关 |
| backends | [] | 逐个填写已探测的后端档案 ID |
| tools | search、read_source | 前者找线索，后者按行核对原文。可另选 read_page 阅读 Wiki、read_item 阅读事项。每轮只提供角色和成员也有权使用的工具 |
| ttlMinutes | 15 | 凭据续期窗口，范围 1–30 分钟。窗口到期后的请求会核对运行状态，仍在运行就续期；运行结束、取消或会话清理时立即作废 |
| maxCalls | 32 | 同一运行共用的次数上限，范围 1–100。查看参数、调用成功和工具返回错误都计次 |
| credentialIn | channel | 优先由适配器的安全通道交付。后端缺少安全通道时保持关闭。只有本人选 message 才会把凭据写入当轮消息 |

选 **message** 意味着这串凭据会留在云端那次会话的历史里，直到会话被删除。它只限本轮，可调用勾选且本轮有权使用的工具，沿用本轮的空间权限。宿主只保存凭据的哈希。只支持 URL 的后端每请求一次就换一个地址，沿响应的 `next` 继续。对外反向代理应关闭这些工具路径的原始 URL 访问日志。

在运行页查看工具名、参数和结果状态，对应事件带 `via: cloud-http`，失败时记录截断、脱敏的错误原因。调用名单外的工具会收到本轮工具名和用途；无头 GET 的错误响应也会给 `next`。凭据签发和作废进审计记录。单个工具结果超过 32 KB 时只保留开头并提示缩小范围。次数用完或授权结束时应停止请求。

本人可用 `GET /api/cloud-tools` 看地址、各后端最近的探测时间和结论、当前有效凭据数，以及最近 50 个使用记录中的次数和错误。设置页的探测操作调用 `POST /api/cloud-tools/probe`，请求体为 `{"backend":"档案 ID"}`。全部作废用 `POST /api/cloud-tools/revoke`，返回本次撤销的数量。要阻止后续运行签发新凭据，同时关闭总开关。
