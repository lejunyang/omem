import { existsSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withAgentPath } from "../core/tools.ts";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { expandPath } from "./accounts.ts";
import { acpCatalog, accountOnlyCatalog } from "./catalog.ts";
import { sourceOf } from "./capacity.ts";
import { backendCapabilities } from "./capabilities.ts";
import { accountOf, omemInstallDir, sandboxSupport, type WorkspaceMounts } from "./sandbox.ts";
import { resolveCommand } from "./spawn.ts";
import { doubaoExecutable } from "./doubao-cli.ts";
import { cachePaths, canonical, normalizeSandbox, ownMounts, selectOwnSandbox, shortPath, under, type OwnSandbox } from "./own-sandbox.ts";

function backendState(profile?: AgentProfile) {
  const layout = profile && (profile.stateLayout ?? sourceOf(profile));
  const entry = [...acpCatalog, ...accountOnlyCatalog].find(e => e.id === layout);
  const env = { ...process.env, ...profile?.env };
  const history = profile?.sessionHistory ?? entry?.sessionHistory;
  const account = profile?.account ?? entry?.account;
  const owned = entry?.statePaths || history ? [] : account?.owns ?? [];
  const paths = [...(entry?.statePaths ?? owned.filter(p => account?.dirs?.includes(p)).map(p => join("~", p))), ...(entry?.skills ? [entry.skills.write] : [])];
  if (history) paths.push((history.env && env[history.env]) || history.root);
  const optional = [...(entry?.stateFiles ?? []), ...owned.filter(p => !account?.dirs?.includes(p)).map(p => join("~", p))];
  return { mounts: entry?.account?.mounts ?? [], dirs: [...new Set(paths.map(path => expandPath(path, env)))], existing: optional.map(path => expandPath(path, env)).filter(existsSync) };
}

/** Missing directories are created at launch. Their closest existing parent must allow a directory there. */
function checkStateDirectory(path: string) {
  let dir = path;
  while (!lstatSync(dir, { throwIfNoEntry: false })) dir = dirname(dir);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error("沙箱状态路径需要目录：" + dir);
}

type MountContext = { workspace?: (readOnly: boolean) => WorkspaceMounts | undefined; inbox?: string; env?: NodeJS.ProcessEnv };

export function ownRun(app: App, profile: AgentProfile, cwd: string, readOnly: boolean, runId?: string | null, context: MountContext = {}): { box?: OwnSandbox; note?: string } {
  const settings = app.config.agents.ownSandbox;
  const local = !profile.peer && backendCapabilities(profile).where === "local";
  const selected = selectOwnSandbox(settings.mode, local, !!accountOf(profile), sandboxSupport);
  if (!selected.active) return { note: selected.reason };
  const box = planRun(app, profile, cwd, readOnly, runId, context, settings);
  return { box, note: "在 omem 沙箱里。可写：" + [...box.plan.rw.map(p => shortPath(p, box.home)), "/tmp（本轮临时目录）"].join("、") + "。写别处会失败，要放开在 设置 → 安全 里加可写目录。" };
}

function planRun(app: App, profile: AgentProfile | undefined, cwd: string, readOnly: boolean, runId: string | null | undefined, context: MountContext, settings: App["config"]["agents"]["ownSandbox"]): OwnSandbox {
  const home = canonical(homedir());
  const data = canonical(app.home);
  const { dirs, existing, mounts } = backendState(profile);
  const config = normalizeSandbox({ ...settings, writable: [...settings.writable, ...existing] }, home, data);
  const state = [...dirs, ...cachePaths.map(p => join(home, p))];
  const checked = normalizeSandbox({ ...config, writable: state }, home, data);
  for (const dir of checked.writable) checkStateDirectory(dir);
  for (const file of existing) {
    if (!statSync(file).isFile()) throw new Error("沙箱状态文件需要普通文件：" + file);
  }
  const runtime = [join(data, "bin"), join(data, "library", "_skills"), omemInstallDir(), dirname(dirname(process.execPath)),
    ...mounts.map(p => expandPath(p))].map(canonical);
  const box = { home, data, state: checked.writable, writable: config.writable, hidden: config.hidden, runtime,
    artifactDir: runId ? join(data, "artifacts", "inbox", runId) : undefined,
    runDir: runId ? join(canonical(app.runsDir), runId, "scratch") : undefined,
    readOnly, snapshot: runId ? join(canonical(app.runsDir), runId, "snap") : undefined,
    secretEnv: [app.config.lark.appSecretEnv, app.config.telegram.tokenEnv, app.config.onebot.tokenEnv, app.config.embeddings.provider === "openai" ? app.config.embeddings.apiKeyEnv : undefined, "LARKSUITE_CLI_APP_SECRET"].filter((s): s is string => !!s) };
  const dir = canonical(cwd);
  if (dir !== data && under(dir, data) && !["library", "workspaces", "runs", "repos"].some(d => dir.startsWith(join(data, d) + "/")))
    throw new Error("工作目录位于 omem 私有数据内，不能挂回沙箱");
  if (!readOnly && ([home, data, "/tmp"].some(p => under(p, dir)) || dir === "/"))
    throw new Error("工作目录范围太大，不能在本人沙箱中授予写权限");
  const exe = profile?.transport === "doubao-cli" ? doubaoExecutable(profile) : profile?.command;
  const program = exe ? resolveCommand(exe, withAgentPath({ ...process.env, ...profile?.env, ...context.env })) : null;
  return { ...box, plan: ownMounts(box, dir, context.workspace?.(readOnly), context.inbox, program) };
}

export function sandboxStatus(app: App, config = app.config) {
  const home = canonical(homedir()), data = canonical(app.home);
  const sample = join(data, "workspaces", "example", "1");
  const profiles = allProfiles(config).filter(p => !p.peer && backendCapabilities(p).where === "local");
  const backends = profiles.map(p => {
    const state = backendState(p);
    return { id: p.id, state: [...state.dirs, ...state.existing] };
  });
  const example = backends.find(p => p.state.length) ?? backends[0];
  const { plan } = planRun(app, profiles.find(p => p.id === example?.id), sample, false, "example",
    { inbox: join(data, "artifacts", "inbox", "example") }, { mode: "off", writable: [], hidden: [] });
  return { ...config.agents.ownSandbox, fullAccess: config.agents.fullAccess, support: sandboxSupport(), backends,
    defaults: { exampleBackend: example?.id, writable: [...plan.rw, "/tmp"], hidden: [data] },
    visibility: "默认只管住写。本人 HOME 中的文件可读，要隐藏的目录请加到 hidden。成员自有账号另行隔离，云端和其他设备不在这台的沙箱里。",
    warning: config.agents.fullAccess === "all" ? "没进沙箱的运行不受任何限制（指后端的沙箱和审批）。omem 工具授权与命令垫片照常检查。" : undefined };
}
