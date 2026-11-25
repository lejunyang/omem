import type { z } from "zod";
import type { App } from "../core/app.ts";
import type { PluginStore } from "./store.ts";

export type { PluginStore };

/**
 * What a plugin's server.ts sees (docs/v2/plugins.md). It default-exports `register(api)`;
 * imports from the host are type-only, everything it uses comes through `api` and `ctx`.
 */
/** open: waiting for the owner; submitted: handed in; shown: display only (a chart), nothing to hand in. */
export type BlockStatus = "open" | "submitted" | "shown";
export type PluginBlockState = { id: string; kind: string; data: any; status: BlockStatus; answers: Record<string, unknown> | null; result: any; conversationId: string; createdAt: string };

/** The owner's settings for a plugin, as the manifest declares them (strings, numbers, booleans). */
export type PluginSettings = Record<string, string | number | boolean>;
/** Messages from a plugin's platform enter the same inbox as built-in chat channels. */
export type PluginChannelMessage = { chatId: string; topicId?: string; isGroup: boolean; senderId: string; text: string; messageId?: string; addressed?: boolean };
export type PluginChannel = {
  id: string;
  label: string;
  send(to: { chatId: string; topicId?: string }, text: string): Promise<void>;
  maxLength: number;
  owner?: (settings: PluginSettings) => string | number | boolean | undefined;
  /** Called once when the host stops the channel (plugin turned off, trust withdrawn, reloaded): close the listener, timers and sockets the plugin opened itself. */
  close?: () => void | Promise<void>;
};

export type PluginContext = {
  app: App;
  plugin: string;
  userId: string;
  spaceId: string;
  runId: string | null;
  /** The plugin session the call belongs to, if any. */
  conversationId: string | null;
  actor: "agent" | "user";
  /** Record a namespaced flow signal; no event is triggered. */
  emit(signal: PluginSignal): Promise<void>;
  /** This plugin's records for this user. */
  store: PluginStore;
  /** The owner's settings for this plugin, defaults filled in. */
  settings(): PluginSettings;
  /** One of this plugin's blocks for this user (null when missing or someone else's). */
  block(id: string): PluginBlockState | null;
  /** Replace a block's result (after grading the open questions, say); the page refreshes. */
  setBlockResult(id: string, result: unknown): void;
  /** Put a block in one of this user's sessions of this plugin without an agent turn (drawn from a question bank, say). */
  present(kind: string, data: unknown, conversationId: string): string;
  /**
   * This user's connection to a platform (docs/v2/multi-user.md, “插件扩展”), or null when they have not
   * connected it. `fetch` goes to the provider's `apiBase` only, with their token; the plugin never sees it.
   */
  connection(provider: string): Promise<PluginConnection | null>;
  /**
   * Keep something as a source (a page, a message thread, a ticket from a connected platform), in a
   * space this call may write (the run's own by default). Tool calls only; the same uri updates it.
   */
  saveSource?(input: PluginSourceInput): { id: string; created: boolean; changed: boolean; space: string };
  /** This person's watches: things on a connected platform kept in sync as sources (src/plugins/platforms.ts). Tool calls only. */
  watches?: {
    add(input: { provider: string; kind: string; target: string; title?: string; space?: string }): PlatformWatch;
    remove(id: string): boolean;
    list(provider?: string): PlatformWatch[];
  };
};

/** What a reader makes of one thing on a platform: its text as a source. */
/** `id`: the thing's own id when it was asked for by a link or another form, so a source is kept once. */
export type PlatformDoc = { title: string; text: string; url?: string; updatedAt?: string; kind?: "doc" | "chat"; id?: string };
/**
 * One kind of thing on a platform (a Figma file, a Notion page, a GitHub repository's issues). `read`
 * turns one into a source; a container has `changes`: what in it changed since `cursor` (oldest
 * first, as things `read` by their own kind, each with the cursor just past it when it has one), and the
 * cursor to continue from next time.
 */
export type PlatformReader = {
  kind: string;
  label: string;
  /** What the id is and where to find it, for the agent and the person. */
  id: string;
  read?(c: PluginConnection, id: string): Promise<PlatformDoc | null>;
  changes?(c: PluginConnection, id: string, cursor: string | null): Promise<{ items: { kind: string; id: string; cursor?: string }[]; cursor: string | null }>;
};
/**
 * A platform pack (docs/v2/connectors.md): what a connected platform can do beyond its authorization.
 * `provider` is the connector it builds on (`connect-figma`); `features` replace the connector's, each
 * asking for its own scopes; readers turn the platform's things into sources and keep watches in sync.
 */
export type PluginPlatform = {
  provider: string;
  features?: import("../auth/features.ts").Feature[];
  readers: PlatformReader[];
  /** How often a watch is brought up to date (minutes, default 60). */
  syncMinutes?: number;
  /** A few lines for the agent: how to find ids, what each reader gives. */
  guide?: string;
};
export type PlatformWatch = { id: string; provider: string; kind: string; target: string; title: string; spaceId: string; lastRunAt: string | null; lastError: string | null };

