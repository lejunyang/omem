import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { createRun, getRun } from "../src/agents/runs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { createSpace, relateSpaces, updateSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { upsertSource } from "../src/sources/store.ts";
import { checkPageWrite, citeIssues, codeRefIssues, lostEntries, HARD_LENGTH, staleCodeIndexes, textLength } from "../src/wiki/checks.ts";
import { readPage, writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
createSpace(app, { id: "biz", name: "业务 A", kind: "project" });
createSpace(app, { id: "biz2", name: "业务 B", kind: "project" });
createSpace(app, { id: "repo", name: "后端仓库", kind: "repo" });
createSpace(app, { id: "wt", name: "交办分支", kind: "worktree" });
updateSpace(app, "wt", { settings: { repo: "repo" } });
createSpace(app, { id: "secret", name: "内部", kind: "project" });
relateSpaces(app, "biz", "repo", { origin: "owner" });
relateSpaces(app, "biz", "biz2", { origin: "owner" });
const src = (spaceId: string, uri: string, text: string, kind: "doc" | "code" = "doc") => upsertSource(app, { spaceId, kind, uri, title: uri, text }).id;
const rule = src("biz", "docs/退款规则.md", "第一行\n第二行\n第三行");
const mine = src("personal", "notes/退款规则.md", "第一行\n第二行\n第三行");
const branch = src("wt", "src/refund/apply.ts", "export function applyRefund() {\n  return 1;\n}\n", "code");
const code = src("repo", "src/refund/apply.ts", "export function applyRefund() {\n  return 1;\n}\n", "code");
const hidden = src("secret", "plan.md", "内部方案");
run(app.db, "insert into symbols(source_id,space_id,name,qname,kind,line_start,line_end,exported) values(?,?,?,?,?,?,?,1)", code, "repo", "applyRefund", "applyRefund", "function", 1, 3);
const page = (spaceId: string, slug: string, body: string, kind = "guide") => writePage(app, spaceId, slug, { meta: { title: slug, kind }, body }, { commit: false });
const agentCtx = (runId: string | null, spaceId = "biz") => toolContextForToken(app, issueToolToken({ runId, spaceId, spaces: null, tools: null, actor: "agent" }))!;
const doneRun = () => {
  const r = createRun(app, { kind: "ask", spaceId: "biz", title: "改首页" });
  run(app.db, "update runs set status = 'done' where id = ?", r.id);
  return r.id;
};

describe("entries a rewritten home or folder page loses", () => {
  for (const s of ["flows/refund", "flows/ship", "cases/a", "cases/b"]) page("biz", s, "正文");
  page("biz", "cases/index", "排查案例", "index");
  const before = "- [[flows/refund|退款]]\n- [[flows/ship|发货]]\n- [[cases/a]]\n- [[cases/b]]\n- [[gone]]";

  it("finds pages still there that the new text neither links nor reaches through a folder index", () => {
    const lost = lostEntries(app, "biz", "index", "index", before, "- [[flows/refund|退款]]\n- [[cases/index|排查案例]]");
    expect(lost.map((l) => l.slug)).toEqual(["flows/ship"]);
    // A page that is not a home or folder page may drop links.
    expect(lostEntries(app, "biz", "flows/refund", "guide", before, "")).toEqual([]);
  });

  it("write_page refuses the first time in a run, puts them back the second time, and at once outside a run", async () => {
    page("biz", "index", before, "index");
    const runId = doneRun();
    const args = { page: "index", title: "首页", kind: "index", summary: "s", body: "- [[flows/refund|退款]]" };
    const first = await callTool(agentCtx(runId), "write_page", args);
    expect(first.isError).toBe(true);
    expect(first.text).toContain("flows/ship");
    expect(readPage(app, "biz", "index").body).toContain("[[flows/ship");
    const second = await callTool(agentCtx(runId), "write_page", args);
    expect(second.isError, second.text).toBe(false);
    expect(second.text).toContain("已补在页尾");
    const body = readPage(app, "biz", "index").body;
    expect(body).toContain("## 其他页面");
    expect(body).toContain("[[flows/ship|flows/ship]]");
    expect(getRun(app, runId).output.writeChecks).toEqual({ rejected: { "lost-entries": 1 }, restored: 1 });
    // Outside a run nobody would see a refusal: they go back at once.
    page("biz", "cases/index", "排查案例", "index");
    page("biz", "cases/index", "- [[cases/a]]\n- [[cases/b]]", "index");
    const direct = await callTool(agentCtx(null), "write_page", { page: "cases/index", title: "排查案例", kind: "index", summary: "s", body: "- [[cases/a]]" });
    expect(direct.isError, direct.text).toBe(false);
    expect(readPage(app, "biz", "cases/index").body).toContain("[[cases/b|cases/b]]");
  });
});

describe("citations", () => {
  it("accepts a citation in the page's own space with lines that exist", () => {
    expect(citeIssues(app, "biz", `见 [规则](src:${rule}#L1-L3)`)).toEqual([]);
    // A personal page may cite the owner's personal notes.
    expect(citeIssues(app, "personal", `见 [笔记](src:${mine}#L1-L2)`)).toEqual([]);
  });

  it("turns away lines past the end, originals that are not there or were deleted", () => {
    expect(citeIssues(app, "biz", `[规则](src:${rule}#L2-L9)`)[0]).toMatchObject({ kind: "cite-range" });
    expect(citeIssues(app, "biz", `[x](src:s_nothere#L1)`)[0]).toMatchObject({ kind: "cite-missing" });
  });

  it("turns away personal and temporary branch originals on a shared page, pointing at the same one in the business space", () => {
    const personal = citeIssues(app, "biz", `[笔记](src:${mine}#L1-L2)`);
    expect(personal[0]).toMatchObject({ kind: "cite-unreachable" });
    expect(personal[0].text).toContain(`src:${rule}`);
    const fromBranch = citeIssues(app, "biz", `[代码](src:${branch}#L1-L3)`);
    expect(fromBranch[0].text).toContain("临时分支");
    expect(fromBranch[0].text).toContain(`src:${code}`);
  });

  it("turns away an original some readers of the page cannot open", () => {
    expect(citeIssues(app, "biz", `[方案](src:${hidden}#L1)`)).toEqual([]);
    createUser(app, { id: "xiaowang", name: "小王" });
    addMember(app, "biz", "xiaowang", "reader");
    expect(citeIssues(app, "biz", `[方案](src:${hidden}#L1)`)[0]).toMatchObject({ kind: "cite-unreachable" });
    addMember(app, "secret", "xiaowang", "reader");
    expect(citeIssues(app, "biz", `[方案](src:${hidden}#L1)`)).toEqual([]);
  });
});

describe("code named in plain text", () => {
  it("asks for a src: citation where the index has the file or the symbol", () => {
    const r = codeRefIssues(app, "biz", "退款入口在 src/refund/apply.ts:1-3，由 `applyRefund()` 处理。", ["biz", "repo"]);
    expect(r.issues.map((i) => i.kind)).toEqual(["plain-code", "plain-code"]);
    expect(r.issues[0].text).toContain(`src:${code}#L1-L3`);
    expect(r.issues[1].text).toContain("applyRefund");
  });

  it("leaves cited code, short words and code blocks alone, and reports what the index does not have", () => {
    const ok = codeRefIssues(app, "biz", `入口 [apply.ts:1](src:${code}#L1-L3) 里的 \`applyRefund\`，\`id\` 字段。\n\n\`\`\`\nsrc/refund/apply.ts:2\n\`\`\``, ["biz", "repo"]);
    expect(ok.issues).toEqual([]);
    expect(codeRefIssues(app, "biz", "见 lib/missing.go:12", ["biz", "repo"]).unresolved).toEqual(["lib/missing.go:12"]);
  });
});

describe("length and the same topic elsewhere", () => {
  it("turns away a page past the hard limit, not an index page", () => {
    const long = "这是一句话。".repeat(Math.ceil(HARD_LENGTH / 5));
    expect(textLength(long)).toBeGreaterThan(HARD_LENGTH);
    const base = { spaceId: "biz", title: "长", before: null, readable: null, restoreLost: false };
    expect(checkPageWrite(app, { ...base, slug: "flows/long", kind: "guide", body: long }).errors.map((e) => e.kind)).toContain("too-long");
    expect(checkPageWrite(app, { ...base, slug: "flows/index", kind: "index", body: long }).errors).toEqual([]);
  });

  it("tells the writer of a new page that a related space has one on the same topic", () => {
    page("biz2", "guides/refund-rules", "正文");
    run(app.db, "update pages set title = '退款规则' where id = 'biz2/guides/refund-rules'");
    const r = checkPageWrite(app, { spaceId: "biz", slug: "guides/refund", kind: "guide", title: "退款规则", body: "正文", before: null, readable: null, restoreLost: false });
    expect(r.notes.join("")).toContain("biz2:guides/refund-rules");
  });

  it("submit_plan asks why a page is written again here, and records topics linked instead", async () => {
    const plan = createRun(app, { kind: "wiki-plan", spaceId: "biz", title: "规划" });
    run(app.db, "update runs set status = 'done' where id = ?", plan.id);
    const ctx = agentCtx(plan.id);
    const p = { slug: "guides/refund", title: "退款规则", kind: "guide", question: "怎么退？", outline: "按一次退款讲", entry_points: [] };
    const refused = await callTool(ctx, "submit_plan", { pages: [p] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("biz2:guides/refund-rules");
    const ok = await callTool(ctx, "submit_plan", { pages: [{ ...p, overlap: { pages: ["biz2:guides/refund-rules"], decision: "write-here", reason: "本空间只讲 A 业务特有的退款入口" } }] });
    expect(ok.isError, ok.text).toBe(false);
    const linked = await callTool(ctx, "submit_plan", { pages: [], reuse: [{ topic: "退款规则", page: "biz2:guides/refund-rules", reason: "那边已经讲全" }] });
    expect(linked.text).toContain("1 个主题链接到相关空间");
    expect(getRun(app, plan.id).output.reuse).toHaveLength(1);
  });
});

describe("the code index", () => {
  it("finds a repository whose index is behind its checkout or was never built", () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-repo-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: dir });
    git("init", "-q");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-qm", "one");
    createSpace(app, { id: "repo2", name: "前端仓库", kind: "repo", rootPath: dir });
    expect(staleCodeIndexes(app, ["repo2"])[0].reason).toContain("还没有建过索引");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
    updateSpace(app, "repo2", { settings: { lastSync: "2026-10-19T00:00:00.000Z", commit: head } });
    expect(staleCodeIndexes(app, ["repo2"])).toEqual([]);
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    git("add", ".");
    git("commit", "-qm", "two");
    expect(staleCodeIndexes(app, ["repo2"])[0].reason).toContain("索引停在 2026-10-19");
  });
});
