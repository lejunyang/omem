import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { captureSpace } from "../core/capture-space.ts";
import { one, run } from "../core/db.ts";
import { storedPath } from "../core/stored-files.ts";
import { HttpError, json } from "../core/util.ts";
import { importFile } from "../sources/import.ts";
import { larkCli } from "./lark-cli.ts";
import { messageResourceFile, type ResourceRef } from "./lark-messages.ts";
import { resourceKeys } from "./lark-resource-keys.ts";

/**
 * A Feishu message's attachment for an agent (agents/tools.ts `lark_message_file`, and `lark_read`'s
 * `im +messages-resources-download`, which lark-cli marks as a write because it saves a file): the
 * copy omem keeps. Capture usually saved it already, often as a source (lark-bot.ts, lark-messages.ts,
 * lark-resource-parse.ts); otherwise it is fetched the way the web shows it (`messageResourceFile`:
 * the person's lark-cli, the bot for chats it is in) and imported into the chat's space. Video and
 * audio are kept as files only: omem neither transcribes them nor takes frames.
 *
 * `may`: the caller's read scope — the chat's space, or a chat the run itself is in.
 */
export type MessageFile = { key: string; name: string; chatId: string; sourceId?: string; path?: string; media?: boolean; unreadable?: string };

const MEDIA = /\.(mp4|mov|avi|webm|mkv|m4v|mp3|wav|ogg|opus|m4a|aac|flac|amr)$/i;

export async function messageFile(app: App, messageId: string, key: string | undefined, may: { space(id: string): boolean; chat(id: string): boolean }): Promise<MessageFile> {
  const row = one<{ chat_id: string; content: string; raw_content: string | null; msg_type: string; resources: string; source_id: string | null }>(
    app.db,
    "select chat_id, content, raw_content, msg_type, resources, source_id from lark_messages where message_id = ?",
    messageId,
  );
  let chatId = row?.chat_id;
  let content = row?.content ?? "";
  let type = row?.msg_type ?? "";
  if (!row) {
    // Not captured: Feishu says which chat it is in (a read).
    const v = await larkCli(["im", "+messages-mget", "--message-ids", messageId, "--as", "user", "--format", "json"]).catch(() => null);
    const m = ((v?.data?.messages ?? v?.data?.items ?? []) as { chat_id?: string; content?: unknown; msg_type?: string; message_type?: string }[])[0];
    if (!m?.chat_id) throw new HttpError(404, `读不到消息 ${messageId}：omem 没有采集到它，本人的 lark-cli 也读不到`);
    chatId = m.chat_id;
    content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    type = m.msg_type ?? m.message_type ?? "";
  }
  const spaceId = (row?.source_id ? one<{ space_id: string }>(app.db, "select space_id from sources where id = ?", row.source_id)?.space_id : undefined) ?? captureSpace(app, chatId!);
  if (!may.space(spaceId) && !may.chat(chatId!)) throw new HttpError(403, "这条消息所在的群不在本次任务能读的范围内");

  const refs = json<Record<string, ResourceRef>>(row?.resources, {});
  const keys = key ? [key] : [...new Set([...Object.keys(refs).filter((k) => !refs[k].optional), ...resourceKeys(content, row?.raw_content, type).required])];
  if (!keys.length) throw new HttpError(404, `消息 ${messageId} 没有附件`);
  if (keys.length > 1) throw new HttpError(400, `消息 ${messageId} 有 ${keys.length} 个附件，用 file_key 指定要哪个：${keys.join("、")}`);
  const k = keys[0];
  const ref = refs[k];
  const name = ref?.name ?? new RegExp(`key="${k}"[^>]*name="([^"]+)"`).exec(content)?.[1] ?? k;
  if (ref?.sourceId && one(app.db, "select 1 from sources where id = ? and deleted_at is null", ref.sourceId)) return { key: k, name, chatId: chatId!, sourceId: ref.sourceId };

  const file = (ref?.file && storedPath(app, ref.file) ? ref.file : null) ?? (await messageResourceFile(app, messageId, k));
  const path = file ? storedPath(app, file) : null;
  if (!file || !path) throw new HttpError(404, `下载不到这个附件（本人的 lark-cli 和机器人都读不到它）`);
  if (MEDIA.test(name) || MEDIA.test(file) || ["media", "audio"].includes(ref?.type ?? type)) return { key: k, name, chatId: chatId!, path, media: true };

  // Imported under its own name (the stored copy is named by its hash), like the bot's saved files.
  const dir = mkdtempSync(join(tmpdir(), "omem-msg-file-"));
  let imported: Awaited<ReturnType<typeof importFile>> = null;
  let unreadable: string | undefined;
  try {
    const named = join(dir, name.replace(/[\\/:*?"<>|]/g, "_"));
    copyFileSync(path, named);
    imported = await importFile(app, spaceId, named, `lark:${chatId}/${messageId}/${k}/${name}`, undefined, true);
  } catch (e) {
    // No converter for this format on this machine: the file itself is still there.
    unreadable = (e as Error).message;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!imported) return { key: k, name, chatId: chatId!, path, ...(unreadable ? { unreadable } : {}) };
  if (row) {
    const now = json<Record<string, ResourceRef>>(one<{ resources: string }>(app.db, "select resources from lark_messages where message_id = ?", messageId)?.resources, {});
    now[k] = { ...(now[k] ?? { type: k.startsWith("img_") ? "image" : "file" }), file, name, sourceId: imported.id, parse: { status: "done" } };
    run(app.db, "update lark_messages set resources = ? where message_id = ?", JSON.stringify(now), messageId);
  }
  return { key: k, name, chatId: chatId!, sourceId: imported.id };
}

/** `im +messages-resources-download --message-id … --file-key …` as lark_read gets it, or null. */
export function resourceDownload(command: string[]): { messageId: string; key?: string } | null {
  if (command[0] !== "im" || command[1] !== "+messages-resources-download") return null;
  const flag = (name: string) => {
    const i = command.findIndex((x) => x === name || x.startsWith(`${name}=`));
    if (i < 0) return undefined;
    return command[i].includes("=") ? command[i].slice(name.length + 1) : command[i + 1];
  };
  const messageId = flag("--message-id");
  return messageId ? { messageId, key: flag("--file-key") } : null;
}
