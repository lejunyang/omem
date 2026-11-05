import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import { asOwner, cliUser } from "./lark-auth.ts";
import { larkCli } from "./lark-cli.ts";
import { personalLibrary, wikiNode, type WikiNode } from "./lark-wiki.ts";

/**
 * Writing Feishu docs as the owner (lark-cli, user identity): something the assistant was asked to
 * put together becomes a doc the owner owns. Where it lands decides whether the owner confirms first:
 * the personal document library and the owner's own Drive folders and docs are the owner's own
 * place; a knowledge base others read (or anyone else's folder or doc) needs the owner's approval
 * with the exact place spelled out (tools.ts holds the call). Ordinary editing approval follows
 * the listed documents across turns and retries; create, move and whole-document overwrite keep their
 * own approval boundaries.
 */

export type Place = {
  /** The owner's own place: no approval needed. */
  personal: boolean;
  /** Where, for the owner to check: knowledge base, parent page, folder. */
  label: string;
  /** For lark-cli: `--parent-position my_library` or `--parent-token`. */
  parent: { position: "my_library" } | { token: string };
  /** A knowledge-base place (for moves): space id and parent node. */
  wiki?: { spaceId: string; nodeToken?: string };
  folder?: string;
};

const FOLDER = /\/drive\/folder\/([A-Za-z0-9]+)/;
const DOC = /\/(docx|wiki|docs)\/([A-Za-z0-9]+)/;

async function spaceName(app: App, spaceId: string) {
  try {
    const v = await asOwner(app, "读取知识库信息", () => larkCli(["wiki", "spaces", "get", "--params", JSON.stringify({ space_id: spaceId }), "--as", "user", "--format", "json"], 60_000));
    const d = v?.data ?? v;
    return String(d?.space?.name ?? d?.name ?? spaceId);
  } catch (e) {
    if (/缺少飞书权限/.test((e as Error).message)) throw e;
    return spaceId;
  }
}

/** Who owns a Drive doc or folder (`drive metas`), and whether that is the owner. */
async function ownedByOwner(app: App, token: string, type: string) {
  const me = (await cliUser())?.openId;
  if (!me) return false;
  const v = await asOwner(app, "读取云空间文件信息", () => larkCli(["drive", "metas", "batch_query", "--data", JSON.stringify({ request_docs: [{ doc_token: token, doc_type: type }] }), "--as", "user"], 60_000));
  const m = (v?.data?.metas ?? [])[0] as { owner_id?: string } | undefined;
  return m?.owner_id === me;
}

async function wikiPlace(app: App, node: WikiNode, under = true): Promise<Place> {
  const personal = node.spaceId === (await personalLibrary(app));
  const space = personal ? "个人文档库" : `知识库「${await spaceName(app, node.spaceId)}」`;
  return { personal, label: `${space}${under ? ` 的《${node.title || node.nodeToken}》下` : ` 里的《${node.title || node.nodeToken}》`}`, parent: { token: node.nodeToken }, wiki: { spaceId: node.spaceId, nodeToken: node.nodeToken } };
}

/**
 * Where a new doc (or a moved one) would go: nothing or `my_library` = the root of the personal
 * library; a knowledge-base page link = under that page; a Drive folder link = in that folder.
 */
export async function placeFor(app: App, parent?: string | null): Promise<Place> {
  const p = parent?.trim();
  if (!p || p === "my_library") {
    const spaceId = await personalLibrary(app);
    return { personal: true, label: "个人文档库（根目录）", parent: { position: "my_library" }, wiki: { spaceId } };
  }
  const folder = FOLDER.exec(p)?.[1];
  if (folder) return folderPlace(app, folder);
  const node = await wikiNode(app, p);
  if (node) return wikiPlace(app, node);
  // A bare token that is not a wiki node: a Drive folder.
  if (/^[A-Za-z0-9]+$/.test(p)) return folderPlace(app, p);
  throw new HttpError(400, `看不出 ${p} 是知识库页面还是云空间文件夹：给出飞书链接`);
}

async function folderPlace(app: App, token: string): Promise<Place> {
  const mine = await ownedByOwner(app, token, "folder");
  return { personal: mine, label: `${mine ? "我的" : "别人的"}云空间文件夹 ${token}`, parent: { token }, folder: token };
}

