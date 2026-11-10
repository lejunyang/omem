import { normalizeStoredList } from "./stored-list";

// 连接 omem 的方式。可以存多条、随时切换：
// - local：本机的 omem（默认 http://127.0.0.1:4317）；
// - remote：任意地址（局域网、常驻服务器、网关后面的 omem）；
// - peer：经另一条连接转到它配对的设备（omem 的 /api/peers/<设备>/… 转发），不用单独登录。
// 本机和远程都用 omem 的「命令行登录」换一个 om_ 令牌（docs/v2/remote-clients.md §4.2）：
// 打开确认页，浏览器里已登录的话点一下「允许」即可。令牌只存在扩展自己的 storage 里。

export const CONNECTIONS_STORAGE_KEY = "omem.connections";
export const ACTIVE_CONNECTION_STORAGE_KEY = "omem.connection.active";
export const DEFAULT_LOCAL_URL = "http://127.0.0.1:4317";

export type ConnectionKind = "local" | "remote" | "peer";

export interface OmemConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  /** local / remote：omem 的地址（只有 origin，末尾不带 /） */
  url: string;
  /** local / remote：登录后拿到的 om_ 令牌 */
  token: string;
  /** peer：经哪条连接转发、转到哪台设备 */
  via?: string;
  peer?: string;
  /** 登录的是谁（显示用） */
  user?: { id: string; name: string };
  /** 发送时默认的空间 */
  space?: string;
  createdAt: number;
}

/** 地址只留 origin：用户可能粘贴带路径或 #/ask 的网页地址。没有协议时补 http://。 */
export function normalizeOmemUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("请填写 omem 的地址");
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (!/^https?:$/.test(url.protocol)) throw new Error("只支持 http / https 地址");
  return url.origin;
}

/** 申请访问权限用的匹配模式：只要这个 origin。 */
export function originPattern(url: string): string {
  const { protocol, hostname } = new URL(url);
  // 匹配模式不能带端口：同一主机的所有端口都在内，范围仍然只是这一台主机。
  return `${protocol}//${hostname}/*`;
}

export function normalizeConnections(value: unknown): OmemConnection[] {
  return normalizeStoredList(value).flatMap((item): OmemConnection[] => {
    if (!item || typeof item !== "object") return [];
    const c = item as Record<string, unknown>;
    const kind = c.kind === "local" || c.kind === "remote" || c.kind === "peer" ? c.kind : null;
    if (!kind || typeof c.id !== "string" || typeof c.name !== "string") return [];
    if (kind === "peer" && (typeof c.via !== "string" || typeof c.peer !== "string")) return [];
    if (kind !== "peer" && typeof c.url !== "string") return [];
    const user = c.user && typeof c.user === "object" ? (c.user as { id?: unknown; name?: unknown }) : null;
    return [
      {
        id: c.id,
        name: c.name,
        kind,
        url: typeof c.url === "string" ? c.url : "",
        token: typeof c.token === "string" ? c.token : "",
        ...(kind === "peer" ? { via: c.via as string, peer: c.peer as string } : {}),
        ...(user && typeof user.id === "string" && typeof user.name === "string" ? { user: { id: user.id, name: user.name } } : {}),
        ...(typeof c.space === "string" && c.space ? { space: c.space } : {}),
        createdAt: typeof c.createdAt === "number" ? c.createdAt : Date.now()
      }
    ];
  });
}

export interface ResolvedEndpoint {
  /** 请求前缀：peer 是 <中转的地址>/api/peers/<设备>，其他是地址本身 */
  base: string;
  /** 打开网页用的地址；peer 没有（它的网页要用 omem peer open 在本机转出来，转发路径下的页面请求会落到中转的 omem 上） */
  web: string | null;
  token: string;
  /** 要有访问权限的 origin */
  origin: string;
}

/** 算出一条连接实际请求的地址和凭据；peer 用它所经连接的令牌，那条连接重新登录后自动跟着换。 */
export function resolveEndpoint(connection: OmemConnection, all: OmemConnection[]): ResolvedEndpoint {
  if (connection.kind !== "peer") return { base: connection.url, web: connection.url, token: connection.token, origin: connection.url };
  const via = all.find((item) => item.id === connection.via);
  if (!via || via.kind === "peer") throw new Error(`「${connection.name}」经过的连接已被删除`);
  const base = `${via.url}/api/peers/${encodeURIComponent(connection.peer ?? "")}`;
  return { base, web: null, token: via.token, origin: via.url };
}

export function connectionLabel(connection: OmemConnection, all: OmemConnection[]): string {
  if (connection.kind === "local") return `本机 · ${connection.url.replace(/^https?:\/\//, "")}`;
  if (connection.kind === "remote") return connection.url.replace(/^https?:\/\//, "");
  const via = all.find((item) => item.id === connection.via);
  return `设备 ${connection.peer} · 经 ${via?.name ?? "已删除的连接"}`;
}

export function newConnectionId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
