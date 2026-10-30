# omem for VS Code

在 VS Code 里用 omem 的交办编码和评审：看交办列表和过程，评审问题挂在代码行上逐条定“改 / 暂不改 / 不改”，选中代码提问或记修改点，开始下一轮修改，写任务文档发起交办。设计见仓库的 `docs/v2/ide.md`。

## 连接

点状态栏左下的 omem，或运行命令“omem：连接 omem…”，选 omem 在哪里：

| 情况 | 选 | 要填 |
| --- | --- | --- |
| omem 就在这台电脑上，或这个窗口用 Remote-SSH / WSL / 容器连在 omem 那台机器上（插件装在那边） | 这台机器上的 omem | 一般什么都不用填；端口不是 4317 时填端口 |
| 另一台机器的 omem，能直接访问 | 粘贴配对码或链接 | 那台机器上 `omem link` 或 `omem peer invite` 的输出 |
| 同上，手头有地址和令牌 | 填地址和令牌 | 地址和 `omem user token` 的令牌 |
| 本机 omem 已经 `omem peer add` 配好那台机器（只能经中转访问的也行） | 本机配对的设备 | 从 `omem peer list` 的设备里选；本机 omem 服务不用开 |

后三种连的是别的机器：要从评审跳到代码、打开交办的工作区，还得填那台机器的 SSH 主机名（`omem.sshHost`，`~/.ssh/config` 里的 Host），用 Remote-SSH 打开。令牌存在系统钥匙串（SecretStorage），不进设置文件。设置页（搜 omem）里也能直接改，每项写了在哪种方式下用。

在 omem 的网页版 VS Code 里（运行页“在 VS Code 中打开”选“网页版 VS Code”）插件已经装好，连的就是打开它的那个 omem，什么都不用填：omem 启动网页版时把自己的地址和令牌放在环境变量 `OMEM_URL`、`OMEM_TOKEN` 里。设了 `omem.port` 时以设置为准。

## 用法

- 打开交办的工作区（网页运行页“在 VS Code 中打开”，或侧栏“交办”里的打开按钮），插件按文件夹认出是哪次交办。
- 评审问题是代码上的评论线程，线程标题上有“改 / 暂不改 / 不改”；“不改”要写一句理由。侧栏“修改单”列出全部问题和修改点。
- 选中代码按 `Ctrl+Alt+A` 或右键“问 omem”：在这段代码上开一个线程，输入后点“提问”，回答写回同一线程；点“记为修改点”则留到下一轮。
- “修改单”标题栏的“开始修改”：标了“改”的问题和修改点一起交给编码 Agent，续在原工作区。
- “交办”标题栏的 ＋：选仓库，在临时 Markdown 文档里写任务（右键“引用到交办任务”把选中代码带进去），点文档顶部的“提交交办”。
- 状态栏显示当前交办的轮次和状态，点开“omem 交办”输出看过程。

## 开发

```bash
pnpm install && pnpm --filter omem-vscode run build   # 在仓库根目录：vscode/ 是 pnpm workspace 里的一个包
```

`node test/run.mjs` 启动一个带演示数据的 omem（`test/seed.mts`），在真实 VS Code 里跑 `test/suite.cjs`；`VSCODE_PATH` 指向已安装的 Code 可执行文件可以不下载。打包：`pnpm run package`。
