import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addLogin, canAddLogin, removeLogin } from "../src/agents/login-slots.ts";
import { checkMachineLogin, machineLogin, sendMachineLoginInput, startMachineLogin } from "../src/agents/machine-login.ts";
import { quotaKey, quotaKind } from "../src/agents/quota.ts";
import { allProfiles } from "../src/core/config.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

// A CLI that keeps its login where FAKE_STATE points (as Codex keeps it in CODEX_HOME): login waits for a pasted code.
const dir = mkdtempSync(join(tmpdir(), "omem-login-slots-"));
const script = join(dir, "fake-cli.mjs");
writeFileSync(script, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = (process.env.FAKE_STATE || "/nonexistent") + "/login";
if (process.argv[2] === "status") {
  if (existsSync(file)) { console.log("Logged in as " + readFileSync(file, "utf8")); process.exit(0); }
  console.log("Not logged in"); process.exit(1);
}
console.log("Visit https://auth.example.test/authorize?x=1");
process.stdout.write("Paste code here > ");
process.stdin.setEncoding("utf8");
let got = "";
process.stdin.on("data", (d) => { got += d; if (got.includes("\\n")) { writeFileSync(file, got.trim()); process.exit(0); } });
`);
app.config.agents.profiles = [...app.config.agents.profiles, {
  id: "fakeslot", name: "Fake (ACP)", transport: "acp", command: "fake-slot-acp", args: ["acp"], model: "m1", env: {}, idleTimeoutMs: 600_000,
  account: { cli: process.execPath, env: { FAKE_STATE: "{home}/.fake" }, dirs: [".fake"], owns: [".fake"], login: { args: [script, "login"], url: "https://[^\\s\"'<>]+", input: "Paste code", timeoutMs: 60_000 }, status: { args: [script, "status"], user: "as (\\S+)" } },
} as any];

async function loginAs(source: string, who: string) {
  await startMachineLogin(app, source);
  sendMachineLoginInput(app, source, who);
  for (let i = 0; i < 100 && (machineLogin(app, source).pending || machineLogin(app, source).state !== "logged-in"); i++) await new Promise((r) => setTimeout(r, 100));
}

describe("more than one login of the owner's for a backend", () => {
  it("adds a backend with a folder of its own, logs it in there, and removes it with every reference", async () => {
    expect(canAddLogin(app, "fakeslot")).toBe(true);
    const added = addLogin(app, "fakeslot", "owner");
    expect(added).toMatchObject({ id: "fakeslot-2", source: "fakeslot#2" });
    const p = allProfiles(app.config).find(x => x.id === "fakeslot-2")!;
    expect(p).toMatchObject({ command: "fake-slot-acp", args: ["acp"], model: "m1", source: "fakeslot#2" });
    expect(normalize(p.env.FAKE_STATE)).toBe(join(app.home, "logins", "fakeslot-2", ".fake"));
    expect(existsSync(p.env.FAKE_STATE)).toBe(true);
    expect(canAddLogin(app, "fakeslot#2")).toBe(false);
    expect(machineLogin(app, "fakeslot#2")).toMatchObject({ extra: true, canAdd: false, name: "Fake (ACP) · 账号 2" });

    await loginAs("fakeslot#2", "second@example.test");
    expect(readFileSync(join(p.env.FAKE_STATE, "login"), "utf8")).toBe("second@example.test");
    expect(machineLogin(app, "fakeslot#2")).toMatchObject({ state: "logged-in", user: "second@example.test" });
    // The machine's own login of the backend did not see it.
    expect(await checkMachineLogin(app, "fakeslot")).toMatchObject({ state: "none" });

    // A third gets the next number; quota is kept apart per login.
    expect(addLogin(app, "fakeslot", "owner").id).toBe("fakeslot-3");
    expect(quotaKey(p)).toBe("fakeslot#2");

    app.config.agents.roles = { ...app.config.agents.roles, assistant: "fakeslot-2" };
    app.config.agents.routing = { ...app.config.agents.routing, candidates: [{ profile: "fakeslot-2", when: "x" } as any] };
    await removeLogin(app, "fakeslot#2", "owner");
    expect(allProfiles(app.config).some(x => x.id === "fakeslot-2")).toBe(false);
    expect(app.config.agents.roles.assistant).toBeUndefined();
    expect(app.config.agents.routing.candidates).toEqual([]);
    expect(existsSync(join(app.home, "logins", "fakeslot-2"))).toBe(false);
    await expect(removeLogin(app, "fakeslot", "owner")).rejects.toThrow(/不是另加的账号/);
  }, 30_000);

  it("an extra login of a catalog backend keeps its quota kind", () => {
    expect(quotaKind({ id: "antigravity-2", source: "antigravity#2" } as any)).toBe("antigravity-usage");
    expect(canAddLogin(app, "antigravity")).toBe(true);
    expect(canAddLogin(app, "cursor")).toBe(false);
    // Gemini CLI keeps its login in a folder too, but cannot log in from a page.
    expect(canAddLogin(app, "gemini")).toBe(false);
  });
});
