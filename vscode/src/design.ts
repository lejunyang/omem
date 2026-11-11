import * as vscode from "vscode";
import type { Api } from "./api";
import type { Current } from "./current";
import type { Patch, Tasks } from "./tasks";

/**
 * The design the current work is based on (docs/v2/coding-plan.md), in the 方案 view: its decisions,
 * each with the files that landed under it and the concerns still open, and what was changed outside
 * every decision. A decision opens its own part of the change — the tasks done for it, or in a branch
 * review the files put under it — in the multi-file diff, both sides read from omem; one of its files
 * opens that file alone. Confirming a design and answering its questions stay on the web page.
 */
type Kind = "add" | "change" | "remove" | "refactor";
type Level = "problem" | "risk" | "improve" | "question";
type Field = { brief: string };
type Concern = { id: string; level: Level; text: string; where?: string[]; state: "open" | "resolved" | "dropped"; note?: string };
type Decision = {
  id: string; kind: Kind; title: string; fields: Record<string, Field>; rejected?: { text: string; why: string }[];
  question?: { text: string; options: string[]; answer?: string }; stated?: boolean; concerns?: Concern[];
  after?: { deviation?: string; simpler?: string; done?: "yes" | "partly" | "no" };
};
type File = { space: string; path: string; add: number; del: number };
type Change = { decision: string; tasks: { seq: number; title: string; state: string }[]; commits: number; files: File[]; findings: { open: number; total: number } };
export type DesignData = {
  id: string; title: string; origin: "own" | "external" | "derived"; status: "drafting" | "review" | "approved" | "assessed" | "recorded"; revision: number; author: string | null;
  body: { decisions: Decision[]; concerns?: Concern[]; outside?: string[] };
  work: { rootId: string; title: string; branchReview: boolean } | null;
  changes: Change[];
  outside: File[];
};

const KIND: Record<Kind, string> = { add: "新增", change: "修改", remove: "删除", refactor: "重构" };
const LEVEL: Record<Level, string> = { problem: "问题", risk: "风险", improve: "改进", question: "要问" };
const LEVEL_ICON: Record<Level, string> = { problem: "error", risk: "warning", improve: "lightbulb", question: "question" };
const DONE = { yes: "做了", partly: "部分做了", no: "没做" } as const;
const ORIGIN = { own: "方案", external: "别人的方案", derived: "变更说明" } as const;
const STATUS = { drafting: "在写", review: "等你确认", approved: "已通过", assessed: "已评估", recorded: "已记录" } as const;
/** The fields of each kind in the order the web page shows them (src/designs/types.ts DECISION_FIELDS). */
const FIELDS: Record<Kind, [string, string][]> = {
  add: [["entry", "入口"], ["layer", "放在哪一层"], ["contract", "约定"], ["reuse", "复用"], ["behavior", "行为"], ["excludes", "不包含"]],
  change: [["behavior", "行为"], ["where", "改在"], ["callers", "影响"], ["migration", "过渡"]],
  remove: [["removes", "删掉"], ["users", "谁在用"], ["fallback", "删后"], ["cleanup", "一起清理"]],
  refactor: [["problem", "问题"], ["structure", "改成"], ["invariants", "不变的"], ["removes", "删掉"]],
};
export const OUTSIDE = "outside";

type Node =
  | { kind: "head"; data: DesignData }
  | { kind: "decision"; d: Decision; change: Change | undefined }
  | { kind: "outside"; files: File[] }
  | { kind: "concerns"; list: Concern[] }
  | { kind: "concern"; c: Concern }
  | { kind: "file"; decision: string; file: File };

export class DesignItem extends vscode.TreeItem {
  constructor(readonly node: Node) {
    super("", vscode.TreeItemCollapsibleState.None);
  }
}

const sum = (files: File[]) => files.reduce((n, f) => ({ add: n.add + f.add, del: n.del + f.del }), { add: 0, del: 0 });
const lines = (files: File[]) => {
  const n = sum(files);
  return n.add || n.del ? ` +${n.add} −${n.del}` : "";
};
const open = (list?: Concern[]) => (list ?? []).filter((c) => c.state === "open");

