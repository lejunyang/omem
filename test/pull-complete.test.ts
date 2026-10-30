import { execFileSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { cleanupFetched, fetchRemote, mergeLibrary, overwriteLocal, snapshotStream, type Fetched } from "../src/core/pull.ts";
import { pullTables } from "../src/core/pull-data.ts";
import { createSpace, getSpace } from "../src/core/spaces.ts";
import { remember } from "../src/memory/store.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

async function snapshot(app: App): Promise<Fetched> {
  const dir = mkdtempSync(join(tmpdir(), "omem-snap-test-"));
  const archive = join(dir, "snapshot.tar");
  await pipeline(await snapshotStream(app), createWriteStream(archive));
  execFileSync("tar", ["-xf", "snapshot.tar"], { cwd: dir });
  rmSync(archive);
  return { dbDir: dir, libraryDir: join(dir, "library"), filesDir: join(dir, "files"), fetchedFiles: readdirSync(join(dir, "files")) };
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), "omem-repo-test-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(root, "app.txt"), "base\n");
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  git(root, ["branch", "feature/demo"]);
  return root;
}

describe("complete portable pulls", () => {
  it("accounts for every business table explicitly", () => {
    const app = testApp();
    const derived = new Set(["chunks", "symbols", "code_refs", "pages", "page_rowids", "page_links", "page_cites", "page_aliases", "memory_rowids", "req_rowids"]);
    const device = new Set(["kv", "api_tokens", "lark_cursors", "pull_aliases", "lark_meetings", "lark_meeting_lines", "shares", "source_note_hits", "lark_kb_reads"]);
    const covered = new Set(["spaces", "sources", "lark_people", ...pullTables.map((t) => t.name)]);
    const tables = all<{ name: string }>(app.db, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%' and name not like 'memory_fts%'");
    expect(tables.map((t) => t.name).filter((n) => !derived.has(n) && !device.has(n) && !covered.has(n))).toEqual([]);
  });

  it("merges forked chats, relocates remote citations and structured lines without renumbering local lines", async () => {
    const local = testApp();
    const remote = testApp();
    const a = appendToSource(local, { spaceId: "personal", kind: "chat", uri: "chat:demo", title: "讨论", lines: ["共同消息", "本地消息"] });
    const b = appendToSource(remote, { spaceId: "personal", kind: "chat", uri: "chat:demo", title: "讨论", lines: ["共同消息", "远端消息"] });
    const memory = remember(remote, { spaceId: "personal", kind: "fact", content: "发布在周五", sourceRefs: [`src:${b.id}#L2`] });
    run(remote.db, "insert into source_notes(source_id,line_start,line_end,kind,note,created_at) values(?,2,2,'key','关键依据','2026-01-01')", b.id);
    run(remote.db, "insert into lark_messages(message_id,chat_id,create_ms,source_id,line) values('msg_remote','chat_demo',1,?,2)", b.id);
    run(remote.db, "insert into cards(id,space_id,front,back,state,due_at,created_at) values('card_demo','personal',?,'123456789012345678901234567890','{}','2026-01-01','2026-01-01')", `[依据](src:${b.id}#L2)`);
    writePage(remote, "personal", "chat", { meta: { title: "讨论" }, body: `[依据](src:${b.id}#L2)` });
    const f = await snapshot(remote);
    try {
      mergeLibrary(local, f, { dryRun: true });
      mergeLibrary(local, f);
      expect(one<{ text: string }>(local.db, "select text from sources where id = ?", a.id)!.text).toBe("共同消息\n本地消息\n远端消息");
      expect(one<{ source_refs: string }>(local.db, "select source_refs from memories where id = ?", memory.id)!.source_refs).toContain(`src:${a.id}#L3`);
      expect(one(local.db, "select source_id,line_start,line_end from source_notes")).toMatchObject({ source_id: a.id, line_start: 3, line_end: 3 });
      expect(one(local.db, "select source_id,line from lark_messages")).toMatchObject({ source_id: a.id, line: 3 });
      expect(one(local.db, "select front,back from cards where id='card_demo'")).toMatchObject({ front: `[依据](src:${a.id}#L3)`, back: "123456789012345678901234567890" });
      expect(readFileSync(join(local.libraryDir, "personal/wiki/chat.md"), "utf8")).toContain(`src:${a.id}#L3`);
      mergeLibrary(local, f);
      expect(all(local.db, "select * from source_notes")).toHaveLength(1);
      expect(one<{ text: string }>(local.db, "select text from sources where id = ?", a.id)!.text.split("\n")).toHaveLength(3);
    } finally { cleanupFetched(f); }
  });

  it("keeps independently allocated annotation and finding IDs, follows merged findings and later decisions", async () => {
    const local = testApp();
    const remote = testApp();
    const sources = [local, remote].map((app) => upsertSource(app, { spaceId: "personal", kind: "doc", uri: "plan.md", title: "计划", text: "正文" }));
    const runs = [local, remote].map((app) => createRun(app, { kind: "code", spaceId: "personal", title: "评审" }));
    for (const [i, app] of [local, remote].entries()) {
      run(app.db, "insert into reviews(id,code_run_id,check_name,verdict,created_at) values(?,?,'functional','changes','2026-01-01')", `review_${i}`, runs[i].id);
      run(app.db, "insert into review_findings(review_id,severity,title) values(?,'P2',?)", `review_${i}`, `问题 ${i}`);
      run(app.db, "insert into source_notes(source_id,kind,note,created_at) values(?,'key',?,'2026-01-01')", sources[i].id, `标注 ${i}`);
    }
    run(remote.db, "insert into review_findings(review_id,severity,title,merged_into,state) values('review_1','P2','重复问题',1,'merged')");
    run(remote.db, "update runs set output = ?, status = 'done', finished_at = '2026-01-02' where id = ?", JSON.stringify({ reviewLead: { rulings: [{ id: 2, decision: "merge", into: 1 }] } }), runs[1].id);
    let f = await snapshot(remote);
    try { mergeLibrary(local, f); } finally { cleanupFetched(f); }
    const findings = all<{ id: number; title: string; merged_into: number | null }>(local.db, "select id,title,merged_into from review_findings");
    const first = findings.find((r) => r.title === "问题 1")!;
    const merged = findings.find((r) => r.title === "重复问题")!;
    expect(findings).toHaveLength(3);
    expect(merged.merged_into).toBe(first.id);
    expect(all(local.db, "select * from source_notes")).toHaveLength(2);
    expect(JSON.parse(one<{ output: string }>(local.db, "select output from runs where id = ?", runs[1].id)!.output).reviewLead.rulings).toEqual([{ id: merged.id, decision: "merge", into: first.id }]);
    await new Promise((r) => setTimeout(r, 10));
    run(remote.db, "update review_findings set decision = 'wontfix', decision_note = '保持现有行为' where id = 1");
    f = await snapshot(remote);
    try {
      mergeLibrary(local, f);
      expect(one(local.db, "select decision,decision_note from review_findings where id = ?", first.id)).toMatchObject({ decision: "wontfix", decision_note: "保持现有行为" });
      mergeLibrary(local, f);
      expect(all(local.db, "select * from review_findings")).toHaveLength(3);
    } finally { cleanupFetched(f); }
  });

  it("does not cancel a local job when the peer has a copy of its ID", async () => {
    const local = testApp();
    const remote = testApp();
    const active = createRun(local, { kind: "heartbeat", title: "本地任务" });
    const copied = createRun(remote, { kind: "heartbeat", title: "远端副本" });
    run(remote.db, "update runs set id = ? where id = ?", active.id, copied.id);
    const f = await snapshot(remote);
    try {
      mergeLibrary(local, f);
      expect(one(local.db, "select status,title from runs where id = ?", active.id)).toMatchObject({ status: "queued", title: "本地任务" });
    } finally { cleanupFetched(f); }
  });

  it("accepts a later remote completion and answer after cancelling their imported pending copies", async () => {
    const local = testApp();
    const remote = testApp();
    const job = createRun(remote, { kind: "heartbeat", title: "巡检" });
    run(remote.db, "update runs set created_at='2026-01-01' where id=?", job.id);
    run(remote.db, "insert into asks(id,run_id,kind,created_at) values('question_demo',?,'question','2026-01-01')", job.id);
    run(remote.db, "update asks set sync_updated_at='2026-01-01' where id='question_demo'");
    let f = await snapshot(remote);
    try {
      mergeLibrary(local, f);
      expect(one(local.db, "select status from runs where id=?", job.id)).toMatchObject({ status: "cancelled" });
      expect(one(local.db, "select status from asks where id='question_demo'")).toMatchObject({ status: "cancelled" });
    } finally { cleanupFetched(f); }
    run(remote.db, "update runs set status='done',finished_at='2026-01-02',output='{}' where id=?", job.id);
    run(remote.db, "update asks set status='answered',answer='周五',sync_updated_at='2026-01-02' where id='question_demo'");
    f = await snapshot(remote);
    try {
      mergeLibrary(local, f);
      expect(one(local.db, "select status from runs where id=?", job.id)).toMatchObject({ status: "done" });
      expect(one(local.db, "select status,answer from asks where id='question_demo'")).toMatchObject({ status: "answered", answer: "周五" });
    } finally { cleanupFetched(f); }
  });

  it("imports rules, schedules, quality and routing data, while keeping new execution disabled", async () => {
    const local = testApp();
    const remote = testApp();
    const a = upsertSource(local, { spaceId: "personal", kind: "doc", uri: "rules.md", title: "约定", text: "约定" });
    const b = upsertSource(remote, { spaceId: "personal", kind: "doc", uri: "rules.md", title: "约定", text: "约定" });
    run(remote.db, "insert into rules(id,name,description,trigger,actions,enabled,created_at,updated_at) values('rule_demo','示例规则','检查新材料','{}','[]',1,'2026-01-01','2026-01-01')");
    run(remote.db, "insert into schedules(id,kind,cron,enabled) values('custom','heartbeat','0 * * * *',1)");
    run(remote.db, "insert into archive_rules(id,body) values('archive_demo','{}')");
    run(remote.db, "insert into attention_rules(id,body) values('attention_demo','{}')");
    run(remote.db, "insert into memory_rejections(id,space_id,tool,kind,content,at) values('reject_demo','personal','remember','fact','被退回的写入','2026-01-01')");
    run(remote.db, "insert into shadow_writes(id,run_id,tool,at) values('shadow_demo','run_demo','remember','2026-01-01')");
    run(remote.db, "insert into source_routes(source_id,origin_space,mode,reason) values(?,'personal','manual','本人指定') on conflict(source_id) do update set mode='manual',reason='本人指定'", b.id);
    const f = await snapshot(remote);
    try {
      mergeLibrary(local, f);
      expect(one(local.db, "select enabled,description from rules where id='rule_demo'")).toMatchObject({ enabled: 0, description: "检查新材料" });
      expect(one(local.db, "select enabled from schedules where id='custom'")).toMatchObject({ enabled: 0 });
      expect(one(local.db, "select source_id,mode from source_routes where source_id=?", a.id)).toMatchObject({ source_id: a.id, mode: "manual" });
      for (const table of ["archive_rules", "attention_rules", "memory_rejections", "shadow_writes"]) expect(all(local.db, `select * from ${table}`)).toHaveLength(1);
      mergeLibrary(local, f);
      for (const table of ["rules", "archive_rules", "attention_rules", "memory_rejections", "shadow_writes"]) expect(all(local.db, `select * from ${table}`)).toHaveLength(1);
    } finally { cleanupFetched(f); }
  });

  it("rolls back an overwrite when restoring repositories fails", async () => {
    const local = testApp();
    const remote = testApp();
    remember(local, { spaceId: "personal", kind: "fact", content: "原来的记忆" });
    writeFileSync(join(local.filesDir, "original.txt"), "keep");
    createSpace(remote, { id: "demo", name: "示例", kind: "repo", rootPath: repo() });
    const f = await snapshot(remote);
    const manifestPath = join(f.dbDir, "pull-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.repositories[0].key = "../outside";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    local.db.close();
    try {
      expect(() => overwriteLocal(local.home, f)).toThrow(/标识不合法/);
      const recovered = App.open(local.home);
      try { expect(one(recovered.db, "select content from memories")).toMatchObject({ content: "原来的记忆" }); }
      finally { recovered.db.close(); }
      expect(readFileSync(join(local.filesDir, "original.txt"), "utf8")).toBe("keep");
    } finally { cleanupFetched(f); }
  });

  it("restores branches, staged/unstaged/untracked files and linked worktrees, without hooks or ignored files", async () => {
    const local = testApp();
    const remote = testApp();
    const root = repo();
    createSpace(remote, { id: "demo", name: "示例仓库", kind: "repo", rootPath: root });
    writeFileSync(join(root, "app.txt"), "staged\n");
    git(root, ["add", "app.txt"]);
    writeFileSync(join(root, "app.txt"), "unstaged\n");
    writeFileSync(join(root, "new.txt"), "new\n");
    mkdirSync(join(root, "ignored"));
    writeFileSync(join(root, "ignored/secret.txt"), "local-only");
    writeFileSync(join(root, ".git/hooks/post-checkout"), "private hook");
    const job = createRun(remote, { kind: "code", spaceId: "demo", title: "改动" });
    const work = join(remote.runsDir, job.id, "work/demo");
    mkdirSync(join(remote.runsDir, job.id, "patches"), { recursive: true });
    git(root, ["worktree", "add", "-qb", "work/demo", work]);
    writeFileSync(join(work, "app.txt"), "worktree change\n");
    writeFileSync(join(remote.runsDir, job.id, "patches/demo.patch"), "patch data");
    run(remote.db, "update runs set status='done', output=? where id=?", JSON.stringify({ worktrees: [{ path: work, root }] }), job.id);
    const f = await snapshot(remote);
    try {
      mergeLibrary(local, f, { dryRun: true });
      expect(existsSync(join(local.home, "repos"))).toBe(false);
      mergeLibrary(local, f);
      const dest = getSpace(local, "demo").rootPath!;
      expect(dest).not.toBe(root);
      expect(readFileSync(join(dest, "app.txt"), "utf8")).toBe("unstaged\n");
      expect(git(dest, ["show", ":app.txt"]).stdout).toBe("staged\n");
      expect(git(dest, ["rev-parse", "feature/demo"]).ok).toBe(true);
      expect(readFileSync(join(dest, "new.txt"), "utf8")).toBe("new\n");
      expect(existsSync(join(dest, "ignored/secret.txt"))).toBe(false);
      expect(existsSync(join(dest, ".git/hooks/post-checkout"))).toBe(false);
      const out = JSON.parse(one<{ output: string }>(local.db, "select output from runs where id=?", job.id)!.output);
      expect(readFileSync(join(out.worktrees[0].path, "app.txt"), "utf8")).toBe("worktree change\n");
      expect(git(out.worktrees[0].path, ["rev-parse", "HEAD"]).ok).toBe(true);
      expect(readFileSync(join(local.runsDir, job.id, "patches/demo.patch"), "utf8")).toBe("patch data");
    } finally { cleanupFetched(f); }
  });

  it("preserves local repository changes and retains diverged remote branches and files", async () => {
    const local = testApp();
    const remote = testApp();
    const remoteRoot = repo();
    const localRoot = mkdtempSync(join(tmpdir(), "omem-local-repo-"));
    git(localRoot, ["clone", "-q", remoteRoot, "."]);
    createSpace(local, { id: "demo", name: "示例仓库", kind: "repo", rootPath: localRoot });
    createSpace(remote, { id: "demo", name: "示例仓库", kind: "repo", rootPath: remoteRoot });
    writeFileSync(join(localRoot, "app.txt"), "local change\n");
    writeFileSync(join(remoteRoot, "app.txt"), "remote change\n");
    git(remoteRoot, ["commit", "-qam", "remote commit"]);
    const f = await snapshot(remote);
    try {
      mergeLibrary(local, f);
      expect(getSpace(local, "demo").rootPath).toBe(localRoot);
      expect(readFileSync(join(localRoot, "app.txt"), "utf8")).toBe("local change\n");
      expect(git(localRoot, ["show", "refs/remotes/omem-pull/demo/main:app.txt"]).stdout).toBe("remote change\n");
      const saved = join(local.home, "repos/pulled", readdirSync(join(local.home, "repos/pulled"))[0]);
      expect(readFileSync(join(saved, "app.txt"), "utf8")).toBe("remote change\n");
    } finally { cleanupFetched(f); }
  });

  it("fast-forwards a clean existing checkout and restores checked-out submodules", async () => {
    const local = testApp();
    const remote = testApp();
    const root = repo();
    const sub = repo();
    expect(git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "libs/sub"]).ok).toBe(true);
    git(root, ["commit", "-qm", "add submodule"]);
    const localRoot = mkdtempSync(join(tmpdir(), "omem-fast-forward-"));
    // Byte-exact checkout on Windows too (a global autocrlf rewrites line ends).
    git(localRoot, ["clone", "-q", "-c", "core.autocrlf=false", root, "."]);
    createSpace(local, { id: "demo", name: "示例仓库", kind: "repo", rootPath: localRoot });
    createSpace(remote, { id: "demo", name: "示例仓库", kind: "repo", rootPath: root });
    writeFileSync(join(root, "app.txt"), "new commit\n");
    git(root, ["commit", "-qam", "new commit"]);
    const f = await snapshot(remote);
    try {
      mergeLibrary(local, f);
      // The uninitialised local submodule stays that way; the complete remote snapshot is independent.
      expect(git(localRoot, ["rev-parse", "HEAD"]).stdout).toBe(git(root, ["rev-parse", "HEAD"]).stdout);
      const saved = join(local.home, "repos/pulled", readdirSync(join(local.home, "repos/pulled"))[0]);
      expect(git(join(saved, "libs/sub"), ["rev-parse", "HEAD"]).stdout).toBe(git(sub, ["rev-parse", "HEAD"]).stdout);
      // The restored checkout follows this machine's line-end setting (autocrlf on Windows).
      expect(readFileSync(join(saved, "libs/sub/app.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
    } finally { cleanupFetched(f); }
  });

  // The fake ssh is a shell script on PATH, which Windows cannot run as "ssh".
  it.skipIf(process.platform === "win32")("SSH fetch includes a remote-only original and embedded media, and overwrite keeps every fetched file", () => {
    const local = testApp();
    const remote = testApp();
    upsertSource(remote, { spaceId: "personal", kind: "doc", uri: "report", title: "报告", text: "![图](/api/files/abcdef0123456789.png)", meta: { original: "report.pdf" } });
    writeFileSync(join(remote.filesDir, "report.pdf"), "document");
    writeFileSync(join(remote.filesDir, "abcdef0123456789.png"), "image");
    writeFileSync(join(local.filesDir, "report.pdf"), "document");
    run(local.db, "insert into api_tokens(token_hash,user_id,label,created_at) values('local_hash','owner','local','2026-01-01')");
    run(remote.db, "insert into api_tokens(token_hash,user_id,label,created_at) values('remote_hash','owner','remote','2026-01-01')");
    run(local.db, "insert or replace into kv(key,value) values('capture_demo','local cursor')");
    run(remote.db, "insert or replace into kv(key,value) values('capture_demo','remote cursor')");
    const bin = mkdtempSync(join(tmpdir(), "omem-ssh-test-"));
    writeFileSync(join(bin, "ssh"), '#!/bin/sh\nexec /bin/sh -c "$4"\n');
    chmodSync(join(bin, "ssh"), 0o755);
    const savedPath = process.env.PATH;
    let f: Fetched;
    try {
      process.env.PATH = `${bin}:${savedPath}`;
      f = fetchRemote(local, "fixture", remote.home);
    } finally { process.env.PATH = savedPath; }
    const home = local.home;
    local.db.close();
    try {
      const backup = overwriteLocal(home, f);
      expect(readFileSync(join(home, "files/report.pdf"), "utf8")).toBe("document");
      expect(readFileSync(join(home, "files/abcdef0123456789.png"), "utf8")).toBe("image");
      expect(readFileSync(join(backup, "files/report.pdf"), "utf8")).toBe("document");
      const after = App.open(home);
      try {
        expect(all(after.db, "select token_hash from api_tokens")).toEqual([{ token_hash: "local_hash" }]);
        expect(one(after.db, "select value from kv where key='capture_demo'")).toMatchObject({ value: "local cursor" });
      } finally { after.db.close(); }
    } finally { cleanupFetched(f); }
  });
});
