import * as vscode from "vscode";
import { STATUS, type Api, type Run } from "./api";
import type { Current } from "./current";

/** Recent delegations (first rounds), the current one marked; open its folder or follow it here. */
export class Runs implements vscode.TreeDataProvider<RunItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly api: Api, private readonly current: Current) {
    current.onDidChange(() => this.changed.fire());
  }

  refresh() {
    this.changed.fire();
  }

  getTreeItem(e: RunItem) {
    return e;
  }

  async getChildren(): Promise<RunItem[]> {
    try {
      const { runs } = await this.api.get<{ runs: Run[] }>("/api/runs?kind=code&limit=60");
      const firsts = runs.filter((r) => !r.input.continueFrom).slice(0, 30);
      const latest = new Map<string, Run>();
      for (const r of runs) {
        const root = String(r.input.continueFrom ?? r.id);
        if (!latest.has(root)) latest.set(root, r);
      }
      const here = this.current.run;
      return firsts.map((r) => new RunItem(latest.get(r.id) ?? r, !!here && here.rounds.includes(r.id)));
    } catch (e) {
      // Not connected: the view's welcome text says how to connect.
      if (!this.api.reachable) return [];
      const item = new RunItem(null, false);
      item.label = (e as Error).message;
      return [item];
    }
  }
}

export class RunItem extends vscode.TreeItem {
  constructor(readonly run: Run | null, here: boolean) {
    super(run ? run.title : "", vscode.TreeItemCollapsibleState.None);
    if (!run) {
      this.iconPath = new vscode.ThemeIcon("error");
      return;
    }
    const out = run.output;
    // A delegation on work branches is confirmed (pushed), not applied (docs/v2/ide.md).
    const confirmed = ((out.worktrees ?? []) as { commits?: boolean }[]).some((w) => w.commits);
    const state = out.appliedAt ? (confirmed ? "已确认" : "已应用") : out.discardedAt ? "已丢弃" : STATUS[run.status] ?? run.status;
    const round = (run.input as { round?: number }).round;
    this.description = `${here ? "● 当前 · " : ""}${round ? `第 ${round} 轮 · ` : ""}${state}${out.verdict ? ` · ${verdict(String(out.verdict))}` : ""}`;
    this.tooltip = `${run.title}\n${run.id} · ${new Date(run.createdAt).toLocaleString()}`;
    this.iconPath = new vscode.ThemeIcon(run.status === "running" ? "sync~spin" : run.status === "queued" ? "clock" : run.status === "failed" ? "error" : out.appliedAt ? "check-all" : "git-pull-request");
    const hasFolder = !out.discardedAt;
    this.contextValue = hasFolder ? "run-folder" : "run";
    this.command = { command: "omem.showRun", title: "看评审", arguments: [this] };
  }
}

function verdict(v: string) {
  return ({ approved: "评审通过", "changes-requested": "要修改", "awaiting-plan": "等确认评审计划", "no-changes": "没有改动", "sync-conflict": "同步冲突" } as Record<string, string>)[v] ?? v;
}