/** `uri`: the platform's own stable address of the thing (`notion:page/<id>`), so a later capture updates it instead of adding another. */
export type PluginSourceInput = { space?: string; kind?: "doc" | "chat" | "web" | "note"; uri: string; title: string; text: string; meta?: Record<string, unknown> };

/** `base`: where its calls go (the provider's apiBase), null when the owner has not set it up. */
export type PluginConnection = { account: string; scopes: string[]; base: string | null; fetch(path: string, init?: RequestInit): Promise<Response> };

export type PluginSignal = { kind: string; keys: Record<string, unknown>; payload?: unknown };
/**
 * `revision`: the plugin's own mark of “something changed” that is not a status (head commit plus
 * comment count, say); when it moves while the status stays, omem records `object.<kind>.updated`.
 * `note`: what changed this time, in a line (shown on the item's timeline).
 */
export type PluginObjectState = { title: string; status: string; link: string; fields?: { label: string; value: string }[]; revision?: string; note?: string };
export type * from "../../packages/plugin-sdk/hook.ts";
/** What the host does next: read these objects again (kind without the plugin prefix is its own), record these signals. */
export type PluginHookResult = { refresh?: { kind: string; key: string }[]; emit?: PluginSignal[] };
/**
 * A callback another system calls when something changed (docs/v2/plugins.md, “回调”), at
 * `POST /api/hooks/<plugin id>/<name>/<secret>`; the owner makes the secret on the plugin's page.
 */
export type PluginHook = import("../../packages/plugin-sdk/hook.ts").PluginHookOptions & {
  accept?: import("../../packages/plugin-sdk/hook.ts").PluginHookAccept;
  handle(ctx: PluginContext, req: import("../../packages/plugin-sdk/hook.ts").PluginHookRequest): PluginHookResult | void | Promise<PluginHookResult | void>;
};
/**
 * Something a person can do to an object (merge it, rerun its failed checks): one of the plugin's own
 * tools, called with the object's key in `arg` (default `key`). The button on the item page and an
 * agent calling the tool are the same call, under the same approval rung. `statuses`: only in these
 * (the button is not shown otherwise); left out, in any.
 */
export type PluginObjectAction = { id: string; label: string; tool: string; arg?: string; statuses?: string[]; confirm?: string };
export type PluginObject = {
  kind: string;
  label: string;
  match(url: string): string | null;
  read(ctx: PluginContext, key: string): Promise<PluginObjectState>;
  statuses: Record<string, string>;
  final: string[];
  poll?: { minutes: number };
  actions?: PluginObjectAction[];
};

/** A platform people connect (logging in with it, or only binding): see src/auth/providers.ts LoginProvider. */
export type PluginConnector = import("../auth/providers.ts").LoginProvider & {
  /** What a person can turn on, each with the scopes it asks for (src/auth/features.ts); a function when they follow the owner's settings. */
  features?: import("../auth/features.ts").Feature[] | (() => import("../auth/features.ts").Feature[]);
};

export type PluginTool<S extends z.ZodObject = z.ZodObject> = {
  /** Must start with `<plugin id>_`. */
  name: string;
  description: string;
  schema: S;
  write?: boolean;
  /** The plugin's page may call it too (as the owner, never another plugin's). */
  page?: boolean;
  /** Every call by an agent waits for the owner's OK (clicking, typing, anything done on a machine). */
  approval?: boolean;
  /** Offered to a run only when its person has connected one of this plugin's connectors (`<plugin id>-…`). */
  whenConnected?: boolean;
  handler: (ctx: PluginContext, args: z.infer<S>) => string | Promise<string>;
};

export type BlockGrade = {
  /** Kept with the block and shown on the page (it may reveal the answers now). */
  result: unknown;
  /** What the agent gets as the next message in the session. */
  message: string;
};

export type PluginBlock<S extends z.ZodObject = z.ZodObject> = {
  /** The agent hands one in with the tool `<plugin id>_<kind>` (host blocks: `plugin_<kind>`). */
  kind: string;
  description: string;
  schema: S;
  /** Display only (a chart): stored as shown, nothing to hand in. */
  display?: boolean;
  /** Normalize and check before storing (fill in ids…); throw to send the agent a reason. */
  prepare?: (data: z.infer<S>) => z.infer<S>;
  /** What the page may see before submission: leave out the answers. */
  publicView?: (data: z.infer<S>) => unknown;
  grade?: (ctx: PluginContext & { blockId: string }, data: z.infer<S>, answers: Record<string, unknown>) => BlockGrade | Promise<BlockGrade>;
  /** What the tool returns to the agent after storing the block. */
  presented?: (data: z.infer<S>, blockId: string) => string;
  /** In a slot (`api.slot`): what it shows there, read as the person looking, in the item's space; must pass `schema`. */
  load?: (ctx: PluginContext, slot: PluginSlotContext) => z.infer<S> | Promise<z.infer<S>>;
  /** How omem's own pages draw it in a slot: display components (docs/v2/interactive-ui.md), no `page`. */
  view?: (data: z.infer<S>) => PluginSlotView;
};