export class Design implements vscode.TreeDataProvider<DesignItem> {
  data: DesignData | null = null;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly api: Api, private readonly current: Current, private readonly tasks: Tasks) {
    current.onDidChange(() => void this.load().catch(() => {}));
  }

  /** The current work's design, if it has one with anything in it (a change description nobody handed in is nothing to show). */
  async load() {
    const run = this.current.run;
    const work = run ? await this.api.get<{ design: { id: string } | null }>(`/api/code-works/${run.id}`).catch(() => null) : null;
    this.data = work?.design ? await this.api.get<DesignData>(`/api/designs/${work.design.id}`).catch(() => null) : null;
    await vscode.commands.executeCommand("setContext", "omem.hasDesign", !!this.data);
    this.changed.fire();
    return this.data;
  }

  getTreeItem(item: DesignItem) {
    const n = item.node;
    if (n.kind === "head") {
      const d = n.data;
      item.label = d.title;
      item.description = `${ORIGIN[d.origin]} · ${d.status === "drafting" ? (d.origin === "external" ? "正在评估" : "在写") : STATUS[d.status]}${d.revision > 1 ? ` · 第 ${d.revision} 版` : ""}`;
      item.tooltip = `${d.body.decisions.length} 个决定${d.author ? `，作者 ${d.author}` : ""}。确认方案、回答问题、标意见在网页上做（点这一行打开）。`;
      item.iconPath = new vscode.ThemeIcon(d.status === "review" ? "question" : d.status === "drafting" ? "sync~spin" : "list-tree");
      item.contextValue = "design";
      item.command = { command: "omem.design.openWeb", title: "在网页中查看" };
    } else if (n.kind === "decision") {
      const { d, change } = n;
      const files = change?.files ?? [];
      const concerns = open(d.concerns);
      item.label = `${d.id} ${d.title}`;
      item.description = [
        `${KIND[d.kind]}${d.stated === false ? "（文档没写）" : ""}`,
        files.length ? `${files.length} 个文件${lines(files)}` : "没有改动",
        d.after?.done ? DONE[d.after.done] : "",
        d.after?.deviation ? "有偏差" : "",
        concerns.length ? `意见 ${concerns.length}` : "",
        change?.findings.open ? `评审问题 ${change.findings.open}` : "",
      ].filter(Boolean).join(" · ");
      item.tooltip = decisionText(d, change);
      item.iconPath = new vscode.ThemeIcon(d.question && !d.question.answer ? "question" : d.after?.done === "no" ? "circle-slash" : concerns.some((c) => c.level === "problem") ? "error" : d.after?.deviation || concerns.length ? "warning" : files.length ? "pass" : "circle-outline");
      item.collapsibleState = files.length || concerns.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      item.contextValue = files.length ? "decision-files" : "decision";
      if (files.length) item.command = { command: "omem.design.diff", title: "看这个决定的改动", arguments: [item] };
    } else if (n.kind === "outside") {
      item.label = "方案之外的改动";
      item.description = `${n.files.length} 个文件${lines(n.files)}`;
      item.tooltip = "没有挂在任何决定上的改动：评审时单独看它们该不该在这次里。";
      item.iconPath = new vscode.ThemeIcon("diff-added");
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      item.contextValue = "decision-files";
      item.command = { command: "omem.design.diff", title: "看方案之外的改动", arguments: [item] };
    } else if (n.kind === "concerns") {
      item.label = "整份方案的意见";
      item.description = String(n.list.length);
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    } else if (n.kind === "concern") {
      const c = n.c;
      item.label = `${LEVEL[c.level]}：${c.text.replace(/\s+/g, " ").slice(0, 120)}`;
      item.description = c.where?.join("、") ?? "";
      const md = new vscode.MarkdownString(`**${LEVEL[c.level]}** ${c.id}\n\n${c.text}`);
      if (c.where?.length) md.appendMarkdown(`\n\n位置：${c.where.join("、")}`);
      item.tooltip = md;
      item.iconPath = new vscode.ThemeIcon(LEVEL_ICON[c.level]);
    } else {
      const f = n.file;
      item.label = f.path.split("/").pop()!;
      item.description = `${f.path.includes("/") ? `${f.path.slice(0, f.path.lastIndexOf("/"))} ` : ""}${f.add || f.del ? `+${f.add} −${f.del}` : ""}`.trim();
      item.tooltip = `${this.multi() && f.space ? `${f.space}/` : ""}${f.path}`;
      item.iconPath = vscode.ThemeIcon.File;
      item.command = { command: "omem.design.diff", title: "看这个文件的改动", arguments: [item] };
    }
    return item;
  }

  getChildren(parent?: DesignItem): DesignItem[] {
    const d = this.data;
    if (!d) return [];
    if (!parent) {
      const by = new Map(d.changes.map((c) => [c.decision, c]));
      const overall = open(d.body.concerns);
      return [
        new DesignItem({ kind: "head", data: d }),
        ...d.body.decisions.map((x) => new DesignItem({ kind: "decision", d: x, change: by.get(x.id) })),
        ...(d.outside.length ? [new DesignItem({ kind: "outside", files: d.outside })] : []),
        ...(overall.length ? [new DesignItem({ kind: "concerns", list: overall })] : []),
      ];
    }
    const n = parent.node;
    const files = (decision: string, list: File[]) => [...list].sort((a, b) => a.path.localeCompare(b.path)).map((file) => new DesignItem({ kind: "file", decision, file }));
    if (n.kind === "decision") return [...open(n.d.concerns).map((c) => new DesignItem({ kind: "concern", c })), ...files(n.d.id, n.change?.files ?? [])];
    if (n.kind === "outside") return files(OUTSIDE, n.files);
    if (n.kind === "concerns") return n.list.map((c) => new DesignItem({ kind: "concern", c }));
    return [];
  }

  private multi() {
    return new Set((this.data?.changes ?? []).flatMap((c) => c.files.map((f) => f.space)).filter(Boolean)).size > 1;
  }

  /**
   * A decision's part of the change (or what is outside every decision; `only`: one of its files) in
   * the diff. The right side is the work folder's own file where the compared tip is checked out.
   */
  async showDecision(decision: string, only?: File) {
    const d = this.data;
    if (!d?.work) return void vscode.window.showInformationMessage("这份方案还没有关联的代码");
    const what = decision === OUTSIDE ? "方案之外的改动" : `${decision} ${d.body.decisions.find((x) => x.id === decision)?.title ?? ""}`.trim();
    let { patches } = await this.api.get<{ patches: Patch[] }>(`/api/designs/${d.id}/diff?decision=${encodeURIComponent(decision)}`);
    if (only) patches = patches.filter((p) => !only.space || p.space === only.space).map((p) => ({ ...p, patch: sectionOf(p.patch, only.path) })).filter((p) => p.patch);
    if (!patches.length) return void vscode.window.showInformationMessage(`${what}：没有读到改动（工作区可能已经释放，或这个决定还没有提交）`);
    return this.tasks.showPatches(only ? `${only.path}（${what}）` : what, d.work.rootId, patches, true);
  }
}

