import { afterEach, expect, it } from "vitest";
import { captureChoice, pendingCapture } from "../src/auth/login.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { docCaptureOf, docSkipper, parseDocRule, setDocCapture } from "../src/channels/lark-doc-filter.ts";
import { captureRecentDocs } from "../src/channels/lark-personal.ts";
import { all, run } from "../src/core/db.ts";
import { createUser, OWNER } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

afterEach(() => setLarkCliForTests(null));
const ORIGIN = "https://tenant.larkoffice.com";

// A small Feishu: a personal library (LIB) with one page, a team base (TEAM) with 方案 → 细节, a folder with a doc.
const nodes: Record<string, { space_id: string; node_token: string; obj_token: string; obj_type: string; title: string; parent_node_token?: string }> = {
  Diary: { space_id: "LIB", node_token: "Diary", obj_token: "docDiary", obj_type: "docx", title: "我的日记" },
  PlanA: { space_id: "TEAM", node_token: "PlanA", obj_token: "docPlan", obj_type: "docx", title: "项目 A 方案" },
  Detail: { space_id: "TEAM", node_token: "Detail", obj_token: "docDetail", obj_type: "docx", title: "细节", parent_node_token: "PlanA" },
  Other: { space_id: "TEAM", node_token: "Other", obj_token: "docOther", obj_type: "docx", title: "差旅报销制度" },
};
function fakeLark(opened: string[]) {
  const fetched: string[] = [];
  setLarkCliForTests(async (args) => {
    if (args[0] === "drive" && args[1] === "+search")
      return { ok: true, data: { has_more: false, results: opened.map((u) => ({ result_meta: { url: `${ORIGIN}${u}`, doc_types: u.startsWith("/wiki") ? "WIKI" : "DOCX" } })) } };
    if (args[0] === "drive" && args[1] === "files") {
      const p = JSON.parse(args[args.indexOf("--params") + 1]);
      return { ok: true, data: { has_more: false, files: p.folder_token === "FolderPriv" ? [{ token: "Sub", type: "folder" }] : p.folder_token === "Sub" ? [{ token: "Secret", type: "docx" }] : [] } };
    }
    if (args[0] === "wiki" && args[1] === "+node-get") {
      const n = nodes[args[args.indexOf("--node-token") + 1]];
      if (!n) throw new Error("131014 not in wiki");
      return { ok: true, data: { node: n } };
    }
    if (args[0] === "wiki" && args[1] === "spaces") {
      const p = JSON.parse(args[args.indexOf("--params") + 1]);
      return { ok: true, data: { space: p.space_id === "my_library" ? { space_id: "LIB" } : { space_id: p.space_id, name: "团队知识库" } } };
    }
    if (args[0] === "docs" && args[1] === "+fetch") {
      const token = args[args.indexOf("--doc") + 1].split("/").pop()!;
      fetched.push(token);
      const title = nodes[token]?.title ?? token;
      return { ok: true, data: { document: { document_id: `doc_${token}`, revision_id: 1, content: `<title>${title}</title>\n正文 ${token}` } } };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return fetched;
}

it("认链接：文档、知识库页面、知识库首页、文件夹；别的不认", () => {
  expect(parseDocRule(`${ORIGIN}/docx/AbCdEf12?from=x`)).toEqual({ kind: "doc", token: "AbCdEf12", url: `${ORIGIN}/docx/AbCdEf12` });
  expect(parseDocRule(`${ORIGIN}/wiki/PlanA123`)?.kind).toBe("wiki");
  expect(parseDocRule(`${ORIGIN}/wiki/space/7000000001`)).toMatchObject({ kind: "space", token: "7000000001" });
  expect(parseDocRule(`${ORIGIN}/wiki/settings/7000000001`)).toMatchObject({ kind: "space", url: `${ORIGIN}/wiki/space/7000000001` });
  expect(parseDocRule(`${ORIGIN}/drive/folder/FolderPriv`)?.kind).toBe("folder");
  expect(parseDocRule(`${ORIGIN}/messenger/`)).toBeNull();
  expect(parseDocRule("javascript:alert(1)")).toBeNull();
});

it("成员默认跳过个人文档库，本人默认不跳；排除页面连同子页面、整个知识库、文件夹里的文档", async () => {
  const app = testApp();
  createUser(app, { id: "ann", name: "小安", role: "member" });
  expect(docCaptureOf(app, "ann")).toMatchObject({ on: true, skipLibrary: true, exclude: [] });
  expect(docCaptureOf(app, OWNER)).toMatchObject({ on: true, skipLibrary: false });
  fakeLark([]);
  const skip = docSkipper(app, "ann");
  expect(await skip(`${ORIGIN}/wiki/Diary`)).toBe("个人文档库");
  expect(await skip(`${ORIGIN}/wiki/Detail`)).toBeNull();
  expect(await skip(`${ORIGIN}/docx/Loose`)).toBeNull();

  await setDocCapture(app, OWNER, { add: `${ORIGIN}/wiki/PlanA` });
  await setDocCapture(app, OWNER, { add: `${ORIGIN}/drive/folder/FolderPriv` });
  const c = await setDocCapture(app, OWNER, { add: `${ORIGIN}/docx/docOther` });
  expect(c.exclude.map((r) => [r.kind, r.title ?? ""])).toEqual([["wiki", "项目 A 方案"], ["folder", ""], ["doc", ""]]);
  const own = docSkipper(app, OWNER);
  expect(await own(`${ORIGIN}/wiki/Detail`)).toBe("排除的知识库页面《项目 A 方案》");
  expect(await own(`${ORIGIN}/wiki/Other`)).toBe("排除的文档"); // the page of an excluded document
  expect(await own(`${ORIGIN}/docx/Secret`)).toBe("排除的文件夹"); // two folders down
  expect(await own(`${ORIGIN}/wiki/Diary`)).toBeNull();
  await setDocCapture(app, OWNER, { add: `${ORIGIN}/wiki/space/LIB` });
  expect(await docSkipper(app, OWNER)(`${ORIGIN}/wiki/Diary`)).toMatch(/^排除的知识库/);
  await expect(setDocCapture(app, OWNER, { on: false })).rejects.toThrow(/设置/);
  await expect(setDocCapture(app, OWNER, { add: `${ORIGIN}/messenger/` })).rejects.toThrow(/认不出/);
  const after = await setDocCapture(app, OWNER, { remove: "PlanA" });
  expect(after.exclude.some((r) => r.token === "PlanA")).toBe(false);
  app.db.close();
});

it("最近打开的文档：排除的不读、不占这一轮的名额，链过去的也不跟", async () => {
  const app = testApp();
  const fetched = fakeLark(["/wiki/PlanA", "/wiki/Detail", "/docx/Loose"]);
  await setDocCapture(app, OWNER, { add: `${ORIGIN}/wiki/PlanA` });
  expect(await captureRecentDocs(app, new Map())).toBe(1);
  expect(fetched).toEqual(["Loose"]);
  expect(all<{ title: string }>(app.db, "select title from sources where kind = 'doc'").map((s) => s.title)).toEqual(["Loose"]);
  run(app.db, "delete from kv where key like 'lark_recent_doc:%'");
  app.db.close();
});

it("登录页的选择：只对勾了的功能生效，授权回来时取一次", () => {
  expect(captureChoice("docs,group", ["messages", "docs"])).toEqual({ group: true, docs: true });
  expect(captureChoice("", ["messages", "messages-p2p", "docs"])).toEqual({ group: false, p2p: false, docs: false });
  expect(captureChoice("p2p", ["docs"])).toEqual({ docs: false });
  const app = testApp();
  run(app.db, "insert into kv(key,value) values('auth_capture:st1', ?)", JSON.stringify({ docs: false }));
  expect(pendingCapture(app, "st1")).toEqual({ docs: false });
  expect(pendingCapture(app, "st1")).toBeNull();
  app.db.close();
});
