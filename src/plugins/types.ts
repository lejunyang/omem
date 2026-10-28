import type { z } from "zod";
import type { App } from "../core/app.ts";
import type { PluginStore } from "./store.ts";

export type { PluginStore };

/**
 * What a plugin's server.ts sees (docs/v2/plugins.md). It default-exports `register(api)`;
 * imports from the host are type-only, everything it uses comes through `api` and `ctx`.
 */
export type PluginBlockState = { id: string; kind: string; data: any; status: "open" | "submitted"; answers: Record<string, unknown> | null; result: any; conversationId: string; createdAt: string };

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
  /** One of this plugin's blocks for this user (null when missing or someone else's). */
  block(id: string): PluginBlockState | null;
  /** Replace a block's result (after grading the open questions, say); the page refreshes. */
  setBlockResult(id: string, result: unknown): void;
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
  /** The agent hands one in with the tool `<plugin id>_<kind>`. */
  kind: string;
  description: string;
  schema: S;
  /** Normalize before storing (fill in ids…). */
  prepare?: (data: z.infer<S>) => z.infer<S>;
  /** What the page may see before submission: leave out the answers. */
  publicView?: (data: z.infer<S>) => unknown;
  grade: (ctx: PluginContext & { blockId: string }, data: z.infer<S>, answers: Record<string, unknown>) => BlockGrade | Promise<BlockGrade>;
  /** What the tool returns to the agent after storing the block. */
  presented?: (data: z.infer<S>, blockId: string) => string;
};

export type PluginApi = {
  id: string;
  tool<S extends z.ZodObject>(tool: PluginTool<S>): void;
  block<S extends z.ZodObject>(block: PluginBlock<S>): void;
};

export type PluginRegister = (api: PluginApi) => void | Promise<void>;
