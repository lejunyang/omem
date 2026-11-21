import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { runPeerCommand } from "../src/core/peer-exec.ts";
import { createApiToken, pairedTokens } from "../src/core/users.ts";
import { getRun } from "../src/agents/runs.ts";

it("配对令牌决定来源、作用域和接活策略，重发只建一条运行", async () => {
  const app = testApp();
  const caller = { token: createApiToken(app,"owner","peer:desk"), user: "owner" };
  const other = { token: createApiToken(app,"owner","ordinary"), user: "owner" };
  const req = { key: "try-1", from: "desk", space: "personal", goal: "读说明", accept: "给出行号", deadline: new Date(Date.now()+60000).toISOString() };
  const send = (args: object) => runPeerCommand(app,"work-accept",args,caller);
  try {
    await expect(send(req)).rejects.toThrow("关闭接活");
    app.config.node.acceptWorkFrom = { [pairedTokens(app)[0].id]: "read" };
    await expect(send({ ...req, space: "missing" })).rejects.toThrow();
    await expect(send({ ...req, access: "write" })).rejects.toThrow("只接只读");
    await expect(runPeerCommand(app,"work-accept",req,other)).rejects.toThrow("配对令牌");
    const [first,second] = await Promise.all([send(req),send(req)]) as {runId: string}[];
    expect(second).toEqual(first);
    expect(getRun(app,first.runId).title).toContain("desk");
    await expect(runPeerCommand(app,"work-status",{key:req.key},{user:"owner",token:createApiToken(app,"owner","peer:other")})).rejects.toThrow("没有这次派单");
    await runPeerCommand(app,"work-cancel",{key:req.key},caller);
    expect(getRun(app,first.runId).status).toBe("cancelled");
  } finally { app.db.close(); }
});
