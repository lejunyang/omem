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
  plugin?: string;
  pluginName?: string;
  /** Names to inherit from the host environment; values are never stored in the manifest. */
  envNames?: string[];
  /**
   * Settings the agent takes when it starts, as a JSON object in an environment variable (`env`), and the keys
   * its model and thinking level go by there. A run that names a model or a level writes them in, so the
   * session starts on them whatever the agent's model catalog lists at that moment (acp.ts openAcp).
   */
  launchConfig?: { env: string; model?: string; effort?: string };
  egressHosts?: string[];
  id: string;
  name: string;
  command: string;
  args?: string[];
  /** Archive via the same executable when the ACP agent does not advertise session/delete. */
  archiveArgs?: string[];
  sessionHistory?: AgentProfile["sessionHistory"];
  env?: Record<string, string>;
  /** npm package that provides `command` (enables `npm i -g` / npx in setup). */
  npm?: string;
  /** Install hint when there is no npm package. */
  install?: string;
  model?: string;
  effort?: string;
  /** Earlier default args: a saved profile still using one of them gets the current `args`. */
  previousArgs?: string[][];
  /**
   * How the plan's usage limits of the logged-in account can be read (agents/quota.ts):
   * `codex-app-server` asks `codex app-server` (account/rateLimits/read), `claude-usage` runs the
   * local `/usage` command in an ACP session. Accounts behind an API key have none.
   */
  quota?: "codex-app-server" | "claude-usage";
  /**
   * Where the agent finds its own skills (agent-skills.ts takes them over when the owner turns that
   * on): `read` every folder it loads, `write` the one omem puts the omem guide and the group hubs in
   * (one per agent, so an agent reading two folders does not see them twice). `~` and
   * `${VAR:-default}` are expanded.
   */
  skills?: { read: string[]; write: string };
  /**
   * Each omem user can run this backend with an account of their own (docs/v2/agent-accounts.md):
   * the user's account folder is the HOME of a sandbox the agent starts in (agents/sandbox.ts). Only
   * backends with this field take part; everything that differs between them is written here.
   */
  account?: AccountSpec;
};

export type AccountSpec = {
  /** The command that logs in, checks and logs out, when not `command` (the ACP adapter is another program). `~` and `${VAR:-default}` expand. */
  cli?: string;
  /** Set at launch; `{home}` is the user's account folder (the sandbox's HOME). */
  env: Record<string, string>;
  /** Made beforehand under the account folder, 0700 (socket and temp folders). */
  dirs?: string[];
  /** This machine's installs the sandbox sees read-only (`~` and `${VAR:-default}` are the service's own). */
  mounts?: string[];
  /** What under the account folder belongs to this backend: removed when the user logs out of it. */
  owns: string[];
  /** Logging in without a screen: arguments, and patterns that find the link and the code in what it prints. */
  login?: { args: string[]; url: string; code?: string; timeoutMs?: number };
  /** Exit code 0 is logged in; `user` finds the account name in the output. */
  status?: { args: string[]; user?: string };
  logout?: { args: string[] };
  /** A long-lived token can stand in for a login: the variable it goes in (kept in omem's vault, per user). */
  tokenEnv?: string;
};

// Patterns for what device logins print. Best effort: the first https link, a code like ABCD-1234.
const LOGIN_URL = "https://[^\\s\"'<>]+";
const DEVICE_CODE = "\\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\\b";

