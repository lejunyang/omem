import type { App } from "../core/app.ts";
import { keyOf, setKey } from "../core/ai-keys.ts";
import { saveConfig } from "../core/config.ts";
import { HttpError } from "../core/util.ts";
import type { McpServerSpec } from "./specs.ts";

/**
 * The owner's MCP servers (settings `mcp.servers`): set up once on the Agent page, then given to the
 * Agent 档案 and built-in roles that name them. The definition is in the config file; the values of
 * its environment variables and headers are keys, kept in the secrets file under `mcp:<name>` and
 * never sent back to the page (it sees their names and that they are set).
 *
 * Who gets them is decided in runner.prepareRun: the owner's own runs only, nothing for guests or
 * review checks, and a replay arm only the ones marked read-only.
 */
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const secretId = (name: string) => `mcp:${name}`;

type Stored = App["config"]["mcp"]["servers"][string];
export type McpServerView = {
  name: string;
  kind: "command" | "url";
  description: string;
  readOnly: boolean;
  command?: string;
  args: string[];
  url?: string;
  /** Names of the environment variables (command) or headers (url); `set` says whether a value is stored. */
  secrets: { name: string; set: boolean }[];
};
export type McpServerInput = {
  description?: string;
  readOnly?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  /** Environment variables or headers by name. A string sets the value; null keeps the stored one (or none, when none is stored yet); a name left out is removed. */
  secrets?: Record<string, string | null>;
};

function secretsOf(app: App, name: string): Record<string, string> {
  try {
    const v = JSON.parse(keyOf(secretId(name), app.home) || "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const view = (app: App, name: string, s: Stored): McpServerView => {
  const values = secretsOf(app, name);
  return {
    name,
    kind: s.url ? "url" : "command",
    description: s.description,
    readOnly: s.readOnly,
    ...(s.url ? { url: s.url } : { command: s.command ?? "" }),
    args: s.url ? [] : s.args,
    secrets: (s.url ? s.headers : s.env).map((k) => ({ name: k, set: !!values[k] })),
  };
};

export function listMcpServers(app: App): McpServerView[] {
  return Object.entries(app.config.mcp.servers)
    .map(([name, s]) => view(app, name, s))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function saveMcpServer(app: App, name: string, input: McpServerInput): McpServerView {
  if (!NAME.test(name)) throw new HttpError(400, "名称只能用小写字母、数字和连字符，字母开头，最多 40 个字符");
  const command = input.command?.trim();
  const url = input.url?.trim();
  if (!!command === !!url) throw new HttpError(400, "填启动命令，或者填网址，二选一");
  if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, "网址要以 http:// 或 https:// 开头");
  const before = secretsOf(app, name);
  // A name may be kept without a value yet (a server a plugin brought, a key the owner fills in
  // later): the view says it is not set, and a run is simply given the server without it.
  const names: string[] = [];
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.secrets ?? {})) {
    const key = k.trim();
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new HttpError(400, `名字不合法：${key}`);
    names.push(key);
    const value = v === null ? before[key] : v;
    if (value) values[key] = value;
  }
  app.config.mcp.servers[name] = {
    description: input.description?.trim() ?? "",
    ...(url ? { url } : { command }),
    args: url ? [] : (input.args ?? []).map((a) => a.trim()).filter(Boolean),
    env: url ? [] : names,
    headers: url ? names : [],
    readOnly: !!input.readOnly,
  };
  setKey(app.home, secretId(name), Object.keys(values).length ? JSON.stringify(values) : null);
  saveConfig(app.config, app.home);
  return view(app, name, app.config.mcp.servers[name]);
}

/** Removes the server and its keys. Profiles and roles that still name it simply stop getting it. */
export function deleteMcpServer(app: App, name: string) {
  if (!app.config.mcp.servers[name]) throw new HttpError(404, `没有名为 ${name} 的 MCP 服务`);
  delete app.config.mcp.servers[name];
  setKey(app.home, secretId(name), null);
  saveConfig(app.config, app.home);
}

/** The named servers as a backend is given them (names that no longer exist are passed over). */
export function mcpServersFor(app: App, names: string[]): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {};
  for (const name of new Set(names)) {
    const s = app.config.mcp.servers[name];
    if (!s) continue;
    const values = secretsOf(app, name);
    const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => values[k]).map((k) => [k, values[k]]));
    out[name] = s.url ? { url: s.url, headers: pick(s.headers), readOnly: s.readOnly } : { command: s.command ?? "", args: s.args, env: pick(s.env), readOnly: s.readOnly };
  }
  return out;
}
