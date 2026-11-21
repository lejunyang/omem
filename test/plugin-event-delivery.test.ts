import { expect, it } from "vitest";
import { all, one, run, tx } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { recordPrior, settleRereview } from "../src/agents/rereview.ts";
import { setFindingDecision } from "../src/agents/review-fix.ts";
import { deliverPluginEvents } from "../src/plugins/event-delivery.ts";
import { replayPluginEvent, replaceSubscriptions } from "../src/plugins/event-store.ts";
import { manifestSchema } from "../src/plugins/registry.ts";
import { registerProcessHooks } from "../src/plugins/process-hooks.ts";
import type { PluginEventV1, Subscription } from "../src/plugins/types.ts";
import { testApp } from "./helpers.ts";

function setup(events: Subscription["events"], handle: Subscription["handle"]) {
  const app = testApp();
  const undo: (() => void)[] = [];
  const manifest = manifestSchema.parse({ id: "sample", name: "示例", permissions: { events } });
  app.config.plugins.eventSpaces.sample = ["personal"];
  const def = { id: "sync", events, handle };
  const enable = () => {
    registerProcessHooks(manifest, undo).subscribe(def);
    replaceSubscriptions(app, "sample", [def]);
  };
  const disable = () => undo.splice(0).forEach(fn => fn());
  enable();
  return { app, enable, disable, close() { disable(); app.db.close(); } };
}

it("commits only subscribed, authorized facts with the business write", async () => {
  const seen: PluginEventV1[] = [];
  const { app, close } = setup(["item.created"], async (_, event) => { seen.push(event); });
  try {
    expect(() => tx(app.db, () => {
      upsertItem(app, undefined, { title: "回滚" });
      throw Error("回滚");
    })).toThrow();
    const item = upsertItem(app, undefined, { title: "标题", detail: "正文" });
    upsertItem(app, item.id, { status: "waiting" });
    app.config.plugins.eventSpaces.sample = [];
    upsertItem(app, undefined, { title: "未授权" });
    app.config.plugins.eventSpaces.sample = ["personal"];
    await deliverPluginEvents(app);
    await deliverPluginEvents(app);
    expect(seen).toHaveLength(1);
    expect(seen[0].data).toEqual({ title: "标题", kind: "todo", from: null, status: "open", parentId: null, links: [] });
    expect(one(app.db, "select count(*) n from plugin_events")).toEqual({ n: 1 });
  } finally { close(); }
});

it("preserves entity order across disable, failure, retries and replay", async () => {
  const seen: string[] = [];
  let fail = true;
  const { app, enable, disable, close } = setup(["item.created", "item.status"], async (_, e) => {
    if (e.type === "item.created" && fail) throw Error("暂不可用");
    seen.push(e.type);
  });
  try {
    disable();
    const item = upsertItem(app, undefined, { title: "同步" });
    upsertItem(app, item.id, { status: "waiting" });
    await deliverPluginEvents(app);
    enable();
    for (let i = 0; i < 6; i++) {
      await deliverPluginEvents(app);
      expect(one<{ due: number }>(app.db, "select due from plugin_deliveries order by seq limit 1")!.due).toBeGreaterThan(Date.now());
      run(app.db, "update plugin_deliveries set due=0");
    }
    expect(all(app.db, "select state,attempts from plugin_deliveries order by seq")).toEqual([{ state: "failed", attempts: 6 }, { state: "pending", attempts: 0 }]);
    fail = false;
    await deliverPluginEvents(app);
    expect(seen).toEqual([]);
    const id = one<{ id: string }>(app.db, "select id from plugin_events order by seq limit 1")!.id;
    expect(replayPluginEvent(app, "sample:sync", id)).toBe(true);
    await Promise.all([deliverPluginEvents(app), deliverPluginEvents(app)]);
    await deliverPluginEvents(app);
    expect(seen).toEqual(["item.created", "item.status"]);
  } finally { close(); }
});

it("publishes review transitions and the resolution actually written", async () => {
  const seen: PluginEventV1[] = [];
  const { app, close } = setup(["review.finished", "finding.decision", "finding.resolution"], async (_, e) => { seen.push(e); });
  try {
    const base = createRun(app, { kind: "code", spaceId: "personal", title: "评审" });
    run(app.db, "insert into reviews(id,code_run_id,check_name,verdict,created_at) values('r',?,'a','revise','2026-01-01')", base.id);
    for (const id of [1, 2]) run(app.db, "insert into review_findings(id,review_id,title,severity) values(?,'r','建议','minor')", id);
    setFindingDecision(app, base.id, 1, "fix");
    const output = { reviewStage: "done", reviewLead: { round: 1, verdict: "revise" } };
    setRunOutput(app, base.id, output);
    setRunOutput(app, base.id, output);
    const next = createRun(app, { kind: "code", spaceId: "personal", title: "复审", input: { rereviewOf: base.id } });
    recordPrior(app, next.id, [{ id: 1, status: "fixed" }]);
    settleRereview(app, next.id);
    await deliverPluginEvents(app);
    await deliverPluginEvents(app);
    expect(seen.map(e => e.type).sort()).toEqual(["finding.decision", "finding.resolution", "finding.resolution", "review.finished"]);
    expect(seen.find(e => e.type === "review.finished")?.data).toEqual({ runId: base.id, verdict: "revise", findingCount: 2 });
  } finally { close(); }
});
