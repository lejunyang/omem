import { afterEach, describe, expect, it, vi } from "vitest";
import { askModel } from "../src/agents/oneshot.ts";
import { draftRule } from "../src/rules/compile.ts";
import { testApp } from "./helpers.ts";

vi.mock("../src/agents/oneshot.ts", async (original) => ({ ...await original<typeof import("../src/agents/oneshot.ts")>(), askModel: vi.fn() }));
const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
  vi.resetAllMocks();
});

describe("rule drafts", () => {
  it("accepts conditional confirmation as one editable, disabled rule", async () => {
    const app = testApp(); apps.push(app);
    const confirm = { field: "meeting.participantCount", op: "gte", value: "30" };
    vi.mocked(askModel).mockResolvedValue(JSON.stringify({ name: "入会机器人", trigger: { event: "meeting" }, actions: [{ type: "meeting-bot", confirm }] }));
    const draft = await draftRule(app, "当我进入会议时，自动拉我的机器人进来，若人数大于等于30人，则先发卡片问我，否则直接拉进来");
    expect(draft.error).toBeUndefined();
    expect(draft.rule).toMatchObject({ enabled: false, conditions: null, trigger: { event: "meeting" }, actions: [{ type: "meeting-bot", confirm }] });
  });

  it.each([
    [{ error: "不支持这类要求" }, "不支持这类要求"],
    [{ rules: [] }, "缺少规则名称、动作清单"],
  ])("explains incomplete model output without exposing schema internals", async (response, message) => {
    const app = testApp(); apps.push(app);
    vi.mocked(askModel).mockResolvedValue(JSON.stringify(response));
    expect(await draftRule(app, "会议规则")).toMatchObject({ error: expect.stringContaining(message) });
  });
});
