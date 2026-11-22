# 本机示例账号

在装有 bubblewrap 的 Linux 上，把本目录复制到 omem 数据目录的 `plugins/acmeauth`。将 `bin` 中两个文件安装到运行服务的用户的 `~/.local/lib/acmeauth`，将该目录加入服务的 PATH。重启服务，在插件设置中信任它并选择「在 omem 里运行」。

成员调用 `POST /api/credentials/acmeauth:demo/login` 后即可用 `GET /api/credentials` 查看状态。成员沙箱里的 `acme-demo whoami` 输出虚构账号名。选择后端 `acmeauth:demo` 进行一次对话，它通过 ACP 返回同一个账号名。调用 `DELETE /api/credentials/acmeauth:demo` 退出会移除账号文件。

示例在成员 HOME 的 `.acme-demo/account.json` 写入虚构账号名，续签有效期为七天。登录、检查和对话都在本机完成。

用 `acme-demo show --project sample` 查看公共示例项目，换成示例账号名则查看其个人项目。垫片识别拒绝时会显示示例申请链接。用 `who_can(resource="project:sample", kind="acmeauth:demo")` 查询权限记录，没有记录时会用插件预检。

示例的权限数据来自本地演示规则，`precheck` 只为 `who_can` 返回查询结果。接入真实资源服务后，插件可按完整参数核验发起人的读取权，并用 `verifiedRead` 明确授权本次只读代跑。
