#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFile, writeFile, mkdir, cp, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  assetPath,
  configPath,
  defaultDataDir,
  optionalRuntime,
} from "./paths.js";
import { requestJson as api, serverAddress } from "./cli/client.js";

const pkg = JSON.parse(readFileSync(assetPath("package.json"), "utf8"));
const program = new Command()
  .name("omem")
  .version(pkg.version)
  .description(
    "个人记忆与助理：保存材料、找回知识、提问和持续跟进。Node.js 24+。",
  )
  .option(
    "--data-dir <path>",
    "个人库目录（已安装版默认 ~/.omem；可用 OMEM_DATA_DIR）",
  )
  .option("--config <file>", "配置文件（默认个人库中的 config.json）")
  .option(
    "--url <url>",
    "连接已有服务，可用 OMEM_URL；认证使用环境变量 OMEM_TOKEN",
  )
  .option("--port <number>", "本地服务端口，可用 OMEM_PORT", (value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error("端口必须为 1–65535");
    return port;
  })
  .option("--json", "输出 JSON，适合脚本或 Agent（进度和错误写入 stderr）")
  .showHelpAfterError()
  .showSuggestionAfterError()
  .addHelpText(
    "after",
    `\n快速开始：\n  omem init\n  omem service start\n  omem import file ./notes.md\n  omem search "发布流程"\n  omem ask "这个项目如何发布？"\n\n逐层帮助：omem <命令> --help；如 omem messages watch --help。\n退出码：0 成功，1 执行失败/状态异常，2 参数或未知命令错误，130 用户中断。\n基础导入、全文搜索和网页不依赖 Bun/osdk；AI 需已登录 Agent CLI。\n飞书采集默认暂停，仅只读；机器人通知使用独立的显式绑定。`,
  );
