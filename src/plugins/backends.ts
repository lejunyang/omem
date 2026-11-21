import { z } from "zod";
import { accountSpecSchema, agentProfileSchema } from "../core/config.ts";

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const text = z.string().min(1).max(1000);
const args = z.array(z.string().max(4000)).max(100);
/** Only launch metadata is declarative. Credentials stay in the host's or backend's account settings. */
export const pluginBackendSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), name: text, command: text, args: args.optional(),
  env: z.array(envName).max(50).optional(), archiveArgs: args.optional(),
  sessionHistory: agentProfileSchema.shape.sessionHistory,
  npm: text.optional(), install: text.optional(), model: text.optional(), effort: text.optional(),
  skills: z.object({ read: z.array(text).max(20), write: text }).strict().optional(),
  launchConfig: z.object({ env: envName, model: text.optional(), effort: text.optional() }).strict().optional(),
  egressHosts: z.array(z.string().regex(/^(?:\*\.)?[a-zA-Z0-9.-]+$/)).max(50).optional(),
  account: accountSpecSchema.optional(),
}).strict();
