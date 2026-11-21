# 本机阶段示例

用 `omem plugin install examples/plugins/stagekit` 安装，再信任插件的三项流程权限。文件都在数据目录的 `plugin-data/stagekit/` 下。

保存下面的流程会先给本人确认卡片。本人确认后才保存和使用运行器；成员不能自行启用。

```yaml
id: local-check
name: 本机检查
stages:
  - id: mark
    name: 等待标记
    by: wait
    done: { signal: "stagekit:mark", with: { file: ready.txt } }
  - id: write
    name: 写检查文件
    by: { runner: "stagekit:write" }
    budget: { minutes: 1 }
```

在 `plugin-data/stagekit/ready.txt` 写入 `ready`，巡检后第一段完成，第二段创建 `proof-<运行id>.txt`。相同尝试重启后用相同幂等键，文件只创建一次。阶段证据列出标记文件和检查文件。

默认没有结果检查。本人调用 `PUT /api/flows/local-check/checks`，传 `[{"id":"stagekit:word","stages":["write"],"mandatory":true}]`，第二段才会要求结果包含“已验证”。缺少时阶段卡住，本人可以在卡片上对这一次仍然通过，记录里写明越过的检查。传空数组关闭检查。
