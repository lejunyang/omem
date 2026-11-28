import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CredentialCommand } from "../packages/plugin-sdk/credential.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { commandGate, commandGateDir, gatePaths } from "../src/agents/command-gate.ts";
import { registerCredential } from "../src/agents/credential-registry.ts";
import { createRun } from "../src/agents/runs.ts";
import { acpPermission } from "../src/agents/acp-permission.ts";
import { testApp } from "./helpers.ts";

it("插件判定在用户规则之后，覆盖 ACP、离线垫片、按对象审批及判定失败", async () => {
  const app = testApp();
  const runId = createRun(app, { kind: "code", title: "判定验证" }).id;
  app.db.prepare("update runs set status='running' where id=?").run(runId);
  const ctx = { app, runId, userId: "owner", commandTurn: "turn", actor: "agent" as const, spaces: [], tools: null, spaceId: "" };
  const name = "sample";
  const call = (op: string, arg: string) => commandGate(app, ctx, { command: name, args: [op, arg], cwd: app.home });
  const judge = vi.fn<NonNullable<CredentialCommand["judge"]>>(c => ({ action: "approve", key: c.argv[0], approver: "caller", reason: "写入对象" }));
  const drop = registerCredential("fixture", { id: "account", name: "示例", login: async () => ({ user: "sample" }), provides: { commands: [{ name, judge }] } });
  async function pending() {
    const ask = () => listAsks(app, { status: "pending" })[0];
    await vi.waitFor(() => expect(ask()).toBeDefined(), { timeout: 5000 });
    return ask()!;
  }
  try {
    commandGateDir(app);
    const offline = spawnSync(process.execPath, [gatePaths(app.home).script, name], { env: { ...process.env, OMEM_TOKEN: "", OMEM_URL: "" }, cwd: join(app.home) });
    expect(offline.status).toBe(126);
    app.config.security.operationRules = [{ id: "own", revision: 1, enabled: true, action: "allow", match: { kind: "command", executable: name } }];
    expect((await call("update", "first")).decision).toBe("allow");
    expect(judge).not.toHaveBeenCalled();
    app.config.security.operationRules = [];
    const request = call("update", "first");
    const first = await pending();
    expect(first.question).toContain("写入对象");
    await answerAsk(app, first.id, { by: "owner", approved: true, choice: 1 });
    expect((await request).decision).toBe("allow");
    expect((await call("update", "next")).decision).toBe("allow");
    const other = call("delete", "next");
    await answerAsk(app, (await pending()).id, { by: "owner", approved: false });
    expect((await other).decision).toBe("deny");
    judge.mockReturnValue({ action: "deny" });
    const acp = await acpPermission({ toolCall: { kind: "execute", toolCallId: "sample", rawInput: { command: [name, "write"] } },
      options: [{ kind: "reject_once", optionId: "no", name: "拒绝" }] , sessionId: "fixture" }, { app, runId, backend: "test", cwd: app.home, writable: true });
    expect(acp.optionId).toBe("no");
    for (const answer of [null, { action: "allow" }, { action: "log" }] as const) {
      judge.mockReturnValue(answer); expect((await call("read", "fixture")).decision).toBe("allow");
    }
    judge.mockRejectedValue(new Error("test"));
    const failed = call("other", "one");
    const fallback = await pending();
    expect(fallback.question).toContain("插件判定失败");
    await answerAsk(app, fallback.id, { approved: false, by: "owner" });
    expect((await failed).decision).toBe("deny");
  } finally { drop(); app.db.close(); }
}, 20000);
