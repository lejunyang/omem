/**
 * Credentials (docs/v2/credentials.md, phase 1): one authorization per person that provides several
 * AI backends and command-line tools. Declared in `register(api)`:
 *
 *     api.credential({
 *       id: "corp",
 *       name: "公司账号",
 *       required: true,
 *       async login(ctx, show) {
 *         const device = await startDeviceFlow(ctx.signal);
 *         show({ url: device.url, code: device.code });
 *         const token = await waitForToken(device, ctx.signal);
 *         await ctx.secret.set(token.refresh);
 *         await writeCredentials(ctx.home, token);
 *         return { user: token.user, expiresAt: token.expiresAt };
 *       },
 *       async refresh(ctx) { … return { expiresAt } or null },
 *       async check(ctx) { … return { state: "ok" | "expired" | "missing", … } },
 *       async logout(ctx) { await revoke(await ctx.secret.get()); },
 *       async provide(ctx) { await writeCredentials(ctx.home, await exchange(await ctx.secret.get())); },
 *       provides: { backends: ["somebackend"], commands: [{ name: "acme", install: ["~/.local/share/acme"], state: [".local/share/acme/data"] }] },
 *     });
 *
 * The manifest declares `permissions.credential: true`; omem calls it only once the owner trusts the
 * plugin and runs it inside omem. No imports here, so omem's own type checks can compare these with
 * the host's (src/agents/credentials.ts).
 */
export type CredentialContext = {
  userId: string;
  /** This person's account folder (HOME inside the sandbox their runs start in); for the owner, this machine's HOME. */
  home: string;
  /** `HOME` for this person. */
  env: Record<string, string>;
  /** One secret omem keeps for the plugin per person and credential (in its vault, never in the account folder). */
  secret: { get(): Promise<string | null>; set(value: string | null): Promise<void> };
  /** The plugin's own settings (the owner's values from 设置 → 插件, defaults filled in). */
  settings: Record<string, string | number | boolean | string[]>;
  /** Aborted when the login times out (11 minutes) or the person cancels or logs out. */
  signal: AbortSignal;
};

export type CredentialOutcome = { json: string; equals: unknown };
type CommandMatch = {
  subcommand?: string[];
  /** Exact argument vector, including flags. */
  args?: string[];
  /** Named options, e.g. { instance: "sample", verbose: true }. False requires absence. */
  options?: Record<string, string | boolean>;
};
export type CommandJudgeCall = { command: string; argv: readonly string[]; cwd: string; member: string; runId: string | null };
export type CommandVerdict = { action: "allow" | "approve" | "deny" | "log"; title?: string; reason?: string; approver?: "caller" | "owner"; key?: string };
/** One command-line tool the credential provides. */
export type CredentialCommand = {
  name: string;
  /**
   * Optional: only invocations whose subcommand starts with these words belong to this credential
   * (after global options, as in readOnly matches). Two credentials can then share one executable —
   * `bytedcli meego …` for one login, the rest of `bytedcli` for another; the longest prefix wins.
   */
  subcommand?: string[];
  /** Install directories mounted read-only into members' sandboxes (`~` is this machine's HOME). */
  install?: string[];
  /** State directories it writes, relative to HOME. */
  state?: string[];
  /** Command login variable names (e.g. ACME_TOKEN) to restore for this invocation in the executor. */
  loginEnv?: string[];
  /** Called after enabled operation rules, with the caller's read-only credential context. */
  judge?(call: CommandJudgeCall, ctx: CredentialContext): Promise<CommandVerdict | null> | CommandVerdict | null;
  readOnly?: CommandMatch[];
  resource?: { match: CommandMatch; key: string }[];
  outcomes?: { unauthenticated?: CredentialOutcome[]; expired?: CredentialOutcome[]; denied?: CredentialOutcome[]; applyUrl?: string };
};
export type CredentialDef = {
  /** Unique within the plugin; the full name is `<plugin>:<id>`. */
  id: string;
  name: string;
  describe?: string;
  /** Shown as required in the onboarding list. */
  required?: boolean;
  /** Call `show` with the link (and code) the person opens; omem puts it on their page and in their Feishu private chat. */
  login(ctx: CredentialContext, show: (link: { url: string; code?: string }) => void): Promise<{ user: string; expiresAt?: number }>;
  /**
   * Optional: the owner's own login on this machine, through the tool's official flow (ctx.home is this
   * machine's HOME; ctx.secret cannot be written). Call `show` with the official link, resolve when it is
   * done. Without it, the owner logs in on the machine themselves and omem only checks.
   */
  ownerLogin?(ctx: CredentialContext, show: (link: { url: string; code?: string }) => void): Promise<{ user: string; expiresAt?: number }>;
  /**
   * Refreshes a member's access token, starting up to 30 minutes before `expiresAt`.
   * Return null only when a new authorization is required. Throw on temporary failures so omem
   * retries without prompting. A successful refresh is followed by provide.
   */
  refresh?(ctx: CredentialContext): Promise<{ expiresAt?: number } | null>;
  /** Read-only: is this person still logged in? */
  /**
   * `expiresAt`: for a member with a refresh callback, the access token deadline (not a reminder).
   * Otherwise, it is the actual login deadline. Leave it out of login results and give null here
   * if the tool handles renewal on its own and has no useful login deadline to report.
   */
  check?(ctx: CredentialContext): Promise<{ state: "ok" | "expired" | "missing"; user?: string; expiresAt?: number | null }>;
  /** When they log out (revoke what you hold); omem removes the secret and the declared state directories afterwards. */
  logout?(ctx: CredentialContext): Promise<void>;
  /** After a login or a refresh: write the credential where this person's tools look for it. */
  provide?(ctx: CredentialContext): Promise<void>;
  provides: { backends?: string[]; commands?: CredentialCommand[] };
  /** Query access for req.user (the subject), using ctx only to authenticate the query.
   * Only return verifiedRead for a command when the resource service confirms this subject can
   * read its entire result, and the complete argv is a read of exactly req.resource. Leave it
   * unset for advisory answers, ambiguous options, or a service that only checks the login in ctx.
   */
  /** req.user is the omem id; `account` is the account this person last logged in with for this credential
   * (from your login or check) and `email` the email omem has for them, each present when known. Map them to
   * the principal your service checks; answer allowed: null when you cannot tell who it is. */
  precheck?(ctx: CredentialContext, req: { resource: string; user: string; account?: string; email?: string; command?: { name: string; args: readonly string[] } }): Promise<{ allowed: boolean | null; verifiedRead?: true; missing?: string; applyUrl?: string }>;
};
export type CredentialApi = {
  credential(def: CredentialDef): void;
  /** The owner's values of this plugin's settings; read when needed so a change takes effect without reloading. In-process plugins only. */
  settings(): Record<string, string | number | boolean | string[]>;
};