/** Where an existing doc is: its knowledge base page, or a Drive doc (the owner's own or not). */
export async function docPlace(app: App, doc: string): Promise<Place & { token: string; objToken: string; objType: string; node?: WikiNode }> {
  const m = DOC.exec(doc);
  const token = m?.[2] ?? doc.trim();
  const node = await wikiNode(app, doc);
  if (node) return { ...(await wikiPlace(app, node, false)), token, objToken: node.objToken, objType: node.objType, node };
  const type = m?.[1] === "docs" ? "doc" : "docx";
  const mine = await ownedByOwner(app, token, type);
  return { personal: mine, label: `${mine ? "我的" : "别人的"}云空间文档 ${token}`, parent: { token }, token, objToken: token, objType: type };
}

/** Content goes through a file: long Markdown on the command line breaks on quoting. */
async function withContent<T>(content: string, fn: (ref: string, cwd: string) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), "omem-docw-"));
  try {
    writeFileSync(join(dir, "content.md"), content);
    return await fn("@content.md", dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function createDoc(app: App, input: { title: string; content: string; format?: "markdown" | "xml"; place: Place }) {
  const parent = "position" in input.place.parent ? ["--parent-position", input.place.parent.position] : ["--parent-token", input.place.parent.token];
  const v = await withContent(input.content, (ref, cwd) =>
    asOwner(app, "以本人身份新建飞书文档", () => larkCli(["docs", "+create", "--as", "user", "--title", input.title, "--doc-format", input.format ?? "markdown", "--content", ref, ...parent], 120_000, cwd)),
  );
  const d = v?.data?.document ?? v?.data ?? {};
  return { url: String(d.url ?? ""), documentId: String(d.document_id ?? ""), warnings: (v?.data?.warnings ?? []) as unknown[] };
}

/** The fixed node-copy command is the only high-risk-labelled CLI operation exposed here. */
export async function copyDoc(app: App, source: WikiNode, target: NonNullable<Place["wiki"]>, title?: string) {
  const v = await asOwner(app, "以本人身份复制飞书文档", () => larkCli([
    "wiki", "+node-copy", "--space-id", source.spaceId, "--node-token", source.nodeToken,
    ...(target.nodeToken ? ["--target-parent-node-token", target.nodeToken] : ["--target-space-id", target.spaceId]),
    ...(title ? ["--title", title] : []), "--as", "user", "--yes", "--format", "json",
  ], 180_000));
  return v?.data ?? v;
}

export const UPDATE_COMMANDS = ["append", "str_replace", "block_replace", "block_insert_after", "block_delete", "block_move_after", "block_copy_insert_after", "overwrite"] as const;
export type UpdateCommand = (typeof UPDATE_COMMANDS)[number];
export type UpdateInput = {
  doc: string;
  command: UpdateCommand;
  content?: string;
  pattern?: string;
  format?: "markdown" | "xml";
  blockId?: string;
  startBlockId?: string;
  endBlockId?: string;
  srcBlockIds?: string;
  revisionId?: number;
};

/** What each command needs (lark-cli checks the same; failing here keeps the error readable). */
export function checkUpdate(input: UpdateInput) {
  const c = input.command;
  const range = !!(input.startBlockId || input.endBlockId);
  if (range && !(input.startBlockId && input.endBlockId)) throw new HttpError(400, "start_block_id 和 end_block_id 要成对给");
  if (range && input.blockId) throw new HttpError(400, "block_id 和 start_block_id/end_block_id 只能给一种");
  if (range && c !== "block_replace" && c !== "block_delete") throw new HttpError(400, "start_block_id/end_block_id 只用于 block_replace 和 block_delete");
  if (c === "str_replace" && !input.pattern) throw new HttpError(400, "str_replace 需要 pattern（要替换的原文）");
  if ((c === "block_replace" || c === "block_delete") && !input.blockId && !range) throw new HttpError(400, `${c} 需要 block_id，或 start_block_id + end_block_id`);
  if ((c === "block_insert_after" || c === "block_move_after" || c === "block_copy_insert_after") && !input.blockId) throw new HttpError(400, `${c} 需要 block_id（锚点）`);
  if ((c === "block_move_after" || c === "block_copy_insert_after") && !input.srcBlockIds) throw new HttpError(400, `${c} 需要 src_block_ids`);
  if ((c === "append" || c === "overwrite" || c === "block_replace" || c === "block_insert_after") && !input.content) throw new HttpError(400, `${c} 需要 content`);
}

/** Block commands carry DocxXML by default (what lark_doc_fetch shows); text commands Markdown, as before. */
export function updateFormat(input: Pick<UpdateInput, "command" | "format">) {
  return input.format ?? (input.command.startsWith("block_") ? "xml" : "markdown");
}

export async function updateDoc(app: App, input: UpdateInput) {
  checkUpdate(input);
  const flags = [
    ...(input.pattern !== undefined ? ["--pattern", input.pattern] : []),
    ...(input.blockId ? ["--block-id", input.blockId] : []),
    ...(input.startBlockId ? ["--start-block-id", input.startBlockId, "--end-block-id", input.endBlockId!] : []),
    ...(input.srcBlockIds ? ["--src-block-ids", input.srcBlockIds] : []),
    ...(input.revisionId !== undefined ? ["--revision-id", String(input.revisionId)] : []),
  ];
  const run = (content: string[], cwd?: string) =>
    asOwner(app, "以本人身份编辑飞书文档", () =>
      larkCli(["docs", "+update", "--as", "user", "--doc", input.doc, "--command", input.command, "--doc-format", updateFormat(input), ...content, ...flags], 120_000, cwd),
    );
  const v = input.content !== undefined ? await withContent(input.content, (ref, cwd) => run(["--content", ref], cwd)) : await run([]);
  const d = v?.data ?? {};
  return {
    revision: d.document?.revision_id ?? d.revision_id ?? null,
    result: typeof d.result === "string" ? d.result : null,
    newBlocks: (Array.isArray(d.document?.new_blocks) ? d.document.new_blocks : []) as { block_id?: string; block_type?: string; block_token?: string }[],
    warnings: (Array.isArray(d.warnings) ? d.warnings : []) as unknown[],
    tips: typeof d.tips === "string" ? d.tips : "",
  };
}

export type FetchInput = {
  doc: string;
  scope?: "outline" | "section" | "range" | "keyword";
  keyword?: string;
  startBlockId?: string;
  endBlockId?: string;
  maxDepth?: number;
  contextBefore?: number;
  contextAfter?: number;
  detail?: "simple" | "with-ids" | "full";
  format?: "xml" | "markdown";
};

/** Read a doc, or the part about to change, as the owner: the block ids block_* edits target. */
export async function fetchForEdit(app: App, input: FetchInput) {
  if (input.scope === "section" && !input.startBlockId) throw new HttpError(400, "scope=section 需要 start_block_id（标题的 block id，先用 scope=outline 找）");
  if (input.scope === "keyword" && !input.keyword) throw new HttpError(400, "scope=keyword 需要 keyword");
  if (input.scope === "range" && !input.startBlockId && !input.endBlockId) throw new HttpError(400, "scope=range 需要 start_block_id 或 end_block_id");
  const args = ["docs", "+fetch", "--as", "user", "--doc", input.doc, "--doc-format", input.format ?? "xml", "--detail", input.detail ?? "with-ids"];
  if (input.scope) args.push("--scope", input.scope);
  if (input.keyword) args.push("--keyword", input.keyword);
  if (input.startBlockId) args.push("--start-block-id", input.startBlockId);
  if (input.endBlockId) args.push("--end-block-id", input.endBlockId);
  if (input.maxDepth !== undefined) args.push("--max-depth", String(input.maxDepth));
  if (input.contextBefore) args.push("--context-before", String(input.contextBefore));
  if (input.contextAfter) args.push("--context-after", String(input.contextAfter));
  const v = await asOwner(app, "读取飞书文档", () => larkCli(args, 60_000));
  const d = v?.data?.document ?? {};
  return { content: String(d.content ?? ""), revision: d.revision_id ?? null, tips: typeof d.tips === "string" ? d.tips : "" };
}

/** Move a doc into a knowledge-base place (`wiki +move`; a Drive doc moves into the knowledge base) or out to a Drive folder. */
export async function moveDoc(app: App, from: Awaited<ReturnType<typeof docPlace>>, to: Place) {
  let args: string[];
  if (to.wiki) {
    args = from.node
      ? ["wiki", "+move", "--node-token", from.node.nodeToken, ...(to.wiki.nodeToken ? ["--target-parent-token", to.wiki.nodeToken] : ["--target-space-id", to.wiki.spaceId])]
      : ["wiki", "+move", "--obj-type", from.objType, "--obj-token", from.objToken, "--target-space-id", to.wiki.spaceId, ...(to.wiki.nodeToken ? ["--target-parent-token", to.wiki.nodeToken] : [])];
  } else if (to.folder) {
    if (!from.node) throw new HttpError(400, "云空间里的文档在云空间之间移动还不支持：只能移进知识库，或把知识库页面移到云空间文件夹");
    args = ["wiki", "+move-to-drive", "--node-token", from.node.nodeToken, "--folder-token", to.folder];
  } else throw new HttpError(400, "目标位置不对");
  const v = await asOwner(app, "以本人身份移动飞书文档", () => larkCli([...args, "--as", "user", "--format", "json"], 180_000));
  return v?.data ?? v;
}
