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
 * for every create, edit, overwrite and move, with the exact place spelled out (tools.ts holds the call).
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

export type UpdateCommand = "append" | "overwrite" | "str_replace";

export async function updateDoc(app: App, input: { doc: string; command: UpdateCommand; content: string; pattern?: string; format?: "markdown" | "xml" }) {
  if (input.command === "str_replace" && !input.pattern) throw new HttpError(400, "str_replace 需要 pattern（要替换的原文）");
  const v = await withContent(input.content, (ref, cwd) =>
    asOwner(app, "以本人身份编辑飞书文档", () =>
      larkCli(["docs", "+update", "--as", "user", "--doc", input.doc, "--command", input.command, "--doc-format", input.format ?? "markdown", "--content", ref, ...(input.pattern ? ["--pattern", input.pattern] : [])], 120_000, cwd),
    ),
  );
  return { revision: v?.data?.document?.revision_id ?? v?.data?.revision_id ?? null };
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
