import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { HttpError, truncate } from "../core/util.ts";
import { asOwner, cliUser } from "./lark-auth.ts";
import { larkActing, larkCli, larkCliOutput } from "./lark-cli.ts";
import { larkOpenIdOf } from "../core/users.ts";
import { personalLibrary, wikiNode } from "./lark-wiki.ts";

/**
 * lark_read / lark_write: lark-cli commands run as the owner (or as whoever the run works for, with their
 * own connection: src/auth/lark-user.ts), so an agent can follow lark-cli's own
 * skills (`lark-cli skills read lark-sheets`…) for spreadsheets, Base, tasks, Drive, mail, meetings.
 * lark-cli labels every command read | write | high-risk-write in its --help; that label decides:
 * reads run in the domains below, writes only in the few where the owner allowed them (and with the
 * owner's approval outside the owner's own files, tools.ts), high-risk writes never. Docs keep
 * their own tools (lark_doc_*); messages and mail are never sent as the owner.
 */

/** Data the owner can read through lark-cli. Not: api (raw), auth, config, profile, update, event, apps, doctor. */
const READ_DOMAINS = new Set(["docs", "drive", "markdown", "sheets", "slides", "base", "task", "mail", "wiki", "im", "minutes", "note", "vc", "calendar", "contact", "mindnotes", "whiteboard", "okr", "approval", "attendance"]);
/** Where writes may run (lark_write). drive: comments only. */
const WRITE_DOMAINS = new Set(["sheets", "base", "slides", "markdown", "task", "drive"]);
/** Flags the tools set themselves or that lark-cli uses to skip a confirmation or switch accounts. */
const BANNED_FLAGS = ["--as", "--yes", "--profile", "--config"];

export type Risk = "read" | "write" | "high-risk-write";

/** The command's name: the leading words before the first flag (`sheets +cells-get`, `schema sheets.spreadsheets.get`). */
export function commandPath(args: string[]) {
  const i = args.findIndex((a) => a.startsWith("-"));
  return i < 0 ? args : args.slice(0, i);
}

const risks = new Map<string, Risk | null>();
/** lark-cli's own label for a command, from its --help; null when it has none (not a command). */
export async function riskOf(path: string[]): Promise<Risk | null> {
  const key = path.join(" ");
  if (risks.has(key)) return risks.get(key)!;
  const help = await larkCliOutput([...path, "--help"]).catch(() => "");
  const m = /^Risk:\s*(read|write|high-risk-write)\b/m.exec(help);
  const risk = (m?.[1] as Risk | undefined) ?? null;
  risks.set(key, risk);
  return risk;
}

/** Tests: forget cached labels. */
export function clearRiskCache() {
  risks.clear();
}

function checkArgs(args: string[]) {
  if (!args.length) throw new HttpError(400, "command 为空：写 lark-cli 之后的部分，如 [\"sheets\", \"+cells-get\", \"--url\", \"…\"]");
  if (args[0] === "lark-cli") throw new HttpError(400, "command 不要带 lark-cli 本身，从业务域写起");
  for (const a of args) {
    const flag = a.split("=")[0];
    if (BANNED_FLAGS.includes(flag)) throw new HttpError(400, `不要传 ${flag}：身份固定为本人（--as user），高风险操作不能确认执行`);
  }
}

const isGuide = (args: string[]) => (args[0] === "skills" && (args[1] === "read" || args[1] === "list")) || args[0] === "schema";

