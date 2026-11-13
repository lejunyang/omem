/**
 * @omem-ai/cli: the light client for a remote omem (docs/v2/remote-clients.md). `omem tool` and
 * `omem mcp` against `--url` / `--remote` / `OMEM_URL`, plus `omem login`, `omem open` and
 * `omem remote`. Same commands and the same `~/.omem/client.json` as the full app (@omem-ai/app);
 * no local library, no server, no agents. Bundled into one file with no dependencies (vite.config.ts).
 *
 * Only the remote modules of the app are imported here (test/omem-cli.test.ts checks that).
 */
import { Command } from "commander";
import { createMcpServer } from "../../../src/agents/mcp-server.ts";
import { toolArgs } from "../../../src/agents/tool-cli.ts";
import { clientName, remoteToolBackend, resolveRemote, type RemoteTarget } from "../../../src/remote-client.ts";
import { addRemoteCommands, clientInfo, today } from "../../../src/remote-commands.ts";

declare const __OMEM_CLI_VERSION__: string | undefined;
const version = typeof __OMEM_CLI_VERSION__ === "string" ? __OMEM_CLI_VERSION__ : "dev";

const program = new Command();
program.name("omem").description("omem 的轻量命令行：以你自己的身份在远程 omem 上用工具（omem tool）、给 Agent 接 MCP（omem mcp）。本机运行 omem 服务要装 @omem-ai/app。").version(version);
program.option("--home <dir>", "存远程地址和令牌的目录（默认 ~/.omem，或环境变量 OMEM_HOME）");
program.hook("preAction", () => {
  const home = program.opts().home as string | undefined;
  if (home) process.env.OMEM_HOME = home;
});

type ToolOptions = { file?: string; readOnly?: boolean; space?: string; url?: string; remote?: string; spaces?: string; session?: string; agent?: string; model?: string; effort?: string };

/** Without an address there is nothing to use: this package has no local library. */
function target(o: { url?: string; remote?: string }): RemoteTarget {
  const t = resolveRemote(o);
  if (!t) throw new Error("没有远程地址：加 --url <地址> 或 --remote <名字>，设 OMEM_URL，或者 omem login <地址> 记一个默认的。\n（在本机运行 omem 服务、用本机的库，要装完整版：npm i -g @omem-ai/app）");
  return t;
}

const shared = (cmd: Command, kind: "tool" | "mcp") =>
  cmd
    .option("--url <地址>", `${kind === "tool" ? "在远程 omem 上调用" : "使用远程 omem"}（凭据取 OMEM_TOKEN、OMEM_AUTH_CMD 或 omem login 存下的）；也可用环境变量 OMEM_URL`)
    .option("--remote <name>", "omem remote add / omem login 存下的远程地址（不填用默认的）")
    .option("--read-only", "只开放读取类工具")
    .option("--space <id>", "默认空间")
    .option("--spaces <ids>", "只开放这些空间（逗号分隔）")
    .option("--session <name>", `会话名（对方一个会话一条运行；默认${kind === "tool" ? "本机名加当天日期" : "每个 MCP 进程一个"}，也可用环境变量 OMEM_SESSION）`)
    .option("--agent <name>", "在对方运行记录里登记的 Agent 名（如 claude-code；也可用环境变量 OMEM_AGENT）")
    .option("--model <id>", "登记的模型（也可用 OMEM_MODEL）")
    .option("--effort <level>", "登记的推理强度（也可用 OMEM_EFFORT）");

shared(
  program
    .command("tool")
    .description("在终端里调用远程 omem 的工具（omem tool help 看说明）")
    .argument("[name]", "工具名；help 看说明；不填列出能用的工具")
    .argument("[args...]", "JSON 参数，或 键=值（值是 JSON 就按 JSON 解析）；help 后面跟工具名或分组")
    .option("-f, --file <path>", "从文件读 JSON 参数（- 为标准输入）"),
  "tool",
).action(async (name: string | undefined, rest: string[], o: ToolOptions) => {
  const call = !name || name === "help" ? { tool: "omem_help", args: { topic: rest.join(",") || undefined } } : { tool: name, args: toolArgs(rest, o.file) };
  const r = await remoteToolBackend(target(o), clientInfo(o, `cli-${clientName()}-${today()}`)).call(call.tool, call.args);
  (r.isError ? process.stderr : process.stdout).write(r.text.endsWith("\n") ? r.text : r.text + "\n");
  if (r.isError) process.exitCode = 1;
});

shared(program.command("mcp").description("以 stdio MCP 服务暴露远程 omem 的工具（claude mcp add omem -- omem mcp --remote <名字>）"), "mcp").action(async (o: ToolOptions) => {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const backend = remoteToolBackend(target(o), clientInfo(o, `mcp-${clientName()}-${Date.now().toString(36)}`));
  await createMcpServer(backend).connect(new StdioServerTransport());
});

addRemoteCommands(program);

program.parseAsync().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
