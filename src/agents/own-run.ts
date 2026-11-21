import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { expandPath } from "./accounts.ts";
import { acpCatalog, accountOnlyCatalog, type CatalogEntry } from "./catalog.ts";
import { sourceOf } from "./capacity.ts";
import { backendCapabilities } from "./capabilities.ts";
import { accountOf, omemInstallDir, sandboxSupport } from "./sandbox.ts";
import { cachePaths, canonical, normalizeSandbox, ownMounts, selectOwnSandbox, shortPath, under, type OwnSandbox } from "./own-sandbox.ts";

export function backendState(entry?: CatalogEntry, profile?: AgentProfile) {
  const env = { ...process.env, ...profile?.env };
  const history = profile?.sessionHistory ?? entry?.sessionHistory;
  const paths = [...(entry?.statePaths ?? []), ...(entry?.skills ? [entry.skills.write] : [])];
  if (history) paths.push((history.env && env[history.env]) || history.root);
  return [...new Set(paths.map(path => expandPath(path, env)))];
}

export function ownRun(app: App, profile: AgentProfile, cwd: string, readOnly: boolean, runId?: string | null): { box?: OwnSandbox; note?: string } {
  const settings = app.config.agents.ownSandbox;
  const local = !profile.peer && backendCapabilities(profile).where === "local";
  const selected = selectOwnSandbox(settings.mode, local, !!accountOf(profile), sandboxSupport);
  if (!selected.active) return { note: selected.reason };
  const home = canonical(homedir());
  const data = canonical(app.home);
  const config = normalizeSandbox(settings, home, data);
  const entry = [...acpCatalog, ...accountOnlyCatalog].find(e => e.id === sourceOf(profile));
  const state = [...backendState(entry, profile), ...cachePaths.map(p => join(home, p))].filter(existsSync);
  const checked = normalizeSandbox({ ...config, writable: state }, home, data);
  const runtime = [join(data, "bin"), join(data, "library", "_skills"), omemInstallDir(), dirname(dirname(process.execPath)),
    ...(entry?.account?.mounts ?? []).map(p => expandPath(p))].map(canonical);
  const box = { home, data, state: checked.writable, writable: config.writable, hidden: config.hidden, runtime,
    readOnly, snapshot: runId ? join(canonical(app.runsDir), runId, "snap") : undefined,
    secretEnv: [app.config.lark.appSecretEnv, app.config.telegram.tokenEnv, app.config.onebot.tokenEnv, "LARKSUITE_CLI_APP_SECRET"].filter((s): s is string => !!s) };
  const dir = canonical(cwd);
  if (dir !== data && under(dir, data) && !["library", "workspaces", "runs", "repos"].some(d => dir.startsWith(join(data, d) + "/")))
    throw new Error("工作目录位于 omem 私有数据内，不能挂回沙箱");
  if (!readOnly && ([home, data, "/tmp"].some(p => under(p, dir)) || dir === "/"))
    throw new Error("工作目录范围太大，不能在本人沙箱中授予写权限");
  const working = !readOnly || (box.snapshot && under(dir, box.snapshot)) ? [dir] : [];
  const list = [...working, ...box.state, ...box.writable, "/tmp"].filter(p => !box.hidden.some(h => under(p, h))).map(p => shortPath(p, home));
  return { box, note: "在 omem 沙箱里。可写：" + list.join("、") + "及本轮产物。写别处会失败，要放开在 设置 → 安全 里加可写目录。" };
}

export function sandboxStatus(app: App) {
  const home = canonical(homedir()), data = canonical(app.home);
  const sample = join(data, "workspaces", "example", "1");
  const profiles = allProfiles(app.config).filter(p => !p.peer && backendCapabilities(p).where === "local");
  const backends = profiles.map(p => ({
    id: p.id, state: backendState([...acpCatalog, ...accountOnlyCatalog].find(e => e.id === sourceOf(p)), p),
  }));
  const example = backends.find(p => p.state.length) ?? backends[0];
  const plan = ownMounts({ home, data, state: [...cachePaths.map(p => join(home, p)), ...(example?.state ?? [])].filter(existsSync).map(canonical),
    writable: [], hidden: [], runtime: [], readOnly: false, secretEnv: [] }, sample, undefined, join(data, "artifacts", "inbox", "example"));
  return { ...app.config.agents.ownSandbox, fullAccess: app.config.agents.fullAccess, support: sandboxSupport(), backends,
    defaults: { exampleBackend: example?.id, writable: [...plan.rw, "/tmp"], hidden: [data] },
    visibility: "默认只管住写。本人 HOME 中的文件可读，要隐藏的目录请加到 hidden。成员自有账号另行隔离，云端和其他设备不在这台的沙箱里。",
    warning: app.config.agents.fullAccess === "all" ? "没进沙箱的运行不受任何限制（指后端的沙箱和审批）。omem 工具授权与命令垫片照常检查。" : undefined };
}
