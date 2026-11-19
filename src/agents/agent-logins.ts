/**
 * Login methods plugins bring for a backend (docs/v2/agent-accounts.md §6, `api.agentLogin`): a
 * company's own sign-in that ends with the backend's credentials written into a member's account
 * folder. The plugin decides how credentials are obtained and in what form; omem calls it in its own
 * process (never in the sandbox: it only writes files), shows the link and code to the person, keeps
 * one secret per person for it, refreshes before `expiresAt` and calls `logout` when they leave.
 * The flow is in accounts.ts; this module only keeps what is registered (no imports of the flow).
 */

export type AgentLoginContext = {
  userId: string;
  /** This person's account folder (HOME inside the sandbox). */
  home: string;
  /** The backend's `account.env` expanded for this person (TRAE_HOME=<home>/.trae…): write the credentials where they point. */
  env: Record<string, string>;
  /** One secret the host keeps for the plugin per person and backend (secrets/vault.db, never in the account folder), such as a refresh token. */
  secret: { get(): Promise<string | null>; set(value: string | null): Promise<void> };
  /** The plugin's own settings (the owner's values from 设置 → 插件, defaults filled in), read when the method runs. */
  settings: Record<string, string | number | boolean>;
  signal: AbortSignal;
};

export type AgentLoginResult = { user: string; expiresAt?: number };

export type AgentLoginDef = {
  /** The account backend (catalog id, or the source of the owner's profile with `account`). */
  backend: string;
  /** Unique within the plugin; the method's full name is `<plugin>:<id>`. */
  id: string;
  label: string;
  /** Lead the person through signing in (device code or a web page), then write the credentials; `show` puts the link and code in front of them. */
  login(ctx: AgentLoginContext & { show(link: { url: string; code?: string }): void }): Promise<AgentLoginResult>;
  /** Called 10 minutes before `expiresAt` (no more than once a minute) and from 检查: the new `expiresAt`, or null when the person must log in again. */
  refresh?(ctx: AgentLoginContext): Promise<{ expiresAt?: number } | null>;
  /** Clean up when the person logs out (revoke a token…); the host removes the folder afterwards. */
  logout?(ctx: AgentLoginContext): Promise<void>;
};

export type AgentLoginMethod = AgentLoginDef & { plugin: string; key: string; settings: () => Record<string, string | number | boolean> };

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const registry = new Map<string, AgentLoginMethod>();

export function registerAgentLogin(plugin: string, def: AgentLoginDef, settings: () => Record<string, string | number | boolean> = () => ({})): () => void {
  if (!ID.test(def.id)) throw new Error(`登录方式 id 只能用小写字母、数字和连字符，字母开头：${def.id}`);
  if (typeof def.login !== "function") throw new Error(`登录方式 ${def.id} 没有 login`);
  if (!def.label?.trim()) throw new Error(`登录方式 ${def.id} 没有 label`);
  const key = `${plugin}:${def.id}`;
  if (registry.has(key)) throw new Error(`插件 ${plugin} 已经注册过登录方式 ${def.id}`);
  const m: AgentLoginMethod = { ...def, plugin, key, settings };
  registry.set(key, m);
  return () => {
    if (registry.get(key) === m) registry.delete(key);
  };
}

/** The plugin methods for one backend, in the order they were registered. */
export const loginMethodsFor = (backend: string) => [...registry.values()].filter((m) => m.backend === backend);
export const loginMethod = (key: string) => registry.get(key) ?? null;
