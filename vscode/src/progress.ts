import * as vscode from "vscode";
import { STATUS, type Api, type Run, type RunEvent } from "./api";
import type { Current } from "./current";

/**
 * Following the current delegation while it runs: the status bar shows the round and state, and
 * an output channel the run's events (status lines, checks, the agents' text) as they come.
 * Finishing reloads the review.
 */
export class Progress {
  readonly output = vscode.window.createOutputChannel("omem 交办");
  private readonly bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private timer: NodeJS.Timeout | undefined;
  private seq = new Map<string, number>();
  private following: string | null = null;

  constructor(private readonly api: Api, private readonly current: Current, private readonly finished: () => void) {
    this.bar.command = "omem.showProgress";
    current.onDidChange(() => void this.follow());
  }

  dispose() {
    clearTimeout(this.timer);
    this.output.dispose();
    this.bar.dispose();
  }

  async follow() {
    clearTimeout(this.timer);
    const run = this.current.run;
    if (!run) return this.bar.hide();
    if (this.following !== run.id) {
      this.following = run.id;
      this.output.appendLine(`\n==== ${run.title}（${run.id}）====`);
    }
    await this.tick();
  }

  private async tick() {
    const run = this.current.run;
    if (!run) return;
    try {
      const after = this.seq.get(run.id) ?? 0;
      const r = await this.api.get<{ run: Run; events: RunEvent[] }>(`/api/runs/${run.id}?after=${after}`);
      for (const e of r.events) this.print(e);
      if (r.events.length) this.seq.set(run.id, r.events.at(-1)!.seq);
      const round = (r.run.input as { round?: number }).round ?? run.rounds.indexOf(run.id) + 1;
      const active = ["queued", "running"].includes(r.run.status);
      this.bar.text = `${active ? "$(sync~spin)" : "$(git-pull-request)"} omem 第 ${round} 轮 · ${STATUS[r.run.status] ?? r.run.status}`;
      this.bar.tooltip = `${r.run.title}\n点开看过程`;
      this.bar.show();
      const was = run.status;
      run.status = r.run.status;
      if (active) this.timer = setTimeout(() => void this.tick(), 3000);
      else if (["queued", "running"].includes(was)) this.finished();
    } catch (e) {
      this.bar.text = "$(warning) omem";
      this.bar.tooltip = (e as Error).message;
      this.bar.show();
      this.timer = setTimeout(() => void this.tick(), 15000);
    }
  }

  private print(e: RunEvent) {
    const d = e.data as { text?: string; phase?: string; check?: string; title?: string; status?: string; command?: string; code?: number };
    const who = d.check ?? d.phase;
    if (e.type === "status" && d.text) this.output.appendLine(`· ${who ? `[${who}] ` : ""}${d.text}`);
    else if (e.type === "check") this.output.appendLine(`· 检查 ${d.command}：${d.code === 0 ? "通过" : `退出码 ${d.code}`}`);
    else if (e.type === "tool" && d.title && d.status !== "in_progress") this.output.appendLine(`  ${who ? `[${who}] ` : ""}${d.title}`);
    else if (e.type === "text" && d.text) this.output.append(d.text);
  }
}
