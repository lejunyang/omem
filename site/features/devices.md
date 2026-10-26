# 多台设备与多人

## 多台设备

常见用法是一台机器常驻运行（采集、定时任务），其他机器拉它的数据、看它的状态、让它执行检查。机器之间不必能直接访问，可以经中间那台转发。

```bash
# 常驻那台
omem peer invite --label laptop       # 打印一行配对码，含本机所有网卡地址

# 另一台
omem peer add <配对码>                # 直接能访问到
omem peer add <配对码> --via <中间那台> # 只能经中间那台访问
omem diag <同伴>                      # 版本、数量、最近失败、采集状态、Agent
omem peer commands <同伴>             # 可远程执行的命令
omem peer call <同伴> update          # 拉代码、装依赖、构建、重启
omem pull <同伴>                      # 拉一份快照合并进本机
omem peer open <同伴>                 # 在本机浏览器打开它的网页
```

远程命令是固定的一组（诊断、日志、配置、只读查询、手动采集与回溯、运行记录、只读 SQL、git 与更新、重启），没有任意 shell。配对码里的令牌可以随时撤销。

## 多人

omem 默认只服务你自己。要给同事用：

```bash
omem user add 小王 --id wang --lark ou_xxx --space team   # 建用户、绑定飞书身份、可读 team 空间
omem user token wang                                      # 发一个 API 令牌
omem space share project-a wang [--edit]                  # 再开放一个空间
```

他私聊机器人时，会话进他自己的个人空间，只能检索自己和被共享的空间；事项和偏好各归各的。同一台机器、同一个数据目录，不做多租户隔离。
