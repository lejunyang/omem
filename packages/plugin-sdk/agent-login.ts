/**
 * Login methods for members' own AI accounts (docs/v2/agent-accounts.md §6): a plugin lets people log
 * in to a backend (TraeX, Codex…) through its own sign-in, then writes the backend's credentials into
 * that person's account folder. Declared in `register(api)`:
 *
 *     api.agentLogin({
 *       backend: "traex",
 *       id: "company",
 *       label: "用公司账号登录",
 *       async login(ctx) {
 *         const device = await startDeviceFlow(ctx.signal);
 *         ctx.show({ url: device.url, code: device.code });
 *         const tokens = await waitForTokens(device, ctx.signal);
 *         await writeCredentials(ctx.env.TRAE_HOME, tokens);
 *         await ctx.secret.set(tokens.refreshToken);
 *         return { user: tokens.user, expiresAt: tokens.expiresAt };
 *       },
 *       async refresh(ctx) { … return { expiresAt } or null },
 *       async logout(ctx) { await revoke(await ctx.secret.get()); },
 *     });
 *
 * The manifest declares the backend (`permissions.agentLogin: [traex]`); omem calls it only once the
 * owner trusts the plugin and runs it inside omem. No imports here, so omem's own type checks can
 * compare these with the host's (src/agents/agent-logins.ts).
 */
export type AgentLoginContext = {
  userId: string;
  /** This person's account folder (HOME inside the sandbox their runs start in). */
  home: string;
  /** The backend's `account.env` expanded for this person (TRAE_HOME=<home>/.trae…): write the credentials where they point. */
  env: Record<string, string>;
  /** One secret omem keeps for the plugin per person and backend (in its vault, never in the account folder), such as a refresh token. */
  secret: { get(): Promise<string | null>; set(value: string | null): Promise<void> };
  /** The plugin's own settings (the owner's values from 设置 → 插件, manifest `settings`, defaults filled in). */
  settings: Record<string, string | number | boolean | string[]>;
  /** Aborted when the login times out (11 minutes) or the person cancels or logs out. */
  signal: AbortSignal;
};
export type AgentLoginResult = { user: string; expiresAt?: number };
export type AgentLoginDef = {
  backend: string;
  /** Unique within the plugin. */
  id: string;
  label: string;
  /** Call `show` with the link (and code) the person opens; omem puts it on their page and in their Feishu private chat. */
  login(ctx: AgentLoginContext & { show(link: { url: string; code?: string }): void }): Promise<AgentLoginResult>;
  /** 10 minutes before `expiresAt` (at most once a minute) and when the person presses 检查: the new `expiresAt`, or null to ask them to log in again. */
  refresh?(ctx: AgentLoginContext): Promise<{ expiresAt?: number } | null>;
  /** When they log out (revoke what you hold); omem removes the folder afterwards. */
  logout?(ctx: AgentLoginContext): Promise<void>;
};
export type AgentLoginApi = {
  agentLogin(def: AgentLoginDef): void;
  /** The owner's values of this plugin's settings; read when needed so a change takes effect without reloading. In-process plugins only. */
  settings(): Record<string, string | number | boolean | string[]>;
};
