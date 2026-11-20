import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveSkill } from "../src/agents/specs.ts";
import { run } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { pendingActions, type PendingAction } from "../src/items/pending.ts";
import { workOverview } from "../src/items/work-http.ts";
import { testApp } from "./helpers.ts";

describe("pending actions", () => {
  const app = testApp();
  const at = "2026-05-03T01:00:00.000Z";
  let actions: PendingAction[];
  const via = (kind: PendingAction["via"]) => actions.filter(a => a.via === kind);
  beforeAll(async () => {
    createUser(app, { id: "member", name: "成员" });
    for (const [id, space, user, status, parent] of [
      ["line", "personal", "owner", "open", null], ["leaf", "personal", "owner", "candidate", "line"],
      ["theirs", "personal-member", "member", "candidate", null], ["revoked", "personal", "member", "candidate", null],
    ]) run(app.db, "insert into items(id,space_id,user_id,title,status,parent_id,kind,created_at,updated_at) values(?,?,?,?,?,?,'todo',?,?)", id, space, user, id, status, parent, at, at);
    for (const [id, user, item] of [["q", "owner", "leaf"], ["mine", "member", "theirs"], ["hidden", "member", "revoked"]])
      run(app.db, `insert into asks(id,user_id,kind,question,options,status,created_at,context) values(?,?,'question',?,'[]','pending',?,?)`, id, user, "**要确认**<b>吗</b>？ 下一句。\n\n理由", at, JSON.stringify({ handler: "item-follow", itemId: item }));
    run(app.db, `insert into asks(id,user_id,kind,question,options,status,created_at,context)
      values('hidden-line','member','question','建成工作线？','[]','pending',?,?)`, at,
      JSON.stringify({ handler: "line-propose", proposals: [{ items: ["revoked"] }] }));
    run(app.db, "insert into item_flows(item_id,flow_id,definition,started_at,started_by,updated_at) values('leaf','flow',?,?, 'owner',?)",
      JSON.stringify({ name: "验收", stages: [{ id: "a", name: "复核" }, { id: "b", name: "交付" }] }), at, at);
    for (const [id, ask] of [["a", "q"], ["b", null]]) {
      run(app.db, "insert into item_stages(item_id,stage_id,state,ask_id,since,updated_at) values('leaf',?,'gated',?,?,?)", id, ask, at, at);
      run(app.db, "insert into item_changes(id,item_id,at,type,summary,refs,run_id,status,ask_id,updated_at) values(?,'leaf',?,'note','有变化','[]','','asked',?,?)", id, at, ask, at);
    }
    for (const [id, item] of [["m1", "line"], ["m2", "leaf"]])
      run(app.db, "insert into metrics(id,name,item_id,status,created_at,updated_at) values(?,?,?,'proposed',?,?)", id, id, item, at, at);
    run(app.db, "insert into metrics(id,name,space_id,status,created_at,updated_at) values('private','自己的指标','personal-member','proposed',?,?)", at, at);
    const recentDraft = new Date(Date.now() - 86_400_000).toISOString();
    const oldDraft = new Date(Date.now() - 3 * 86_400_000).toISOString();
    run(app.db, "insert into card_interactions(id,purpose,created_at) values('old-draft','draft',?)", oldDraft);
    for (const purpose of ["draft", "mention-reply", "watch-draft", "meeting-answer", "draft"]) {
      run(app.db, "insert into card_interactions(id,purpose,created_at) values(lower(hex(randomblob(8))),?,?)", purpose, recentDraft);
    }
    for (const id of ["a", "b"])
      run(app.db, "insert into profile_proposals(id,target,kind,title,body,created_at) values(?,'assistant','prompt','调整','{}',?)", id, at);
    saveSkill(app, { name: "example", description: "示例", body: "读材料", status: "draft" });
    for (const [id, user, item, space] of [["u", "owner", "leaf", "personal"], ["secret", "member", "theirs", "personal"]])
      run(app.db, "insert into item_update_proposals(id,item_id,user_id,from_space,note,source_refs,created_at) values(?,?,?,?,'有进展','[]',?)", id, item, user, space, at);
    actions = await pendingActions(app, "owner");
  });
  afterAll(() => app.db.close());
  it("asks carry an answer link and first sentence", () => {
    expect(via("ask")).toMatchObject([{ id: "ask:q", title: "要确认吗？", askId: "q", href: "#/ui/q", lineTitle: "line" }]);
  });
  it("only stages without a listed ask need their own entry", () => {
    expect(via("stage")).toMatchObject([{ id: "stage:leaf:b", group: "work", lineId: "line" }]);
  });
  it("only the change named by the card is suppressed", () => {
    expect(via("change")).toMatchObject([{ id: "change:b", itemId: "leaf" }]);
  });
  it("keeps the unlinked change in the legacy work list alongside its sibling’s card", async () => {
    const { waiting, pending } = await workOverview(app, "owner");
    expect(waiting.changes.map(c => c.id)).toEqual(["b"]);
    expect(waiting.asks.map(a => a.id)).toEqual(["q"]);
    expect(waiting.total).toBe(pending.length);
  });
  it("includes owned candidates", () => expect(via("candidate")).toMatchObject([{ id: "candidate:leaf" }]));
  it("groups only the last two days of drafts by purpose", async () => {
    expect(via("draft")).toHaveLength(4);
    expect(via("draft")).toContainEqual(expect.objectContaining({ id: "draft:draft", count: 2 }));
    expect((await workOverview(app, "owner")).waiting.drafts).toBe(5);
  });
  it("groups metric proposals under their common root", () => expect(via("metric")).toMatchObject([{ id: "metric:line", lineTitle: "line", count: 2 }]));
  it("groups profile proposals", () => expect(via("profile")).toMatchObject([{ count: 2 }]));
  it("groups file-backed draft skills", () => expect(via("skill")).toMatchObject([{ count: 1, href: "#/agents?tab=skills" }]));
  it("includes cross-space update proposals", () => expect(via("item-update")).toMatchObject([{ id: "item-update:u", lineId: "line" }]));
  it("restricts ownership, item and originating space before projecting", async () => {
    expect((await pendingActions(app, "member")).map(a => a.id).sort()).toEqual(["ask:mine", "candidate:theirs", "metric:unassigned"]);
  });
});