/** Run in a scratch directory: files a command downloads go there and are removed after; their names are reported. */
async function run(app: App, args: string[], label: string) {
  const dir = mkdtempSync(join(tmpdir(), "omem-lark-"));
  try {
    const v = await asOwner(app, label, () => larkCli([...args, "--as", "user"], 180_000, dir));
    const files = readdirSync(dir).map((f) => `${f}（${statSync(join(dir, f)).size} 字节）`);
    return { value: v?.data ?? v, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MAX = 60_000;
function show(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return text.length > MAX ? `${text.slice(0, MAX)}\n…（已截断，共 ${text.length} 字；用 --jq、分页或更窄的范围再读）` : text;
}

/** lark_read: a read-labelled command, or one of lark-cli's guides (skills read/list, schema). */
export async function larkRead(app: App, args: string[]) {
  checkArgs(args);
  if (isGuide(args)) return show(await larkCliOutput(args));
  if (!READ_DOMAINS.has(args[0])) throw new HttpError(400, `lark_read 不能用 ${args[0]}：可读的是 ${[...READ_DOMAINS].join("、")}，以及 skills read / schema`);
  const path = commandPath(args);
  const risk = await riskOf(path);
  if (risk === null) throw new HttpError(400, `lark-cli 没有命令 ${path.join(" ")}（或它没有标风险）；用 ["${args[0]}", "--help"] 看可用命令`);
  if (risk !== "read") throw new HttpError(400, `${path.join(" ")} 是${risk === "write" ? "写操作" : "高风险写操作"}，lark_read 只做读；${path.join(" ") === "wiki +node-copy" ? "完整复制用 lark_doc_copy，可请本人批准" : args[0] === "docs" ? "改文档用 lark_doc_update" : WRITE_DOMAINS.has(args[0]) ? "写入用 lark_write" : "这一类不能以本人身份写"}`);
  const r = await run(app, args, `读取飞书（${path.join(" ")}）`);
  return `${show(r.value)}${r.files.length ? `\n\n下载的文件只在这次调用里，已删除：${r.files.join("、")}` : ""}`;
}

export type WriteTarget = { key: string; label: string; personal: boolean; tokens: string[] };

const FILE_TYPES: Record<string, string> = { sheets: "sheet", base: "bitable", slides: "slides", file: "file", docx: "docx", docs: "doc", folder: "folder" };
const TYPE_LABELS: Record<string, string> = { sheet: "表格", bitable: "多维表格", slides: "幻灯片", file: "文件", docx: "文档", doc: "文档", folder: "文件夹" };
const LINK = /\/(sheets|base|slides|file|docx|docs|wiki|folder)\/([A-Za-z0-9]+)/;
/** Flags that put a new file somewhere other than the owner's own Drive root. */
const PLACE_FLAG = /^--(folder|parent|wiki|space|url|[a-z-]*token)/;

/** What a lark_write changes, from its link: the file (the owner's own or not), or the owner's tasks. */
export async function writeTarget(app: App, args: string[], target: string | undefined): Promise<WriteTarget> {
  if (args[0] === "task") return { key: "task", label: "你的飞书任务（创建、修改、指派会通知到相关的人）", personal: false, tokens: [] };
  if (!target) {
    // A new file in the owner's own Drive root is the owner's, like lark_doc_create without a parent.
    const creates = /create/.test(commandPath(args).at(-1) ?? "");
    if (creates && !args.some((a) => PLACE_FLAG.test(a) || LINK.test(a))) return { key: `new:${args[0]}`, label: "你的云空间里的新文件", personal: true, tokens: [] };
    throw new HttpError(400, "target 填要改的文件链接（表格、多维表格、幻灯片、Markdown 文件，或要评论的文档）；新建到某个文件夹时填那个文件夹的链接");
  }
  const m = LINK.exec(target);
  if (!m) throw new HttpError(400, "target 要是飞书文件链接（/sheets/、/base/、/slides/、/file/、/docx/ 或 /wiki/）");
  if (m[1] === "wiki") {
    const node = await wikiNode(app, target);
    if (!node) throw new HttpError(400, "读不到这个知识库页面");
    const personal = node.spaceId === (await personalLibrary(app));
    return { key: `${node.objType}:${node.objToken}`, label: `${personal ? "个人文档库" : "知识库"}里的《${node.title || node.nodeToken}》`, personal, tokens: [node.nodeToken, node.objToken] };
  }
  const type = FILE_TYPES[m[1]];
  // Owner ids are in the calling app's id space: lark-cli's for the owner, the bot app's for someone's connection.
  const acting = larkActing();
  const me = acting ? larkOpenIdOf(app, acting.userId) : (await cliUser())?.openId;
  let personal = false;
  let title = "";
  if (me) {
    const v = await asOwner(app, "读取云空间文件信息", () => larkCli(["drive", "metas", "batch_query", "--data", JSON.stringify({ request_docs: [{ doc_token: m[2], doc_type: type }] }), "--as", "user"], 60_000));
    const meta = (v?.data?.metas ?? [])[0] as { owner_id?: string; title?: string } | undefined;
    personal = meta?.owner_id === me;
    title = meta?.title ?? "";
  }
  return { key: `${type}:${m[2]}`, label: `${personal ? "你的" : "别人的"}${TYPE_LABELS[type]}${title ? `《${title}》` : ` ${m[2]}`}`, personal, tokens: [m[2]] };
}

/** Checks for lark_write before anything else: the domain and lark-cli's label for the command. */
export async function checkWrite(args: string[]) {
  checkArgs(args);
  const path = commandPath(args);
  if (!WRITE_DOMAINS.has(args[0])) {
    const where = args[0] === "docs" || args[0] === "wiki" ? "改文档用 lark_doc_update，移动用 lark_doc_move，完整复制用 lark_doc_copy" : args[0] === "im" || args[0] === "mail" ? "消息和邮件不能以本人身份发；机器人发消息用 lark_send" : "这一类不能以本人身份写";
    throw new HttpError(400, `lark_write 不能用 ${args[0]}：${where}`);
  }
  if (args[0] === "drive" && !path.some((p) => /comment/.test(p))) throw new HttpError(400, "云空间只能写评论（drive +add-comment、+resolve-comment 等）；上传、移动、权限不在这里做");
  const risk = await riskOf(path);
  if (risk === null) throw new HttpError(400, `lark-cli 没有命令 ${path.join(" ")}；用 lark_read(["${args[0]}", "--help"]) 看可用命令`);
  if (risk === "read") throw new HttpError(400, `${path.join(" ")} 只是读取，用 lark_read`);
  if (risk === "high-risk-write") throw new HttpError(400, `${path.join(" ")} 是高风险写操作（删除、清空之类），不以本人身份执行；告诉本人在飞书里自己做`);
  return path;
}

/** An approval is for its target: the command must name that file. */
export function checkTouches(args: string[], target: WriteTarget) {
  if (target.tokens.length && !args.some((a) => target.tokens.some((t) => a.includes(t)))) throw new HttpError(400, "command 里没有 target 那个文件：批准只对 target 有效，命令要改的必须是它");
}

/** `written`: told the full output once the write succeeded (the record ids it made, say). */
export async function larkWrite(app: App, args: string[], path: string[], written?: (output: string) => void) {
  const r = await run(app, args, `以本人身份写飞书（${path.join(" ")}）`);
  const out = show(r.value);
  written?.(out);
  return truncate(out, 4000);
}
