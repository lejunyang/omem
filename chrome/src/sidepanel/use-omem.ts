import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  CONNECTIONS_STORAGE_KEY,
  DEFAULT_LOCAL_URL,
  newConnectionId,
  normalizeConnections,
  normalizeOmemUrl,
  type OmemConnection,
  originPattern,
  resolveEndpoint
} from "../shared/connections";
import { getStorageItems, setStorageItems } from "../shared/extension-storage";
import {
  browserSession,
  type ClipRequest,
  type ClipResponse,
  type ConversationMessage,
  OmemError,
  type OmemMe,
  type OmemPeer,
  type OmemSpace,
  pollLogin,
  requestFor,
  startLogin
} from "../shared/omem-client";

export type ConnectionStatus = { state: "idle" } | { state: "checking" } | { state: "ok"; me: OmemMe } | { state: "error"; message: string; relogin: boolean };

export interface PendingLogin {
  connectionId: string;
  code: string;
  url: string;
  browserUser: string | null;
}

const LOGIN_CLIENT = "omem 浏览器扩展（Chrome）";

/** 拾取篮里的 omem 连接：存多条、切换、登录、检查状态、列空间和设备、发送。 */
export function useOmem() {
  const connections = shallowRef<OmemConnection[]>([]);
  const activeId = ref<string>("");
  const status = ref<ConnectionStatus>({ state: "idle" });
  const spaces = ref<OmemSpace[]>([]);
  const pending = ref<PendingLogin | null>(null);
  const loaded = ref(false);
  let loginAbort: AbortController | null = null;
  let checkSeq = 0;

  const active = computed(() => connections.value.find((item) => item.id === activeId.value) ?? null);
  const writableSpaces = computed(() => {
    if (status.value.state !== "ok") return [];
    const writes = status.value.me.writes;
    return writes === null ? spaces.value : spaces.value.filter((space) => writes.includes(space.id));
  });
  const space = computed(() => {
    const preferred = active.value?.space;
    return writableSpaces.value.find((item) => item.id === preferred)?.id ?? writableSpaces.value.find((item) => item.id === "personal")?.id ?? writableSpaces.value[0]?.id ?? "";
  });

  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local") return;
    if (CONNECTIONS_STORAGE_KEY in changes) connections.value = normalizeConnections(changes[CONNECTIONS_STORAGE_KEY].newValue);
    if (ACTIVE_CONNECTION_STORAGE_KEY in changes) {
      activeId.value = String(changes[ACTIVE_CONNECTION_STORAGE_KEY].newValue ?? "");
      void check();
    }
  };

  onMounted(async () => {
    const items = await getStorageItems(chrome.storage.local, [CONNECTIONS_STORAGE_KEY, ACTIVE_CONNECTION_STORAGE_KEY]).catch(() => ({}) as Record<string, unknown>);
    connections.value = normalizeConnections(items[CONNECTIONS_STORAGE_KEY]);
    activeId.value = typeof items[ACTIVE_CONNECTION_STORAGE_KEY] === "string" ? (items[ACTIVE_CONNECTION_STORAGE_KEY] as string) : connections.value[0]?.id ?? "";
    loaded.value = true;
    chrome.storage.onChanged.addListener(onStorage);
    await check();
  });
  onBeforeUnmount(() => {
    chrome.storage.onChanged.removeListener(onStorage);
    loginAbort?.abort();
  });

  async function persist(next: OmemConnection[]): Promise<void> {
    connections.value = next;
    // 响应式数组直接存会变成 {"0": …}，先转成普通对象。
    await setStorageItems(chrome.storage.local, { [CONNECTIONS_STORAGE_KEY]: JSON.parse(JSON.stringify(next)) });
  }

  async function update(id: string, patch: Partial<OmemConnection>): Promise<void> {
    await persist(connections.value.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function setActive(id: string): Promise<void> {
    activeId.value = id;
    await setStorageItems(chrome.storage.local, { [ACTIVE_CONNECTION_STORAGE_KEY]: id });
    await check();
  }

  async function setSpace(id: string): Promise<void> {
    if (active.value) await update(active.value.id, { space: id });
  }

  /** 读 /api/me 和空间；连接切换、登录后、出错重试时调用。只采用最新一次的结果。 */
  async function check(): Promise<void> {
    const seq = ++checkSeq;
    const connection = active.value;
    spaces.value = [];
    if (!connection) {
      status.value = { state: "idle" };
      return;
    }
    // 没有令牌就算没登录：本机的 omem 会把不带 Origin 的读请求当成本机网页放行，
    // 读得到 /api/me 不代表写得进去（写请求带着扩展的 Origin，会被拒绝）。
    if (connection.kind !== "peer" && !connection.token) {
      status.value = { state: "error", message: "还没有登录", relogin: true };
      return;
    }
    status.value = { state: "checking" };
    try {
      const request = requestFor(connection, connections.value);
      const [me, list] = await Promise.all([request<OmemMe>("/api/me"), request<OmemSpace[]>("/api/spaces")]);
      if (seq !== checkSeq) return;
      spaces.value = list.map((item) => ({ id: item.id, name: item.name }));
      status.value = { state: "ok", me };
    } catch (error) {
      if (seq !== checkSeq) return;
      const relogin = error instanceof OmemError && error.status === 401;
      const noToken = connection.kind !== "peer" && !connection.token;
      status.value = { state: "error", message: noToken ? "还没有登录" : (error as Error).message, relogin: relogin || noToken };
    }
  }

  /** 访问 omem 地址需要这个主机的权限；必须在点击里直接申请。 */
  async function ensurePermission(url: string): Promise<boolean> {
    const origins = [originPattern(url)];
    if (await chrome.permissions.contains({ origins })) return true;
    return chrome.permissions.request({ origins });
  }

  async function addDirect(kind: "local" | "remote", name: string, urlInput: string): Promise<OmemConnection> {
    const url = normalizeOmemUrl(urlInput || DEFAULT_LOCAL_URL);
    if (!(await ensurePermission(url))) throw new Error("没有授权访问这个地址");
    const connection: OmemConnection = { id: newConnectionId(), name: name.trim() || (kind === "local" ? "本机" : new URL(url).host), kind, url, token: "", createdAt: Date.now() };
    await persist([...connections.value, connection]);
    await setActive(connection.id);
    await login(connection.id);
    return connection;
  }

  async function addPeer(via: string, peer: string, name: string): Promise<void> {
    const connection: OmemConnection = { id: newConnectionId(), name: name.trim() || peer, kind: "peer", url: "", token: "", via, peer, createdAt: Date.now() };
    await persist([...connections.value, connection]);
    await setActive(connection.id);
  }

  async function listPeers(via: string): Promise<OmemPeer[]> {
    const connection = connections.value.find((item) => item.id === via);
    if (!connection) return [];
    const result = await requestFor(connection, connections.value)<{ peers: OmemPeer[] }>("/api/peers");
    return result.peers;
  }

  /**
   * omem 的命令行登录：拿确认码、打开确认页，浏览器里已登录的话点「允许」就行；
   * 这里每 2 秒问一次，批准后拿到令牌存进这条连接。10 分钟没批准就作废。
   */
  async function login(id: string): Promise<void> {
    const connection = connections.value.find((item) => item.id === id);
    if (!connection || connection.kind === "peer") return;
    if (!(await ensurePermission(connection.url))) throw new Error("没有授权访问这个地址");
    loginAbort?.abort();
    const abort = new AbortController();
    loginAbort = abort;
    const started = await startLogin(connection.url, LOGIN_CLIENT);
    const browserUser = (await browserSession(connection.url))?.name ?? null;
    pending.value = { connectionId: id, code: started.code, url: started.url, browserUser };
    await chrome.tabs.create({ url: started.url });
    const deadline = Date.parse(started.expiresAt) || Date.now() + 10 * 60_000;
    try {
      while (!abort.signal.aborted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (abort.signal.aborted) return;
        const result = await pollLogin(connection.url, started.code, started.secret);
        if (result.status === "done") {
          await update(id, { token: result.token, user: result.user });
          if (activeId.value === id) await check();
          return;
        }
      }
      if (!abort.signal.aborted) throw new Error("确认码已过期，重新连接");
    } finally {
      if (pending.value?.connectionId === id) pending.value = null;
    }
  }

  function cancelLogin(): void {
    loginAbort?.abort();
    pending.value = null;
  }

  async function remove(id: string): Promise<void> {
    // 经它转发的设备连接一起删掉，否则它们没有地方可走。
    const next = connections.value.filter((item) => item.id !== id && item.via !== id);
    await persist(next);
    if (!next.some((item) => item.id === activeId.value)) await setActive(next[0]?.id ?? "");
  }

  async function rename(id: string, name: string): Promise<void> {
    if (name.trim()) await update(id, { name: name.trim() });
  }

  async function send(clip: Omit<ClipRequest, "space">): Promise<ClipResponse> {
    const connection = active.value;
    if (!connection) throw new Error("还没有连接 omem");
    if (!space.value) throw new Error("这个账号没有可以写入的空间");
    return requestFor(connection, connections.value)<ClipResponse>("/api/clips", { body: { ...clip, space: space.value }, timeoutMs: 120_000 });
  }

  async function conversation(id: string): Promise<ConversationMessage[]> {
    const connection = active.value;
    if (!connection) return [];
    const result = await requestFor(connection, connections.value)<{ messages: ConversationMessage[] }>(`/api/conversations/${encodeURIComponent(id)}`);
    return result.messages;
  }

  /** 在浏览器里打开 omem 的某一页；peer 没有直接的网页地址。 */
  function webUrl(hash: string): string | null {
    const connection = active.value;
    if (!connection) return null;
    const { web } = resolveEndpoint(connection, connections.value);
    return web ? `${web}/#${hash}` : null;
  }

  return {
    active,
    activeId,
    addDirect,
    addPeer,
    cancelLogin,
    check,
    connections,
    conversation,
    listPeers,
    loaded,
    login,
    pending,
    remove,
    rename,
    send,
    setActive,
    setSpace,
    space,
    spaces: writableSpaces,
    status,
    webUrl
  };
}

export type OmemContext = ReturnType<typeof useOmem>;
