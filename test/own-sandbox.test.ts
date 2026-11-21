import { expect, it } from "vitest";
import { normalizeSandbox, ownMounts, ownSandboxEnv, selectOwnSandbox } from "../src/agents/own-sandbox.ts";
import { bwrapArgs } from "../src/agents/sandbox.ts";

it("normalizes grants and rejects ancestors, private data and system roots", () => {
  const dirs = (...writable: string[]) => normalizeSandbox({ mode: "prefer", writable, hidden: [] }, "/home/me", "/store/data", p => p);
  expect(dirs("~/src/a/..", "/home/me/src").writable).toEqual(["/home/me/src"]);
  for (const p of ["/", "~", "/home", "/store", "/store/data", "/store/data/secrets", "/tmp", "/etc", "/proc/self", "relative"])
    expect(() => dirs(p)).toThrow();
});

it("applies availability only to local machine-login runs", () => {
  const no = () => ({ ok: false, reason: "不可用" });
  expect(selectOwnSandbox("prefer", true, false, no)).toMatchObject({ active: false, reason: expect.stringContaining("不可用") });
  expect(() => selectOwnSandbox("require", true, false, no)).toThrow("不可用");
  expect(selectOwnSandbox("require", false, false, no).active).toBe(false);
  expect(selectOwnSandbox("require", true, true, no).active).toBe(false);
});

it("mounts only the assigned workspace, private snapshot, state and artifacts", () => {
  const box = { data: "/data", home: "/home/me", state: ["/home/me/.cache"], writable: [], hidden: ["/home/me/private"], runtime: ["/data/bin"], secretEnv: [], readOnly: true, snapshot: "/data/runs/r/snap", artifactDir: "/data/inbox/r" };
  const cwd = "/data/runs/r/snap";
  const plan = ownMounts(box, cwd, { ro: ["/work"], rw: [] }, "/data/inbox/r");
  expect(plan.rw).toEqual(["/home/me/.cache", "/data/inbox/r", cwd]);
  expect(plan.ro).toEqual(["/work", "/data/bin"]);
  const args = bwrapArgs({ ...plan, cwd, command: "node", args: [] });
  expect(args).toContain("/home/me/private");
  expect(args).not.toContain("--unshare-net");
  expect(ownMounts({ ...box, writable: ["/work/child"] }, "/work").rw).not.toContain("/work/child");
  expect(ownMounts({ ...box, readOnly: false }, "/work").rw).toContain("/work");
  expect(ownMounts(box, cwd, undefined, "/data/inbox/other").rw).not.toContain("/data/inbox/other");
});

it("retains login variables and replaces service credentials with turn-scoped access", () => {
  const env = ownSandboxEnv({ OPENAI_API_KEY: "login", OMEM_SERVICE_TOKEN: "service", CHAT_SECRET: "service", OMEM_TOKEN: "stale" }, { OMEM_TOKEN: "turn" }, ["CHAT_SECRET"]);
  expect(env).toEqual({ OPENAI_API_KEY: "login", TMPDIR: "/tmp", OMEM_TOKEN: "turn" });
});
