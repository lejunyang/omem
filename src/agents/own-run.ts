import { existsSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { withAgentPath } from "../core/tools.ts";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { listAgentSpecs } from "./specs.ts";
import { listRoleStates } from "./builtin-roles.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { checkBackendCommandState } from "./credential-registry.ts";
import { credentialStatePaths } from "./credentials.ts";
import { expandPath } from "./accounts.ts";
import { acpCatalog, accountCatalog, accountOnlyCatalog } from "./catalog.ts";
import { sourceOf } from "./capacity.ts";
import { backendCapabilities } from "./capabilities.ts";
import { accountOf, egressRequested, omemInstallDir, sandboxSupport, type WorkspaceMounts } from "./sandbox.ts";
import { resolveCommand } from "./spawn.ts";
import { doubaoExecutable } from "./doubao-cli.ts";
import { cachePaths, defaultLoginPaths, canonical, normalizeSandbox, ownMounts, shortPath, under, type OwnSandbox } from "./own-sandbox.ts";

function backendState(profile: AgentProfile | undefined, profiles: AgentProfile[]) {
  const layout = profile && (profile.stateLayout ?? sourceOf(profile));
  const entry = [...acpCatalog, ...accountOnlyCatalog].find(e => e.id === layout);
  const env = { ...process.env, ...profile?.env };
  const history = profile?.sessionHistory ?? entry?.sessionHistory;
  const account = profile?.account ?? (layout ? accountCatalog(profiles).find(e => e.id === layout)?.account : undefined);
  const owned = entry?.statePaths || history ? [] : account?.owns ?? [];
  const paths = [...(entry?.statePaths ?? owned.filter(p => account?.dirs?.includes(p)).map(p => join("~", p))), ...(entry?.skills ? [entry.skills.write] : [])];
  if (history) paths.push((history.env && env[history.env]) || history.root);
  const optional = [...(entry?.stateFiles ?? []), ...owned.filter(p => !account?.dirs?.includes(p)).map(p => join("~", p))];
  const dirs = [...new Set(paths.map(path => expandPath(path, env)))];
  const files = optional.map(path => expandPath(path, env));
  // Catalog backends can redirect their machine login through the environment. Custom account
  // declarations also apply to profiles sharing the layout, independently of session history.
  const declared = profile?.account ?? (entry && !entry.plugin ? undefined : account);
  return { mounts: entry?.account?.mounts ?? [], dirs, existing: files.filter(existsSync),
    loginState: [...dirs, ...files, ...(declared?.owns ?? []).map(rel => join(homedir(), rel))] };
}

/** Missing directories are created at launch. Their closest existing parent must allow a directory there. */
function checkStateDirectory(path: string) {
  let dir = path;
  while (!lstatSync(dir, { throwIfNoEntry: false })) dir = dirname(dir);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error("沙箱状态路径需要目录：" + dir);
}

type MountContext = { workspace?: (readOnly: boolean) => WorkspaceMounts | undefined; inbox?: string; env?: NodeJS.ProcessEnv; kind?: string | null; credentialState?: string[] };

export function ownRun(app: App, profile: AgentProfile, cwd: string, readOnly: boolean, runId?: string | null, context: MountContext = {}): { box?: OwnSandbox; note?: string } {
  const settings = app.config.agents.ownSandbox;
  const local = !profile.peer && backendCapabilities(profile).where === "local";
  if (settings.mode === "off" || accountOf(profile)) return {};
  if (!local) return { note: "云端或其他设备上的运行不在这台的沙箱里" };
  // null keeps guest and lending isolation independent of the owner’s rollout filter.
  const kind = context.kind;
  if (kind !== null) {
    if (settings.includeKinds?.length && (!kind || !settings.includeKinds.includes(kind)))
      return { note: "本轮未列入本人沙箱的运行类型：" + (kind ?? "无类型") };
    if (kind && settings.excludeKinds?.includes(kind)) return { note: "按运行类型排除本人沙箱：" + kind };
  }
  // A lent command has its own declaration even if its credential kind is also a backend id.
  const state = backendState(context.credentialState === undefined ? profile : undefined, app.config.agents.profiles);
  if (process.platform === "linux")
    checkBackendCommandState(profile.id, homedir(), state.loginState, app.config.security.protectedCommands);
  const support = sandboxSupport();
  if (!support.ok) {
    const note = "这台机器不能隔离本次运行：" + support.reason;
    if (settings.mode === "require") throw new Error(note);
    return { note };
  }
  const box = planRun(app, profile, cwd, readOnly, runId, context, settings, state);
  return { box, note: "在 omem 沙箱里。可写：" + [...box.plan.rw.map(p => shortPath(p, box.home)), "/tmp（本轮临时目录）"].join("、") + "。写别处会失败，要放开在 设置 → 安全 里加可写目录。" };
}

function planRun(app: App, profile: AgentProfile | undefined, cwd: string, readOnly: boolean, runId: string | null | undefined, context: MountContext, settings: App["config"]["agents"]["ownSandbox"], stateLayout = backendState(profile, app.config.agents.profiles)): OwnSandbox {
  const home = canonical(homedir());
  const data = canonical(app.home);
  const { dirs, existing, mounts } = stateLayout;
  const config = normalizeSandbox(settings, home, data);
  const declared = credentialStatePaths(app);
  // The existing lending executor works in a host-created empty directory and receives only this declaration.
  const grant = (context.credentialState ?? []).map(rel => canonical(join(home, rel))).filter(path => declared.includes(path));
  const state = [...dirs, ...cachePaths.map(p => join(home, p)), ...grant];
  const env = { ...process.env, ...profile?.env, ...context.env };
  const loginFiles = ["SSH_AUTH_SOCK", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_CONFIG", "AZURE_CONFIG_DIR", "DOCKER_CONFIG", "GH_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "GNUPGHOME"]
    .flatMap(key => env[key] || []);
  if (env.KUBECONFIG) loginFiles.push(...env.KUBECONFIG.split(":").filter(Boolean));
  const login = normalizeSandbox({ ...settings, writable: [], hidden: [...(settings.loginPaths ?? defaultLoginPaths),
    ...loginFiles.filter(p => p.startsWith("/") && !p.startsWith("/dev/"))] }, home, data).hidden;
  const masked = [...new Set([...login, ...declared])].filter(path => !grant.includes(path));
  const checked = normalizeSandbox({ ...config, writable: state }, home, data);
  for (const dir of checked.writable) checkStateDirectory(dir);
  for (const file of existing) {
    if (!statSync(file).isFile()) throw new Error("沙箱状态文件需要普通文件：" + file);
  }
  const runtime = [join(data, "bin"), join(data, "library", "_skills"), join(data, "agent-skills", "hubs"), omemInstallDir(), dirname(dirname(process.execPath)),
    ...mounts.map(p => expandPath(p))].map(canonical);
  const isolatedNetwork = !!profile && egressRequested(app.config, profile, true);
  const dependencies = join(omemInstallDir(), "node_modules");
  if (isolatedNetwork && existsSync(dependencies)) runtime.push(canonical(dependencies));
  const box = { home, data, masked, isolatedNetwork, state: checked.writable, stateFiles: normalizeSandbox({ ...settings, writable: existing }, home, data).writable, writable: config.writable, hidden: config.hidden, runtime,
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
    const state = backendState(p, config.agents.profiles);
    return { id: p.id, state: [...state.dirs, ...state.existing] };
  });
  const example = backends.find(p => p.state.length) ?? backends[0];
  // The sandbox's path rules are POSIX. Where paths are not (Windows), no run can enter it and there is no example to work out.
  const writable = sep === "/" ? [...planRun(app, profiles.find(p => p.id === example?.id), sample, false, "example",
    { inbox: join(data, "artifacts", "inbox", "example") }, { mode: "off", writable: [], hidden: [] }).plan.rw, "/tmp"] : [];
  const fullAccessGrants = {
    roles: listRoleStates(app).filter(r => r.overlay.fullAccess).map(r => ({ id: r.name, name: r.description })),
    profiles: listAgentSpecs(app, { includeDrafts: true }).filter(p => p.fullAccess).map(p => ({ id: p.name, name: p.name })),
    rules: all<{ id: string; name: string }>(app.db, `select id,name from rules indexed by rules_full_access
      where instr(json(actions), '"fullAccess":true') > 0 order by id`),
  };
  return { ...config.agents.ownSandbox, home, fullAccessGrants, fullAccess: config.agents.fullAccess, support: sandboxSupport(), backends,
    defaults: { exampleBackend: example?.id, writable, hidden: [data, ...credentialStatePaths(app)], loginPaths: defaultLoginPaths },
    visibility: "默认遮住常用登录文件和凭据插件的状态目录，其他 HOME 文件只读，额外隐藏目录可加到 hidden。成员自有账号另行隔离，云端和其他设备不在这台的沙箱里。",
    warning: config.agents.fullAccess === "all" ? "没进沙箱的运行不受任何限制（指后端的沙箱和审批）。omem 工具授权与命令垫片照常检查。" : undefined };
}
