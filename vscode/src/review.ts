import * as vscode from "vscode";
import { DECISION, SEVERITY, type Api, type Decision, type Finding, type Message, type Reviews, type Run } from "./api";
import type { Current } from "./current";

/**
 * Review findings as comment threads on the code, the owner's 改 / 暂不改 / 不改 on each, questions
 * asked in a thread on a selection, and fix points; the 修改单 view lists findings and fix points and
 * starts the fix (docs/v2/ide.md). Thread contextValue: `finding` / `finding-<decision>`, `draft`
 * (new, nothing sent), `asked`, `fixpoint`.
 */
type FindingThread = { finding: Finding; check: string; thread: vscode.CommentThread | null; uri: vscode.Uri | null };
type FixPoint = { thread: vscode.CommentThread; file: string; range: vscode.Range; quote: string; text: string };

const NOTE = "（关于交办运行";
const author = { name: "omem" };
const me = { name: "我" };
const comment = (body: string | vscode.MarkdownString, who = author, label?: string): vscode.Comment => ({ body, mode: vscode.CommentMode.Preview, author: who, label });

export class Workbench implements vscode.TreeDataProvider<Item> {
  readonly controller = vscode.comments.createCommentController("omem", "omem");
  findings: FindingThread[] = [];
  fixPoints: FixPoint[] = [];
  private readonly conversations = new WeakMap<vscode.CommentThread, string>();
  private readonly threadFinding = new WeakMap<vscode.CommentThread, FindingThread>();
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private generation = 0;

  constructor(private readonly api: Api, private readonly current: Current) {
    this.controller.options = { placeHolder: "问 omem，或写下要改什么", prompt: "就这段代码提问或记修改点" };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => (this.current.run && this.current.contains(doc.uri) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
    };
  }

  dispose() {
    this.controller.dispose();
  }

  // ---- findings ---------------------------------------------------------------------------------

  /** The latest round's findings, with what earlier rounds left as 暂不改; as threads on the code. */
  async load() {
    // Loads overlap (the folder is found, then a round finishes): only the latest one lands.
    const gen = ++this.generation;
    const run = this.current.run;
    const found: FindingThread[] = [];
    try {
      let data: Reviews | null = null;
      for (const id of run ? [...run.rounds].reverse() : []) {
        const r = await this.api.get<Reviews>(`/api/runs/${id}/reviews`);
        if (r.reviews.length) {
          data = r;
          break;
        }
      }
      const latest = data ? Math.max(...data.reviews.map((r) => r.round)) : 0;
      const live = (f: Finding) => f.merged_into === null && !["rejected", "merged"].includes(f.state);
      for (const rv of data?.reviews ?? []) {
        for (const f of rv.findings) {
          if (!live(f) || (rv.round !== latest && f.decision !== "later")) continue;
          found.push({ finding: f, check: data!.labels[rv.check_name] ?? rv.check_name, thread: null, uri: f.file_path ? await this.current.resolve(f.file_path) : null });
        }
      }
    } finally {
      if (gen === this.generation) this.show(found);
    }
  }

  private show(found: FindingThread[]) {
    for (const f of this.findings) f.thread?.dispose();
    for (const ft of found) {
      if (!ft.uri) continue;
      const line = Math.max(0, (ft.finding.line ?? 1) - 1);
      ft.thread = this.controller.createCommentThread(ft.uri, new vscode.Range(line, 0, line, 0), []);
      ft.thread.collapsibleState = ft.finding.severity === "blocker" || ft.finding.severity === "major" ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
      this.threadFinding.set(ft.thread, ft);
      this.render(ft);
    }
    const rank = { blocker: 0, major: 1, minor: 2, nit: 3 };
    this.findings = found.sort((a, b) => rank[a.finding.severity] - rank[b.finding.severity] || a.finding.id - b.finding.id);
    this.changed.fire(undefined);
  }

