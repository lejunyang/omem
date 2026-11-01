import * as vscode from "vscode";

/**
 * The files of the change last opened from the 修改项 view (a task, a checkpoint, since the owner last
 * looked, or the branch against another one) as a tree in the 改动的文件 view: folders fold, a chain of
 * single folders reads as one row, each file shows its added and removed lines. A file opens on its
 * own diff; a large change is read this way rather than as one multi-file diff of hundreds of files.
 */
export type ChangedFile = { path: string; left: vscode.Uri; right: vscode.Uri; status: "A" | "D" | "M" | "R"; add: number; rm: number };
type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: ChangedFile[] };
type Node = { dir: Dir } | { file: ChangedFile };

const STATUS: Record<ChangedFile["status"], string> = { A: "新增", D: "删除", M: "修改", R: "改名" };
/** Up to this many files the multi-file diff opens at once; beyond it the tree is the way in. */
export const OPEN_ALL_UP_TO = 50;
/** A file in the multi-file diff: an added one has no left side and a deleted one no right, so VS Code marks them A and D. */
export const changeEntry = (f: ChangedFile) => [f.status === "D" ? f.left : f.right, f.status === "A" ? undefined : f.left, f.status === "D" ? undefined : f.right];

export class ChangedFiles implements vscode.TreeDataProvider<Node> {
  title = "";
  files: ChangedFile[] = [];
  private root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** The view shows only while there is a change: the context is set before anything focuses it. */
  async set(title: string, files: ChangedFile[]) {
    this.title = title;
    this.files = files;
    this.root = tree(files);
    this.changed.fire(undefined);
    await vscode.commands.executeCommand("setContext", "omem.hasChanges", files.length > 0);
  }

  clear() {
    return this.set("", []);
  }

  /** The whole change in VS Code's multi-file diff. */
  async openAll() {
    if (!this.files.length) return;
    await vscode.commands.executeCommand("vscode.changes", this.title, this.files.map(changeEntry));
  }

  getChildren(node?: Node): Node[] {
    const d = node ? ("dir" in node ? node.dir : null) : this.root;
    if (!d) return [];
    return [...[...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((dir) => ({ dir })), ...[...d.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ file }))];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if ("dir" in node) {
      const n = count(node.dir);
      // A small change opens unfolded; hundreds of files start folded.
      const item = new vscode.TreeItem(node.dir.name, this.files.length > OPEN_ALL_UP_TO ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${n} 个文件`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.tooltip = node.dir.path;
      return item;
    }
    const f = node.file;
    const name = f.path.split("/").pop()!;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.description = `${f.status === "M" ? "" : `${STATUS[f.status]} `}+${f.add} −${f.rm}`;
    item.resourceUri = f.right;
    item.tooltip = `${f.path}（${STATUS[f.status]}，+${f.add} −${f.rm}）`;
    item.command = { command: "vscode.diff", title: "看改动", arguments: [f.left, f.right, `${name}（${this.title}）`] };
    return item;
  }
}

function tree(files: ChangedFile[]): Dir {
  const top: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    let d = top;
    for (const part of f.path.split("/").slice(0, -1)) {
      const path = d.path ? `${d.path}/${part}` : part;
      if (!d.dirs.has(part)) d.dirs.set(part, { name: part, path, dirs: new Map(), files: [] });
      d = d.dirs.get(part)!;
    }
    d.files.push(f);
  }
  const squash = (d: Dir): Dir => {
    let cur = d;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0];
      cur = { ...only, name: cur.name ? `${cur.name}/${only.name}` : only.name };
    }
    return { ...cur, dirs: new Map([...cur.dirs].map(([k, v]) => [k, squash(v)])) };
  };
  return { ...top, dirs: new Map([...top.dirs].map(([k, v]) => [k, squash(v)])) };
}

const count = (d: Dir): number => d.files.length + [...d.dirs.values()].reduce((n, x) => n + count(x), 0);
