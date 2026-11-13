# @omem-ai/cli

在自己的电脑上用一台远程的 omem：在终端里调它的工具，或者把它作为 MCP 服务接给 Claude Code、Codex 这类 Agent。工具以你自己的身份运行，只能用你看得到的空间。

这个包只有一个文件，不带依赖，不含服务端（向量、飞书、Agent 运行、网页）。要在本机运行 omem 服务、用本机的库，请装完整版 `@omem-ai/app`。两个包的命令都叫 `omem`，同一台机器上装一个就行：完整版也有下面这些命令。

```bash
npm install -g @omem-ai/cli        # Node 20 以上
```

```bash
omem login https://omem.example.com                  # 浏览器里登录并确认，拿到只属于你的令牌，记成一个远程地址
omem tool list_spaces                                # 调用工具；omem tool help [工具名|分组] 看说明
omem tool search query=退款 space=proj-a
claude mcp add omem -- omem mcp                       # 给 Claude Code 接上（默认远程地址；也可 --remote <名字> / --url <地址>）
omem open /wiki                                      # 在浏览器里打开远程 omem，直接登录
omem remote add|list|default|rm                      # 管理记下的远程地址（~/.omem/client.json）
```

凭据按顺序取：环境变量 `OMEM_TOKEN`、`OMEM_AUTH_CMD`（一条输出凭据的命令，比如组织登录体系的 JWT，需要服务端装了对应的鉴权插件）、`omem login` 存下的令牌。地址按顺序取：`--url`、`--remote`、`OMEM_URL`、默认远程地址。

`--space`、`--spaces`、`--read-only` 限定默认空间、可用空间和只读；`--session`、`--agent`、`--model`、`--effort` 登记到对方运行页上的会话和 Agent 信息。

设计见仓库里的 docs/v2/remote-clients.md。
