import { describe, expect, it } from "vitest";
import { all, one } from "../src/core/db.ts";
import { getSpace, updateSpace } from "../src/core/spaces.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { staleDetail, writePage } from "../src/wiki/store.ts";
import { BATCH, PAGE_COOLDOWN_MS, pagesToCheck, runWikiUpkeep, SETTLE_MS, SPACE_GAP_MS, startWikiUpkeep, upkeepStatus } from "../src/wiki/upkeep.ts";
import { testApp } from "./helpers.ts";

type App = ReturnType<typeof testApp>;
const page = (app: App, slug: string, body: string, title = slug) => writePage(app, "personal", slug, { meta: { title, summary: title, kind: "guide" }, body }, { commit: false });
const doc = (app: App, uri: string, text: string) => upsertSource(app, { spaceId: "personal", kind: "doc", uri, title: uri, text });
const runs = (app: App, kind: string) => all<{ id: string; status: string; input: string; title: string }>(app.db, "select id, status, input, title from runs where kind = ? order by created_at", kind);
const later = (ms: number) => Date.now() + ms;

describe("automatic wiki upkeep", () => {
  it("checks a page after its cited original changed and settled, once, with a bounded batch", () => {
    const app = testApp();
    const ids = Array.from({ length: BATCH + 3 }, (_, i) => doc(app, `d${i}.md`, "v1\n").id);
    ids.forEach((id, i) => page(app, `docs/p${i}`, `[引](src:${id}#L1-L1)`));
    expect(runWikiUpkeep(app, later(SETTLE_MS * 2))).toEqual([]); // nothing changed yet

    ids.forEach((_, i) => doc(app, `d${i}.md`, "v2\n"));
    expect(staleDetail(app, "personal")).toHaveLength(BATCH + 3);
    // Just changed: it may still be edited.
    expect(pagesToCheck(app, "personal", later(SETTLE_MS / 2))).toEqual([]);
    expect(runWikiUpkeep(app, later(SETTLE_MS / 2))).toEqual([]);

    const made = runWikiUpkeep(app, later(SETTLE_MS + 1000));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: "wiki-lint", spaceId: "personal", pages: BATCH });
    const input = JSON.parse(runs(app, "wiki-lint")[0].input) as { pages: string[]; auto: boolean };
    expect(input.auto).toBe(true);
    expect(input.pages).toHaveLength(BATCH);

    // One check per space per gap, and none while one is queued or running.
    expect(runWikiUpkeep(app, later(SETTLE_MS + 2000))).toEqual([]);
    app.db.prepare("update runs set status = 'done' where kind = 'wiki-lint'").run();
    expect(runWikiUpkeep(app, later(SETTLE_MS + 2000))).toEqual([]);
    // After the gap the pages left over go next; the ones already looked at wait out their cooldown.
    const next = runWikiUpkeep(app, later(SPACE_GAP_MS + SETTLE_MS));
    expect(next).toHaveLength(1);
    expect(next[0].pages).toBe(3);
    expect(new Set([...input.pages, ...(JSON.parse(runs(app, "wiki-lint")[1].input) as { pages: string[] }).pages]).size).toBe(BATCH + 3);
    app.db.prepare("update runs set status = 'done' where kind = 'wiki-lint'").run();
    expect(runWikiUpkeep(app, later(SPACE_GAP_MS * 2 + SETTLE_MS))).toEqual([]); // all in cooldown
    expect(runWikiUpkeep(app, later(PAGE_COOLDOWN_MS + SPACE_GAP_MS * 2)).length).toBe(1); // still stale after a day: again
  });

  it("leaves chats that only grew alone, but not deleted ones, and respects the space setting", () => {
    const app = testApp();
    const chat = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_1", title: "群", lines: ["[10:00] 甲: 你好"] });
    page(app, "from-chat", `[聊](src:${chat.id}#L1-L1)`);
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_1", title: "群", lines: ["[10:01] 乙: 收到"] });
    expect(staleDetail(app, "personal")).toHaveLength(1);
    expect(pagesToCheck(app, "personal", later(SETTLE_MS * 4))).toEqual([]);
    app.db.prepare("update sources set deleted_at = ? where id = ?").run(new Date().toISOString(), chat.id);
    expect(pagesToCheck(app, "personal", later(SETTLE_MS * 4))).toEqual(["from-chat"]);

    const d = doc(app, "x.md", "a\n");
    page(app, "from-doc", `[x](src:${d.id}#L1-L1)`);
    doc(app, "x.md", "b\n");
    updateSpace(app, "personal", { settings: { ...getSpace(app, "personal").settings, autoLint: false } });
    expect(runWikiUpkeep(app, later(SETTLE_MS * 4)).filter((m) => m.kind === "wiki-lint")).toEqual([]);
  });

  it("asks for folder upkeep when pages sit at the top level, with a quiet period after a pass that moved nothing", () => {
    const app = testApp();
    for (let i = 0; i < 7; i++) page(app, `loose-${i}`, "x");
    const made = runWikiUpkeep(app, later(1000));
    expect(made.map((m) => m.kind)).toEqual(["wiki-organize"]);
    expect(runs(app, "wiki-organize")[0].title).toContain("7 页在顶层");
    expect(runWikiUpkeep(app, later(2000))).toEqual([]); // running
    app.db.prepare("update runs set status = 'done', output = ? where kind = 'wiki-organize'").run(JSON.stringify({ moved: 0 }));
    expect(runWikiUpkeep(app, later(8 * 3_600_000))).toEqual([]); // moved nothing: leave it for a week
    expect(runWikiUpkeep(app, later(8 * 86_400_000)).map((m) => m.kind)).toEqual(["wiki-organize"]);
    // Organized: nothing to do.
    const app2 = testApp();
    for (let i = 0; i < 7; i++) page(app2, `flows/p-${i}`, "x");
    expect(runWikiUpkeep(app2, later(1000))).toEqual([]);
  });

  it("reports what waits and when, and a source change arms one debounced check", async () => {
    const app = testApp();
    const d = doc(app, "y.md", "a\n");
    page(app, "py", `[y](src:${d.id}#L1-L1)`);
    expect(upkeepStatus(app, "personal")).toMatchObject({ auto: true, waiting: 0, lastCheck: null });
    doc(app, "y.md", "b\n");
    expect(upkeepStatus(app, "personal", later(SETTLE_MS + 1000))).toMatchObject({ waiting: 1, running: false });

    // The page is only picked up once the change has settled; here "settled" is a 0 ms debounce
    // and the original's change time is moved into the past.
    app.db.prepare("update sources set updated_at = ? where uri = 'y.md'").run(new Date(Date.now() - 2 * SETTLE_MS).toISOString());
    const stop = startWikiUpkeep(app, { debounceMs: 20, firstMs: 3_600_000, everyMs: 3_600_000 });
    doc(app, "z.md", "new\n");
    doc(app, "z.md", "newer\n");
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(runs(app, "wiki-lint")).toHaveLength(1);
    expect(one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'wiki-lint'")!.n).toBe(1);
  });
});
