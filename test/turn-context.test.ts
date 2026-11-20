import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { resolveTurn } from "../src/agents/turn-context.ts";
import { addMaterials } from "../src/items/materials.ts";
import { upsertItem } from "../src/items/store.ts";
import { run } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { boot } from "../src/main.ts";

describe("当轮事项", async () => {
  const home = mkdtempSync(join(tmpdir(), "turn-context-"));
  const prompts = join(home, "prompts");
  writeFileSync(join(home, "config.json"), JSON.stringify({
    agents: { default: "echo", profiles: [{ id: "echo", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_PROMPT_LOG: prompts } }] },
  }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(async () => { releaseAll(); await server.close(); });
  const ask = (body: Record<string, unknown>) => fetch(app.baseUrl + "/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "进展如何？", ...body }) });

  it("只把打分结果当线索，已关联事项按最近活动选", () => {
    const thread = createThread(app, { channel: "web", spaceId: "personal" });
    const r = createRun(app, { kind: "ask", title: "讨论", input: { conversationId: thread.id }, notBefore: new Date(Date.now() + 60_000).toISOString() });
    const first = upsertItem(app, undefined, { title: "核对退款运费 PAY-1234" });
    const second = upsertItem(app, undefined, { title: "核对退款规则" });
    addMessage(app, thread.id, "user", "PAY-1234 核对退款运费");
    const resolve = () => resolveTurn(app, r.id, thread, [], "owner").context;
    expect(resolve().item).toBeUndefined();
    expect(resolve().candidates.map(c => c.itemId)).toContain(first.id);
    for (const i of [first, second]) addMaterials(app, i.id, [{ kind: "conversation", ref: thread.id }], "owner");
    run(app.db, "update items set updated_at='2000-01-01' where id=?", first.id);
    expect(resolve()).toMatchObject({ item: { id: second.id, via: "linked" }, candidates: [{ itemId: first.id, reason: "这个会话也挂在它上面" }] });
  });

  it("提问入口拒绝别人的事项，新会话持续记住入口事项", async () => {
    const user = createUser(app, { name: "成员甲" });
    const other = upsertItem(app, undefined, { title: "成员的事项", userId: user.id });
    expect((await ask({ itemId: other.id })).status).toBe(403);
    const line = upsertItem(app, undefined, { title: "退款改造", kind: "line" });
    const first = await (await ask({ itemId: line.id })).json();
    const r = await waitForRun(app, first.runId);
    expect(r.status).toBe("done");
    expect(r.output.turnContext).toMatchObject({ item: { id: line.id, via: "explicit" } });
    const second = await (await ask({ conversationId: first.conversationId })).json();
    expect((await waitForRun(app, second.runId)).output.turnContext).toMatchObject({ item: { id: line.id } });
    expect(readFileSync(prompts, "utf8")).toContain("进展如何");
  });
});
