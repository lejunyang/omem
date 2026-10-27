import * as vscode from "vscode";
import type { Api, Folder, Reviews, Run, RunAt } from "./api";

/**
 * The delegation this window works on: the one whose worktree (or applied target) is the open
 * folder, or the one picked in the run list. Its folders map review file paths to local files.
 */
export class Current {
  run: RunAt | null = null;
  folders: Folder[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly api: Api) {}

  /** Find the delegation of an open workspace folder. */
  async detect() {
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      // A folder on another machine than omem's is not one of its delegations.
      const path = this.api.conn.path(f.uri);
      if (!path) continue;
      const { runs } = await this.api.get<{ runs: RunAt[] }>(`/api/code-runs/at?folder=${encodeURIComponent(path)}`);
      if (runs[0]) return this.set(runs[0]);
    }
    await this.set(null);
  }

  /** Work on a delegation picked by id (any of its rounds). */
  async select(runId: string) {
    const { run } = await this.api.get<{ run: Run }>(`/api/runs/${runId}`);
    const rounds = run.kind === "code" ? (await this.api.get<Reviews>(`/api/runs/${runId}/reviews`)).rounds.map((r) => r.runId) : [run.id];
    const last = rounds.at(-1) ?? run.id;
    const lastRun = last === run.id ? run : (await this.api.get<{ run: Run }>(`/api/runs/${last}`)).run;
    await this.set({ id: lastRun.id, rounds, title: lastRun.title, status: lastRun.status, space: lastRun.spaceId, folder: lastRun.output.appliedAt ? "applied" : "work" });
  }

  /** A new round started from here (a fix): it becomes the one to follow. */
  async advance(next: Run) {
    if (!this.run) return;
    await this.set({ ...this.run, id: next.id, rounds: [...this.run.rounds, next.id], title: next.title, status: next.status });
  }

  async set(run: RunAt | null) {
    this.run = run;
    this.folders = run ? (await this.api.get<{ folders: Folder[] }>(`/api/runs/${run.id}/folders`)).folders : [];
    await vscode.commands.executeCommand("setContext", "omem.hasRun", !!run);
    this.changed.fire();
  }

  /** Whether a file is inside one of the delegation's folders. */
  contains(uri: vscode.Uri) {
    const at = this.api.conn.path(uri);
    if (!at) return false;
    const p = norm(at);
    return this.folders.some((f) => p.startsWith(norm(f.path) + "/") || p === norm(f.path));
  }

  /** Where a path from a review (relative; with several repositories, maybe prefixed by the space id) is here. */
  async resolve(file: string): Promise<vscode.Uri | null> {
    const rel = file.replace(/\\/g, "/").replace(/^\.?\//, "");
    const head = rel.split("/")[0];
    const at = (f: Folder, r: string) => {
      const root = this.api.conn.uri(f.path);
      return root ? [vscode.Uri.joinPath(root, r)] : [];
    };
    const candidates = [...this.folders.filter((f) => f.space === head).flatMap((f) => at(f, rel.slice(head.length + 1))), ...this.folders.flatMap((f) => at(f, rel))];
    for (const uri of candidates) {
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {}
    }
    return null;
  }

  /** A file's path as the delegation names it, for questions and fix points. */
  relative(uri: vscode.Uri) {
    const at = this.api.conn.path(uri);
    const p = at ? norm(at) : "";
    const f = at ? this.folders.find((x) => p.startsWith(norm(x.path) + "/")) : undefined;
    if (!at || !f) return vscode.workspace.asRelativePath(uri);
    // norm only changes case and slashes: the same length cuts the original.
    const rel = at.replace(/\\/g, "/").slice(norm(f.path).length + 1);
    return this.folders.length > 1 ? `${f.space}/${rel}` : rel;
  }
}

const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