program.hook("preAction", () => {
  const opts = program.opts();
  if (opts.dataDir) {
    process.env.OMEM_DATA_DIR = resolve(opts.dataDir);
    if (!opts.config && !process.env.OMEM_CONFIG)
      process.env.OMEM_CONFIG = join(defaultDataDir(), "config.json");
  }
  if (opts.config) process.env.OMEM_CONFIG = resolve(opts.config);
  if (opts.url) process.env.OMEM_URL = opts.url;
  if (opts.port) process.env.OMEM_PORT = String(opts.port);
});
const json = () => Boolean(program.opts().json);
function show(value: any, text?: string) {
  console.log(
    json()
      ? JSON.stringify(value, null, 2)
      : (text ?? JSON.stringify(value, null, 2)),
  );
}
const enc = encodeURIComponent;
async function stdin() {
  if (process.stdin.isTTY)
    throw Error("请指定文件，或通过管道提供输入；查看命令 --help");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
const readJson = async (file?: string) =>
  JSON.parse(file ? await readFile(file, "utf8") : await stdin());
const group = (name: string, description: string) =>
  program.command(name).description(description);
const read = (
  parent: Command,
  name: string,
  description: string,
  path: string,
) =>
  parent
    .command(name)
    .description(description)
    .action(async () => show(await api(path)));
const write = (
  parent: Command,
  name: string,
  description: string,
  path: string,
) =>
  parent
    .command(name)
    .description(description)
    .action(async () => show(await api(path, {})));

program
  .command("init")
  .description("创建个人配置；保留现有配置、材料和数据库")
  .action(async () => {
    const file = configPath();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    let created = false;
    try {
      await writeFile(
        file,
        await readFile(assetPath("config/omem.default.json")),
        { flag: "wx", mode: 0o600 },
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    show(
      { created, config: file, dataDir: defaultDataDir() },
      `${created ? "已创建" : "已保留"}配置：${file}\n个人库：${defaultDataDir()}\n下一步：omem service start，然后打开 http://127.0.0.1:${process.env.OMEM_PORT || 4317}\nAI 默认使用 Traex / gpt-5.6-sol；omem agent probe 检查登录和模型。`,
    );
  });
program
  .command("serve")
  .description("前台运行服务与网页；适合终端、容器或已有服务管理器")
  .action(async () => {
    await import("./main.js");
  });
const service = group(
  "service",
  "PM2 后台服务：启动、停止、重启及状态（不安装开机启动项）",
);
for (const action of ["start", "stop", "restart", "status"] as const)
  service
    .command(action)
    .description(
      {
        start: "启动后台服务，退出终端后继续运行",
        stop: "停止本个人库的服务，保留全部数据",
        restart: "读取新配置并重启服务",
        status: "检查本个人库的进程、接口、采集与日志位置",
      }[action],
    )
    .action(async () => {
      const { manageService, formatServiceStatus } = await import(
        "./service-manager.js"
      );
      const result = await manageService(action);
      show(result, formatServiceStatus(result));
      if (
        action !== "stop" &&
        (result.state !== "online" || !result.health.healthy)
      )
        process.exitCode = 1;
    });
program
  .command("status")
  .description("检查目标 HTTP 服务、索引和个人消息采集是否健康")
  .action(async () => {
    const value = await api("/api/health");
    show(value);
    if (value.status !== "ok") process.exitCode = 1;
  });
program
  .command("open")
  .description("显示个人库网页地址；不会启动服务或修改系统默认浏览器")
  .action(() => show({ url: serverAddress() }, serverAddress()));
program
  .command("doctor")
  .description("检查安装资源、配置、服务及可选解析器；不下载、不调用模型")
  .action(async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    let health;
    try {
      health = await api("/api/health");
    } catch (error) {
      health = { error: String(error) };
    }
    const assets = [
      "apps/web/dist/index.html",
      "packages/agent-runtime/roles/daily-assistant/1/manifest.json",
      "skills/omem-cli/SKILL.md",
    ].map((path) => ({ path, present: existsSync(assetPath(path)) }));
    const result = {
      node: process.version,
      config: configPath(),
      dataDir: config.dataDir,
      url: serverAddress(),
      health,
      assets,
      agents: config.profiles.map((p) => ({
        id: p.id,
        command: p.command,
        model: p.model,
        idleTimeoutMs: p.idleTimeoutMs ?? p.timeoutMs,
        maxDurationMs: p.maxDurationMs ?? null,
      })),
      optional: {
        docling: existsSync(
          join(optionalRuntime("docling"), "venv/bin/python"),
        ),
        decisions: config.decisions?.mode ?? "off",
        semanticSearch: config.retrieval?.enabled ?? false,
      },
    };
    show(result);
    if (assets.some((a) => !a.present) || health.error) process.exitCode = 1;
  });
const config = group(
  "config",
  "查看配置位置、当前配置与验证结果；令牌仅由 OMEM_TOKEN 提供",
);
config
  .command("path")
  .description("显示实际配置及个人库位置")
  .action(() =>
    show(
      { config: configPath(), dataDir: defaultDataDir() },
      `${configPath()}\n个人库：${defaultDataDir()}`,
    ),
  );
config
  .command("show")
  .description("显示配置文件，不输出环境变量中的令牌")
  .action(async () => show(await readJson(configPath())));
config
  .command("validate")
  .description("验证配置结构和 Agent 选择；不调用模型")
  .action(async () => {
    const { loadConfig } = await import("./config.js");
    loadConfig();
    show({ ok: true }, "配置有效；修改后运行 omem service restart 生效。");
  });
const imports = group(
  "import",
  "把材料保存为带来源、固定版本的个人记忆；不自动扫描目录",
).addHelpText(
  "after",
  "\n示例：\n  omem import file ./notes.md\n  omem import git ./project src/main.ts --ref HEAD\n  omem import lark https://example.feishu.cn/docx/TOKEN\n  printf '周五前完成方案' | omem import text --title 项目记录\nPDF/DOCX 需显式运行 omem setup documents。飞书读取使用随包提供的官方 lark-cli。",
);
async function importFile(path: string) {
  const file = resolve(path);
  if ([".pdf", ".docx"].includes(extname(file).toLowerCase())) {
    if ((await stat(file)).size > 20_000_000) throw Error("文件不能超过 20 MB");
    return api(
      "/api/connectors/document",
      {
        name: basename(file),
        data: (await readFile(file)).toString("base64"),
        externalId: `file:${file}`,
      },
      "POST",
      undefined,
      240_000,
    );
  }
  const { fileInput } = await import("./connectors.js");
  return api("/api/captures", await fileInput(file, [dirname(file)]));
}
imports
  .command("file <path>")
  .description("导入一个本地文本/代码或 PDF/DOCX；文件内容上传到目标服务")
  .action(async (path) => show(await importFile(path)));
imports
  .command("git <repository> <file>")
  .option("--ref <ref>", "固定 Git 版本", "HEAD")
  .description("读取本地仓库指定版本的一个文件，保存提交与来源信息")
  .action(async (repo, file, opts) => {
    const { gitInput } = await import("./connectors.js");
    show(
      await api(
        "/api/captures",
        await gitInput(resolve(repo), file, opts.ref, [resolve(repo)]),
      ),
    );
  });
imports
  .command("lark <url>")
  .description("只读导入飞书正文；使用服务所在机器的飞书登录身份")
  .action(async (url) =>
    show(
      await api("/api/connectors/lark", { url }, "POST", undefined, 240_000),
    ),
  );
imports
  .command("capture [json-file]")
  .description("导入完整 Capture JSON；省略文件时从 stdin 读取")
  .action(async (file) => {
    const { captureSchema } = await import(
      "../../../packages/contracts/src/index.js"
    );
    show(await api("/api/captures", captureSchema.parse(await readJson(file))));
  });
imports
  .command("text [text]")
  .requiredOption("--title <title>", "这份记录的标题")
  .option("--source-id <id>", "复用此来源标识可保存后续版本")
  .description("保存一段文字；省略文字时读取 stdin")
  .action(async (text, opts) =>
    show(
      await api("/api/captures", {
        source: "file",
        externalId: opts.sourceId || `note:${randomUUID()}`,
        title: opts.title,
        parts: [{ type: "text", text: text ?? (await stdin()) }],
      }),
    ),
  );
program
  .command("search <query>")
  .description("检索原文、知识、记忆与代码，不调用大模型")
  .addOption(
    new Option("--purpose <purpose>", "查找目的")
      .choices([
        "balanced",
        "concept",
        "implementation",
        "background",
        "follow-up",
      ])
      .default("balanced"),
  )
  .action(async (query, opts) => {
    const hits = await api(
      `/api/search?${new URLSearchParams({ q: query, purpose: opts.purpose })}`,
    );
    show(
      hits,
      hits.length
        ? hits
            .map(
              (h: any, i: number) =>
                `${i + 1}. ${h.title || h.section?.title || h.id}\n${h.text || h.snippet || ""}\n`,
            )
            .join("\n")
        : "没有找到材料。先导入相关原文，或换一个关键词。",
    );
  });
program
  .command("ask <question>")
  .option("--conversation <id>", "在之前会话中追问；未指定则新建会话")
  .option("--research", "只调查和回答，不提出事项变更")
  .description(
    "让 Agent 搜索、补读并回答；普通模式也可提出事项变更（需服务与 Agent）",
  )
  .action(async (question, opts) => {
    const conversationId =
      opts.conversation ||
      (
        await api("/api/assistant/conversations", {
          chatId: `cli:${randomUUID()}`,
        })
      ).id;
    const requestId = randomUUID(),
      controller = new AbortController();
    const interrupt = () => {
      controller.abort();
    };
    process.once("SIGINT", interrupt);
    if (!json())
      console.error(`正在调查；会话 ${conversationId}。Ctrl+C 取消本轮。`);
    try {
      const result = await api(
        `/api/assistant/conversations/${enc(conversationId)}/turns`,
        {
          text: question,
          requestId,
          mode: opts.research ? "research" : "assist",
        },
        "POST",
        controller.signal,
        0,
      );
      const status = result.turn?.inputMessageRefs?.status;
      show(
        result,
        `${result.turn?.result || result.turn?.inputMessageRefs?.error || status}\n\n继续追问：omem ask "问题" --conversation ${conversationId}`,
      );
      if (status !== "done") process.exitCode = 1;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      try {
        const turns = await api(
          `/api/assistant/conversations/${enc(conversationId)}/turns`,
        );
        const own = turns.find(
          (t: any) =>
            t.inputMessageRefs?.transportEventId === `web:${requestId}`,
        );
        if (own)
          await api(
            `/api/assistant/conversations/${enc(conversationId)}/turns/${enc(own.id)}/cancel`,
            {},
          );
      } catch {
        console.error("取消请求未送达；请在网页检查本轮是否仍在运行。");
      }
      process.exitCode = 130;
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  });
const sources = group("sources", "浏览保存的来源与固定版本");
read(sources, "list", "列出来源（包含当前 revisionId）", "/api/sources");
sources
  .command("revision <id>")
  .description("读取一个固定版本")
  .action(async (id) => show(await api(`/api/revisions/${enc(id)}`)));
sources
  .command("history <source-id>")
  .description("列出某个来源的历史版本")
  .action(async (id) => show(await api(`/api/sources/${enc(id)}/history`)));
const knowledge = group("knowledge", "查看知识与材料；按阅读目标提交写作任务");
read(knowledge, "list", "列出文章、选材及处理状态", "/api/knowledge/articles");
knowledge
  .command("show <key>")
  .description("读取文章及其固定引用")
  .action(async (key) =>
    show(await api(`/api/knowledge/articles/${enc(key)}`)),
  );
knowledge
  .command("write <plan-file>")
  .description("用 {brief, revisionIds} JSON 提交调查、写作、独立复核任务")
  .addHelpText(
    "after",
    "\n计划字段与实例：omem skills show；完成状态见 omem knowledge list。排队成功不等于生成成功。",
  )
  .action(async (file) =>
    show(await api("/api/knowledge/pages", await readJson(file))),
  );
for (const [name, desc, path] of [
  ["memories", "已应用的持续记忆", "/api/memories"],
  ["tasks", "事项与待办", "/api/tasks"],
  ["jobs", "后台处理与失败诊断", "/api/jobs"],
]) {
  const parent = group(name!, desc!);
  read(parent, "list", `列出${desc}`, path!);
  if (name === "jobs") {
    parent
      .command("show <id>")
      .description("查看任务详情")
      .action(async (id) => show(await api(`/api/jobs/${enc(id)}`)));
    for (const action of ["retry", "cancel"])
      parent
        .command(`${action} <id>`)
        .description(action === "retry" ? "重试失败任务" : "取消后台任务")
        .action(async (id) =>
          show(await api(`/api/jobs/${enc(id)}/${action}`, {})),
        );
  }
}
const messages = group(
  "messages",
  "个人飞书消息：发现、订阅、只读采集与处理结果",
).addHelpText(
  "after",
  "\n开始：omem lark login → omem messages discover → omem messages watch <chat-id> → omem messages enable。\n默认暂停；免打扰默认排除，保留提及例外。不会发送/回复/删除消息或改变已读状态。\n采集周期与资源策略见 omem messages configure --help；消息通知由单独绑定的机器人发送。",
);
const mp = "/api/integrations/lark-personal";
read(messages, "status", "查看开关、订阅与采集状态", mp);
write(
  messages,
  "discover",
  "只读刷新最近会话列表；不会自动订阅",
  mp + "/discover",
);
write(
  messages,
  "sync",
  "排队采集已订阅会话；查看 inbox 跟踪结果",
  mp + "/sync",
);
read(messages, "inbox", "查看已采集消息及资源、决策与处理状态", mp + "/inbox");
for (const [action, mode, desc] of [
  ["watch", "watch", "订阅指定会话"],
  ["unwatch", "off", "取消订阅指定会话"],
  ["exclude", "excluded", "明确排除指定会话，包括提及例外"],
])
  messages
    .command(`${action} <chat-id>`)
    .description(desc!)
    .action(async (id) =>
      show(await api(mp + "/chats/" + enc(id), { mode }, "PUT")),
    );
for (const enabled of [true, false])
  messages
    .command(enabled ? "enable" : "pause")
    .description(enabled ? "启用定时只读采集" : "暂停定时采集，保留订阅与历史")
    .action(async () => show(await api(mp, { enabled }, "PUT")));
messages
  .command("configure <json-file>")
  .description(
    "修改采集设置：enabled、intervalMinutes、historyHours、mentionExceptions、resources",
  )
  .addHelpText(
    "after",
    '\n示例文件：{"enabled":false,"intervalMinutes":10,"historyHours":24,"mentionExceptions":true}\n这里只修改本助手采集配置，不修改飞书会话设置。',
  )
  .action(async (file) => show(await api(mp, await readJson(file), "PUT")));
messages
  .command("retry <id>")
  .description("重试一条消息的资源处理")
  .action(async (id) =>
    show(await api(mp + "/inbox/" + enc(id) + "/retry", {})),
  );
const agent = group("agent", "配置的 Agent 与实际模型/思考强度发现");
read(agent, "list", "列出服务启用的 Agent", "/api/profiles");
agent
  .command("probe [profile]")
  .description(
    "直接连接本机 Agent，读取可用模型、思考强度和技能；不要求启动服务",
  )
  .action(async (id = "traex") => {
    const { loadConfig } = await import("./config.js"),
      { acp } = await import("./agents.js");
    const c = loadConfig();
    const p = c.profiles.find((p) => p.id === id);
    if (!p || p.transport !== "acp")
      throw Error("请选择 ACP profile；CLI 类型不提供 ACP 能力发现");
    show(
      await acp(p, c.agentCwd, null, () => {}, new AbortController().signal),
    );
  });
const lark = group(
  "lark",
  "使用随包提供的官方 lark-cli 登录或检查身份；不开放消息写操作",
);
for (const action of ["login", "status"])
  lark
    .command(action)
    .description(
      action === "login" ? "交互式登录个人飞书身份" : "查看本机飞书授权状态",
    )
    .action(async () => {
      const child = spawn(
        process.execPath,
        [
          createRequire(import.meta.url).resolve(
            "@larksuite/cli/scripts/run.js",
          ),
          "auth",
          action,
        ],
        { stdio: "inherit" },
      );
      await new Promise<void>((r, j) => {
        child.once("error", j);
        child.once("exit", (code) => {
          if (code) process.exitCode = code;
          r();
        });
      });
    });
const bot = group(
  "bot",
  "复用已有飞书机器人绑定与通知流程（与个人只读采集分开）",
);
read(bot, "status", "查看已绑定机器人", "/api/integrations/lark/status");
read(
  bot,
  "defaults",
  "读取已有机器人绑定配置模板",
  "/api/integrations/lark/default-config",
);
read(
  bot,
  "apps",
  "列出已有可复用应用（不创建机器人）",
  "/api/integrations/lark/reusable-apps",
);
bot
  .command("connect <json-file>")
  .description("按既有绑定接口导入应用配置；密钥文件保留在个人目录")
  .action(async (file) =>
    show(await api("/api/integrations/lark/existing", await readJson(file))),
  );
bot
  .command("setup")
  .description("显示网页绑定入口，由现有向导完成登录与通知对象选择")
  .action(() =>
    show({ url: serverAddress() + "/#/lark" }, serverAddress() + "/#/lark"),
  );
const skills = group(
  "skills",
  "查看或复制随包提供的 Agent 使用技能；不自动安装全局 hooks",
);
skills
  .command("path")
  .description("输出 skills/omem-cli 所在目录")
  .action(() =>
    show({ path: assetPath("skills/omem-cli") }, assetPath("skills/omem-cli")),
  );
skills
  .command("show")
  .description("显示 omem-cli 的 SKILL.md")
  .action(async () => {
    const content = await readFile(
      assetPath("skills/omem-cli/SKILL.md"),
      "utf8",
    );
    show({ content }, content);
  });
skills
  .command("install <skills-directory>")
  .description("复制到你指定的 skills 目录；目标已存在则拒绝覆盖")
  .action(async (dir) => {
    const target = resolve(dir, "omem-cli");
    if (existsSync(target))
      throw Error(`已存在：${target}；先检查已有定制再决定是否替换`);
    await mkdir(dirname(target), { recursive: true });
    await cp(assetPath("skills/omem-cli"), target, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    show({ path: target }, `已复制：${target}`);
  });
program
  .command("setup <component>")
  .description(
    "显式准备可选能力：documents、document-models、decisions、embedding（需 osdk）",
  )
  .addHelpText(
    "after",
    "\n只准备运行环境和模型，不自动开启功能。documents 安装解析器；document-models 下载 PDF 模型；\ndecisions 安装 StartLux 并下载 2B/4B；embedding 下载中文向量模型。安装后按帮助修改配置并重启。",
  )
  .action(async (name) => {
    const { setupOptional } = await import("./cli/setup.js");
    await setupOptional(name);
  });
// Existing local integrations keep their command spellings; new users see grouped help.
program
  .command("capture [json-file]", { hidden: true })
  .action(async (file) =>
    show(await api("/api/captures", await readJson(file))),
  );
program
  .command("file <path>", { hidden: true })
  .action(async (file) => show(await importFile(file)));
program
  .command("lark-import <url>", { hidden: true })
  .action(async (url) => show(await api("/api/connectors/lark", { url })));
program.command("hook", { hidden: true }).action(async () => {
  const { hookInput } = await import("./connectors.js");
  await api("/api/captures", hookInput(await readJson()));
});
program.exitOverride();
try {
  if (process.argv.length === 2) program.outputHelp();
  else await program.parseAsync(process.argv);
} catch (error) {
  const e = error as Error & { code?: string; exitCode?: number };
  if (e.code?.startsWith("commander."))
    process.exitCode = e.exitCode === 0 ? 0 : 2;
  else {
    console.error(
      json() ? JSON.stringify({ error: e.message }) : `omem: ${e.message}`,
    );
    process.exitCode = 1;
  }
}
