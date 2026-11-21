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
    by: { runner: "stagekit:write", with: { verified: false } }
    budget: { minutes: 1 }
```

1. 保存流程并由本人确认。用 `PUT /api/flows/local-check/checks` 传入 `[{"id":"stagekit:word","stages":["write"],"mandatory":true}]`，为写文件阶段启用检查。
2. 在插件数据目录的 `ready.txt` 写入一行 `ready`，为一件事项启动 `local-check`。第一段读取标记，第二段创建 `proof-<运行id>.txt`。同一次尝试重启后复用已有文件。
3. 流程里的 `verified: false` 让文件和结果写“待复核”。写文件阶段会卡住，处理卡显示“结果缺少‘已验证’”。核对文件证据后，点「仍然通过」。阶段随即完成，日志里能看到越过的检查 `stagekit:word`。
4. 要试正常通过，删掉 `with: { verified: false }` 并去掉前面的逗号，重新保存、确认流程，再开一件事项。默认结果是“已验证”，检查直接通过。用同一检查设置接口传空数组可以关闭检查。