export const acpCatalog: CatalogEntry[] = [
  {
    id: "codex", launchConfig: { env: "CODEX_CONFIG", model: "model", effort: "model_reasoning_effort" }, egressHosts: ["api.openai.com","chatgpt.com","auth.openai.com"], name: "Codex", command: "codex-acp", npm: "@agentclientprotocol/codex-acp", model: "gpt-6.1-sol", effort: "low", sessionHistory: { format: "codex-rollout", root: "~/.codex", env: "CODEX_HOME" }, quota: "codex-app-server", skills: { read: ["${CODEX_HOME:-~/.codex}/skills", "~/.agents/skills"], write: "~/.agents/skills" },
    account: { cli: "codex", env: { CODEX_HOME: "{home}/.codex" }, dirs: [".codex"], owns: [".codex"], login: { args: ["login", "--device-auth"], url: LOGIN_URL, code: DEVICE_CODE, timeoutMs: 900_000 }, status: { args: ["login", "status"], user: "(?:as|account:?)\\s+([^\\s()]+@[^\\s()]+|[^\\s()]+)" }, logout: { args: ["logout"] } },
  },
  // headless_queue_status: traex reports the provider queue as session_info_update._meta.trae.queueStatus.
  {
    id: "traex", name: "TraeX", command: "traex", args: ["acp", "serve", "-c", "features.headless_queue_status=true"], archiveArgs: ["archive"], previousArgs: [["acp", "serve"]], model: "gpt-6.1-sol", effort: "low", install: "安装 TraeX CLI", skills: { read: ["${TRAE_HOME:-~/.trae}/skills", "~/.agents/skills"], write: "~/.agents/skills" },
    // Its socket folder and temp folder must be private (0700) and not links.
    account: { env: { TRAE_HOME: "{home}/.trae", XDG_RUNTIME_DIR: "{home}/.run", TMPDIR: "{home}/.tmp" }, dirs: [".trae", ".run", ".tmp"], owns: [".trae"], login: { args: ["login", "--sso-device"], url: LOGIN_URL, code: DEVICE_CODE, timeoutMs: 900_000 }, status: { args: ["login", "status"], user: "(?:as|user:?|account:?)\\s+([^\\s()]+)" }, logout: { args: ["logout"] } },
  },
  {
    id: "claude", egressHosts: ["api.anthropic.com","platform.claude.com"], name: "Claude Code", command: "claude-agent-acp", npm: "@agentclientprotocol/claude-agent-acp", quota: "claude-usage", skills: { read: ["${CLAUDE_CONFIG_DIR:-~/.claude}/skills"], write: "${CLAUDE_CONFIG_DIR:-~/.claude}/skills" },
    // `claude setup-token` prints a long-lived token on the person's own machine; pasted here, it goes in the vault.
    account: { cli: "claude", env: { CLAUDE_CONFIG_DIR: "{home}/.claude" }, dirs: [".claude"], owns: [".claude", ".claude.json"], tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN", status: { args: ["auth", "status"], user: "([^\\s\"]+@[^\\s\"]+)" } },
  },
  { id: "gemini", egressHosts: ["generativelanguage.googleapis.com","cloudcode-pa.googleapis.com","oauth2.googleapis.com"], name: "Gemini CLI", command: "gemini", args: ["--acp"], npm: "@google/gemini-cli" },
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

/**
 * Backends that are not ACP agents but can run with each user's own account: the Doubao CLI
 * (agents/doubao-cli.ts). Its native program starts from this machine's install by absolute path,
 * so that install is mounted read-only; its data and login go under the user's account folder.
 */
export const accountOnlyCatalog: CatalogEntry[] = [
  {
    id: "doubao-cli", name: "豆包 (CLI)", command: "doubao", install: "npm i -g @bytedance/doubao-cli",
    account: {
      cli: "${XDG_DATA_HOME:-~/.local/share}/doubao_cli/app/current/doubao",
      env: { XDG_DATA_HOME: "{home}/.local/share" },
      dirs: [".local/share"],
      mounts: ["${XDG_DATA_HOME:-~/.local/share}/doubao_cli/app"],
      owns: [".local/share/doubao_cli"],
      login: { args: ["login", "--qr=full"], url: LOGIN_URL, timeoutMs: 600_000 },
      status: { args: ["auth", "status"] },
    },
  },
];

const pluginDeclarations = new Map<string, CatalogEntry>();
const pluginOrigins = new Map<string, CatalogEntry>();
export function declarePluginBackends(plugin: string, name: string, entries: CatalogEntry[]) {
  for (const [id, e] of pluginDeclarations) if (e.plugin === plugin) pluginDeclarations.delete(id);
  for (const e of entries) {
    const entry = { ...e, id: `${plugin}:${e.id}`, plugin, pluginName: name };
    pluginDeclarations.set(entry.id, entry);
    pluginOrigins.set(entry.id, entry);
  }
}
export function registerPluginBackends(plugin: string) {
  const entries = [...pluginDeclarations.values()].filter(e => e.plugin === plugin);
  acpCatalog.push(...entries);
  return () => {
    for (const e of entries) {
      const i = acpCatalog.indexOf(e);
      if (i >= 0) acpCatalog.splice(i, 1);
    }
  };
}
export function pluginBackendStatus(profile: Pick<AgentProfile, "id" | "source" | "plugin">) {
  const id = profile.source ?? profile.id, e = pluginOrigins.get(id);
  if (!e && !profile.plugin) return undefined;
  const available = !!e && acpCatalog.some(c => c.id === id && c.plugin === e.plugin);
  return { plugin: e?.plugin ?? profile.plugin!, name: e?.pluginName ?? profile.plugin!, available, ...(!available && { reason: "这个后端来自已停用或未信任的插件" }) };
}
export class PluginBackendUnavailable extends Error {}
export function requirePluginBackend(profile: Pick<AgentProfile, "id" | "source" | "plugin" | "peer">) {
  const status = !profile.peer && pluginBackendStatus(profile);
  if (status && !status.available) throw new PluginBackendUnavailable(status.reason);
}
export function referencedPluginProfiles(ids: Set<string>) {
  return [...pluginOrigins.values()].filter(e => ids.has(e.id)).map(catalogProfile);
}

/**
 * Every backend that can run with a user's own account: the catalog's, then the owner's own profiles
 * (`agents.profiles`) that carry an `account` — keyed by their source, so one replaces a catalog entry
 * of the same id. A device's agent or an API key never takes part.
 */
export function accountCatalog(profiles: AgentProfile[] = []): (CatalogEntry & { account: AccountSpec })[] {
  const out = [...acpCatalog, ...accountOnlyCatalog].filter((e): e is CatalogEntry & { account: AccountSpec } => !!e.account);
  for (const p of profiles) {
    if (!p.account || p.peer || p.keyRef || p.transport === "doubao") continue;
    const id = p.source ?? p.id;
    const entry = { id, name: p.name ?? p.id, command: p.command, account: p.account as AccountSpec };
    const at = out.findIndex((e) => e.id === id);
    if (at >= 0) out[at] = { ...out[at], ...entry, name: out[at].name };
    else out.push(entry);
  }
  return out;
}

export function catalogProfile(e: CatalogEntry): AgentProfile {
  return {
    id: e.id,
    name: `${e.name} (ACP)`,
    transport: "acp",
    command: e.command,
    args: e.args ?? [],
    archiveArgs: e.archiveArgs,
    sessionHistory: e.sessionHistory,
    model: e.model,
    effort: e.effort,
    env: e.env ?? {},
    ...(e.plugin && { source: e.id, plugin: e.plugin }),
    idleTimeoutMs: 600_000,
  };
}

export function entryForProfile(profile: Pick<AgentProfile, "source" | "id" | "command">, entries = [...acpCatalog, ...accountOnlyCatalog]) {
  return entries.find(e => e.id === (profile.source ?? profile.id))
    ?? entries.find(e => !e.plugin && (e.command === profile.command || e.account?.cli === profile.command));
}

/** A saved profile with the catalog's current default args when it still has an earlier default. */
export function upgradeProfileArgs(p: AgentProfile): AgentProfile {
  const e = p.transport === "acp" ? entryForProfile(p, acpCatalog) : undefined;
  const previous = e?.previousArgs?.some((a) => a.length === p.args.length && a.every((v, i) => v === p.args[i]));
  return e ? { ...p, args: previous ? e.args ?? [] : p.args, archiveArgs: p.archiveArgs ?? e.archiveArgs, sessionHistory: p.sessionHistory ?? e.sessionHistory } : p;
}

/**
 * The environment variable that starts this profile's agent on a model and a thinking level, when its catalog
 * entry declares one (`launchConfig`). What the profile's own env already puts there is kept; a value there
 * that is not a JSON object is left alone.
 */
export function launchConfigEnv(profile: Pick<AgentProfile, "id" | "source" | "command" | "env">, want: { model?: string | null; effort?: string | null }): Record<string, string> {
  const spec = entryForProfile(profile)?.launchConfig;
  if (!spec) return {};
  let base: Record<string, unknown> = {};
  const given = profile.env?.[spec.env];
  if (given) {
    try {
      const parsed: unknown = JSON.parse(given);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      base = parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const next = { ...base };
  if (spec.model && want.model && next[spec.model] === undefined) next[spec.model] = want.model;
  if (spec.effort && want.effort && next[spec.effort] === undefined) next[spec.effort] = want.effort;
  return Object.keys(next).length === Object.keys(base).length ? {} : { [spec.env]: JSON.stringify(next) };
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