/** One file's section of a unified diff (by its new path, else its old one). */
export function sectionOf(patch: string, path: string): string {
  return patch.split(/^(?=diff --git )/m).filter((s) => {
    const plus = /^\+\+\+ b\/(.+?)\t?$/m.exec(s)?.[1];
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(s);
    return (plus ?? head?.[2] ?? head?.[1]) === path;
  }).join("");
}

function decisionText(d: Decision, change?: Change) {
  const md = new vscode.MarkdownString(`**${d.id} ${d.title}**（${KIND[d.kind]}）\n\n`);
  for (const [key, label] of FIELDS[d.kind]) if (d.fields[key]?.brief) md.appendMarkdown(`- **${label}**：${d.fields[key].brief}\n`);
  for (const r of d.rejected ?? []) md.appendMarkdown(`- 不选：${r.text}（${r.why}）\n`);
  if (d.question) md.appendMarkdown(`\n**要你定**：${d.question.text}${d.question.answer ? `\n\n你的回答：${d.question.answer}` : ""}\n`);
  if (d.after?.done) md.appendMarkdown(`\n**做了没有**：${DONE[d.after.done]}\n`);
  if (d.after?.deviation) md.appendMarkdown(`\n**和方案的偏差**：${d.after.deviation}\n`);
  if (d.after?.simpler) md.appendMarkdown(`\n**更简单的做法**：${d.after.simpler}\n`);
  if (change?.tasks.length) md.appendMarkdown(`\n修改项：${change.tasks.map((t) => `T${t.seq} ${t.title}`).join("；")}\n`);
  return md;
}
