import * as vscode from "vscode";
import type { Api } from "./api";
import type { Current } from "./current";

/**
 * A delegation driven by tasks (docs/v2/coding-loop.md) in the 修改项 view: where it stands and its
 * budget, the questions waiting for the owner, each task with where it came from and how its
 * verification went, and the checkpoints. A task's change, one checkpoint's step or everything since
 * the owner last looked opens in VS Code's multi-file diff, both sides read from omem (`omem-rev:`),
 * so it works when the worktree is on another machine. The owner answers, re-does, drops, reverts,
 * adds tasks, goes back to a checkpoint, pauses and goes on from here as on the run page.
 */
export type TaskState = "todo" | "coding" | "verify" | "disputed" | "done" | "owner" | "wontdo" | "reverted";
export type Task = { seq: number; title: string; doneWhen: string; kind: string; origin: { findings?: number[]; note?: string }; state: TaskState; question: string | null; options: string[]; answer: string | null; verifier: string | null; attempts: number; reverts: number; commits: Record<string, string[]>; checkpoint: number | null; notes: { at: string; by: string; text: string; kind: string }[] };
export type Checkpoint = { seq: number; tasks: number[]; by: string; label: string; createdAt: string };
export type Work = { budget: number; budgetBy: string | null; until: number; round: number; lastRunId: string; paused: string | null; viewed: number; status: string; verdict: string | null; stage: string | null; reverts: number[]; pending: string[]; max: number };
export type TaskData = { taskMode: boolean; rootId?: string; tasks?: Task[]; checkpoints?: Checkpoint[]; work?: Work };

export const TASK_STATE: Record<TaskState, string> = { todo: "待做", coding: "编码中", verify: "待验证", disputed: "裁决中", done: "已完成", owner: "等你决定", wontdo: "不做", reverted: "已回退" };
const PAUSE: Record<string, string> = { budget: "暂停：自动推进的轮数用完了", owner: "你暂停了", "not-converging": "暂停：修改没有收敛", paused: "已暂停" };
const SKIP = "不做这一项";

type Node =
  | { kind: "status"; data: TaskData }
  | { kind: "group"; id: string; label: string; tasks: Task[] }
  | { kind: "task"; task: Task }
  | { kind: "checkpoints"; list: Checkpoint[] }
  | { kind: "checkpoint"; cp: Checkpoint; last: number };

export class TaskItem extends vscode.TreeItem {
  constructor(readonly node: Node) {
    super("", vscode.TreeItemCollapsibleState.None);
  }
}

/** The rows of a `git diff`, file by file: where each file was and is, so both sides can be shown. */
export function patchFiles(patch: string): { oldPath: string | null; newPath: string | null }[] {
  return patch.split(/^diff --git /m).filter(Boolean).map((chunk) => {
    const lines = chunk.split("\n");
    const pick = (re: RegExp) => lines.map((l) => re.exec(l)?.[1]).find((x) => x !== undefined);
    const minus = pick(/^--- (?:a\/)?(.+?)\t?$/);
    const plus = pick(/^\+\+\+ (?:b\/)?(.+?)\t?$/);
    const from = pick(/^rename from (.+)$/) ?? pick(/^copy from (.+)$/);
    const to = pick(/^rename to (.+)$/) ?? pick(/^copy to (.+)$/);
    const head = /^a\/(\S+) b\/(\S+)/.exec(lines[0]);
    const added = lines.some((l) => l.startsWith("new file mode"));
    const deleted = lines.some((l) => l.startsWith("deleted file mode"));
    const oldPath = added ? null : from ?? (minus && minus !== "/dev/null" ? minus : null) ?? head?.[1] ?? null;
    const newPath = deleted ? null : to ?? (plus && plus !== "/dev/null" ? plus : null) ?? head?.[2] ?? null;
    return { oldPath, newPath };
  });
}

