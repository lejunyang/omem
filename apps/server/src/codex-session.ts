/** Read Codex's own effective configuration, then override only the tools for
 * this session. Authentication stays in the user's existing credential store. */
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AgentProfile } from "../../../packages/contracts/src/index.js";

type Inventory = {
  mcp_servers?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
};
const features = Object.fromEntries(
  [
    "apps",
    "hooks",
    "remote_plugin",
    "memories",
    "multi_agent",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "skill_mcp_dependency_install",
    "shell_tool",
  ].map((name) => [name, false]),
);

export function codexSessionConfig(config: Inventory, skills: string[]) {
  const overrides: Record<string, unknown> = {
    features,
    web_search: "disabled",
    project_doc_max_bytes: 0,
    developer_instructions: "",
    skills: {
      config: [...new Set(skills)].map((path) => ({ path, enabled: false })),
    },
    plugins: Object.fromEntries(
      Object.keys(config.plugins ?? {}).map((name) => [
        name,
        { enabled: false },
      ]),
    ),
  };
  for (const name of Object.keys(config.mcp_servers ?? {})) {
    // App Server splits override keys on '.', without TOML quoted-key parsing.
    // ACP adds its own mcp_servers table, so use leaf overrides to retain these
    // disables instead of letting the adapter replace them.
    if (!/^[\w-]+$/.test(name) || name === "omem")
      throw Error(`CODEX_MCP_CONFIG_CONFLICT: cannot isolate server ${name}`);
    overrides[`mcp_servers.${name}.enabled`] = false;
  }
  return overrides;
}

function executable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const paths =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [resolve(cwd, command)]
      : (env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, command));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {}
  }
  throw Error(`CODEX_EXECUTABLE_NOT_FOUND: ${command}`);
}

export async function codexSessionEnvironment(
  profile: AgentProfile,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  // Use the same binary for discovery and the adapter's actual sessions. Native
  // wrappers may specify codexCommand; npm installs reuse the adapter dependency.
  let command: string;
  if (profile.codexCommand)
    command = executable(profile.codexCommand, cwd, env);
  else {
    const require = createRequire(executable(profile.command, cwd, env));
    // pnpm's .bin entry is a shell wrapper, not a symlink to the package.
    const adapter = require.resolve(
      "@agentclientprotocol/codex-acp/package.json",
    );
    command = createRequire(adapter).resolve("@openai/codex/bin/codex.js");
  }
  const child = spawn(
    command,
    [
      "app-server",
      "-c",
      "features.hooks=false",
      "-c",
      "features.apps=false",
      "-c",
      "features.remote_plugin=false",
    ],
    {
      cwd,
      env,
      stdio: "pipe",
      shell: false,
    },
  );
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: Error) => void }
  >();
  let id = 0;
  const fail = (reason: Error) => {
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
  };
  const closed = new Promise<void>((done) => {
    child.once("close", () => done());
    child.once("error", () => done());
  });
  child.on("error", () =>
    fail(
      Error("CODEX_CONFIG_DISCOVERY_FAILED: could not start Codex App Server"),
    ),
  );
  child.on("exit", () =>
    fail(Error("CODEX_CONFIG_DISCOVERY_FAILED: App Server exited")),
  );
  child.stdin.on("error", () => {});
  child.stderr.resume(); // Configuration/credentials are never copied to logs.
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: { id?: number; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const request =
      message.id === undefined ? undefined : pending.get(message.id);
    if (!request) return;
    pending.delete(message.id!);
    if (message.error)
      request.reject(
        Error(
          "CODEX_CONFIG_DISCOVERY_FAILED: App Server rejected configuration discovery",
        ),
      );
    else request.resolve(message.result);
  });
  const request = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ id: requestId, method, params }) + "\n",
      );
    });
  const cancel = () => {
    fail(Error("CANCELLED"));
    child.kill();
  };
  const timeout = setTimeout(() => {
    fail(Error("CODEX_CONFIG_DISCOVERY_TIMEOUT"));
    child.kill();
  }, 30_000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw Error("CANCELLED");
    await request("initialize", {
      clientInfo: { name: "omem-tools", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const config = await request("config/read", { includeLayers: false, cwd });
    const inventory = await request("skills/list", {
      cwds: [cwd],
      forceReload: true,
    });
    if (
      !config?.config ||
      !Array.isArray(inventory?.data) ||
      inventory.data.some(
        (entry: any) => entry.errors?.length || !Array.isArray(entry.skills),
      )
    )
      throw Error(
        "CODEX_CONFIG_DISCOVERY_INCOMPLETE: cannot assemble a task from an incomplete tool inventory",
      );
    const skillPaths = inventory.data.flatMap((entry: any) =>
      entry.skills.map((skill: any) => skill.path),
    );
    if (skillPaths.some((path: unknown) => typeof path !== "string"))
      throw Error("CODEX_SKILL_INVENTORY_INVALID");
    return {
      ...env,
      CODEX_PATH: command,
      CODEX_CONFIG: JSON.stringify(
        codexSessionConfig(config.config, skillPaths),
      ),
      INITIAL_AGENT_MODE: "read-only",
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    lines.close();
    child.kill();
    const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
    await closed;
    clearTimeout(kill);
  }
}
