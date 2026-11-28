import { expect, it, vi } from "vitest";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { commandGate } from "../src/agents/command-gate.ts";
import { createUser } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

it.each(["owner", "member"])("只有调用者 %s 能处理审批，包括没有飞书身份的成员", async member => {
  const app = testApp();
  createUser(app, { id: "member", name: "示例成员", role: "member" });
  app.config.security.operationRules = [{ enabled: true, id: "write", revision: 1, action: "approve",
    match: { kind: "command", executable: "sample" }, approval: { approver: "caller" } }];
  const ctx = { app, userId: member, spaces: [], spaceId: "", runId: null, tools: null, actor: "agent" as const };
  const call = { command: "sample", args: [], cwd: "/work" };
  try {
    expect((await commandGate(app, { ...ctx, role: "guest" }, call)).decision).toBe("deny");
    const decision = commandGate(app, ctx, call);
    const pending = () => listAsks(app, { status: "pending", userId: member })[0];
    await vi.waitFor(() => expect(pending()?.userId).toBe(member));
    const id = pending()!.id;
    await expect(answerAsk(app, id, { by: member === "owner" ? "member" : "owner", approved: true })).rejects.toThrow("调用者");
    await answerAsk(app, id, { by: member, approved: true });
    expect((await decision).decision).toBe("allow");
  } finally { app.db.close(); }
});
