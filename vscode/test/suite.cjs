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
  await vscode.workspace.getConfiguration("omem").update("url", process.env.OMEM_TEST_URL, vscode.ConfigurationTarget.Global);
  const ext = vscode.extensions.getExtension("omem.omem-vscode");
  const { api, current, bench, delegate } = await ext.activate();
  const step = (s) => console.log(`  · ${s}`);

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
  await bench.ask({ thread: asked, text: "这里为什么乘 100？" });
  assert.equal(asked.contextValue, "asked");
  assert.equal(asked.comments.length, 2);
  const answer = asked.comments[1];
  assert.equal(answer.author.name, "omem");
  const text = typeof answer.body === "string" ? answer.body : answer.body.value;
  assert.doesNotMatch(text, /没问成/);
  assert.match(text, /乘 100/, "假 Agent 回显问题");

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
