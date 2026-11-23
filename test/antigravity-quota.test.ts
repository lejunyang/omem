import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAntigravityUsage, readAntigravityQuota } from "../src/agents/antigravity-quota.ts";
import { quotaAvoid, quotaView, refreshQuota } from "../src/agents/quota.ts";
import { builtinProfiles } from "../src/core/config.ts";
import { testApp } from "./helpers.ts";

const reset = "2099-01-02T00:00:00Z";
// Synthetic CLI output: group membership comes from the provider, not a host model list.
const usage = (fraction = 0.04) => JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [
  { name: "Example Models", description: "Models within this group: Example Pro 2, Orchestrator (Example)", buckets: [
    { window: "weekly", remaining_fraction: fraction, reset_time: reset },
    { window: "5h", remaining_fraction: 0.75, reset_time: reset },
  ] },
  { name: "Other Model 3", buckets: [{ window: "weekly", remaining_fraction: 1, reset_time: reset }] },
  { name: "Unknown Group", buckets: [{ window: "weekly", remaining_fraction: 0, reset_time: reset }] },
] } } });

describe("Antigravity CLI quota", () => {
  it("converts remaining fractions and preserves group scope and reset times", () => {
    const { windows } = parseAntigravityUsage(usage());
    expect(windows[0]).toEqual({ name: "Example Models · 7d", usedPercent: 96, windowMinutes: 10080,
      resetsAt: "2099-01-02T00:00:00.000Z", models: ["example-pro-2", "orchestrator-example"] });
    expect(windows[1]).toMatchObject({ usedPercent: 25, windowMinutes: 300 });
    expect(windows[2]).toMatchObject({ usedPercent: 0, models: ["other-model-3"] });
    expect(windows[3].models).toEqual([]);
  });

  it("rejects errors, unrecognized output and missing or invalid fractions", () => {
    for (const text of ["not json", "null", JSON.stringify({ status: "ERROR" }),
      JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } }),
      usage().replaceAll('"remaining_fraction":0.04', '"remaining_fraction":2')
        .replaceAll('"remaining_fraction":0.75', '"remaining_fraction":null')
        .replaceAll('"remaining_fraction":1', '"remaining_fraction":"1"')
        .replaceAll('"remaining_fraction":0,', '"remaining_fraction":-1,'),
    ]) expect(() => parseAntigravityUsage(text)).toThrow();
  });

  it.skipIf(process.platform === "win32")("reads the configured CLI, caches quota and avoids only affected models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-quota-cli-"));
    const cli = join(dir, "fake-agy");
    writeFileSync(cli, `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["-p","/usage","--output-format","json"])) process.exit(2);\nconsole.log(process.env.QUOTA_FIXTURE);\n`);
    chmodSync(cli, 0o755);
    const app = testApp();
    const p = { ...builtinProfiles.find(p => p.id === "antigravity")!, command: cli,
      env: { QUOTA_FIXTURE: usage() }, model: "example-pro-2" };
    const first = await refreshQuota(app, p, 0);
    expect(first).toMatchObject({ via: "antigravity-usage", windows: [{ usedPercent: 96 }, {}, {}, {}] });
    expect(quotaView(app, p)?.windows).toHaveLength(4);
    expect(quotaAvoid(app, p)).toContain("已用 96%");
    expect(quotaAvoid(app, { ...p, model: "prefix-orchestrator-example" })).toContain("已用 96%");
    expect(quotaAvoid(app, { ...p, model: "other-model-3" })).toBeNull();
    expect(quotaAvoid(app, { ...p, model: "example-pro-20" })).toBeNull();
    expect(quotaAvoid(app, { ...p, model: "unlisted" })).toBeNull();
    expect(quotaAvoid(app, { ...p, model: undefined })).toBeNull();
    const broken = { ...p, env: { QUOTA_FIXTURE: "{}" } };
    expect(await refreshQuota(app, broken)).toEqual(first);
    expect(await refreshQuota(app, broken, 0)).toMatchObject({ error: expect.stringContaining("结构化"), windows: first!.windows });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(readAntigravityQuota(p, ctrl.signal)).rejects.toThrow();
  });
});
