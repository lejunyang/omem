# omem for VS Code

在 VS Code 里用 omem 的交办编码和评审：看交办列表和过程，评审问题挂在代码行上逐条定“改 / 暂不改 / 不改”，选中代码提问或记修改点，开始下一轮修改，写任务文档发起交办。设计见仓库的 `docs/v2/ide.md`。

## 连接

- 插件优先跑在工作区所在的机器上（`extensionKind: workspace`）。经 Remote-SSH 打开 omem 那台机器上的交办工作区时，插件直接连那台的 omem（默认 `http://127.0.0.1:4317`），不用令牌。
- 本地连别处的 omem：设置 `omem.url`，再运行“omem：设置访问令牌”，填 omem 所在机器上 `omem user token` 给出的令牌（存在 VS Code 的 SecretStorage）。

## 用法

- 打开交办的工作区（网页运行页“在 VS Code 中打开”，或侧栏“交办”里的打开按钮），插件按文件夹认出是哪次交办。
- 评审问题是代码上的评论线程，线程标题上有“改 / 暂不改 / 不改”；“不改”要写一句理由。侧栏“修改单”列出全部问题和修改点。
- 选中代码按 `Ctrl+Alt+A` 或右键“问 omem”：在这段代码上开一个线程，输入后点“提问”，回答写回同一线程；点“记为修改点”则留到下一轮。
- “修改单”标题栏的“开始修改”：标了“改”的问题和修改点一起交给编码 Agent，续在原工作区。
- “交办”标题栏的 ＋：选仓库，在临时 Markdown 文档里写任务（右键“引用到交办任务”把选中代码带进去），点文档顶部的“提交交办”。
- 状态栏显示当前交办的轮次和状态，点开“omem 交办”输出看过程。

## 开发

```bash
cd vscode && pnpm install --ignore-workspace && pnpm run build
```

`node test/run.mjs` 启动一个带演示数据的 omem（`test/seed.mts`），在真实 VS Code 里跑 `test/suite.cjs`；`VSCODE_PATH` 指向已安装的 Code 可执行文件可以不下载。打包：`pnpm run package`。
