import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import type { AgentProfile } from "../core/config.ts";
import { commandExists } from "./spawn.ts";

/**
 * Known ACP agents. Each runs as a local command speaking ACP over stdio;
 * omem only needs the command and its ACP arguments. `npm` / `install` are
 * hints for setup; agents not listed here can be added from the official
 * ACP registry (`omem agents registry`) or by hand in config.agents.profiles.
 */
export type CatalogEntry = {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** npm package that provides `command` (enables `npm i -g` / npx in setup). */
  npm?: string;
  /** Install hint when there is no npm package. */
  install?: string;
  model?: string;
  effort?: string;
  /** Earlier default args: a saved profile still using one of them gets the current `args`. */
  previousArgs?: string[][];
};

export const acpCatalog: CatalogEntry[] = [
  { id: "codex", name: "Codex", command: "codex-acp", npm: "@agentclientprotocol/codex-acp", model: "gpt-6.1-sol", effort: "low" },
  // headless_queue_status: traex reports the provider queue as session_info_update._meta.trae.queueStatus.
  { id: "traex", name: "TraeX", command: "traex", args: ["acp", "serve", "-c", "features.headless_queue_status=true"], previousArgs: [["acp", "serve"]], model: "gpt-6.1-sol", effort: "low", install: "安装 TraeX CLI" },
  { id: "claude", name: "Claude Code", command: "claude-agent-acp", npm: "@agentclientprotocol/claude-agent-acp" },
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], npm: "@google/gemini-cli" },
  { id: "copilot", name: "GitHub Copilot CLI", command: "copilot", args: ["--acp"], npm: "@github/copilot" },
  { id: "qwen", name: "Qwen Code", command: "qwen", args: ["--acp"], npm: "@qwen-code/qwen-code" },
  { id: "cursor", name: "Cursor Agent", command: "cursor-agent", args: ["acp"], install: "curl https://cursor.com/install -fsS | bash（Windows 见 cursor.com/cli）" },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"], npm: "opencode-ai" },
  { id: "goose", name: "goose", command: "goose", args: ["acp"], install: "见 block.github.io/goose 安装说明" },
  { id: "kimi", name: "Kimi CLI", command: "kimi", args: ["acp"], install: "uv tool install kimi-cli" },
  { id: "kilo", name: "Kilo", command: "kilo", args: ["acp"], npm: "@kilocode/cli" },
  { id: "auggie", name: "Auggie (Augment)", command: "auggie", args: ["--acp"], env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" }, npm: "@augmentcode/auggie" },
  { id: "cline", name: "Cline", command: "cline", args: ["--acp"], npm: "cline" },
  { id: "codebuddy", name: "CodeBuddy Code", command: "codebuddy", args: ["--acp"], npm: "@tencent-ai/codebuddy-code" },
  { id: "qoder", name: "Qoder CLI", command: "qodercli", args: ["--acp"], npm: "@qoder-ai/qodercli" },
  { id: "iflow", name: "iFlow CLI", command: "iflow", args: ["--experimental-acp"], npm: "@iflow-ai/iflow-cli" },
  {
    id: "droid",
    name: "Factory Droid",
    command: "droid",
    args: ["exec", "--output-format", "acp-daemon"],
    env: { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    npm: "droid",
  },
  { id: "grok", name: "Grok Build", command: "grok", args: ["agent", "stdio"], npm: "@xai-official/grok" },
  { id: "minimax", name: "MiniMax Code", command: "mcode", args: ["acp"], npm: "@minimax-ai/code" },
  { id: "amp", name: "Amp", command: "amp-acp", npm: "amp-acp" },
  { id: "vibe", name: "Mistral Vibe", command: "vibe-acp", install: "uv tool install mistral-vibe" },
  { id: "junie", name: "Junie (JetBrains)", command: "junie", args: ["--acp=true"], install: "见 jetbrains.com/junie" },
  { id: "devin", name: "Devin", command: "devin", args: ["acp"], install: "见 devin.ai/cli" },
  { id: "pi", name: "pi", command: "pi-acp", npm: "pi-acp" },
  { id: "deepagents", name: "DeepAgents", command: "deepagents-acp", npm: "deepagents-acp" },
];

export function catalogProfile(e: CatalogEntry): AgentProfile {
  return {
    id: e.id,
    name: `${e.name} (ACP)`,
    transport: "acp",
    command: e.command,
    args: e.args ?? [],
    model: e.model,
    effort: e.effort,
    env: e.env ?? {},
    idleTimeoutMs: 600_000,
  };
}

/** A saved profile with the catalog's current default args when it still has an earlier default. */
export function upgradeProfileArgs(p: AgentProfile): AgentProfile {
  const e = acpCatalog.find((x) => x.command === p.command && x.previousArgs?.some((a) => a.length === p.args.length && a.every((v, i) => v === p.args[i])));
  return e ? { ...p, args: e.args ?? [] } : p;
}

export function catalogEntry(id: string) {
  return acpCatalog.find((e) => e.id === id);
}

/** Profile that runs an npm-published agent through npx without a global install. */
export function npxProfile(e: CatalogEntry): AgentProfile {
  if (!e.npm) throw new Error(`${e.id} 没有 npm 包`);
  return { ...catalogProfile(e), command: "npx", args: ["-y", e.npm, ...(e.args ?? [])] };
}

export function installHint(e: CatalogEntry) {
  return e.npm ? `npm i -g ${e.npm}` : (e.install ?? "");
}

// ---- official ACP registry --------------------------------------------------

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

type Launch = { package?: string; args?: string[]; env?: Record<string, string> };
type BinaryTarget = { archive: string; cmd: string; args?: string[]; env?: Record<string, string>; sha256?: string };
export type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description?: string;
  website?: string;
  repository?: string;
  distribution: { npx?: Launch; uvx?: Launch; binary?: Record<string, BinaryTarget> };
};

