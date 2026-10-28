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

export type PluginContext = {
  app: App;
  plugin: string;
  userId: string;
  spaceId: string;
  runId: string | null;
  /** The plugin session the call belongs to, if any. */
  conversationId: string | null;
  actor: "agent" | "user";
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
};

export type PluginTool<S extends z.ZodObject = z.ZodObject> = {
  /** Must start with `<plugin id>_`. */
  name: string;
  description: string;
  schema: S;
  write?: boolean;
  /** The plugin's page may call it too (as the owner, never another plugin's). */
  page?: boolean;
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
};

export type PluginApi = {
  id: string;
  tool<S extends z.ZodObject>(tool: PluginTool<S>): void;
  block<S extends z.ZodObject>(block: PluginBlock<S>): void;
};

export type PluginRegister = (api: PluginApi) => void | Promise<void>;
