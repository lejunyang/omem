import { basename, join } from "node:path";
import type { App } from "../core/app.ts";
import { one, run, tx } from "../core/db.ts";
import { json } from "../core/util.ts";
import { createRun, type RunContext } from "../agents/runs.ts";
import { importFile } from "../sources/import.ts";
import { upsertSource } from "../sources/store.ts";
import type { ResourceRef } from "./lark-messages.ts";

/** Queue after the message and original files are committed. Failed jobs are retried explicitly. */
export function queueResourceParsing(app: App, spaceId: string, messageId: string) {
  tx(app.db, () => {
    const row = one<{ chat_id: string; resources: string }>(app.db, "select chat_id,resources from lark_messages where message_id=?", messageId);
    if (!row) return;
    const refs = json<Record<string, ResourceRef>>(row.resources, {});
    let changed = false;
    for (const [key, ref] of Object.entries(refs)) {
      if (!ref.file || ref.parse?.status !== "pending" || ref.parse.runId) continue;
      const task = createRun(app, { kind: "lark-resource-parse", spaceId, title: `解析已保存附件：${ref.name ?? ref.file}`,
        lane: "lark-resource-parse", input: { messageId, chatId: row.chat_id, key, file: ref.file, name: ref.name } });
      ref.parse = { status: "pending", runId: task.id };
      changed = true;
    }
    if (changed) run(app.db, "update lark_messages set resources=? where message_id=?", JSON.stringify(refs), messageId);
  });
}

/** The file and message remain usable on any parse failure. */
export async function parseLarkResource(ctx: RunContext) {
  const { app } = ctx;
  const { messageId, chatId, key, file, name } = ctx.run.input as { messageId: string; chatId: string; key: string; file: string; name?: string };
  if (!ctx.run.spaceId || basename(file) !== file) throw new Error("附件解析任务缺少有效空间或本地文件");
  const spaceId = ctx.run.spaceId;
  const initial = one<{ resources: string; space_id: string }>(app.db, "select m.resources,s.space_id from lark_messages m join sources s on s.id=m.source_id where m.message_id=? and m.chat_id=? and s.deleted_at is null", messageId, chatId);
  if (!initial || initial.space_id !== ctx.run.spaceId) return { skipped: "消息不在任务空间内", quiet: true };
  const initialRefs = json<Record<string, ResourceRef>>(initial.resources, {}), ref = initialRefs[key];
  if (!ref || ref.file !== file || ref.parse?.status === "done") return { skipped: "附件已变化或已解析", quiet: true };
  if (ref.parse?.runId && ref.parse.runId !== ctx.run.id) {
    const previous = one<{ status: string }>(app.db, "select status from runs where id=?", ref.parse.runId);
    if (previous && ["queued", "running"].includes(previous.status)) return { skipped: "附件已有解析任务", quiet: true };
    ref.parse = { status: "pending", runId: ctx.run.id };
    run(app.db, "update lark_messages set resources=? where message_id=?", JSON.stringify(initialRefs), messageId);
  }
  const current = () => {
    const row = one<{ resources: string; source_id: string | null; line: number | null }>(app.db, "select resources,source_id,line from lark_messages where message_id=? and chat_id=?", messageId, chatId);
    const refs = json<Record<string, ResourceRef>>(row?.resources, {});
    return row && refs[key]?.file === file && refs[key]?.parse?.runId === ctx.run.id ? { row, refs } : null;
  };
  if (!current()) return { skipped: "附件已变化", quiet: true };
  try {
    const imported = await importFile(app, spaceId, join(app.filesDir, file), `lark:${chatId}/${messageId}/${key}/${name ?? file}`, ctx.signal);
    ctx.signal.throwIfAborted();
    if (!imported) throw new Error("附件暂不支持内容解析，原文件已保存");
    const { scheduleIngest } = await import("../agents/jobs.ts");
    const latest = current();
    if (!latest) return { skipped: "附件已变化", quiet: true };
    // Keep citation line numbers stable when linking the parsed source to its original message.
    const source = latest.row.source_id ? one<{ id: string; space_id: string; uri: string; title: string; text: string; meta: string }>(app.db, "select * from sources where id=? and deleted_at is null", latest.row.source_id) : undefined;
    if (source && latest.row.line) {
      const lines = source.text.split("\n"), i = latest.row.line - 1;
      if (lines[i]?.endsWith(`(${messageId})`) && !lines[i].includes(`src:${imported.id}`)) {
        lines[i] = lines[i].slice(0, -`(${messageId})`.length) + `→ src:${imported.id} (${messageId})`;
        upsertSource(app, { spaceId: source.space_id, kind: "chat", uri: source.uri, title: source.title, text: lines.join("\n"), meta: json(source.meta, {}) });
      }
    }
    // Persist the completion marker together with the follow-up job: restart cannot lose ingest.
    tx(app.db, () => {
      latest.refs[key] = { ...latest.refs[key], sourceId: imported.id, parse: { status: "done", runId: ctx.run.id } };
      scheduleIngest(app, spaceId, [imported.id], "已保存附件解析完成");
      run(app.db, "update lark_messages set resources=? where message_id=?", JSON.stringify(latest.refs), messageId);
    });
    return { sourceId: imported.id, file };
  } catch (e) {
    const latest = current();
    if (latest) {
      latest.refs[key].parse = { status: "failed", runId: ctx.run.id, error: (e as Error).message.slice(0, 500) };
      run(app.db, "update lark_messages set resources=? where message_id=?", JSON.stringify(latest.refs), messageId);
    }
    throw e;
  }
}
