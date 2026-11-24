import { expect, it } from "vitest";
import { run } from "../src/core/db.ts";
import { notify } from "../src/core/notify.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { saveRule } from "../src/rules/store.ts";
import { highQuietRules, ruleQuietStats } from "../src/rules/quiet-stats.ts";
import { testApp } from "./helpers.ts";

it("counts each firing once, not skips, delayed continuations, or undelivered work as a second firing", () => {
  const app = testApp();
  try {
    const r = saveRule(app, { name: "定时规则", description: "检查", trigger: { event: "schedule", cron: "0 9 * * *", once: "event", waitMinutes: 0, unless: [] }, enabled: true, conditions: null, judge: "code", actions: [{ type: "notify", urgent: false }] });
    const ownerRule = () => ({ type: "agent" as const, input: { rule: { id: r.id } } });
    const agent = (status = "done", reason?: string) => {
      const job = createRun(app, { kind: ownerRule().type, input: ownerRule().input, title: "模拟" });
      run(app.db, "update runs set status=? where id=?", status, job.id);
      if (reason) setRunOutput(app, job.id, { stayQuiet: reason });
      return job.id;
    };
    const now = new Date(Date.now() + 1000);
    const fire = (key: string, days: number, a: string, id?: string) => run(app.db, "insert into rule_firings(rule_id,event_key,at,summary,judged_by,reason,results) values(?,?,?,?,?,?,?)", r.id, key, new Date(now.getTime() - days * 86400_000).toISOString(), "测试", "code", "判断", JSON.stringify([{ action: a, ok: true, runId: id }]));
    const merged = agent("done", "检查通过\n无需打扰");
    for (let i = 0; i < 8; i++) fire(`key-${i}`, 0, "agent", merged);
    fire("later", 0, "delay", agent());
    fire("later#later", 0, "agent", agent("done", "延后复查完成"));
    const spoken = agent("done", "发过了，不重复发");
    notify(app, { title: "需要处理", runId: spoken });
    fire("spoken", 0, "agent", spoken);
    fire("skipped", 0, "skip", merged);
    fire("pending", 12, "agent", agent("queued"));
    fire("old", 12, "agent", agent());
    fire("ancient", 40, "agent", merged);
    expect(ruleQuietStats(app, [r.id], now).get(r.id)).toMatchObject({ days7: { fired: 10, quiet: 9 }, days30: { fired: 12, quiet: 10 }, reasons: ["延后复查完成", "检查通过 无需打扰"] });
    expect(highQuietRules(app, now)).toEqual([expect.stringContaining("10 次触发，9 次安静结束")]);
    fire("dispatched", 0, "notify");
    expect(highQuietRules(app, now)).toEqual([]);
  } finally { app.db.close(); }
});
