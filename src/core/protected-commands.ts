import { z } from "zod";

// Backend API keys and the per-run tool token are needed by the backend itself.
const backendLogin = /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|TRAE|DOUBAO|GEMINI)_|^OMEM_TOKEN$/i;
const commandLogin = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY|API_KEY)(?:_|$)|^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|SSH_ASKPASS|GIT_ASKPASS|GIT_CONFIG_.+|GH_.+|GITHUB_.+|GITLAB_.+|GLAB_.+|DOCKER_AUTH_CONFIG|AWS_.+|AZURE_.+|CLOUDSDK_.+|GOOGLE_APPLICATION_CREDENTIALS|KUBECONFIG)$/i;

export const commandCredentialVariable = (key: string) => !backendLogin.test(key) && commandLogin.test(key);

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
