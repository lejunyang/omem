import { describe, expect, it } from "vitest";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { moveSource, sourceRoute } from "../src/sources/archive.ts";
import { aliasTarget } from "../src/sources/duplicates.ts";
import { kbHome, kbStrays, rehomeKb, setDirHome } from "../src/sources/kb-home.ts";
import { getSource, upsertSource } from "../src/sources/store.ts";
import { treeChildren } from "../src/sources/catalog.ts";
import { testApp } from "./helpers.ts";

const ORIGIN = "https://tenant.larkoffice.com";

/** A knowledge base filed under 项目 A, with a directory 结算 holding one page. */
function setup() {
  const app = testApp();
  createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
  createSpace(app, { id: "project-b", name: "项目 B", kind: "project" });
  run(app.db, "insert into wiki_spaces(id, name, status, target_space, discovered_at) values('kb1', '研发知识库', 'mapped', 'project-a', '2026-01-01')");
  run(app.db, "insert into wiki_nodes(token, wiki_space_id, parent_token, title) values('dir1', 'kb1', null, '结算'), ('n1', 'kb1', 'dir1', '对账流程'), ('n2', 'kb1', null, '发布规范')");
  return app;
}
const doc = (app: ReturnType<typeof testApp>, space: string, node: string, opts: { archive?: boolean; parent?: string; text?: string; docId?: string } = {}) =>
  upsertSource(app, {
    ...(opts.archive ? { archive: true } : {}), spaceId: space, kind: "doc", uri: `${ORIGIN}/wiki/${node}`, title: `文档 ${node}`, text: opts.text ?? `# ${node}\n正文`,
    meta: { via: "lark-cli", url: `${ORIGIN}/wiki/${node}`, wikiSpaceId: "kb1", wikiNodeToken: node, documentId: opts.docId ?? `d-${node}`, ...(opts.parent ? { wikiParentNodeToken: opts.parent } : {}) },
  }).id;

describe("a knowledge base's documents live in the space it is filed under", () => {
  it("automatic capture lands there whichever space it came through; a personal knowledge base has no such home", () => {
    const app = setup();
    // Linked in a chat of 项目 B, opened lately in the personal space: both go to 项目 A.
    const a = doc(app, "project-b", "n2", { archive: true });
    expect(getSource(app, a).spaceId).toBe("project-a");
    expect(sourceRoute(app, a)).toMatchObject({ mode: "binding", reason: expect.stringContaining("研发知识库") });
    const b = doc(app, "personal", "n1", { archive: true, parent: "dir1" });
    expect(getSource(app, b).spaceId).toBe("project-a");
    // The same document captured again through the other space is the same source.
    expect(doc(app, "personal", "n2", { archive: true, text: "# n2\n改过" })).toBe(a);

    run(app.db, "update wiki_spaces set target_space = 'personal' where id = 'kb1'");
    expect(kbHome(app, { wikiSpaceId: "kb1" })).toBeNull();
  });

  it("brings strays home: moves, merges into the copy already there, leaves what the owner moved by hand", async () => {
    const app = setup();
    const home = doc(app, "project-a", "n2");
    // Followed as a link from a document of 项目 B (stored without routing), before the rule existed.
    const dup = doc(app, "project-b", "n2", { text: "# n2\n另一份" });
    const stray = doc(app, "project-b", "n1", { parent: "dir1" });
    const mine = doc(app, "personal", "n3");
    moveSource(app, mine, "project-b", "这篇是项目 B 的");

    expect(kbStrays(app).map((s) => [s.id, s.action]).sort()).toEqual([[dup, "merge"], [mine, "keep"], [stray, "move"]].sort());
    expect(await rehomeKb(app)).toMatchObject({ dryRun: true, moved: 1, merged: 1, kept: 1 });
    expect(getSource(app, stray).spaceId).toBe("project-b");

    expect(await rehomeKb(app, { dryRun: false })).toMatchObject({ moved: 1, merged: 1, kept: 1, failed: [] });
    expect(getSource(app, stray).spaceId).toBe("project-a");
    expect(aliasTarget(app, dup)).toBe(home);
    expect(getSource(app, mine).spaceId).toBe("project-b");
    expect(kbStrays(app).filter((s) => s.action !== "keep")).toEqual([]);
  });

  it("a directory filed under another space takes what is below it", async () => {
    const app = setup();
    const under = doc(app, "project-a", "n1", { parent: "dir1" });
    const other = doc(app, "project-a", "n2");
    setDirHome(app, "dir1", "project-b");
    expect(kbHome(app, { wikiSpaceId: "kb1", wikiNodeToken: "n1", wikiParentNodeToken: "dir1" })).toMatchObject({ space: "project-b", dir: "dir1" });
    expect(kbHome(app, { wikiSpaceId: "kb1", wikiNodeToken: "n2" })).toMatchObject({ space: "project-a" });
    await rehomeKb(app, { dryRun: false });
    expect(getSource(app, under).spaceId).toBe("project-b");
    expect(getSource(app, other).spaceId).toBe("project-a");
    // The tree shows where the directory is filed.
    const kb = treeChildren(app, "project-b", "wiki:kb1").nodes;
    expect(kb.find((n) => n.key === "wn:dir1")).toMatchObject({ home: "project-b" });
    // Back to following the knowledge base.
    setDirHome(app, "dir1", null);
    await rehomeKb(app, { dryRun: false });
    expect(getSource(app, under).spaceId).toBe("project-a");
    expect(() => setDirHome(app, "dir1", "personal")).toThrow(/业务空间/);
  });
});
