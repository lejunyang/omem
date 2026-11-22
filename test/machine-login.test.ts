import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cancelMachineLogin, checkMachineLogin, machineLogin, sendMachineLoginInput, startMachineLogin } from "../src/agents/machine-login.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

// A CLI whose login prints a link, asks for the code from the authorization page, and keeps it; its status
// answers 0 once a code was kept. Declared the way the catalog declares a backend's account.
const dir = mkdtempSync(join(tmpdir(), "omem-machine-login-"));
const marker = join(dir, "logged-in");
const script = join(dir, "fake-cli.mjs");
writeFileSync(script, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
if (process.argv[2] === "status") {
  if (existsSync(marker)) { console.log("Logged in as " + readFileSync(marker, "utf8")); process.exit(0); }
  console.log("Not logged in"); process.exit(1);
}
console.log("Opening browser to sign in…");
console.log("If the browser didn't open, visit: https://auth.example.test/authorize?code=true&state=abc");
process.stdout.write("Paste code here if prompted > ");
process.stdin.setEncoding("utf8");
let got = "";
process.stdin.on("data", (d) => { got += d; if (got.includes("\\n")) { writeFileSync(marker, got.trim() === "good-code" ? "someone@example.test" : ""); process.exit(got.trim() === "good-code" ? 0 : 1); } });
`);
app.config.agents.profiles = [...app.config.agents.profiles, {
  id: "fakeagent", name: "Fake (ACP)", transport: "acp", command: "fake-agent-acp", args: [], env: {}, idleTimeoutMs: 600_000,
  account: { cli: process.execPath, env: {}, owns: [], login: { args: [script, "login"], url: "https://[^\\s\"'<>]+", input: "Paste code", timeoutMs: 60_000 }, status: { args: [script, "status"], user: "as (\\S+)" } },
} as any];

// A device-code login with no status command (as Copilot's): it prints the page and a code, then ends by itself.
const device = join(dir, "device-cli.mjs");
writeFileSync(device, `console.log("To authenticate, visit https://github.example.test/login/device and enter code ABCD-1234"); console.log("Waiting for authorization..."); setTimeout(() => process.exit(0), 800);`);
app.config.agents.profiles = [...app.config.agents.profiles, {
  id: "devicecli", name: "Device (ACP)", transport: "acp", command: "device-cli-acp", args: [], env: {}, idleTimeoutMs: 600_000,
  account: { cli: process.execPath, env: {}, owns: [], login: { args: [device], url: "https://[^\\s\"'<>]+", code: "\\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\\b" } },
} as any];

describe("this machine's own login from settings", () => {
  it("takes a clean exit of a login without a status command as logged in", async () => {
    expect(machineLogin(app, "devicecli")).toMatchObject({ canLogin: true, canCheck: false, state: "unknown" });
    const started = await startMachineLogin(app, "devicecli");
    expect(started.pending).toMatchObject({ url: "https://github.example.test/login/device", code: "ABCD-1234", input: false });
    for (let i = 0; i < 60 && machineLogin(app, "devicecli").pending; i++) await new Promise((r) => setTimeout(r, 100));
    expect(machineLogin(app, "devicecli")).toMatchObject({ state: "logged-in", pending: null });
  }, 30_000);

  it("checks, shows the link, takes the pasted code and checks again", async () => {
    expect(machineLogin(app, "fakeagent")).toMatchObject({ canLogin: true, canCheck: true, state: "unknown", pending: null });
    expect(await checkMachineLogin(app, "fakeagent")).toMatchObject({ state: "none" });

    const started = await startMachineLogin(app, "fakeagent");
    expect(started.pending).toMatchObject({ url: "https://auth.example.test/authorize?code=true&state=abc", input: true });
    // Pressing again shows the same login instead of starting a second one.
    expect((await startMachineLogin(app, "fakeagent")).pending?.startedAt).toBe(started.pending!.startedAt);
    expect(() => sendMachineLoginInput(app, "fakeagent", "two\nlines")).toThrow(/一行/);

    sendMachineLoginInput(app, "fakeagent", "  good-code ");
    for (let i = 0; i < 100 && (machineLogin(app, "fakeagent").pending || machineLogin(app, "fakeagent").state !== "logged-in"); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("someone@example.test");
    expect(machineLogin(app, "fakeagent")).toMatchObject({ state: "logged-in", user: "someone@example.test", pending: null });
  }, 30_000);

  it("cancels a login that is waiting, and refuses a backend the catalog has no login for", async () => {
    await startMachineLogin(app, "fakeagent");
    expect(cancelMachineLogin(app, "fakeagent").pending).toBeNull();
    expect(() => sendMachineLoginInput(app, "fakeagent", "x")).toThrow(/没有在等授权码/);
    expect(() => machineLogin(app, "cursor")).toThrow(/没有声明怎么登录/);
  }, 30_000);
});
