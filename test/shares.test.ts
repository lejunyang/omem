import { afterEach, describe, expect, it } from "vitest";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { listShares, readShare, revokeShare } from "../src/core/shares.ts";
import { resolveCardCitations, resolveCitations, resolveCitationsNow } from "../src/channels/citations.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { remember } from "../src/memory/store.ts";
import { upsertSource } from "../src/sources/store.ts";
import { writePage } from "../src/wiki/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

afterEach(() => setLarkCliForTests(null));

const CHAT = "oc_demo1";
const tokenOf = (md: string) => /#\/share\/([A-Za-z0-9_-]{43})/.exec(md)?.[1] ?? null;

function fixture() {
  const app = testApp();
  app.config.webUrl = "https://omem.example.test/";
  const code = upsertSource(app, { spaceId: "personal", kind: "code", uri: "src/refund.ts", title: "src/refund.ts", text: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") });
  const work = upsertSource(app, { spaceId: "personal", kind: "work", uri: "work/investigations/refund", title: "退款排查", text: "# 退款排查\n结论见下\n| 时间 | 状态 |\n| --- | --- |\n| 10:00 | 失败 |\n| 10:05 | 成功 |\n依据 [原话](src:abc123def#L1) 和 mem:m0abcdefgh" });
  const doc = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "https://tenant.larkoffice.com/docx/Guide", title: "退款说明", text: "申请后需确认" });
  const chat = upsertSource(app, { spaceId: "personal", kind: "chat", uri: `lark:${CHAT}`, title: "退款改造群", text: "[2026-10-29 09:00] 小王: 退款失败了 (om_a1)\n[2026-10-29 09:01] 小李: 我看看 (om_a2)" });
  run(app.db, "insert into lark_messages(message_id, chat_id, content, create_ms, source_id, line, position) values('om_a1', ?, '退款失败了', 1, ?, 1, 41)", CHAT, chat.id);
  run(app.db, "insert into lark_messages(message_id, chat_id, content, create_ms, source_id, line) values('om_a2', ?, '我看看', 2, ?, 2)", CHAT, chat.id);
  const mem = remember(app, { spaceId: "personal", kind: "fact", content: "退款失败多半是渠道超时，见 [记录](src:abc123def#L2)", sourceRefs: [] });
  run(app.db, "insert into runs(id, kind, space_id, status, title, created_at, user_id) values('r_owner', 'ask', 'personal', 'done', '问答', '2026-10-29T10:00:00Z', 'owner')");
  return { app, code, work, doc, chat, mem };
}

