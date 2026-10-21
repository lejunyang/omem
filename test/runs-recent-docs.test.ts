import { afterEach, describe, expect, it } from "vitest";
import { isQuiet } from "../src/agents/jobs.ts";
import { countRuns, createRun, listRuns } from "../src/agents/runs.ts";
import { all, run } from "../src/core/db.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { captureRecentDocs } from "../src/channels/lark-personal.ts";
import { testApp } from "./helpers.ts";

afterEach(() => setLarkCliForTests(null));

describe("run list filters", () => {
  it("takes several kinds and one agent spec's runs at once", () => {
    const app = testApp();
    createRun(app, { kind: "heartbeat", title: "巡检" });
    createRun(app, { kind: "ingest", title: "整理" });
    createRun(app, { kind: "agent", title: "分析报警", input: { spec: "alert-analyst" } });
    createRun(app, { kind: "agent", title: "写周报", input: { spec: "writer" } });
    const titles = (kind: string) => listRuns(app, { kind }).map((r) => r.title).sort();
    expect(titles("heartbeat,ingest")).toEqual(["巡检", "整理"]);
    expect(titles("agent:alert-analyst")).toEqual(["分析报警"]);
    expect(titles("agent:alert-analyst,heartbeat")).toEqual(["分析报警", "巡检"]);
    expect(titles("agent")).toEqual(["写周报", "分析报警"]);
    expect(countRuns(app, { kind: "agent:writer,ingest" })).toBe(2);
    app.db.close();
  });

  it("a background run that says a sentence before QUIET is quiet too", () => {
    expect(isQuiet("QUIET")).toBe(true);
    expect(isQuiet("看了 3 个事项，都没有新变化。QUIET")).toBe(true);
    expect(isQuiet("没有需要通知的。\n\n**QUIET**")).toBe(true);
    expect(isQuiet("发了一条通知：周报今天截止")).toBe(false);
    expect(isQuiet("QUIETLY")).toBe(false);
  });
});

describe("docs the owner opened lately", () => {
  it("reads each one once", async () => {
    const app = testApp();
    const ORIGIN = "https://tenant.larkoffice.com";
    const searches: string[][] = [];
    setLarkCliForTests(async (args) => {
      if (args[0] === "drive" && args[1] === "+search") {
        searches.push(args);
        return { ok: true, data: { has_more: false, results: [
          { title_highlighted: "<h>差旅</h>报销制度", result_meta: { url: `${ORIGIN}/docx/Travel`, doc_types: "DOCX" } },
          { title_highlighted: "项目 A 方案", result_meta: { url: `${ORIGIN}/wiki/PlanA`, doc_types: "WIKI" } },
        ] } };
      }
      if (args[0] === "docs" && args[1] === "+fetch") {
        const token = args[args.indexOf("--doc") + 1].split("/").pop()!;
        const title = token === "Travel" ? "差旅报销制度" : "项目 A 方案";
        return { ok: true, data: { document: { document_id: `doc_${token}`, revision_id: 1, content: `<title>${title}</title>\n正文 ${token}` } } };
      }
      if (args[0] === "wiki") return { ok: true, data: { node: { obj_type: "docx", obj_token: "PlanA", title: "项目 A 方案" } } };
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const touched = new Map<string, Set<string>>();
    expect(await captureRecentDocs(app, touched)).toBe(2);
    expect(searches[0]).toEqual(expect.arrayContaining(["--opened-since", "7d", "--sort", "open_time"]));
    expect(all<{ title: string }>(app.db, "select title from sources where kind != 'chat' order by title").map((s) => s.title)).toEqual(expect.arrayContaining(["差旅报销制度"]));
    expect(touched.get("personal")?.size).toBeGreaterThan(0);
    // Opened again later: not read again (the docs check keeps saved docs current).
    expect(await captureRecentDocs(app, new Map())).toBe(0);
    run(app.db, "delete from kv where key like 'lark_recent_doc:%'");
    app.db.close();
  });
});
