import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkbox, confirm, input, number, select } from "@inquirer/prompts";
import { commandExists } from "./agents/spawn.ts";
import type { App } from "./core/app.ts";
import { builtinProfiles, roleNames, saveConfig, type AgentProfile, type Config } from "./core/config.ts";
import { run } from "./core/db.ts";
import { listSchedules, scheduleLabels } from "./core/scheduler.ts";
import { doclingScript } from "./sources/import.ts";

/**
 * `omem setup`: one interactive place for everything that is not a daily
 * setting — agents, local models (through osdk when available), document
 * parsing, channels, sessions, schedules. Each section shows what is already
 * installed, explains the trade-off of each option and only then changes
 * anything. Non-interactive forms (`omem setup embeddings --model …`) stay for
 * scripts.
 */
const here = dirname(fileURLToPath(import.meta.url));
/** The package root, where osdk.toml declares omem's models. */
export function packageRoot() {
  for (const c of [resolve(here, ".."), resolve(here, "../..")]) if (existsSync(join(c, "osdk.toml"))) return c;
  return resolve(here, "..");
}

const out = (s = "") => process.stderr.write(s + "\n");
const ok = (b: boolean) => (b ? "✓" : "·");

// ---- osdk -----------------------------------------------------------------

export function osdkAvailable() {
  return commandExists("osdk");
}
function osdk(args: string[], opts: { inherit?: boolean } = {}) {
  const r = spawnSync("osdk", args, { cwd: packageRoot(), encoding: "utf8", stdio: opts.inherit ? "inherit" : "pipe", windowsHide: true, shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`osdk ${args.join(" ")} 失败${r.stderr ? "：" + r.stderr.trim().slice(-600) : ""}`);
  return (r.stdout ?? "").trim();
}
function osdkModelPath(alias: string): string | null {
  try {
    const p = osdk(["model", "path", alias, "--stable"]).split("\n").pop()!.trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
function guideOsdk() {
  out("  没有找到 osdk。omem 用 osdk 管理 Node、Python 工具和本地模型（下载按锁定摘要校验，可离线复用）。");
  out("  安装方法见 https://github.com/lejunyang/one-sdk 。装好后在 omem 目录运行 `osdk install && osdk deps`，再重新运行 omem setup。");
}

// ---- embeddings -----------------------------------------------------------

export type EmbeddingChoice = { id: string; label: string; alias: string; repo: string; size: string; note: string };
export const EMBEDDINGS: EmbeddingChoice[] = [
  {
    id: "bge-small-zh",
    label: "bge-small-zh-v1.5（推荐）",
    alias: "memory-zh",
    repo: "Xenova/bge-small-zh-v1.5",
    size: "约 25MB",
    note: "512 维，CPU 上很快；T2Retrieval 小样本 nDCG@10 87（纯全文 69）",
  },
  {
    id: "bge-base-zh",
    label: "bge-base-zh-v1.5",
    alias: "memory-zh-base",
    repo: "Xenova/bge-base-zh-v1.5",
    size: "约 100MB",
    note: "768 维，通常比 small 高几个点，建库和查询慢 2～3 倍；未在本项目实测",
  },
  {
    id: "bge-m3",
    label: "bge-m3（多语言、长文本）",
    alias: "memory-m3",
    repo: "Xenova/bge-m3",
    size: "约 570MB",
    note: "1024 维，中英混合和长段落更好，CPU 上明显更慢；未在本项目实测",
  },
];
const EMBED_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];

/** Prepare a local embedding model through osdk; returns the directory transformers.js loads offline. */
export function osdkEmbedding(choice: EmbeddingChoice) {
  if (choice.alias !== "memory-zh") {
    try {
      osdk(["model", "show", choice.alias, "--json", "--offline"]);
    } catch {
      osdk(["model", "use", choice.alias, `hf:${choice.repo}@main`, ...EMBED_FILES.flatMap((f) => ["--include", f]), "--kind", "embedding", "--family", "bge"], { inherit: true });
    }
  }
  osdk(["model", "sync", choice.alias], { inherit: true });
  const path = osdkModelPath(choice.alias);
  if (!path) throw new Error(`osdk 没有给出 ${choice.alias} 的本地路径`);
  return path;
}

async function setupEmbeddingsSection(config: Config) {
  const cur = config.embeddings;
  out(`\n当前：${cur.provider === "none" ? "未开启（只用全文检索）" : `${cur.provider} · ${cur.model}`}`);
  const choice = await select({
    message: "向量检索（语义搜索）",
    choices: [
      ...EMBEDDINGS.map((e) => ({ value: e.id, name: `${e.label} · ${e.size}`, description: e.note })),
      { value: "openai", name: "OpenAI 兼容接口", description: "用远程 embedding 服务（需要 API key，材料会发给该服务）" },
      { value: "none", name: "关闭", description: "只用全文检索（中文双字 + 标识符拆分）" },
      { value: "keep", name: "保持不变" },
    ],
    default: "keep",
  });
  if (choice === "keep") return false;
  if (choice === "none") {
    config.embeddings = { ...cur, provider: "none" };
    return true;
  }
  if (choice === "openai") {
    const url = await input({ message: "接口地址（…/v1）", default: cur.url ?? "https://api.openai.com/v1" });
    const model = await input({ message: "模型名", default: cur.provider === "openai" ? cur.model : "text-embedding-3-small" });
    const apiKeyEnv = await input({ message: "API key 所在的环境变量", default: cur.apiKeyEnv });
    config.embeddings = { provider: "openai", url, model, apiKeyEnv, family: "other" };
    return true;
  }
  const e = EMBEDDINGS.find((x) => x.id === choice)!;
  let model = e.repo;
  if (osdkAvailable()) {
    const how = await select({
      message: `${e.label} 从哪里来`,
      choices: [
        { value: "osdk", name: "osdk 下载并锁定（推荐）", description: "按固定版本校验，换机器可复现，之后离线加载" },
        { value: "hub", name: "首次使用时从 Hugging Face 下载", description: "存在 transformers.js 缓存里，不锁定版本" },
      ],
    });
    if (how === "osdk") model = osdkEmbedding(e);
  } else {
    guideOsdk();
    if (!(await confirm({ message: `先不用 osdk，首次使用时直接从 Hugging Face 下载 ${e.repo}（${e.size}）？`, default: true }))) return false;
  }
  config.embeddings = { ...cur, provider: "local", model, family: e.id === "bge-m3" ? "bge-m3" : "bge-zh" };
  out(`  已选择 ${model}。换模型后已有的向量会清空，服务会在后台重新生成（也可运行 omem setup embeddings 立即生成）。`);
  return true;
}

// ---- documents ------------------------------------------------------------

const DOCLING_MODELS: [alias: string, folder: string][] = [
  ["docling-layout", "docling-project--docling-layout-heron"],
  ["docling-tables", "docling-project--docling-models"],
];

/** Sync Docling's layout/table models through osdk and lay them out the way Docling expects. */
export function prepareDoclingModels(home: string) {
  const root = join(home, "models", "docling");
  mkdirSync(root, { recursive: true });
  for (const [alias, folder] of DOCLING_MODELS) {
    osdk(["model", "sync", alias], { inherit: true });
    const path = osdkModelPath(alias);
    if (!path) throw new Error(`osdk 没有给出 ${alias} 的本地路径`);
    const target = join(root, folder);
    try {
      if (lstatSync(target).isSymbolicLink() && readlinkSync(target) === path) continue;
      unlinkSync(target);
    } catch {}
    symlinkSync(path, target, process.platform === "win32" ? "junction" : "dir");
  }
  return root;
}

async function setupDocumentsSection(config: Config, home: string) {
  const has = { uv: commandExists("uv"), pdftotext: commandExists("pdftotext"), pandoc: commandExists("pandoc"), docling: !!doclingScript() };
  const models = config.documents.doclingArtifacts && existsSync(config.documents.doclingArtifacts);
  out(`\n文档解析（PDF / DOCX）：本机 ${ok(has.uv)} uv（Docling 用）  ${ok(!!models)} Docling PDF 模型  ${ok(has.pdftotext)} pdftotext  ${ok(has.pandoc)} pandoc`);
  out(`当前顺序：${config.documents.engines.join(" → ")}${config.documents.converter ? `；自定义命令优先：${config.documents.converter}` : ""}`);
  const choice = await select({
    message: "PDF / DOCX 用什么解析",
    choices: [
      { value: "docling", name: "Docling（推荐）", description: "保留标题层级、表格和图片位置；首次会装 Python 依赖（含 PyTorch，约 1～2GB），PDF 还需布局模型约 300MB" },
      { value: "light", name: "pdftotext + pandoc", description: "轻量，PDF 只取纯文字（表格会乱），DOCX 效果不错" },
      { value: "custom", name: "自定义命令", description: "任何把文件转成 Markdown 输出到 stdout 的命令，{file} 会被替换" },
      { value: "keep", name: "保持不变" },
    ],
    default: "keep",
  });
  if (choice === "keep") return false;
  if (choice === "custom") {
    config.documents.converter = await input({ message: "命令", default: config.documents.converter ?? "markitdown {file}" });
    return true;
  }
  if (choice === "light") {
    config.documents.engines = ["pdftotext", "pandoc", "docling"];
    if (!has.pdftotext || !has.pandoc)
      out(`  还需要安装：${[!has.pdftotext && "pdftotext（poppler-utils / poppler）", !has.pandoc && "pandoc"].filter(Boolean).join("、")}。Windows 可用 scoop/winget，macOS 用 brew，Linux 用系统包管理器。`);
    return true;
  }
  config.documents.engines = ["docling", "pdftotext", "pandoc"];
  if (!has.uv) {
    if (osdkAvailable() && (await confirm({ message: "Docling 需要 uv（Python 项目管理器）。用 osdk 安装 uv？", default: true }))) osdk(["install", "uv"], { inherit: true });
    else out("  请先安装 uv（https://docs.astral.sh/uv/ ，或 osdk install uv），再重新运行。");
  }
  if (commandExists("uv") && (await confirm({ message: "现在安装 Docling 的 Python 依赖？（否则第一次导入文档时再装）", default: false }))) {
    const r = spawnSync("uv", ["sync", "--project", dirname(doclingScript()!)], { stdio: "inherit", windowsHide: true });
    if (r.status !== 0) out("  安装失败，稍后可在 scripts/document-parser 目录运行 uv sync 重试。");
  }
  if (osdkAvailable()) {
    if (await confirm({ message: "下载 Docling 的 PDF 布局与表格模型（osdk，约 300MB）？没有它们 Docling 只解析 DOCX，PDF 走 pdftotext。", default: true }))
      config.documents.doclingArtifacts = prepareDoclingModels(home);
  } else guideOsdk();
  return true;
}

// ---- agents ---------------------------------------------------------------

const QUICK_ROLES = ["assistant", "ingest", "heartbeat", "summarizer", "brief", "curator"];
const DEEP_ROLES = roleNames.filter((r) => !QUICK_ROLES.includes(r));

async function setupAgentsSection(config: Config) {
  const profiles = new Map(builtinProfiles.map((p) => [p.id, p]));
  for (const p of config.agents.profiles) profiles.set(p.id, p);
  const list = [...profiles.values()].map((p) => ({ ...p, installed: commandExists(p.command) }));
  out("\nAgent 后端：");
  for (const p of list) out(`  ${ok(p.installed)} ${p.id.padEnd(11)} ${p.name ?? ""}${p.model ? ` · ${p.model}` : ""}${p.effort ? `/${p.effort}` : ""}${p.installed ? "" : `（未找到 ${p.command}）`}`);
  if (!list.some((p) => p.installed)) {
    out("  一个都没装。推荐：npm i -g @agentclientprotocol/codex-acp（并登录 codex），或 npm i -g @agentclientprotocol/claude-agent-acp（并登录 claude）。");
    return false;
  }
  const installed = list.filter((p) => p.installed);
  const pick = (message: string, def?: string) =>
    select({ message, choices: [...installed.map((p) => ({ value: p.id, name: `${p.id}${p.model ? ` · ${p.model}` : ""}` })), { value: "", name: "跟随默认" }], default: def ?? "" });
  const def = await select({ message: "默认 Agent", choices: installed.map((p) => ({ value: p.id, name: `${p.id} · ${p.name ?? p.command}` })), default: config.agents.default ?? installed[0].id });
  config.agents.default = def;
  if (await confirm({ message: "按任务分开指定？（日常问答与整理用快的，Wiki、编码、评审、做梦用强的）", default: false })) {
    const quick = await pick(`日常（${QUICK_ROLES.join("、")}）`, config.agents.roles.assistant);
    const deep = await pick(`深度（${DEEP_ROLES.join("、")}）`, config.agents.roles["wiki-writer"]);
    for (const r of QUICK_ROLES) quick ? (config.agents.roles[r] = quick) : delete config.agents.roles[r];
    for (const r of DEEP_ROLES) deep ? (config.agents.roles[r] = deep) : delete config.agents.roles[r];
  }
  if (await confirm({ message: "修改某个后端的模型或 effort？", default: false })) {
    const id = await select({ message: "哪个", choices: installed.map((p) => ({ value: p.id, name: p.id })) });
    const base = profiles.get(id)!;
    const model = await input({ message: "模型（留空用 Agent 自己的默认；可在网页设置里“检测模型”看可选值）", default: base.model ?? "" });
    const effort = await input({ message: "effort（low / medium / high，留空用默认）", default: base.effort ?? "" });
    const next: AgentProfile = { ...base, model: model || undefined, effort: effort || undefined };
    config.agents.profiles = [...config.agents.profiles.filter((p) => p.id !== id), next];
  }
  return true;
}

// ---- channels -------------------------------------------------------------

async function setupChannelsSection(config: Config) {
  const which = await checkbox({
    message: "要接入的渠道",
    choices: [
      { value: "lark", name: "飞书机器人（私聊指挥、群聊/话题会话、通知）", checked: config.lark.enabled },
      { value: "telegram", name: "Telegram 机器人（私聊、群、论坛话题）", checked: config.telegram.enabled },
      { value: "onebot", name: "QQ / 微信（OneBot v11 桥，如 NapCat、LLOneBot）", checked: config.onebot.enabled },
    ],
  });
  config.lark.enabled = which.includes("lark");
  config.telegram.enabled = which.includes("telegram");
  config.onebot.enabled = which.includes("onebot");
  if (config.lark.enabled) {
    config.lark.appId = (await input({ message: "飞书 App ID", default: config.lark.appId ?? "" })) || undefined;
    config.lark.ownerOpenId = (await input({ message: "你的 open_id（不知道就留空，私聊机器人一次它会告诉你）", default: config.lark.ownerOpenId ?? "" })) || undefined;
    out(`  App Secret 放在环境变量 ${config.lark.appSecretEnv}，不写进配置文件。`);
  }
  if (config.telegram.enabled) {
    config.telegram.ownerChatId = (await input({ message: "你的 Telegram 用户 id（留空则私聊机器人时告诉你）", default: config.telegram.ownerChatId ?? "" })) || undefined;
    out(`  Bot token 放在环境变量 ${config.telegram.tokenEnv}。群里用 @机器人 或回复它；论坛群的每个话题各自是一个会话。`);
  }
  if (config.onebot.enabled) {
    config.onebot.url = await input({ message: "OneBot 正向 WebSocket 地址", default: config.onebot.url ?? "ws://127.0.0.1:3001" });
    config.onebot.name = await input({ message: "显示名（QQ / 微信）", default: config.onebot.name });
    config.onebot.ownerUserId = (await input({ message: "你的账号 id（留空则私聊时告诉你）", default: config.onebot.ownerUserId ?? "" })) || undefined;
  }
  return true;
}

// ---- sessions & schedules ---------------------------------------------------

async function setupSessionsSection(config: Config) {
  const s = config.sessions;
  out("\n会话：每个私聊 / 群 / 话题是一个会话，Agent 会话在回复后保持一段时间，之后可恢复或从摘要接上。");
  s.liveMinutes = (await number({ message: "回复后保持 Agent 进程多少分钟（0 = 每次回复后释放，靠恢复接上）", default: s.liveMinutes, min: 0 })) ?? s.liveMinutes;
  s.maxLive = (await number({ message: "最多同时保持几个 Agent 进程", default: s.maxLive, min: 0 })) ?? s.maxLive;
  s.idleHours = (await number({ message: "聊天空闲多少小时后开始新会话（带上一段摘要；0 = 不自动）", default: s.idleHours, min: 0 })) ?? s.idleHours;
  s.mergeMs = (await number({ message: "连发消息合并等待（毫秒）", default: s.mergeMs, min: 0 })) ?? s.mergeMs;
  config.interactiveConcurrency = (await number({ message: "同时处理几个会话", default: config.interactiveConcurrency, min: 1, max: 16 })) ?? config.interactiveConcurrency;
  config.concurrency = (await number({ message: "同时运行几个后台任务（整理、Wiki、做梦…）", default: config.concurrency, min: 1, max: 8 })) ?? config.concurrency;
  return true;
}

async function setupSchedulesSection(app: App) {
  const list = listSchedules(app);
  const on = await checkbox({
    message: "定时任务",
    choices: list.map((s) => ({ value: s.id, name: `${scheduleLabels[s.kind] ?? s.kind}（${s.cron}）`, checked: s.enabled })),
  });
  for (const s of list) run(app.db, "update schedules set enabled = ? where id = ?", on.includes(s.id) ? 1 : 0, s.id);
  return true;
}

// ---- entry ----------------------------------------------------------------

export async function setupInteractive(app: App) {
  const config = app.config;
  out(`omem 设置 · 数据目录 ${app.home}`);
  out(`本机：${ok(osdkAvailable())} osdk  ${ok(commandExists("uv"))} uv  ${ok(commandExists("git"))} git  · 向量 ${config.embeddings.provider === "none" ? "未开启" : config.embeddings.model}`);
  if (!osdkAvailable()) guideOsdk();
  const sections = await checkbox({
    message: "要设置哪些部分（空格选择，回车确认）",
    choices: [
      { value: "agents", name: "Agent 后端与模型", checked: !config.agents.default },
      { value: "embeddings", name: "向量检索模型", checked: config.embeddings.provider === "none" },
      { value: "documents", name: "PDF / DOCX 解析（Docling 等）" },
      { value: "channels", name: "渠道：飞书 / Telegram / QQ·微信" },
      { value: "sessions", name: "会话与并发" },
      { value: "schedules", name: "定时任务（巡检、简报、做梦、同步…）" },
    ],
  });
  const before = JSON.stringify(config.embeddings);
  for (const s of sections) {
    try {
      if (s === "agents") await setupAgentsSection(config);
      if (s === "embeddings") await setupEmbeddingsSection(config);
      if (s === "documents") await setupDocumentsSection(config, app.home);
      if (s === "channels") await setupChannelsSection(config);
      if (s === "sessions") await setupSessionsSection(config);
      if (s === "schedules") await setupSchedulesSection(app);
    } catch (e) {
      if ((e as Error).name === "ExitPromptError") throw e;
      out(`  ${s} 未完成：${(e as Error).message}`);
    }
    saveConfig(config, app.home);
  }
  if (JSON.stringify(config.embeddings) !== before && config.embeddings.provider !== "none") {
    if (await confirm({ message: "现在为已有材料生成向量？（否则服务会在后台慢慢补）", default: true })) {
      const { embedPending } = await import("./search/embeddings.ts");
      let n = 0;
      for (let k = await embedPending(app, 64); k; k = await embedPending(app, 64)) {
        n += k;
        process.stderr.write(`\r已生成 ${n} 个片段的向量…`);
      }
      out("");
    }
  }
  out(`\n已保存到 ${join(app.home, "config.json")}。正在运行的服务需要重启才会读取新设置。`);
}