describe("citations in messages sent outside omem", () => {
  it("links words that are part of the sentence and turns trailing references into numbers", () => {
    const { app, code, work, doc, chat, mem } = fixture();
    const md = [
      `按[退款说明](src:${doc.id}#L1)处理。[日志摘录](src:${work.id}#L3-L5)`,
      `代码在这里。[实现](src:${code.id}#L10-L12) [记录](mem:${mem.id})`,
      `小王说的。[原话](src:${chat.id}#L1-L1) [回复](src:${chat.id}#L2)`,
      "`[不动](src:x)` 和 ```\n[也不动](src:y)\n```",
    ].join("\n");
    const [out] = resolveCitationsNow(app, [md], { runId: "r_owner", chatId: CHAT });
    const token = tokenOf(out)!;
    expect(token).toBeTruthy();
    const lines = out.split("\n");
    expect(lines[0]).toBe(`按[退款说明](https://tenant.larkoffice.com/docx/Guide)处理。[①](https://omem.example.test/#/share/${token}/0)`);
    expect(lines[1]).toBe(`代码在这里。[②](https://omem.example.test/#/share/${token}/1) [③](https://omem.example.test/#/share/${token}/2)`);
    // Feishu messages open in Feishu: at the message when its position is known, else the chat.
    expect(lines[2]).toBe(`小王说的。[④](https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=41) [⑤](https://applink.feishu.cn/client/chat/open?openChatId=${CHAT})`);
    expect(out).toContain("`[不动](src:x)`");
    expect(out).toContain("[也不动](src:y)");
    expect(out).not.toContain("(mem:");

    // Only the hash is stored; the share holds copies of what was cited and nothing else.
    expect(one(app.db, "select count(*) n from shares where token_hash = ?", token)).toEqual({ n: 0 });
    const share = readShare(app, token)!;
    expect(share.items.map((i) => [i.kind, i.label, i.mark])).toEqual([["source", "日志摘录", 1], ["source", "实现", 2], ["memory", "记录", 3]]);
    const log = share.items[0] as Extract<typeof share.items[number], { kind: "source" }>;
    // Cited lines 3-5 of a table: starts at the table header, a few lines of context after.
    expect(log.start).toBe(1);
    expect(log.lines.at(-1)).toBe("依据 原话 和 ");
    const impl = share.items[1] as Extract<typeof share.items[number], { kind: "source" }>;
    expect([impl.start, impl.lines.length, impl.from, impl.to, impl.format, impl.path]).toEqual([7, 9, 10, 12, "code", "src/refund.ts"]);
    expect((share.items[2] as { text: string }).text).toBe("退款失败多半是渠道超时，见 记录");
    expect(listShares(app)[0]).toMatchObject({ runId: "r_owner", origin: "飞书 · 退款改造群", labels: ["日志摘录", "实现", "记录"], views: 1 });
  });

  it("without a web address or a run, leaves out what it cannot link and keeps inline words", () => {
    const { app, code, mem } = fixture();
    const md = `改动在[退款实现](src:${code.id}#L3)里。[记录](mem:${mem.id}) [[flows/refund|退款流程]] mem:${mem.id}`;
    expect(resolveCitationsNow(app, [md], {})[0]).toBe("改动在退款实现里。");
    app.config.webUrl = "";
    expect(resolveCitationsNow(app, [md], { runId: "r_owner" })[0]).toBe("改动在退款实现里。");
    expect(all(app.db, "select id from shares")).toHaveLength(0);
  });

  it("shares wiki pages and sections, but never what the run could not read", () => {
    const { app, mem } = fixture();
    createSpace(app, { id: "proj", name: "项目 A" });
    writePage(app, "proj", "flows/refund", { meta: { title: "退款流程" } as never, body: "# 退款流程\n\n## 申请\n先提交。\n\n## 审核\n客服审核，见 [[other]]。" }, { commit: false });
    // A guest answer read only the project space: the personal memory is not copied.
    run(app.db, "insert into runs(id, kind, space_id, status, title, input, created_at) values('r_guest', 'guest', 'proj', 'done', '访客', ?, '2026-10-29T10:00:00Z')", JSON.stringify({ spaces: ["proj"] }));
    const [out] = resolveCitationsNow(app, [`流程见[[proj:flows/refund#审核|审核这一步]]。[记录](mem:${mem.id})`], { runId: "r_guest" });
    const token = tokenOf(out)!;
    expect(out).toBe(`流程见[审核这一步](https://omem.example.test/#/share/${token}/0)。`);
    const share = readShare(app, token)!;
    expect(share.items).toHaveLength(1);
    expect(share.items[0]).toMatchObject({ kind: "page", title: "退款流程", section: "审核", markdown: "## 审核\n客服审核，见 other。" });
  });

  it("numbers a card's blocks together in one share and leaves callback values alone", async () => {
    const { app, code, work } = fixture();
    const callback = { tag: "markdown", content: `[x](src:${code.id})` };
    const card = { body: { elements: [{ tag: "markdown", content: `第一段。[a](src:${code.id}#L1)` }, { tag: "markdown", content: `第二段。[b](src:${work.id}#L2)` }, { tag: "button", behaviors: [{ value: callback }] }] } };
    const out = (await resolveCardCitations(app, card, { runId: "r_owner" })) as typeof card;
    expect(out.body.elements[0].content).toMatch(/^第一段。\[①\]\(https:\/\/omem\.example\.test\/#\/share\/[\w-]+\/0\)$/);
    expect(out.body.elements[1].content).toMatch(/^第二段。\[②\]\(https:\/\/omem\.example\.test\/#\/share\/[\w-]+\/1\)$/);
    expect(out.body.elements[2].behaviors![0].value).toEqual(callback);
    expect(all(app.db, "select id from shares")).toHaveLength(1);
  });

  it("reads a missing message position once with lark-cli before sending", async () => {
    const { app, chat } = fixture();
    const calls: string[][] = [];
    setLarkCliForTests(async (args) => {
      calls.push(args);
      return { ok: true, data: { messages: [{ message_id: "om_a2", message_position: "42" }] } };
    });
    const out = await resolveCitations(app, `他回了。[回复](src:${chat.id}#L2)`, {});
    expect(out).toBe(`他回了。[①](https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=42)`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(["+messages-mget", "om_a2", "--as", "user"]));
    await resolveCitations(app, `再看。[回复](src:${chat.id}#L2)`, {});
    expect(calls).toHaveLength(1);
  });

  it("links a message that came from Feishu to that message", () => {
    const { app } = fixture();
    run(app.db, "insert into conversations(id, space_id, channel, title, external_id, created_at, updated_at) values('c1', 'personal', 'lark', '群', ?, 'x', 'x')", `${CHAT}#omt_1`);
    run(app.db, "insert into messages(id, conversation_id, role, text, meta, created_at) values('msg0abcdefgh', 'c1', 'user', '帮我查一下', ?, 'x')", JSON.stringify({ externalId: "om_a1" }));
    expect(resolveCitationsNow(app, ["你让我查的。msg:msg0abcdefgh"], {})[0]).toBe(`你让我查的。[①](https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=41)`);
  });
});

describe("share links", () => {
  it("revokes and expires: the link stops working and the copy is dropped", () => {
    const { app, code } = fixture();
    const token = tokenOf(resolveCitationsNow(app, [`见此。[a](src:${code.id}#L1)`], { runId: "r_owner" })[0])!;
    const id = listShares(app)[0].id;
    revokeShare(app, id);
    expect(readShare(app, token)).toBeNull();
    expect(one<{ items: string; revoked_at: string }>(app.db, "select items, revoked_at from shares where id = ?", id)).toMatchObject({ items: "[]" });
    app.config.shares.expiryDays = 7;
    const t2 = tokenOf(resolveCitationsNow(app, [`见此。[a](src:${code.id}#L1)`], { runId: "r_owner" })[0])!;
    expect(readShare(app, t2)).not.toBeNull();
    run(app.db, "update shares set expires_at = '2000-01-01T00:00:00Z' where expires_at is not null");
    expect(readShare(app, t2)).toBeNull();
    expect(listShares(app).find((s) => s.expiresAt)?.expired).toBe(true);
  });

  it("is the only route another machine can read without a token, and returns only the snapshot", async () => {
    const { app, code } = fixture();
    const token = tokenOf(resolveCitationsNow(app, [`见此。[a](src:${code.id}#L1)`], { runId: "r_owner" })[0])!;
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const remote = { remoteAddress: "192.0.2.7" };
      const ok = await server.inject({ url: `/api/share/${token}`, ...remote });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      const body = ok.json();
      expect(Object.keys(body).sort()).toEqual(["createdAt", "expiresAt", "items", "title"]);
      expect(JSON.stringify(body)).not.toMatch(/r_owner|token_hash|personal/);
      expect((await server.inject({ url: `/api/share/${"A".repeat(43)}`, ...remote })).statusCode).toBe(404);
      // Anything else still needs a token from another machine: other paths, queries, the owner's list.
      for (const url of [`/api/share/${token}?x=1`, `/api/share/${token}/0`, "/api/shares", `/api/sources/${code.id}`, `/api/share/${token.slice(1)}`])
        expect((await server.inject({ url, ...remote })).statusCode, url).toBe(401);
      expect((await server.inject({ method: "DELETE", url: `/api/shares/${listShares(app)[0].id}`, ...remote })).statusCode).toBe(401);
      // The owner lists and revokes them.
      const list = (await server.inject({ url: "/api/shares" })).json();
      expect(list.shares).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(token);
      expect((await server.inject({ method: "DELETE", url: `/api/shares/${list.shares[0].id}` })).statusCode).toBe(200);
      expect((await server.inject({ url: `/api/share/${token}`, ...remote })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
