import type { App } from "../core/app.ts";
import { designBodyAt, designCounts, designFeedback, designRevisions, type Design } from "./store.ts";
import { CONCERN_LEVELS, DECISION_FIELDS, KIND_LABELS, LEVEL_LABELS, ORIGIN_LABELS, STATE_LABELS, STATUS_LABELS, type Concern, type Decision, type DesignBody, type Table } from "./types.ts";

/**
 * A design as Markdown for an Agent to read (read_design, the designer's next version, coding and
 * review): facts, the overall behaviour table, gaps, concerns on the whole, then each decision with
 * its fields, rejected approaches, question and concerns. `brief`: one line per field (what a
 * collapsed card shows); `full`: the contract snippets and tables too.
 */
export function designMarkdown(app: App, design: Design, opts: { revision?: number; mode: "full" | "brief" }): string {
  const body = designBodyAt(app, design, opts.revision);
  const revision = opts.revision ?? design.revision;
  const full = opts.mode === "full";
  const head = [
    `# 方案 ${design.id}：${design.title}`,
    [
      ORIGIN_LABELS[design.origin],
      design.author ? `作者 ${design.author}` : "",
      STATUS_LABELS[design.status],
      revision ? `第 ${revision} 版${revision !== design.revision ? `（最新是第 ${design.revision} 版）` : ""}` : "还没有交过",
      design.itemId ? `事项 ${design.itemId}` : "",
      `空间 ${design.spaceId}`,
    ].filter(Boolean).join(" · "),
    design.sources.length ? `方案文档：${design.sources.join("、")}` : "",
    design.repos.length ? `仓库：${design.repos.join("、")}` : "",
    revision ? designLine({ ...design, body }) : "",
  ].filter(Boolean).join("\n\n");
  if (!revision) return head;
  const parts = [head];
  if (body.facts.length) parts.push(`## 影响方案的事实\n\n${body.facts.map((f) => `- ${f.text}${f.refs?.length ? `（${f.refs.join("、")}）` : ""}`).join("\n")}`);
  if (body.matrix) parts.push(`## 整体的行为表${body.matrix.title ? `：${body.matrix.title}` : ""}\n\n${tableMd(body.matrix)}`);
  if (body.gaps?.length) parts.push(`## 和要求不一致的地方\n\n${body.gaps.map((g) => `- ${g}`).join("\n")}`);
  if (body.concerns?.length) parts.push(`## 整体意见\n\n${concernsMd(body.concerns)}`);
  for (const d of body.decisions) parts.push(decisionMd(design, d, full));
  if (body.outside?.length) parts.push(`## 方案之外的改动\n\n${body.outside.map((f) => `- ${f}`).join("\n")}`);
  if (full && revision === design.revision) {
    const fb = design.origin === "own" ? designFeedback(app, design.id) : [];
    if (fb.length) parts.push(`## 对这一版的意见\n\n${fb.map((f) => `- ${f.action === "rethink" ? "换个思路" : f.action === "approve" ? "通过" : "提意见"}（${f.by}，${f.at.slice(0, 16).replace("T", " ")}）${f.text ? `：${f.text}` : ""}${Object.keys(f.answers).length ? `；回答：${Object.entries(f.answers).map(([k, v]) => `${k} → ${v}`).join("；")}` : ""}`).join("\n")}`);
    const revs = designRevisions(app, design.id);
    if (revs.length > 1) parts.push(`## 版本\n\n${revs.map((r) => `- 第 ${r.revision} 版 ${r.at.slice(0, 16).replace("T", " ")}${r.note ? `：${r.note}` : ""}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

function decisionMd(design: Design, d: Decision, full: boolean) {
  const lines = [`## ${d.id} [${KIND_LABELS[d.kind]}] ${d.title}`];
  const meta = [d.reqs.length ? `需求点：${d.reqs.join("、")}` : "", d.stated === false ? "文档没写，从代码推断出来的" : ""].filter(Boolean);
  if (meta.length) lines.push(meta.join("；"));
  for (const f of DECISION_FIELDS[d.kind]) {
    const v = d.fields[f.key];
    if (!v) {
      // Someone else's design leaving a field out is itself something to ask about.
      if (design.origin === "external") lines.push(`- **${f.label}**：（方案没写）`);
      continue;
    }
    lines.push(`- **${f.label}**：${v.brief}`);
    if (!full) continue;
    if (v.text) lines.push(indent(v.text));
    if (v.code) lines.push(indent(`\`\`\`${v.lang ?? ""}\n${v.code}\n\`\`\``));
    if (v.table) lines.push(indent(tableMd(v.table)));
  }
  if (d.rejected?.length) lines.push(`- **不选**：${d.rejected.map((r) => `${r.text}（${r.why}）`).join("；")}`);
  if (d.question) {
    const q = d.question;
    lines.push(`- **要你定**：${q.text}`);
    lines.push(indent(q.options.map((o, i) => `${i + 1}. ${o}${q.recommended === i ? "（建议）" : ""}`).join("\n")));
    if (q.answer) lines.push(indent(`本人的回答：${q.answer}`));
  }
  if (d.after && (d.after.deviation || d.after.simpler || d.after.done)) {
    if (d.after.done) lines.push(`- **做了没有**：${{ yes: "做了", partly: "部分", no: "没做" }[d.after.done]}`);
    if (d.after.deviation) lines.push(`- **偏差**：${d.after.deviation}`);
    if (d.after.simpler) lines.push(`- **更简单的做法**：${d.after.simpler}`);
  }
  if (d.files?.length) lines.push(`- **文件**：${d.files.join("、")}`);
  if (d.tasks?.length) lines.push(`- **修改项**：${d.tasks.map((t) => `T${t}`).join("、")}`);
  if (d.concerns?.length) lines.push(`\n意见：\n${concernsMd(d.concerns)}`);
  return lines.join("\n");
}

const indent = (s: string) => s.split("\n").map((l) => `  ${l}`).join("\n");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
function tableMd(t: Table) {
  const width = Math.max(t.head.length, ...t.rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")].map(cell);
  return [`| ${pad(t.head).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`, ...t.rows.map((r) => `| ${pad(r).join(" | ")} |`)].join("\n");
}
function concernsMd(cs: Concern[]) {
  return cs.map((c) => `- ${c.id} [${LEVEL_LABELS[c.level]}]${c.state !== "open" ? `（${STATE_LABELS[c.state]}${c.note ? `：${c.note}` : ""}）` : ""} ${c.text}${c.where?.length ? `；位置：${c.where.join("、")}` : ""}${c.refs?.length ? `；依据：${c.refs.join("、")}` : ""}${c.state === "open" && c.note ? `；${c.note}` : ""}`).join("\n");
}

/** One line for notifications and cards: “3 个决定，1 个要你定；问题 1 风险 2 改进 1 要问 3”. */
export function designLine(design: Pick<Design, "body">): string {
  const c = designCounts(design.body as DesignBody);
  const head = `${c.decisions} 个决定${c.questions ? `，${c.questions} 个要你定` : ""}`;
  const levels = CONCERN_LEVELS.filter((l) => c.concerns[l]).map((l) => `${LEVEL_LABELS[l]} ${c.concerns[l]}`).join(" ");
  return levels ? `${head}；${levels}` : head;
}