export class Tasks implements vscode.TreeDataProvider<TaskItem>, vscode.TextDocumentContentProvider {
  data: TaskData | null = null;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly api: Api, private readonly current: Current, private readonly state?: vscode.Memento) {
    current.onDidChange(() => void this.load().catch(() => {}));
  }

  async load() {
    const run = this.current.run;
    this.data = run ? await this.api.get<TaskData>(`/api/runs/${run.id}/tasks`).catch(() => null) : null;
    await vscode.commands.executeCommand("setContext", "omem.taskMode", !!this.data?.taskMode);
    await vscode.commands.executeCommand("setContext", "omem.paused", !!this.data?.work?.paused);
    this.changed.fire();
    return this.data;
  }

  getTreeItem(item: TaskItem) {
    const n = item.node;
    if (n.kind === "status") {
      const w = n.data.work!;
      const owner = (n.data.tasks ?? []).filter((t) => t.state === "owner").length;
      const busy = ["queued", "running"].includes(w.status);
      item.label = busy ? (w.stage === "verify" ? "逐项验证中" : w.stage === "arbitrate" ? "评审负责人裁决异议中" : ["plan", "checks", "lead"].includes(w.stage ?? "") ? "阶段评审中" : w.status === "queued" ? "排队中" : "编码中")
        : w.paused ? PAUSE[w.paused] ?? "已暂停" : owner ? `等你决定 ${owner} 项` : w.verdict === "approved" ? "完成，等你确认" : "已停下";
      item.description = `第 ${w.round} 轮 · 最多到第 ${w.until} 轮`;
      item.tooltip = `${w.pending.length ? `下一轮开始前：${w.pending.join("；")}\n` : ""}每次 ${w.budget} 轮（${w.budgetBy === "owner" ? "你给的" : "按任务估的"}），上限 ${w.max}`;
      item.iconPath = new vscode.ThemeIcon(busy ? "sync~spin" : w.paused ? "debug-pause" : owner ? "question" : w.verdict === "approved" ? "pass" : "circle-outline");
      item.contextValue = "work-status";
    } else if (n.kind === "group") {
      item.label = n.label;
      item.description = String(n.tasks.length);
      item.collapsibleState = n.id === "other" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
    } else if (n.kind === "task") {
      const t = n.task;
      item.label = `T${t.seq} ${t.title}`;
      item.description = `${TASK_STATE[t.state]}${t.attempts ? ` · 第 ${t.attempts + 1} 次` : ""}${this.data?.work?.reverts.includes(t.seq) ? " · 下一轮先回退" : ""}`;
      const md = new vscode.MarkdownString();
      if (t.question && t.state === "owner") md.appendMarkdown(`**等你决定**：${t.question}\n\n`);
      if (t.doneWhen) md.appendMarkdown(`**完成标准**：${t.doneWhen}\n\n`);
      if (t.origin.findings?.length) md.appendMarkdown(`来自评审问题 ${t.origin.findings.map((f) => `#${f}`).join("、")}${t.verifier ? `，由 ${t.verifier} 验证` : ""}\n\n`);
      for (const note of t.notes.slice(-5)) md.appendMarkdown(`- ${note.text.replace(/\n/g, " ").slice(0, 300)}\n`);
      item.tooltip = md;
      item.iconPath = new vscode.ThemeIcon({ todo: "circle-outline", coding: "sync~spin", verify: "eye", disputed: "law", done: "pass", owner: "question", wontdo: "circle-slash", reverted: "discard" }[t.state]);
      const commits = Object.values(t.commits).some((l) => l.length);
      item.contextValue = `task-${t.state}${commits ? "-commits" : ""}`;
      if (commits) item.command = { command: "omem.task.diff", title: "看改动", arguments: [item] };
    } else if (n.kind === "checkpoints") {
      item.label = "检查点";
      item.description = String(n.list.length);
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    } else {
      item.label = `${n.cp.seq} ${n.cp.label}`;
      item.description = new Date(n.cp.createdAt).toLocaleString();
      item.iconPath = new vscode.ThemeIcon(n.cp.by === "owner" ? "person" : "git-commit");
      item.contextValue = n.cp.seq === n.last ? "checkpoint-last" : "checkpoint";
      item.command = { command: "omem.checkpoint.step", title: "看这一步", arguments: [item] };
    }
    return item;
  }

  getChildren(parent?: TaskItem): TaskItem[] {
    const d = this.data;
    if (!d?.taskMode || !d.work) return [];
    const tasks = d.tasks ?? [];
    if (!parent) {
      const groups = [
        { id: "owner", label: "等你决定", tasks: tasks.filter((t) => t.state === "owner") },
        { id: "open", label: "进行中", tasks: tasks.filter((t) => ["coding", "verify", "disputed", "todo"].includes(t.state)) },
        { id: "done", label: "已完成", tasks: tasks.filter((t) => t.state === "done") },
        { id: "other", label: "不做与回退", tasks: tasks.filter((t) => ["wontdo", "reverted"].includes(t.state)) },
      ].filter((g) => g.tasks.length);
      return [
        new TaskItem({ kind: "status", data: d }),
        ...groups.map((g) => new TaskItem({ kind: "group", ...g })),
        ...(d.checkpoints?.length ? [new TaskItem({ kind: "checkpoints", list: d.checkpoints })] : []),
      ];
    }
    const n = parent.node;
    if (n.kind === "group") return n.tasks.map((task) => new TaskItem({ kind: "task", task }));
    if (n.kind === "checkpoints") {
      const last = n.list.at(-1)?.seq ?? 0;
      return [...n.list].reverse().map((cp) => new TaskItem({ kind: "checkpoint", cp, last }));
    }
    return [];
  }

  // ---- both sides of a change, read from omem ---------------------------------------------------

  /** `omem-rev:/<path>?run=…&space=…&rev=…`: a file at a commit of the work (empty when it did not exist there). */
  async provideTextDocumentContent(uri: vscode.Uri) {
    const q = new URLSearchParams(uri.query);
    if (!q.get("rev")) return "";
    const r = await this.api.get<{ text: string; missing?: boolean; binary?: boolean }>(`/api/runs/${q.get("run")}/file-at?space=${encodeURIComponent(q.get("space")!)}&path=${encodeURIComponent(uri.path.replace(/^\//, ""))}&rev=${q.get("rev")}`);
    return r.binary ? "（二进制文件，不显示内容）" : r.text;
  }

  private revUri(run: string, space: string, path: string, rev: string | null) {
    return vscode.Uri.from({ scheme: "omem-rev", path: `/${path}`, query: new URLSearchParams({ run, space, rev: rev ?? "" }).toString() });
  }

  /**
   * Open a change in the multi-file diff: one task, a checkpoint's step, since a checkpoint, since the
   * owner last looked, or the branch against another. `local`: the right side is the work folder's own
   * file (the branch tip is what is checked out there), so questions and fix points work on it.
   */
  async showChanges(title: string, query: string, local = false) {
    const run = this.current.run;
    if (!run) return;
    const { patches } = await this.api.get<{ patches: { space: string; patch: string; from?: string; to?: string }[] }>(`/api/runs/${run.id}/task-diff?${query}`);
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
    for (const p of patches) {
      for (const f of patchFiles(p.patch)) {
        const path = f.newPath ?? f.oldPath!;
        const left = this.revUri(run.id, p.space, f.oldPath ?? path, f.oldPath ? p.from ?? null : null);
        const folder = local && f.newPath ? this.current.folders.find((x) => x.space === p.space) : undefined;
        const root = folder ? this.api.conn.uri(folder.path) : null;
        const right = root ? vscode.Uri.joinPath(root, path) : this.revUri(run.id, p.space, path, f.newPath ? p.to ?? null : null);
        resources.push([right, left, right]);
      }
    }
    if (!resources.length) return void vscode.window.showInformationMessage(`${title}：没有改动`);
    await vscode.commands.executeCommand("vscode.changes", title, resources);
    return resources.length;
  }

  // ---- the owner's actions -----------------------------------------------------------------------

  private async act(path: string, body: unknown, done: string) {
    const run = this.current.run;
    if (!run) return;
    const r = await this.api.post<{ next?: string | null }>(`/api/runs/${run.id}${path}`, body);
    void vscode.window.showInformationMessage(r.next ? `${done}，下一轮已经开始` : done);
    await this.load();
    return r;
  }
  private reason(title: string, prompt: string, required = false) {
    return vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true, validateInput: (v) => (required && !v.trim() ? "要写一句理由" : null) });
  }

  async answer(t: Task) {
    const pick = await vscode.window.showQuickPick([...t.options.map((label) => ({ label })), { label: "写我的做法…" }, { label: SKIP }], { title: `T${t.seq} ${t.title}`, placeHolder: t.question ?? "" });
    if (!pick) return;
    if (pick.label === SKIP) return this.act(`/tasks/${t.seq}`, { action: "skip" }, `T${t.seq} 不做了`);
    if (pick.label === "写我的做法…") {
      const text = await this.reason(`T${t.seq} 你的做法`, t.question ?? "", true);
      if (text === undefined) return;
      return this.act(`/tasks/${t.seq}`, { action: "answer", text }, `已回答 T${t.seq}`);
    }
    return this.act(`/tasks/${t.seq}`, { action: "answer", choice: pick.label }, `已回答 T${t.seq}`);
  }
  async reopen(t: Task) {
    const text = await this.reason(`重做 T${t.seq}`, "要怎么改（编码 Agent 会看到）");
    if (text !== undefined) return this.act(`/tasks/${t.seq}`, { action: "reopen", text }, `T${t.seq} 重新排进待做`);
  }
  async drop(t: Task) {
    const text = await this.reason(`T${t.seq} 不做了`, "理由（之后的评审会看到，不再提）", true);
    if (text !== undefined) return this.act(`/tasks/${t.seq}`, { action: "wontdo", text }, `T${t.seq} 不做了`);
  }
  async revert(t: Task, redo: boolean) {
    const text = await this.reason(`${redo ? "回退并重做" : "回退"} T${t.seq}`, "原因（可以不写）");
    if (text !== undefined) return this.act(`/tasks/${t.seq}`, { action: "revert", text: text || undefined, redo }, `T${t.seq} 会在下一轮开始前回退`);
  }
  async backTo(cp: Checkpoint | 0) {
    const seq = cp === 0 ? 0 : cp.seq;
    const text = await this.reason(seq ? `回到检查点 ${seq}` : "回到开始的样子", "之后的改动全部退回（一个回退提交）；原因（可以不写）");
    if (text !== undefined) return this.act("/revert", { checkpoint: seq, reason: text || undefined }, seq ? `下一轮开始前回到检查点 ${seq}` : "下一轮开始前回到开始的样子");
  }
  async add() {
    const title = await vscode.window.showInputBox({ title: "加一个修改项", prompt: "要改什么（一句话）", ignoreFocusOut: true });
    if (!title?.trim()) return;
    const detail = await this.reason("怎样算做完", "可以不写");
    return this.act("/tasks", { title: title.trim(), detail: detail?.trim() || undefined }, "加上了");
  }
  pause(paused: boolean) {
    return this.act("/work", { paused }, paused ? "已暂停：手上这一项做完就停" : "继续推进");
  }
  /** The whole branch against the one it will go into (fetched first when it is origin's), for reviewing everything it brings. */
  async compareBase() {
    const run = this.current.run;
    if (!run) return;
    const key = `omem.compareBase.${this.data?.rootId ?? run.id}`;
    const ref = (await vscode.window.showInputBox({ title: "和哪个分支比较", prompt: "工作分支和它分开以后的全部改动，包括这次交办以前就在分支上的提交；origin/ 开头的先拉取最新", value: this.state?.get<string>(key) ?? "", placeHolder: "如 origin/main", ignoreFocusOut: true }))?.trim();
    if (!ref) return;
    await this.state?.update(key, ref);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `正在和 ${ref} 比较…` }, () => this.showChanges(`和 ${ref} 比较`, `base=${encodeURIComponent(ref)}`, true));
  }

  /** Everything since the checkpoint the owner last looked at; then that is the one looked at. */
  async sinceViewed() {
    const d = this.data;
    if (!d?.work) return;
    const last = d.checkpoints?.at(-1)?.seq ?? 0;
    const n = await this.showChanges(d.work.viewed ? `检查点 ${d.work.viewed} 以后的改动` : "从开始到现在的改动", "since=viewed");
    if (n) await this.act("/work", { viewed: last }, `已看到检查点 ${last}`);
  }
}