  private render(ft: FindingThread) {
    const f = ft.finding;
    if (!ft.thread) return;
    const d = f.decision ? `${DECISION[f.decision]}${f.decision_note ? `：${f.decision_note}` : ""}` : "未定";
    ft.thread.label = `#${f.id} [${SEVERITY[f.severity]}] ${f.title} · ${d}`;
    ft.thread.contextValue = f.decision ? `finding-${f.decision}` : "finding";
    // The thread's title already names it (number, severity, title, decision); the comment, under
    // the check's name, is what the reviewer said about it.
    const body = new vscode.MarkdownString(
      [f.detail, f.owner_suggestion ? `**建议（你改过）**：${f.owner_suggestion}` : f.suggestion && `**建议**：${f.suggestion}`, f.triage_note && `**评审负责人**：${f.triage_note}`]
        .filter(Boolean)
        .join("\n\n") || f.title,
    );
    const rest = ft.thread.comments.slice(1);
    ft.thread.comments = [comment(body, { name: ft.check }), ...rest];
  }

  findingOf(arg: unknown): FindingThread | undefined {
    if (arg instanceof FindingItem) return arg.ft;
    const thread = (arg as { thread?: vscode.CommentThread })?.thread ?? (arg as vscode.CommentThread);
    return thread ? this.threadFinding.get(thread) : undefined;
  }

  async decide(ft: FindingThread, decision: Decision | null) {
    let note: string | undefined;
    if (decision === "wontfix") {
      note = await vscode.window.showInputBox({ title: `不改 #${ft.finding.id}`, prompt: "业务上怎么定的？之后的评审不再提这个问题", ignoreFocusOut: true });
      if (!note?.trim()) return;
    }
    await this.api.put(`/api/runs/${this.current.run!.id}/findings/${ft.finding.id}`, { decision, ...(note ? { note } : {}) });
    ft.finding.decision = decision;
    ft.finding.decision_note = note ?? "";
    this.render(ft);
    this.changed.fire(undefined);
  }

  // ---- questions and fix points -----------------------------------------------------------------

  /** A thread on the selection, open for typing the question or the fix point. */
  startThread(editor: vscode.TextEditor) {
    const sel = editor.selection;
    const thread = this.controller.createCommentThread(editor.document.uri, new vscode.Range(sel.start.line, 0, sel.end.line, 0), []);
    thread.contextValue = "draft";
    // An empty thread gets VS Code's own delete button; ours is for threads with something in them.
    thread.label = "问 omem，或记为修改点";
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return thread;
  }

