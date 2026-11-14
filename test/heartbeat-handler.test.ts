import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRun, runEvents, waitForRun } from "../src/agents/runs.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { one, run } from "../src/core/db.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { upsertItem } from "../src/items/store.ts";
import { boot } from "../src/main.ts";
import { upsertSource } from "../src/sources/store.ts";

describe("巡检 handler 的预筛与补看（真实 ACP 路径）", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-heartbeat-"));
  const prompts = join(home, "prompts.jsonl");
  writeFileSync(join(home, "config.json"), JSON.stringify({
    agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath,
      args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "echo", FAKE_PROMPT_LOG: prompts } }] },
    sessions: { background: { enabled: false } },
    ai: { providers: [{ id: "d", name: "决策", kind: "openai" }], decision: { provider: "d" } },
  }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  setKey(home, "d", "test-key");
  let asked = 0;
  let probability = 0.1;
  let sourceId = "";
  const promptLog = () => existsSync(prompts) ? readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s) as string) : [];
  const skipped = () => JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = 'heartbeat_skipped'")?.value ?? "[]");
  const tick = async () => {
    const queued = createRun(app, { kind: "heartbeat", spaceId: "personal", title: "巡检" });
    const done = await waitForRun(app, queued.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe("done");
    return done;
  };
  const expectStarted = (id: string) => {
    expect(promptLog()).toHaveLength(1);
    expect(promptLog()[0]).toContain(sourceId);
    expect(promptLog()[0]).toContain("食堂本周菜单");
    expect(runEvents(app, id).some((e) => e.type === "prompt")).toBe(true);
  };
  beforeEach(() => {
    asked = 0;
    probability = 0.1;
    app.config.heartbeat.gate = "decision";
    run(app.db, "delete from kv where key in ('heartbeat_at', 'heartbeat_skipped', 'heartbeat_sweep_at')");
    run(app.db, "update sources set deleted_at = ?", new Date().toISOString());
    run(app.db, "update items set status = 'done'");
    writeFileSync(prompts, "");
    upsertItem(app, undefined, { spaceId: "personal", title: "等待审计材料", kind: "waiting", waitingOn: "小王" }, "user");
    sourceId = upsertSource(app, { spaceId: "personal", kind: "doc", uri: `doc:menu-${Date.now()}`, title: "食堂本周菜单", text: "周一：番茄炒蛋。" }).id;
    setDecisionFetchForTests((async () => {
      asked++;
      return new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability }] }));
    }) as typeof fetch);
  });
  afterAll(async () => {
    setDecisionFetchForTests(null);
    await server.close();
  });

  it("无关材料安静跳过，不启动 Agent，并保存材料 ID", async () => {
    const done = await tick();
    expect(asked).toBe(1);
    expect(done.output).toMatchObject({ quiet: true, gated: true, summary: expect.stringContaining("不用看") });
    expect(promptLog()).toEqual([]);
    expect(runEvents(app, done.id).filter((e) => e.type === "prompt" || e.type === "session")).toEqual([]);
    expect(skipped()).toEqual([sourceId]);
  }, 60_000);

  it("预筛认为要看时启动 Agent，任务列出新材料", async () => {
    probability = 0.9;
    const done = await tick();
    expect(asked).toBe(1);
    expectStarted(done.id);
    expect(done.output.gated).toBeUndefined();
  }, 60_000);

  it("跳过 13 小时后直接补看，即使没有新材料也带上跳过的材料，结束后清空", async () => {
    await tick();
    expect(skipped()).toEqual([sourceId]);
    expect(asked).toBe(1);
    run(app.db, "update kv set value = ? where key = 'heartbeat_sweep_at'", new Date(Date.now() - 13 * 3600_000).toISOString());
    // Ensure the next tick cannot rediscover the skipped source as fresh.
    run(app.db, "update sources set updated_at = ? where id = ?", new Date(Date.now() - 3600_000).toISOString(), sourceId);
    const done = await tick();
    expect(asked).toBe(1);
    expectStarted(done.id);
    expect(skipped()).toEqual([]);
  }, 60_000);

  it("关闭预筛直接启动 Agent，不询问决策模型", async () => {
    app.config.heartbeat.gate = "off";
    const done = await tick();
    expect(asked).toBe(0);
    expectStarted(done.id);
  }, 60_000);

  it("补看积累超过 60 份时，不丢弃尚未交给助手的材料", async () => {
    const ids = [sourceId];
    for (let i = 0; i < 60; i++) ids.push(upsertSource(app, {
      spaceId: "personal", kind: "doc", uri: `doc:skipped-${i}`, title: `待补看材料 ${i}`, text: "待补看。",
    }).id);
    run(app.db, "update sources set updated_at = ? where deleted_at is null", new Date(Date.now() - 3600_000).toISOString());
    for (const [key, value] of [
      ["heartbeat_at", new Date().toISOString()],
      ["heartbeat_skipped", JSON.stringify(ids)],
      ["heartbeat_sweep_at", new Date(Date.now() - 13 * 3600_000).toISOString()],
    ]) run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, value);
    await tick();
    expect(asked).toBe(0);
    expect(promptLog()).toHaveLength(1);
    const task = promptLog()[0];
    const pending: string[] = skipped();
    // A batch limit may defer sources, but must retain those not included in the task.
    expect(ids.filter((id) => !task.includes(id) && !pending.includes(id))).toEqual([]);
  }, 60_000);
});
