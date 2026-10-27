import * as vscode from "vscode";
import type { Api, Run, Space } from "./api";
import type { Current } from "./current";

/**
 * Starting a delegation: the task is written in an untitled Markdown document (code can be quoted
 * into it from the editor), and a CodeLens on its first line submits it. The first line names the
 * space the task belongs to.
 */
const MARK = /^<!-- omem 交办 · 空间 ([^\s（(]+)/;

export class Delegate implements vscode.CodeLensProvider {
  constructor(private readonly api: Api, private readonly current: Current) {}

  provideCodeLenses(doc: vscode.TextDocument) {
    if (!MARK.test(doc.lineAt(0).text)) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    return [new vscode.CodeLens(top, { title: "$(rocket) 提交交办", command: "omem.submitTask", arguments: [doc.uri] })];
  }

  /** The open task document, if any. */
  taskDoc() {
    return vscode.workspace.textDocuments.find((d) => !d.isClosed && MARK.test(d.lineAt(0).text));
  }

  async open(): Promise<vscode.TextDocument | undefined> {
    const spaces = (await this.api.get<Space[]>("/api/spaces")).filter((s) => s.kind === "repo" && s.rootPath);
    if (!spaces.length) {
      void vscode.window.showWarningMessage("omem 里还没有代码仓库空间：先在网页“设置 → 空间”里关联仓库");
      return;
    }
    const here = this.guessSpace(spaces);
    const picked = await vscode.window.showQuickPick(
      spaces.map((s) => ({ label: s.name, description: s.id, detail: s.rootPath ?? undefined, picked: s.id === here, s })).sort((a, b) => Number(b.s.id === here) - Number(a.s.id === here)),
      { title: "交办到哪个仓库", placeHolder: "几个仓库一起改的，到网页或问答里交办" },
    );
    if (!picked) return;
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: `<!-- omem 交办 · 空间 ${picked.s.id}（${picked.s.name}）。写好任务后点上面的“提交交办”；第一行文字是标题。 -->\n\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  }

  private guessSpace(spaces: Space[]) {
    if (this.current.run?.space) return this.current.run.space;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => norm(f.uri.fsPath));
    return spaces.find((s) => s.rootPath && folders.includes(norm(s.rootPath)))?.id;
  }

  /** Quote the editor's selection into the task document (opening one when none is open). */
  async quote(editor: vscode.TextEditor) {
    const doc = this.taskDoc() ?? (await this.open());
    if (!doc) return;
    const sel = editor.selection;
    const file = this.current.run && this.current.contains(editor.document.uri) ? this.current.relative(editor.document.uri) : vscode.workspace.asRelativePath(editor.document.uri);
    const where = `${file}:${sel.start.line + 1}${sel.end.line > sel.start.line ? `-${sel.end.line + 1}` : ""}`;
    const text = editor.document.getText(sel).replace(/```/g, "ˋˋˋ");
    const shown = await vscode.window.showTextDocument(doc, { preview: false });
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    await shown.edit((e) => e.insert(end, `${doc.getText().endsWith("\n\n") ? "" : "\n\n"}${where}：\n\n\`\`\`${editor.document.languageId}\n${text}\n\`\`\`\n\n`));
  }

  async submit(uri?: vscode.Uri): Promise<Run | undefined> {
    const doc = uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : this.taskDoc();
    const space = doc && MARK.exec(doc.lineAt(0).text)?.[1];
    if (!doc || !space) return;
    const task = doc.getText().split("\n").slice(1).join("\n").trim();
    if (!task) {
      void vscode.window.showWarningMessage("任务还是空的");
      return;
    }
    const run = await this.api.post<Run>("/api/delegate", { space, task });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    return run;
  }
}

const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
