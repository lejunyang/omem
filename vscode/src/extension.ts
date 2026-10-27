import * as vscode from "vscode";
import { Api, type Folder, type Run } from "./api";
import { askSshHost, connect, Status } from "./connect";
import { Connection } from "./connection";
import { Current } from "./current";
import { Delegate } from "./delegate";
import { Progress } from "./progress";
import { RunItem, Runs } from "./runs";
import { Workbench } from "./review";

/**
 * omem in VS Code (docs/v2/ide.md): delegations and their progress, review findings on the code,
 * questions and fix points on a selection, starting a fix or a new delegation. Everything goes
 * through omem's HTTP API, as the web page does.
 */
export async function activate(context: vscode.ExtensionContext) {
  const api = new Api(new Connection(context.secrets));
  const status = new Status(api);
  const fail = (e: unknown) => void vscode.window.showErrorMessage(`omem：${(e as Error).message}`);
  const current = new Current(api);
  const bench = new Workbench(api, current);
  const runs = new Runs(api, current);
  const delegate = new Delegate(api, current);
  const progress = new Progress(api, current, () => {
    runs.refresh();
    void bench.load().catch(fail);
  });
  current.onDidChange(() => void bench.load().catch(fail));

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        fail(e);
      }
    }));
  const runOf = (arg: unknown) => (arg instanceof RunItem ? arg.run?.id : typeof arg === "string" ? arg : current.run?.id);
  const openWeb = (runId: string) => {
    const uri = api.conn.web(`/runs/${runId}`);
    if (uri) void vscode.env.openExternal(uri);
    else void vscode.window.showInformationMessage(`连配对的设备时，网页在本机终端里用 omem peer open ${api.conn.peer} 打开，再到“运行”里找这次交办`);
  };
  const started = async (run: Run, what: string) => {
    const pick = await vscode.window.showInformationMessage(`${what}：${run.title}`, "看过程", "在网页中查看");
    if (pick === "看过程") progress.output.show(true);
    if (pick === "在网页中查看") openWeb(run.id);
  };

  context.subscriptions.push(
    status,
    bench,
    progress,
    vscode.window.registerTreeDataProvider("omem.runs", runs),
    vscode.window.registerTreeDataProvider("omem.review", bench),
    vscode.languages.registerCodeLensProvider({ language: "markdown" }, delegate),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void current.detect().catch(() => {})),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (["connection", "url", "port", "peer", "home", "sshHost"].some((k) => e.affectsConfiguration(`omem.${k}`))) void reconnect();
    }),
  );

  // A changed connection: check it, then everything shown comes from the new omem.
  const reconnect = async () => {
    if (await status.check()) await current.detect().catch(() => current.set(null));
    else await current.set(null).catch(() => {});
    runs.refresh();
  };
  cmd("omem.connect", () => connect(api, status));
  cmd("omem.refresh", async () => {
    await status.check();
    runs.refresh();
    if (current.run) await current.select(current.run.id);
    else await current.detect();
  });
  cmd("omem.setToken", async () => {
    const token = await vscode.window.showInputBox({ title: `${api.conn.describe()} 的访问令牌`, prompt: "omem 所在机器上运行 omem user token 得到；留空则删除", password: true, ignoreFocusOut: true });
    if (token === undefined) return;
    await api.conn.setToken(token.trim() || null);
    await reconnect();
  });
  cmd("omem.showRun", async (arg) => {
    const id = runOf(arg);
    if (!id) return;
    await current.select(id);
    await vscode.commands.executeCommand("omem.review.focus");
  });
  cmd("omem.openRunFolder", async (arg) => {
    const id = runOf(arg);
    if (!id) return;
    const { folders } = await api.get<{ folders: Folder[] }>(`/api/runs/${id}/folders`);
    if (!folders.length) return void vscode.window.showWarningMessage("这次交办的工作区已经释放了");
    const f = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map((x) => ({ label: x.space, description: x.path, f: x })), { title: "打开哪个仓库" }))?.f;
    if (!f) return;
    let uri = api.conn.uri(f.path);
    if (!uri && (await askSshHost(true))) uri = api.conn.uri(f.path);
    if (!uri) return void vscode.window.showWarningMessage(`工作区在 omem 那台机器上（${f.path}），要填 SSH 主机名才能用 Remote-SSH 打开`);
    await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: !!vscode.workspace.workspaceFolders?.length });
  });
  cmd("omem.openWeb", (arg) => {
    const id = runOf(arg);
    if (id) openWeb(id);
  });
  cmd("omem.showProgress", () => progress.output.show(true));
  cmd("omem.reveal", async (uri: vscode.Uri, line: number, thread?: vscode.CommentThread) => {
    const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false });
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  });

  // Questions and fix points on a selection: a thread on it, typed into and sent from there.
  cmd("omem.askSelection", () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) bench.startThread(editor);
  });
  cmd("omem.fixSelection", () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) bench.startThread(editor);
  });
  cmd("omem.thread.ask", (reply: vscode.CommentReply) => bench.ask(reply));
  cmd("omem.thread.fixPoint", (reply: vscode.CommentReply) => bench.fixPoint(reply));
  cmd("omem.thread.delete", (arg) => bench.deleteThread(arg));

  for (const d of ["fix", "later", "wontfix"] as const)
    cmd(`omem.finding.${d}`, async (arg) => {
      const ft = bench.findingOf(arg);
      if (ft) await bench.decide(ft, d);
    });
  cmd("omem.finding.clear", async (arg) => {
    const ft = bench.findingOf(arg);
    if (ft) await bench.decide(ft, null);
  });
  cmd("omem.startFix", async () => {
    const next = await bench.startFix();
    if (!next) return;
    await current.advance(next);
    runs.refresh();
    await started(next, "已开始修改");
  });

  cmd("omem.delegate", () => delegate.open());
  cmd("omem.quoteToTask", () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) return delegate.quote(editor);
  });
  cmd("omem.submitTask", async (uri?: vscode.Uri) => {
    const run = await delegate.submit(uri);
    if (!run) return;
    runs.refresh();
    await current.select(run.id);
    await started(run, "已交办");
  });

  if (await status.check()) await current.detect().catch(() => current.set(null));
  else await current.set(null).catch(() => {});
  return { api, status, current, bench, runs, delegate };
}

export function deactivate() {}
