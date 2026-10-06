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
const data = group(
  "data",
  "本机个人库：占用、备份、迁移、冷归档与清理（不操作 --url 远程服务）",
).addHelpText(
  "after",
  "\n备份、迁移、归档和清理前先停止服务与前台开发进程。archive/prune 默认只预览，--apply 才执行。恢复仅写入新目录；冷存储必须保持可访问。环境变量密钥和第三方登录不在备份中。",
);
async function libraryPaths() {
  if (program.opts().url || process.env.OMEM_URL)
    throw Error("data 只管理本机目录，请移除 --url/OMEM_URL 并指定 --data-dir");
  return { directory: defaultDataDir(), config: configPath() };
}
data
  .command("info")
  .description("查看实际路径、各类占用、记录数量和冷存储状态")
  .action(async () => {
    const paths = await libraryPaths(),
      lib = await import("./storage/library.js");
    show(lib.libraryInfo(paths.directory, paths.config));
  });
data
  .command("backup <directory>")
  .description("创建含冷存储和校验清单的完整数据备份；目标必须为新目录")
  .action(async (destination) => {
    const paths = await libraryPaths(),
      lib = await import("./storage/library.js");
    const result = lib.backupLibrary(
      paths.directory,
      paths.config,
      destination,
    );
    show(
      result,
      `已备份到 ${result.destination}，${result.files.length} 个文件。备份含个人材料与凭据，请妥善保存。`,
    );
  });
data
  .command("restore <backup>")
  .requiredOption("--to <directory>", "恢复到不存在的新个人库目录")
  .description("检查完整性后恢复，不覆盖现有库")
  .action(async (source, opts) => {
    await libraryPaths();
    const lib = await import("./storage/library.js");
    show(lib.restoreLibrary(source, opts.to));
  });
data
  .command("migrate")
  .requiredOption("--to <directory>", "新个人库目录")
  .description("备份校验后复制到新位置；原目录保留，之后用 --data-dir 启动")
  .action(async (opts) => {
    const paths = await libraryPaths(),
      lib = await import("./storage/library.js");
    show(lib.migrateLibrary(paths.directory, paths.config, opts.to));
  });
data
  .command("archive")
  .requiredOption("--before <date>", "归档早于此日期的消息载荷和附件")
  .option("--to <directory>", "冷存储目录，首次必须指定")
  .option("--apply", "执行归档，默认预览")
  .option("--compact", "归档后收缩 SQLite 文件，需要额外磁盘空间")
  .description(
    "迁出旧载荷，保留原文版本、去重与引用；最近 200 条消息保持热存储",
  )
  .action(async (opts) => {
    const paths = await libraryPaths(),
      lib = await import("./storage/library.js");
    show(
      lib.archiveLibrary(paths.directory, { ...opts, destination: opts.to }),
    );
  });