export async function fetchRegistry(url = REGISTRY_URL): Promise<RegistryAgent[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`读取 ACP 注册表失败：HTTP ${res.status}`);
  const data = (await res.json()) as { agents?: RegistryAgent[] };
  return data.agents ?? [];
}

export function platformKey(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${os}-${cpu}`;
}

export type RegistryOption =
  | { kind: "npx" | "uvx"; profile: AgentProfile; available: boolean }
  | { kind: "binary"; target: BinaryTarget; available: boolean };

/** Ways to run a registry agent on this machine, best first. */
export function registryOptions(agent: RegistryAgent, platform = platformKey()): RegistryOption[] {
  const base = { id: agent.id, name: `${agent.name} (ACP)`, transport: "acp" as const, idleTimeoutMs: 600_000 };
  const out: RegistryOption[] = [];
  const d = agent.distribution;
  const bin = d.binary?.[platform];
  if (bin) out.push({ kind: "binary", target: bin, available: true });
  if (d.npx?.package)
    out.push({ kind: "npx", available: commandExists("npx"), profile: { ...base, command: "npx", args: ["-y", d.npx.package, ...(d.npx.args ?? [])], env: d.npx.env ?? {} } });
  if (d.uvx?.package)
    out.push({ kind: "uvx", available: commandExists("uvx"), profile: { ...base, command: "uvx", args: [d.uvx.package, ...(d.uvx.args ?? [])], env: d.uvx.env ?? {} } });
  // A local install of the same agent beats both npx and a download.
  return out.sort((a, b) => Number(b.available) - Number(a.available) || (a.kind === "binary" ? 1 : 0) - (b.kind === "binary" ? 1 : 0));
}

/**
 * Download and unpack a registry binary into <home>/agents/<id>/<version>,
 * checking sha256 when the registry gives one. Returns a ready profile.
 */
export async function installRegistryBinary(agent: RegistryAgent, target: BinaryTarget, home: string, log: (s: string) => void = () => {}): Promise<AgentProfile> {
  const dir = resolve(home, "agents", agent.id, agent.version);
  const cmd = resolve(dir, target.cmd);
  if (!existsSync(cmd)) {
    mkdirSync(dir, { recursive: true });
    log(`下载 ${target.archive}`);
    const res = await fetch(target.archive, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (target.sha256) {
      const got = createHash("sha256").update(buf).digest("hex");
      if (got !== target.sha256.toLowerCase()) throw new Error(`校验失败：sha256 ${got} ≠ ${target.sha256}`);
    }
    const name = basename(new URL(target.archive).pathname);
    const file = join(dir, name);
    writeFileSync(file, buf);
    extract(file, dir);
    if (/\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz)$/i.test(name)) rmSync(file, { force: true });
    else if (!existsSync(cmd)) renameSync(file, cmd); // bare executable
    if (!existsSync(cmd)) throw new Error(`解压后找不到 ${target.cmd}（目录内容：${readdirSync(dir).join(", ")}）`);
  }
  if (process.platform !== "win32") chmodSync(cmd, 0o755);
  return { id: agent.id, name: `${agent.name} (ACP)`, transport: "acp", command: cmd, args: target.args ?? [], env: target.env ?? {}, idleTimeoutMs: 600_000 };
}

function extract(file: string, dir: string) {
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, stdio: "ignore", windowsHide: true }).status === 0;
  if (/\.(tar\.gz|tgz|tar\.bz2|tar\.xz)$/i.test(file)) {
    if (!run("tar", ["-xf", file, "-C", dir])) throw new Error("tar 解压失败");
  } else if (/\.zip$/i.test(file)) {
    // Windows' tar.exe (bsdtar) reads zip; elsewhere use unzip.
    const ok =
      (process.platform === "win32" && run("tar", ["-xf", file, "-C", dir])) ||
      (commandExists("unzip") && run("unzip", ["-oq", file, "-d", dir])) ||
      (process.platform === "win32" && run("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${file}' -DestinationPath '${dir}'`]));
    if (!ok) throw new Error("zip 解压失败（请安装 unzip）");
  }
}