  private excerpt(thread: vscode.CommentThread) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
    const r = thread.range ?? new vscode.Range(0, 0, 0, 0);
    const text = doc ? doc.getText(new vscode.Range(r.start.line, 0, r.end.line, doc.lineAt(Math.min(r.end.line, doc.lineCount - 1)).text.length)) : "";
    const file = `${this.current.run ? this.current.relative(thread.uri) : vscode.workspace.asRelativePath(thread.uri)}:${r.start.line + 1}${r.end.line > r.start.line ? `-${r.end.line + 1}` : ""}`;
    return { file, text, range: r };
  }

  /**
   * Send the reply as a question; the answer comes back into the same thread. The command returns at
   * once (VS Code clears the reply box when it does) and the answer streams in: the thinking and the
   * tools it used folded above what it says.
   */
  ask(reply: vscode.CommentReply) {
    const thread = reply.thread;
    const question = reply.text.trim();
    if (!question) return;
    if (thread.contextValue === "draft") {
      thread.contextValue = "asked";
      thread.label = "问 omem";
    }
    thread.comments = [...thread.comments, comment(question, me)];
    void this.answer(thread, question);
  }

  private async answer(thread: vscode.CommentThread, question: string) {
    let shown = comment("思考中…");
    thread.comments = [...thread.comments, shown];
    const update = (body: string | vscode.MarkdownString) => {
      const next = comment(body);
      thread.comments = thread.comments.map((c) => (c === shown ? next : c));
      shown = next;
    };
    const { file, text } = this.excerpt(thread);
    const ft = this.threadFinding.get(thread);
    const run = this.current.run;
    const body = [
      question,
      ft ? `评审问题 #${ft.finding.id}（${ft.check}）：${ft.finding.title}\n\n${ft.finding.detail}` : "",
      `${file}：\n\n\`\`\`\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\``,
      run
        ? `${NOTE} ${run.id}「${run.title}」。需要时用 read_run 看这次交办的任务、改动和评审，用 read_source 或工作目录里的文件看代码；只回答，不要修改代码或续轮。）`
        : "（只回答，不要修改代码。）",
    ].filter(Boolean).join("\n\n");
    try {
      const before = this.conversations.get(thread);
      const r = await this.api.post<{ conversationId: string; runId?: string }>("/api/ask", { text: body, space: run?.space ?? undefined, conversationId: before });
      this.conversations.set(thread, r.conversationId);
      const answer = await this.follow(r.conversationId, r.runId, (live) => update(live));
      update(answer);
    } catch (e) {
      update(`没问成：${(e as Error).message}`);
    }
  }

  /**
   * Follow the answering run's events: thinking and tool calls go into a folded block, what it says
   * below; the final text is the conversation's reply once the run is over.
   */
  private async follow(conversationId: string, runId: string | undefined, live: (body: vscode.MarkdownString) => void) {
    const deadline = Date.now() + 15 * 60_000;
    let after = 0;
    let thought = "";
    let said = "";
    const tools: string[] = [];
    let ended = 0;
    const render = (final?: string) => {
      const steps = [thought.trim(), tools.length ? tools.map((t) => `- ${t}`).join("\n") : ""].filter(Boolean).join("\n\n");
      const md = new vscode.MarkdownString(
        [steps ? `<details><summary>${final === undefined ? "思考中…" : "思考过程"}</summary>\n\n${steps}\n\n</details>` : final === undefined ? "思考中…" : "", final ?? said].filter(Boolean).join("\n\n"),
      );
      md.supportHtml = true;
      return md;
    };
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      if (runId) {
        const { run, events } = await this.api.get<{ run: Run; events: { seq: number; type: string; data: { text?: string; title?: string; status?: string } }[] }>(`/api/runs/${runId}?after=${after}`);
        for (const e of events) {
          after = Math.max(after, e.seq);
          if (e.type === "thought") thought += e.data.text ?? "";
          else if (e.type === "text") said += e.data.text ?? "";
          else if (e.type === "tool" && e.data.title && e.data.status !== "completed" && e.data.status !== "failed") tools.push(e.data.title);
        }
        if (run.status === "queued" || run.status === "running") {
          live(render());
          continue;
        }
      }
      const { messages } = await this.api.get<{ messages: Message[] }>(`/api/conversations/${conversationId}`);
      const last = messages.at(-1);
      if (last?.role === "assistant") return render(last.text);
      if (runId && ++ended >= 3) throw new Error("这次回答没有完成，到网页的问答里看");
    }
    throw new Error("等了 15 分钟还没有回答，到网页的问答里看");
  }

  /**
   * Keep the reply as a fix point for the next round. On a finding's thread it says how to fix that
   * finding: the finding is marked 改 and the point goes along with it.
   */
  async fixPoint(reply: vscode.CommentReply) {
    const text = reply.text.trim();
    if (!text) return;
    const thread = reply.thread;
    const ft = this.threadFinding.get(thread);
    const { file, text: quote, range } = this.excerpt(thread);
    const existing = this.fixPoints.find((p) => p.thread === thread);
    if (existing) existing.text = `${existing.text}\n${text}`;
    else this.fixPoints.push({ thread, file, range, quote, text: ft ? `评审问题 #${ft.finding.id}（${ft.finding.title}）按这个改：${text}` : text });
    if (!ft) {
      thread.contextValue = "fixpoint";
      thread.label = "修改点";
    }
    thread.comments = [...thread.comments, comment(text, me, "修改点")];
    this.changed.fire(undefined);
    if (ft && ft.finding.decision !== "fix") await this.decide(ft, "fix");
  }

  deleteThread(arg: unknown) {
    const thread = arg instanceof FixPointItem ? arg.point.thread : ((arg as { thread?: vscode.CommentThread })?.thread ?? (arg as vscode.CommentThread));
    if (!thread) return;
    this.fixPoints = this.fixPoints.filter((p) => p.thread !== thread);
    // A finding's thread stays; only the fix point written in it goes.
    if (this.threadFinding.has(thread)) thread.comments = thread.comments.filter((c) => c.label !== "修改点");
    else thread.dispose();
    this.changed.fire(undefined);
  }

  /** The findings marked 改 and the fix points go to the coding Agent as the next round. */
  async startFix(given?: string): Promise<Run | null> {
    const run = this.current.run;
    if (!run) return null;
    const chosen = this.findings.filter((f) => f.finding.decision === "fix");
    const extra = given ?? await vscode.window.showInputBox({
      title: `开始修改：${chosen.length} 个问题，${this.fixPoints.length} 个修改点`,
      prompt: "还有什么要补充的（可以不填）。没选“改”的未定问题会记为暂不改",
      ignoreFocusOut: true,
    });
    if (extra === undefined) return null;
    const points = this.fixPoints.map((p, i) => `${i + 1}. ${p.file}：${p.text}\n\n\`\`\`\n${p.quote.replace(/```/g, "ˋˋˋ")}\n\`\`\``);
    const text = [points.length ? `代码里标出的修改点：\n\n${points.join("\n\n")}` : "", extra.trim()].filter(Boolean).join("\n\n");
    if (!chosen.length && !text) {
      void vscode.window.showWarningMessage("先把要改的问题标成“改”，或在代码上记修改点");
      return null;
    }
    const next = await this.api.post<Run>(`/api/runs/${run.id}/fix`, { findingIds: chosen.map((f) => f.finding.id), text: text || undefined });
    for (const p of this.fixPoints) if (!this.threadFinding.has(p.thread)) p.thread.dispose();
    this.fixPoints = [];
    this.changed.fire(undefined);
    return next;
  }

  // ---- the 修改单 view --------------------------------------------------------------------------

  getTreeItem(e: Item) {
    return e;
  }

  getChildren(e?: Item): Item[] {
    if (!this.current.run) return [];
    if (!e) {
      const groups: Item[] = [new GroupItem("findings", `评审问题（${this.findings.length}）`)];
      if (this.fixPoints.length) groups.push(new GroupItem("points", `修改点（${this.fixPoints.length}）`));
      return groups;
    }
    if (e instanceof GroupItem) return e.key === "findings" ? this.findings.map((f) => new FindingItem(f)) : this.fixPoints.map((p) => new FixPointItem(p));
    return [];
  }
}