/** Where a block can sit on omem's own pages (docs/v2/flows.md §8, “界面插槽”). */
export type PluginSlotPlace = "item.panel" | "flow.stage" | "today";
/**
 * When a slot shows; not for `today`. `object`: one of this plugin's object kinds — on `item.panel` linked
 * to the item (one block per object), on `flow.stage` the kind the stage follows (`by` / `done`).
 * `stage`: stage ids (`flow.stage` only); `flow`: flow ids; `space`: the item's space.
 */
export type PluginSlotWhen = { object?: string; stage?: string | string[]; flow?: string | string[]; space?: string | string[] };
export type PluginSlot = { block: string; when?: PluginSlotWhen };
/** What a block in a slot is shown for: the item, the stage and the object it sits by (null where there is none). */
export type PluginSlotContext = { at: PluginSlotPlace; item: string | null; stage: string | null; object: { id: string; kind: string; key: string; title: string; status: string; link: string } | null };
export type PluginSlotView = { title?: string; components: unknown[] };

export type * from "../../packages/plugin-sdk/server.ts";
export type PluginApi = import("../../packages/plugin-sdk/server.ts").ProcessApi & {
  id: string;
  /** A stateful object, named <plugin id>:<kind> by the host; its actions are the plugin's own tools. */
  object(def: PluginObject): void;
  /** A callback from outside: `POST /api/hooks/<plugin id>/<name>/<secret>`. */
  hook(def: PluginHook): void;
  /** The host's zod: plugins in the data directory cannot import packages. */
  z: typeof import("zod").z;
  /** In-process only. The host resolves identities, splits deliveries and unregisters on stop. */
  channel(def: PluginChannel): { receive(message: PluginChannelMessage): Promise<void> };
  tool<S extends z.ZodObject>(tool: PluginTool<S>): void;
  block<S extends z.ZodObject>(block: PluginBlock<S>): void;
  /** Put one of its display blocks (with `load` and `view`) on omem's own pages. In-process only; declare the block and objects first. */
  slot(at: PluginSlotPlace, def: PluginSlot): void;
  /** One of the services the manifest declares: started on first use, its address and the token it expects. */
  service(name: string): { ensure(): Promise<{ url: string; token: string }> };
  /** A platform people can connect; its id must start with `<plugin id>-`. Gone when the plugin's code is unloaded. */
  connector(def: PluginConnector): void;
  /**
   * Recognize a bearer credential omem did not issue (an organization's JWT) and say who it is
   * (docs/v2/remote-clients.md §6). Its id must start with `<plugin id>-` and, for a plugin in the
   * data directory, be declared in `permissions.authenticators`; only code trusted to run inside omem.
   */
  authenticator(def: import("../auth/authenticators.ts").Authenticator): void;
  /**
   * A way for members to log in to a backend with their own account (docs/v2/agent-accounts.md §6):
   * `login` leads the person through signing in and writes the credentials where `ctx.env` points;
   * omem shows the link and code, keeps `ctx.secret` per person, calls `refresh` before `expiresAt` and
   * `logout` when they leave. A plugin in the data directory declares the backend in
   * `permissions.agentLogin`; only code trusted to run inside omem.
   */
  agentLogin(def: import("../agents/agent-logins.ts").AgentLoginDef): void;
  /**
   * One authorization per person that provides several AI backends and command-line tools
   * (docs/v2/credentials.md): `login` leads the person through signing in, omem keeps the hold,
   * refreshes it before `expiresAt`, calls `provide` and mounts what `provides` declares. A plugin in
   * the data directory declares `permissions.credential: true`; only code trusted to run inside omem.
   */
  credential(def: import("../agents/credential-registry.ts").CredentialDef): void;
  /**
   * The owner's values of this plugin's settings (manifest `settings`, 设置 → 插件), defaults filled in;
   * read it when needed (not once at load) so a change takes effect without reloading. Code running
   * isolated reads them per call through `ctx.settings()` instead.
   */
  settings(): PluginSettings;
  /** What the owner filled in for one of this plugin's connectors (its `appFields`: client id and secret…), read each time. */
  appConfig(provider: string): Record<string, string>;
  /** The host's fetch for a connector's own calls (exchanging codes, whoami): tests answer it without the network. */
  fetch: typeof fetch;
  /** A platform pack: features and readers for a connector (any plugin's). Gone when the plugin's code is unloaded. */
  platform(def: PluginPlatform): void;
  /** The platform packs registered now, any plugin's. */
  platforms(): PluginPlatform[];
  /** Text helpers: HTML (a page, a mail) as Markdown. */
  text: { html(html: string): string };
};

export type PluginRegister = (api: PluginApi) => void | Promise<void>;
