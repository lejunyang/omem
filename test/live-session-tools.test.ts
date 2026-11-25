import { afterEach, expect, it } from "vitest";
import { callTool, issueToolToken, retargetToolToken, revokeToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { CODE_HANDOFF_DENY } from "../src/agents/code-chain.ts";
import { testApp } from "./helpers.ts";

const issued: string[] = [];
afterEach(() => { for (const t of issued.splice(0)) revokeToolToken(t); });
const token = (tools: string[]) => {
  const t = issueToolToken({ runId: "r-open", spaceId: "personal", spaces: null, tools: new Set(tools), actor: "agent" });
  issued.push(t);
  return t;
};
const refused = "本次运行未开放";

it("会话续用时按这一轮的工具清单：交回编码结果的一轮不能续轮，本人接着说的一轮可以", async () => {
  const app = testApp();
  try {
    const all = ["list_runs", "continue_code_run"];
    // The session was opened by a handoff turn (what a restart leaves as a conversation's first turn).
    const live = token(all.filter((t) => !CODE_HANDOFF_DENY.includes(t)));
    expect((await callTool(toolContextForToken(app, live)!, "continue_code_run", { run_id: "r-none" })).text).toContain(refused);
    // The owner's next message reuses the session with its own, full tool set.
    retargetToolToken(live, "r-owner", token(all));
    const owner = toolContextForToken(app, live)!;
    expect(owner.runId).toBe("r-owner");
    expect((await callTool(owner, "continue_code_run", { run_id: "r-none" })).text).not.toContain(refused);
    // And a later handoff turn in the same session is limited again.
    retargetToolToken(live, "r-handoff", token(all.filter((t) => !CODE_HANDOFF_DENY.includes(t))));
    expect((await callTool(toolContextForToken(app, live)!, "continue_code_run", { run_id: "r-none" })).text).toContain(refused);
    // Without a turn token (other callers) only the run changes.
    retargetToolToken(live, null);
    expect(toolContextForToken(app, live)!.tools!.has("continue_code_run")).toBe(false);
  } finally { app.db.close(); }
});
