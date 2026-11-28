import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { commandCredentialVariable } from "../agents/sandbox.ts";
import type { App } from "./app.ts";

export const commandNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const loginEnvSchema = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .refine(key => !/^OMEM_/i.test(key) && commandCredentialVariable(key), "需要命令登录变量名，例如 ACME_TOKEN")).max(32);

const relativeState = z.string().min(1).max(1024).refine(path =>
  !path.startsWith("~") && !/[:\\\x00-\x1f]/.test(path) && path.split("/").every(part => part && part !== "." && part !== ".."),
  "登录路径必须相对 HOME，不能含空路径段、点路径段、盘符或反斜线");

export const protectedCommandsSchema = z.array(z.object({
  name: commandNameSchema,
  state: z.array(relativeState).max(32).default([]),
  loginEnv: loginEnvSchema.default([]),
}).strict()).max(200).refine(commands => {
  const names = commands.map(c => process.platform === "win32" ? c.name.toLowerCase() : c.name);
  return new Set(names).size === names.length;
}, "受保护命令不能重复登记");

// The sandbox's existing clash check receives the physical login HOME. Keep declarations with
// that HOME for the lifetime of its host, including changes to the open configuration.
const hosts = new Map<App, string>();
export function registerCommandHost(app: App) {
  hosts.set(app, homedir());
  app.events.once("close", () => hosts.delete(app));
}

export function configuredCommandsForHome(home: string) {
  const commands = [];
  for (const [app, machineHome] of hosts) {
    if (home === machineHome || dirname(dirname(home)) === join(app.home, "accounts"))
      commands.push(...app.config.security.protectedCommands);
  }
  return commands;
}
