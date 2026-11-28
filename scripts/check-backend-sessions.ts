// Linux acceptance check. Put installed executables (not package-manager shims) on PATH.
// node scripts/check-backend-sessions.ts [catalog-id ...]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { accountOnlyCatalog, acpCatalog, catalogProfile, type CatalogEntry } from "../src/agents/catalog.ts";
import { doubaoAcpProfile, doubaoExecutable } from "../src/agents/doubao-cli.ts";
import { ownRun } from "../src/agents/own-run.ts";
import { launch, resolveCommand, stop } from "../src/agents/spawn.ts";
import { App } from "../src/core/app.ts";

const fixture = "/var/tmp/omem-acp";
const catalog = [...acpCatalog, ...accountOnlyCatalog];
async function check(entry: CatalogEntry, executable: string) {
  if (process.env.HOME !== fixture + "/home") throw new Error("需要临时 HOME");
  const cwd = fixture + "/project";
  mkdirSync(cwd);
  const app = App.open(fixture + "/data");
  app.config.agents.ownSandbox.mode = "require";
  const profile = { ...catalogProfile(entry), command: executable };
  // Only dummy login material. Some backends verify it remotely at session/new.
  if (entry.id === "codex") {
    mkdirSync(process.env.HOME + "/.codex");
    writeFileSync(process.env.HOME + "/.codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-fixture" }));
  }
  if (entry.id === "traex") {
    const dir = process.env.HOME + "/.trae/cli";
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/auth.json", JSON.stringify({ auth_mode: "trae", trae: { access_token: "fixture", user_id: "fixture", region: "CN", version: 2 } }));
  }
  const token = entry.account?.tokenEnv;
  if (token) profile.env = { ...profile.env, [token]: "fixture" };
  if (entry.id === "grok") {
    mkdirSync(process.env.HOME + "/.grok");
    writeFileSync(process.env.HOME + "/.grok/config.toml", '[model]\napi_key = "xai-fixture"\n');
  }
  const box = ownRun(app, profile, cwd, false).box;
  if (!box) throw new Error("需要本人沙箱");
  const acp = entry.id === "doubao-cli" ? doubaoAcpProfile(profile) : profile;
  const child = launch(acp.command, acp.args, { cwd, ownSandbox: box, env: profile.env });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  const closed = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("close", code => reject(new Error(`进程退出 ${code} ${stderr.trim().slice(-300)}`)));
  });
  const connection = new ClientSideConnection(() => ({
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  let stage = "initialize";
  try {
    const init = await Promise.race([connection.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "omem", version: "0.0.1" } }), closed]);
    if (init.protocolVersion !== 1) throw new Error("initialize 返回了其他协议版本");
    console.log(entry.id, "initialize OK");
    stage = "session/new";
    const session = await Promise.race([connection.newSession({ cwd, mcpServers: [] }), closed]);
    if (!session.sessionId) throw new Error("session/new 缺少 sessionId");
    console.log(entry.id, "session/new OK");
  } catch (error) {
    console.error(entry.id, stage, error instanceof Error ? error.message : String(error), stderr.trim().slice(-300));
    process.exitCode = 1;
  } finally {
    stop(child);
    app.db.close();
  }
}

const ids = process.argv.slice(2);
if (ids[0] === "--fixture") {
  await check(catalog.find(e => e.id === ids[1])!, ids[2]);
} else {
  const entries = ids.length ? ids.map(id => {
    const e = catalog.find(e => e.id === id);
    if (!e) throw new Error("未知的 ACP 后端：" + id);
    return e;
  }) : catalog;
  for (const entry of entries) {
    const command = entry.id === "doubao-cli" ? doubaoExecutable(catalogProfile(entry)) : entry.command;
    const installed = resolveCommand(command);
    if (!installed) {
      console.log(entry.id, "跳过（PATH 中没有 " + entry.command + "）");
      continue;
    }
    // Disposable outer mount and network namespaces also cover setup before the normal ownRun/launch.
    const result = spawnSync("bwrap", ["--die-with-parent", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/var/tmp", "--dir", fixture + "/home",
      "--", process.execPath, import.meta.filename, "--fixture", entry.id, installed.file], {
      env: { PATH: process.env.PATH, HOME: fixture + "/home", TMPDIR: "/var/tmp", LANG: "C.UTF-8", DBUS_SESSION_BUS_ADDRESS: "disabled:" },
      timeout: 60_000, killSignal: "SIGKILL", stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(entry.id, result.error?.message ?? "未建成会话");
      process.exitCode = 1;
    }
  }
}