type Item = GroupItem | FindingItem | FixPointItem;

class GroupItem extends vscode.TreeItem {
  constructor(readonly key: "findings" | "points", label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
  }
}

const DECISION_ICON: Record<Decision, string> = { fix: "tools", later: "clock", wontfix: "circle-slash" };
export class FindingItem extends vscode.TreeItem {
  constructor(readonly ft: FindingThread) {
    const f = ft.finding;
    super(`#${f.id} ${f.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${SEVERITY[f.severity]} · ${f.decision ? DECISION[f.decision] : "未定"}${f.file_path ? ` · ${f.file_path}${f.line ? `:${f.line}` : ""}` : ""}`;
    this.tooltip = new vscode.MarkdownString([`**${f.title}**`, f.detail, (f.owner_suggestion || f.suggestion) && `建议：${f.owner_suggestion || f.suggestion}`, `— ${ft.check}`].filter(Boolean).join("\n\n"));
    this.iconPath = new vscode.ThemeIcon(f.decision ? DECISION_ICON[f.decision] : f.severity === "blocker" || f.severity === "major" ? "warning" : "info");
    this.contextValue = f.decision ? `finding-${f.decision}` : "finding";
    if (ft.uri) this.command = { command: "omem.reveal", title: "转到代码", arguments: [ft.uri, Math.max(0, (f.line ?? 1) - 1), ft.thread] };
  }
}

export class FixPointItem extends vscode.TreeItem {
  constructor(readonly point: FixPoint) {
    super(point.text.split("\n")[0], vscode.TreeItemCollapsibleState.None);
    this.description = point.file;
    this.iconPath = new vscode.ThemeIcon("edit");
    this.contextValue = "fixpoint";
    this.command = { command: "omem.reveal", title: "转到代码", arguments: [point.thread.uri, point.range.start.line, point.thread] };
  }
}
