// Runs inside VS Code's extension host (test/run.mjs): the seeded delegation's folder is open.
const assert = require("node:assert/strict");
const vscode = require("vscode");

const wait = async (what, check, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

exports.run = async function run() {
  const config = vscode.workspace.getConfiguration("omem");
  const G = vscode.ConfigurationTarget.Global;
  const port = Number(new URL(process.env.OMEM_TEST_URL).port);
  const ext = vscode.extensions.getExtension("omem.omem-vscode");
  const { api, status, current, bench, runs, delegate } = await ext.activate();
  const step = (s) => console.log(`  · ${s}`);

  step("连接：这台机器上的 omem（只填端口）");
  await config.update("connection", "local", G);
  await config.update("port", port, G);
  assert.equal((await api.conn.target()).base, process.env.OMEM_TEST_URL);
  assert.equal(await status.check(), true);
  assert.match(status.item.text, /plug/);

  step("连接：直接连接，令牌不对时视图显示“连接 omem”");
  await config.update("connection", "direct", G);
  await config.update("url", process.env.OMEM_TEST_URL + "/", G);
  await api.conn.setToken("wrong");
  assert.equal(await status.check(), false);
  assert.match(status.item.text, /未连接/);
  assert.deepEqual(await runs.getChildren(), [], "没连上时列表为空，显示欢迎页的连接按钮");

  step("连接：粘贴 omem link 的链接，地址和令牌都填好");
  const { fromPasted } = require("../out/connection.js");
  const got = await fromPasted(`${process.env.OMEM_TEST_URL}/?token=${process.env.OMEM_TEST_TOKEN}`);
  assert.equal(got.url, process.env.OMEM_TEST_URL);
  await api.conn.setToken(got.token, got.url);
  assert.equal(await status.check(), true);
  await assert.rejects(fromPasted("随便写的"), /认不出来/);

  step("连接：本机配对的设备，从数据目录读配对，本机 omem 服务不用开");
  await config.update("connection", "peer", G);
  await config.update("peer", "box", G);
  await config.update("home", process.env.OMEM_TEST_HOME, G);
  await config.update("port", 9, G);
  assert.deepEqual(await api.conn.target(), { base: process.env.OMEM_TEST_URL, token: process.env.OMEM_TEST_TOKEN });
  assert.equal(await status.check(), true);
  await config.update("peer", "nobody", G);
  await assert.rejects(api.conn.target(), /本机没有配对 nobody/);
  await config.update("peer", "box", G);
  await config.update("port", port, G);
  assert.equal(api.conn.web("/runs/x"), null, "经转发时网页链接改成提示 omem peer open");
  // That machine's files are not this window's without an SSH host: no delegation here.
  await current.detect();
  assert.equal(current.run, null);
  await config.update("sshHost", "box-host", G);
  assert.equal(api.conn.uri("/srv/work/a.ts").toString(), "vscode-remote://ssh-remote%2Bbox-host/srv/work/a.ts");
  assert.equal(api.conn.path(api.conn.uri("E:\\work\\a.ts")), "E:/work/a.ts");
  await config.update("sshHost", undefined, G);
  await config.update("home", undefined, G);
  await config.update("connection", "local", G);

  step("在 omem 的网页版 VS Code 里，固定连打开它的 omem，不看浏览器里存的设置");
  const hostedUrl = process.env.OMEM_TEST_URL;
  {
    process.env.OMEM_URL = hostedUrl;
    process.env.OMEM_TOKEN = process.env.OMEM_TEST_TOKEN;
    await config.update("connection", "peer", G);
    await config.update("peer", "elsewhere", G);
    try {
      assert.equal(api.conn.mode, "local");
      assert.equal(api.conn.server, hostedUrl);
      assert.equal(await api.conn.token(), process.env.OMEM_TEST_TOKEN);
      await api.get("/api/me");
    } finally {
      delete process.env.OMEM_URL;
      delete process.env.OMEM_TOKEN;
      await config.update("peer", undefined, G);
      await config.update("connection", "local", G);
    }
  }

  step("打开的文件夹认出是哪次交办");
  await current.detect();
  assert.equal(current.run?.id, process.env.OMEM_TEST_RUN);
  assert.equal(current.folders.length, 1);

  step("评审问题挂在代码行上");
  await wait("评审问题", () => bench.findings.length === 2);
  const major = bench.findings.find((f) => f.finding.severity === "major");
  const minor = bench.findings.find((f) => f.finding.severity === "minor");
  assert.ok(major.thread, "有文件和行号的问题是评论线程");
  assert.match(major.thread.uri.fsPath, /refund\.ts$/);
  assert.equal(major.thread.range.start.line, 1);
  assert.equal(minor.thread, null, "没有文件的问题只在修改单里");
  assert.equal(major.thread.contextValue, "finding");

  step("在线程上标“改”，宿主记下决定");
  await vscode.commands.executeCommand("omem.finding.fix", major.thread);
  assert.equal(major.thread.contextValue, "finding-fix");
  const reviews = await api.get(`/api/runs/${current.run.id}/reviews`);
  assert.equal(reviews.reviews[0].findings.find((f) => f.id === major.finding.id).decision, "fix");

  step("选中代码提问，回答回到同一线程");
  const doc = await vscode.workspace.openTextDocument(major.thread.uri);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(1, 0, 1, 10);
  const asked = bench.startThread(editor);
  // Returns at once (VS Code clears the reply box then); the answer streams into the thread.
  bench.ask({ thread: asked, text: "这里为什么乘 100？" });
  assert.equal(asked.contextValue, "asked");
  const body = (c) => (typeof c.body === "string" ? c.body : c.body.value);
  await wait("回答", () => asked.comments.length === 2 && !/^(<details>[\s\S]*<\/details>\s*)?思考中…$/.test(body(asked.comments[1]).trim()));
  const answer = asked.comments[1];
  assert.equal(answer.author.name, "omem");
  const text = typeof answer.body === "string" ? answer.body : answer.body.value;
  assert.doesNotMatch(text, /没问成/);
  assert.match(text, /乘 100/, "假 Agent 回显问题");

  step("在评审问题的线程上写修改点：问题标为“改”，修改点带上问题编号");
  await vscode.commands.executeCommand("omem.finding.clear", major.thread);
  await bench.fixPoint({ thread: major.thread, text: "四舍五入改成向零取整" });
  assert.equal(major.thread.contextValue, "finding-fix");
  assert.equal(bench.fixPoints.length, 1);
  assert.match(bench.fixPoints[0].text, new RegExp(`#${major.finding.id}.*向零取整`));
  bench.deleteThread(major.thread);
  assert.equal(bench.fixPoints.length, 0);
  assert.ok(bench.findings.includes(major) && major.thread.comments.every((c) => c.label !== "修改点"), "删掉修改点，问题的线程还在");

  step("记修改点，和标了“改”的问题一起开始修改");
  editor.selection = new vscode.Selection(0, 0, 0, 5);
  const point = bench.startThread(editor);
  bench.fixPoint({ thread: point, text: "函数名改成 roundRefund" });
  assert.equal(bench.fixPoints.length, 1);
  assert.equal(point.contextValue, "fixpoint");
  const next = await bench.startFix("顺便补一条测试");
  assert.ok(next?.id);
  const { run } = await api.get(`/api/runs/${next.id}`);
  assert.match(String(run.input.task), /负数金额的舍入方向不对/);
  assert.match(String(run.input.task), /refund\.ts:1：函数名改成 roundRefund/);
  assert.match(String(run.input.task), /顺便补一条测试/);
  assert.equal(bench.fixPoints.length, 0);
  await current.advance(run);
  assert.deepEqual(current.run.rounds, [process.env.OMEM_TEST_RUN, next.id]);
  await api.post(`/api/runs/${next.id}/cancel`);

  step("写任务文档交办");
  const task = await vscode.workspace.openTextDocument({ language: "markdown", content: "<!-- omem 交办 · 空间 shop-web（商城前端）。 -->\n\n退款单列表加一列退款原因\n" });
  await vscode.window.showTextDocument(task);
  const lenses = delegate.provideCodeLenses(task);
  assert.equal(lenses.length, 1);
  // The first delegation is still open on main; this one runs beside it.
  await api.post(`/api/runs/${process.env.OMEM_TEST_RUN}/discard`).catch(() => {});
  const made = await delegate.submit(task.uri);
  assert.equal(made.title, "退款单列表加一列退款原因");
  await api.post(`/api/runs/${made.id}/cancel`);
  step("通过");
};
