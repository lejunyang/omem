# Linux 沙箱的日常出网设置

要让本人的某类运行经代理出网，先在「设置 → 安全 → 运行的沙箱」里选中该类型，再把 `security.egress.mode` 设为 `all-sandboxed`。验收时用 `agents.ownSandbox.mode = "require"`，这样文件沙箱建不起来就会报错。`strict-only` 只隔离要求使用独立账号沙箱的成员运行。[出网模式和配置](command-gate.md#出网代理)

## 按实际流量选规则

| 日常操作 | 设置依据 |
| --- | --- |
| 模型请求 | 后端目录声明的模型主机和档案中的模型 base URL 由代理识别。第三方 API key 档案只认自己的地址。使用 omem 转发的档案先访问本轮回调入口，由宿主访问提供商。保留该入口，无需为此放行整个回环网段。 |
| npm、pnpm、pip、Go、Cargo | 按生效的源配置核对索引、包文件及校验服务的主机。仓库的 osdk 配置可以覆盖用户的默认 npm 源。真实包可能从索引以外的主机下载。专用镜像可以按主机授权，共用读写 API 的站点应分别考虑写入权限。 |
| Node 脚本 | 沙箱提供大小写 HTTP(S) 代理变量。在 Node 24.18.1 中，内置 `fetch` 默认直连失败。对该进程设置 `NODE_USE_ENV_PROXY=1` 后，同一 HTTPS 地址可达。 |
| Git HTTPS | 远端操作先过命令规则，HTTP(S) 客户端再按执行器来源走代理。需要登录的仓库由执行器使用本身份的 Git 配置。 |
| Git SSH | 支持按来源判定的版本会为**本人使用本人账号**的 Git 远端命令接入 CONNECT。出口及上游代理都要允许目标主机和 SSH 端口。成员账号及沙箱内普通 `ssh` 命令没有这项 Git 转接。 |

从提交 `843f0728` 起，HTTP 规则支持按来源匹配，本人 Git 执行器支持 SSH 转接。要让 Agent 直接访问某个内网服务时先审批，可用下面的规则。执行器和浏览器可各设自己的规则。未填 `source` 的现有 HTTP 规则仍作用于所有来源。

```json
{
  "id": "confirm-agent-api",
  "revision": 1,
  "enabled": true,
  "action": "approve",
  "match": { "kind": "http", "source": "agent", "host": "api.example.org" }
}
```

本人执行器访问远端内网时，未匹配规则的请求看 `security.egress.default`。成员访问内网需要显式授权。访问本机及链路本地目标时，本人和成员都需要显式授权。后端模型主机按身份和目标地址自动放行。同一 Agent 沙箱的子进程也属于 `agent` 来源，模型专用主机宜与需要审批的业务 API 分开。

只看 HTTPS 目标主机时，`inspect` 留空即可。需要按方法或路径判定时，把对应域名加入 `inspect`，让客户端信任沙箱提供的 CA 包，并核对宿主也信任上游证书。若隧道内条件不可见时希望先问，可将 `tunnelWhenUnsure` 设为 `approve`。使用上游代理时，在后端网络策略中配置支持 CONNECT 的 HTTP(S) 代理。宿主需要能解析目标名称，上游要能连接解析后的 IP 和端口。

## 用临时服务核对

在支持 bubblewrap 网络命名空间的 Linux 上使用临时 HOME、空缓存和回环假服务。先验证直连抵达不了假上游，再检查获准的请求确实到达。

| 操作 | 离线验收结果 |
| --- | --- |
| Codex、Claude CLI 调用假模型 | 两个客户端均经 HTTPS 代理读回约定回复。假服务分别收到了 Responses、Messages 请求。 |
| npm、pnpm、pip 读包源 | 三者均从假索引读到指定版本。`npm pack --ignore-scripts` 和 `pip download --only-binary=:all: --no-deps` 下载的包与源文件逐字节相同。独立安装的 pnpm 还需要能读取同一安装目录的 `dist`。 |
| Go、Cargo | `go list -m` 从假模块代理读到指定版本。`cargo search` 从假 sparse 索引找到配置和查询 API。完整工程构建还取决于依赖包和校验服务。 |
| Git | `git ls-remote` 经 HTTPS 读到假的分支引用。本人执行器的 SSH 验收以假服务收到客户端的 `SSH-2.0-` 标识为准。远端账号认证和仓库读写权限需单独核对。 |

仓库用例覆盖命令执行器、工具回调、HTTP 审批、上游代理及 TLS 校验。支持按来源判定的版本另验 Agent、执行器和浏览器对同一主机的不同决定，并检查 SSH 握手。运行时确认 bubblewrap 用例实际执行，跳过的用例不计入验收。

```sh
pnpm exec vitest run test/egress-sandbox.test.ts test/egress-proxy.test.ts test/command-executor.test.ts
pnpm exec vitest run test/egress-source.test.ts
```