data
  .command("prune")
  .requiredOption("--before <date>", "清理早于此日期的已完成 Agent 临时目录")
  .option("--apply", "执行清理，默认预览")
  .description("仅清理可重建的运行副本；原件、正式输出、历史和日志保留")
  .action(async (opts) => {
    const paths = await libraryPaths(),
      lib = await import("./storage/library.js");
    show(lib.pruneLibrary(paths.directory, opts.before, opts.apply));
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
const contexts = group(
  "contexts",
  "管理项目与主题归属；需求持续跟进按此范围读取新材料",
);
read(contexts, "list", "列出项目与主题", "/api/contexts");
contexts
  .command("create <name>")
  .option("--description <text>", "说明项目范围", "")
  .description("创建一个项目范围")
  .action(async (name, opts) =>
    show(
      await api("/api/contexts", {
        name,
        kind: "project",
        description: opts.description,
      }),
    ),
  );
contexts
  .command("assign <source-id> <context-ids...>")
  .description("设置来源的完整归属列表；从 sources list 获取 source-id")
  .action(async (id, contextIds) =>
    show(await api(`/api/sources/${enc(id)}/contexts`, { contextIds }, "PUT")),
  );
const requirements = group(
  "requirements",
  "需求 Agent：综合文档、消息、纪要与代码持续跟进，导出实现交接",
).addHelpText(
  "after",
  "\n先导入材料并设置项目归属。track 提交调查→实现建议→独立复核，--watch 会跟踪该范围的新材料。不会仅凭群消息改代码或标记需求完成。新消息归属尚待判断时，不会自动进入本需求。生成状态见 list，正文见 show。",
);
requirements
  .command("track <title>")
  .requiredOption("--goal <text>", "需求目标与期望交付")
  .option("--context <ids...>", "持续跟进的项目/主题 ID")
  .option("--revision <ids...>", "明确选择的材料版本 ID")
  .option("--watch", "在材料更新后持续整理")
  .description("建立需求跟进页；至少指定一个项目或原文版本")
  .action(async (title, opts) => {
    if (!opts.context?.length && !opts.revision?.length)
      throw Error("请用 --context 或 --revision 明确选材范围");
    const { requirementBrief } = await import("./knowledge/requirements.js");
    const key = `requirement:${randomUUID()}`;
    const brief = requirementBrief({
      key,
      title,
      goal: opts.goal,
      ...(opts.context?.length ? { contextIds: opts.context } : {}),
    });
    const result = await api("/api/knowledge/pages", {
      brief,
      revisionIds: opts.revision ?? [],
    });
    if (opts.watch)
      await api(
        `/api/knowledge/pages/${enc(key)}/maintenance`,
        { enabled: true },
        "PUT",
      );
    show(
      { ...result, watch: !!opts.watch },
      `需求已排队：${key}\n查看：omem requirements show ${key}\n排队不等于完成；omem requirements list 查看状态。`,
    );
  });
requirements
  .command("list")
  .description("查看需求目标、跟进状态和失败原因")
  .action(async () => {
    const value = await api("/api/knowledge/articles");
    show(
      value.pages.filter(
        (p: any) => p.plan?.workflow === "requirement-followup",
      ),
    );
  });
requirements
  .command("show <key>")
  .description("读取已发布的需求跟进页与固定引用")
  .action(async (key) =>
    show(await api(`/api/knowledge/articles/${enc(key)}`)),
  );
requirements
  .command("refresh <key>")
  .description("请求重新调查与更新同一需求页")
  .action(async (key) =>
    show(await api(`/api/knowledge/pages/${enc(key)}/refresh`, {})),
  );
requirements
  .command("watch <key>")
  .option("--off", "暂停持续更新")
  .description("启用或暂停材料变化后的自动跟进")
  .action(async (key, opts) =>
    show(
      await api(
        `/api/knowledge/pages/${enc(key)}/maintenance`,
        { enabled: !opts.off },
        "PUT",
      ),
    ),
  );
requirements
  .command("handoff <key>")
  .requiredOption("--to <directory>", "新建交接目录，不能已存在")
  .description(
    "导出 TASK.md、固定引用及文本原件，供编码 Agent 继续实现；不执行代码",
  )
  .action(async (key, opts) => {
    const value = await api(`/api/knowledge/pages/${enc(key)}/handoff`),
      dest = resolve(opts.to);
    await mkdir(dest, { mode: 0o700 });
    await mkdir(join(dest, "originals"), { mode: 0o700 });
    const references = [];
    for (const [index, m] of value.materials.entries()) {
      const file = `originals/${index + 1}.txt`;
      await writeFile(join(dest, file), m.text, { mode: 0o600 });
      const { text, ...metadata } = m;
      references.push({ ...metadata, file });
    }
    await writeFile(join(dest, "TASK.md"), value.markdown, { mode: 0o600 });
    await writeFile(
      join(dest, "references.json"),
      JSON.stringify(
        { ...value, markdown: undefined, materials: references },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    show(
      { directory: dest, current: value.current, materials: references.length },
      `交接材料：${dest}/TASK.md\n${value.current ? "固定快照已导出；开工前仍需核对实际仓库。" : "材料已有变化，请先复查再实现。"}`,
    );
  });
requirements
  .command("board <key>")
  .description("查看结构化验收项、行动项及关联待办")
  .action(async (key) => show(await api(`/api/requirements/${enc(key)}`)));
requirements
  .command("follow <key> <action-id>")
  .description("跟进明确行动项；创建个人待办并随已复核需求更新")
  .action(async (key, actionId) => {
    const board = await api(`/api/requirements/${enc(key)}`);
    show(
      await api(
        `/api/requirements/${enc(key)}/actions/${enc(actionId)}/follow`,
        { expectedRevision: board.revision },
      ),
    );
  });
requirements
  .command("unfollow <key> <action-id>")
  .description("停止自动同步，保留已有待办")
  .action(async (key, actionId) =>
    show(
      await api(
        `/api/requirements/${enc(key)}/actions/${enc(actionId)}/follow`,
        undefined,
        "DELETE",
      ),
    ),
  );
import { formatDevelopmentRun } from "./development/format.js";
const develop = group(
  "develop",
  "按需求实施代码、运行项目检查、独立评审与回修",
).addHelpText(
  "after",
  `
本地编码：读取本个人库中的需求和登记仓库；不接受远程 --url。修改发生在独立 Git 副本，原工作区保留。
先登记项目 JSON：{name,repository,instructions?,ruleFiles?,commands:[{name,command,args,purpose,required?}]}。
purpose 可为 setup/test/build/browser/design。只运行明确登记的命令；请包含项目必要的依赖准备和验收。
start/resume 前台运行，活动超时按 Agent 配置；中断后可 resume。最多三轮编码与独立评审。
ready 表示本轮检查和 Agent 评审通过，apply 才把补丁应用到原工作区；不提交、不推送、不部署。
`,
);
async function developmentRunner() {
  if (process.env.OMEM_URL)
    throw Error("编码与外部能力配置在本机个人库运行，不能使用 --url/OMEM_URL");
  const { DevelopmentRunner } = await import("./development/runner.js");
  return new DevelopmentRunner(defaultDataDir());
}
develop
  .command("register <alias> <config-file>")
  .description("登记目标仓库、项目规则与允许运行的检查命令")
  .action(async (alias, file) =>
    show(
      await (await developmentRunner()).register(alias, await readJson(file)),
    ),
  );
develop
  .command("projects")
  .description("查看已登记编码项目")
  .action(async () => show((await developmentRunner()).projects()));
const capabilities = group(
  "capabilities",
  "登记和检查外部只读 skill、CLI、MCP，按项目装配",
).addHelpText(
  "after",
  `\n能力保存在个人库，服务下次调用时读取。先 add 能力 JSON，再 attach 到项目；Agent 可按任务选择已登记能力。\n认证仅引用环境变量或工具现有登录态，不把密钥写入 JSON。此入口不安装软件、不替你登录、不开放消息写入。\nadd <file>：登记/更新；check <id>：执行登记的健康检查并发现允许工具；call：供 Agent 和排障使用。\n查看随包 skills/omem-cli/references/capabilities.md 的完整配置示例。\n`,
);
async function capabilityRegistry() {
  return (await developmentRunner()).capabilities;
}
async function withCapability(
  id: string,
  action: (
    session: import("./capabilities/session.js").CapabilitySession,
  ) => Promise<unknown> | unknown,
) {
  const registry = await capabilityRegistry();
  const { CapabilitySession } = await import("./capabilities/session.js");
  const refs = registry.references([id]);
  const session = new CapabilitySession(registry, refs, {
    directory: join(defaultDataDir(), "capability-runs", id),
    cwd: process.cwd(),
  });
  try {
    return await action(session);
  } finally {
    await session.close();
  }
}
capabilities
  .command("add <config-file>")
  .description(
    "导入能力声明和技能快照；重复 ID 更新当前版本，已有任务保留原版本",
  )
  .action(async (file) =>
    show(
      (await capabilityRegistry()).register(
        await readJson(file),
        dirname(resolve(file)),
      ),
    ),
  );
capabilities
  .command("list")
  .description("列出已启用能力（不自动连接外部服务）")
  .action(async () => show((await capabilityRegistry()).list()));
capabilities
  .command("show <id>")
  .description("查看用途、技能与允许工具")
  .action(async (id) => {
    const r = await capabilityRegistry();
    show(r.describe(r.read(id)));
  });
capabilities
  .command("disable <id>")
  .description("停用能力，保留历史；后续调用立即拒绝")
  .action(async (id) => show((await capabilityRegistry()).disable(id)));
capabilities
  .command("attach <project> [ids...]")
  .description("设置编码项目默认能力；省略 ids 清空，仅影响后续任务")
  .action(async (project, ids) =>
    show((await developmentRunner()).selectCapabilities(project, ids)),
  );
capabilities
  .command("check <id>")
  .description("运行健康/登录检查，并读取允许的 MCP 工具与参数")
  .action(async (id) => {
    const r: any = await withCapability(id, (s) => s.inspect(id));
    show(r);
    if (!r.available) process.exitCode = 1;
  });
capabilities
  .command("skill <id> <name> [path]")
  .description("读取已登记技能及其引用资源（默认 SKILL.md）")
  .action(async (id, name, path = "SKILL.md") => {
    const r = await capabilityRegistry();
    show(r.readSkill(r.read(id), name, path));
  });
capabilities
  .command("call <id> <tool> [input-file]")
  .option("--kind <kind>", "mcp 或 cli", "mcp")
  .description(
    "调用允许的只读工具，输入为 JSON 文件或 stdin；返回真实结果并保存回执",
  )
  .action(async (id, tool, file, opts) => {
    if (!["cli", "mcp"].includes(opts.kind))
      throw Error("--kind 仅支持 cli 或 mcp");
    const args = await readJson(file);
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw Error("工具输入必须为 JSON 对象");
    const r: any = await withCapability(id, (s) =>
      s.call(id, opts.kind, tool, args),
    );
    show(r);
    if (r.result?.isError || r.result?.exitCode) process.exitCode = 1;
  });
develop
  .command("list")
  .description("查看编码任务和结果目录")
  .action(async () => {
    const runs = (await developmentRunner()).list();
    show(
      runs,
      runs.length
        ? runs.map(formatDevelopmentRun).join("\n\n")
        : "还没有编码任务。先用 omem develop register 登记项目。",
    );
  });
develop
  .command("show <id>")
  .description("查看状态、失败原因、实际检查与评审问题")
  .action(async (id) => {
    const run = (await developmentRunner()).read(id);
    show(run, formatDevelopmentRun(run));
  });
async function runDevelopment(
  id: string | undefined,
  key: string | undefined,
  alias: string | undefined,
) {
  const runner = await developmentRunner();
  const { loadConfig, assistantProfile } = await import("./config.js");
  const { Store } = await import("./store.js");
  const config = loadConfig(),
    profile = assistantProfile(config);
  if (!profile) throw Error("请先配置 ACP Agent");
  const store = new Store(config.dataDir),
    abort = new AbortController();
  const stop = () => {
    process.exitCode = 130;
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const run = id ? runner.read(id) : await runner.create(alias!, key!, store);
    console.error(`开发任务 ${run.id}；目录 ${run.directory}`);
    const result = await runner.execute(run.id, store, profile, {
      signal: abort.signal,
      log: (s) => console.error(s),
    });
    show(result, formatDevelopmentRun(result));
    if (result.state !== "ready") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    store.close();
  }
}
develop
  .command("start <requirement-key>")
  .requiredOption("--project <alias>", "已登记项目别名")
  .description("从当前需求与干净仓库创建独立副本并开始编码")
  .action(async (key, opts) => runDevelopment(undefined, key, opts.project));
develop
  .command("resume <id>")
  .description("保留代码和问题，从中断/受阻状态继续一轮实现与独立评审")
  .action(async (id) => runDevelopment(id, undefined, undefined));
develop
  .command("diff <id>")
  .description("输出当前编码任务相对原仓库的差异")
  .action(async (id) => {
    const runner = await developmentRunner(),
      run = runner.read(id),
      { git } = await import("./development/workspace.js");
    const diff = await git(run.checkout, "diff", run.base, "--");
    show({ diff }, diff);
  });
develop
  .command("apply <id>")
  .description("将已评审补丁应用到仍位于原版本的干净工作区，保留未提交供检查")
  .action(async (id) => {
    const run = await (await developmentRunner()).apply(id);
    show(run, formatDevelopmentRun(run));
  });
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
    if (process.exitCode !== 130) process.exitCode = 1;
  }
}
