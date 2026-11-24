import { afterEach, expect, it } from "vitest";
import { registerCredential } from "../src/agents/credentials.ts";
import { credentialCommand } from "../src/agents/credential-outcome.ts";
import { testApp } from "./helpers.ts";

const drops: (() => void)[] = [];
afterEach(() => { for (const d of drops.splice(0)) d(); });

it("两种凭据共用一个命令名时，按子命令前缀分流，最长的前缀优先，全局选项后面也认", () => {
  const app = testApp();
  const login = async () => ({ user: "demo" });
  drops.push(registerCredential("fixture", { id: "cloud", name: "云账号", login, provides: { commands: [{ name: "toolcli", state: [".toolcli"] }] } }, () => ({}), app));
  drops.push(registerCredential("fixture", { id: "tracker", name: "项目管理", login, provides: { commands: [{ name: "toolcli", subcommand: ["tracker"], state: [".tracker"] }] } }, () => ({}), app));
  drops.push(registerCredential("fixture", { id: "tracker-admin", name: "项目管理后台", login, provides: { commands: [{ name: "toolcli", subcommand: ["tracker", "admin"], state: [".tracker-admin"] }] } }, () => ({}), app));
  expect(credentialCommand("toolcli", ["log", "search"])?.method.kind).toBe("fixture:cloud");
  expect(credentialCommand("toolcli", ["tracker", "issue", "list"])?.method.kind).toBe("fixture:tracker");
  expect(credentialCommand("toolcli", ["--site", "cn", "tracker", "issue", "list"])?.method.kind).toBe("fixture:tracker");
  expect(credentialCommand("toolcli", ["tracker", "admin", "users"])?.method.kind).toBe("fixture:tracker-admin");
  // The word only as an option's value does not route.
  expect(credentialCommand("toolcli", ["log", "--grep", "tracker"])?.method.kind).toBe("fixture:cloud");
  expect(credentialCommand("toolcli")?.method.kind).toBe("fixture:cloud");
  expect(credentialCommand("other", ["tracker"])).toBeUndefined();
  app.db.close();
});
