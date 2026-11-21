import type { App } from "../core/app.ts";
import { allProfiles } from "../core/config.ts";
import { findPeer, listPeers, peerFetch } from "../core/peers.ts";
import { HttpError } from "../core/util.ts";
import type { WorkInventory } from "./peer-work.ts";
import type { Execution } from "./execution.ts";

export type Destination = { device?: string; mode?: "borrow" | "remote"; access?: "read" | "write" };
export type BoardDevice = { device: string; mode: "borrow" | "remote"; access: "read" | "write"; backend?: string };

export async function workCommand<T>(app: App, device: string, command: string, args: unknown, timeoutMs = 10000): Promise<T> {
  const res = await peerFetch(app, device, "/api/peer/exec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({command,args}), timeoutMs });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as {error?: string};
    throw new HttpError(res.status, `${device}：${detail.error ?? res.statusText}`);
  }
  return ((await res.json()) as { result: T }).result;
}

export async function workDevices(app: App, user: string) {
  if (user !== "owner") return [];
  const results = await Promise.allSettled(listPeers(app).slice(0,50).map(async p => {
    const info = await workCommand<WorkInventory>(app,p.id,"work-info",{},3000);
    return { ...info, device: p.id, name: p.back?.name ?? p.id, backendCount: info.backends.length, free: info.backends.reduce((n,b) => n+b.free,0), repoCount: info.repos.length };
  }));
  return results.flatMap(r => r.status === "fulfilled" && r.value.version === 1 ? [r.value] : []);
}

export async function selectDevice(app: App, target: Destination, user: string, space: string, execution?: Execution): Promise<BoardDevice | undefined> {
  const { device, mode = "borrow", access = "read" } = target;
  if (!device || device === "local") {
    if (mode === "remote" || access === "write") throw new HttpError(400,"要对方环境时请指定设备");
    return;
  }
  if (user !== "owner") throw new HttpError(403, "当前配对未映射这位发起人");
  if (!findPeer(app,device)) throw new HttpError(400,`设备 ${device} 未配对`);
  if (mode === "borrow" && access !== "read") throw new HttpError(400,"借后端只接只读调查");
  let info: WorkInventory;
  try { info = await workCommand(app,device,"work-info",{target:{space,access},remote:mode === "remote"}); }
  catch (e) { throw new HttpError(400,`无法派到 ${device}：${(e as Error).message}`); }
  if (info.version !== 1) throw new HttpError(400,`${device} 的派单协议版本不兼容`);
  if (!info.backends.length) throw new HttpError(400,`${device} 没有可用的 ACP 后端`);
  if (mode === "remote") return { device, mode, access };
  const alias = allProfiles(app.config).find(p => p.id === execution?.profile && p.peer?.id === device);
  const backend = execution ? info.backends.find(b => b.id === (alias?.peer?.agent ?? execution.profile)) : info.backends.sort((a,b) => b.free-a.free)[0];
  if (!backend) throw new HttpError(400,`${device} 没有所选后端 ${execution?.profile}`);
  return { device, mode, access, backend: backend.id };
}
