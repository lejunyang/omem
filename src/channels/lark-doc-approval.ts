import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import { getAsk, type Ask } from "../agents/asks.ts";

export type DocEditScope = { documents: string[]; commands: string[] };

/** Human-readable previews, including old callers that supply DocxXML without a summary. */
export function docPreview(value: string, max = 240) {
  const plain = value
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (s) => {
      const entity = s.slice(1, -1).toLowerCase();
      if (!entity.startsWith("#")) return ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity];
      const n = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/\s+/g, " ").trim();
  return truncate(plain, max);
}

/** An approval result may wake a new turn; an ordinary new request never inherits its grants. */
function taskRuns(app: App, runId: string, userId: string): string[] {
  const seen = new Set<string>();
  while (!seen.has(runId)) {
    seen.add(runId);
    const r = one<{ input: string }>(app.db, "select input from runs where id = ?", runId);
    const input = JSON.parse(r?.input ?? "{}") as { fromAsk?: boolean; messageIds?: string[]; conversationId?: string };
    if (!input.fromAsk || !input.messageIds?.length) break;
    const origins = input.messageIds.map((id) => {
      const m = one<{ meta: string }>(app.db, "select meta from messages where id = ? and conversation_id = ?", id, input.conversationId ?? "");
      const meta = JSON.parse(m?.meta ?? "{}");
      if (!meta.fromAsk || typeof meta.askId !== "string") return null;
      return one<{ run_id: string }>(app.db, `select run_id from asks where id = ? and user_id = ? and conversation_id = ?
        and kind = 'approval' and tool = 'lark_doc_update' and status = 'answered' and approved = 1`, meta.askId, userId, input.conversationId ?? "")?.run_id ?? null;
    });
    if (!origins[0] || origins.some((id) => id !== origins[0])) break;
    runId = origins[0];
  }
  return [...seen];
}

/** Scope is resolved by the host before the card is shown, never inferred from model prose. */
export function docEditDecision(app: App, runId: string | null, userId: string, scope: DocEditScope): Ask | null {
  if (!runId) return null;
  const ids = taskRuns(app, runId, userId);
  const rows = all<{ id: string; context: string }>(app.db, `select id, context from asks where run_id in (${ids.map(() => "?").join(",")}) and user_id = ?
    and kind = 'approval' and tool = 'lark_doc_update' and status != 'cancelled' order by created_at desc, rowid desc`, ...ids, userId);
  for (const row of rows) {
    const grant = (JSON.parse(row.context ?? "{}") as { docEditScope?: DocEditScope }).docEditScope;
    if (grant && scope.documents.every((d) => grant.documents.includes(d)) && scope.commands.every((c) => grant.commands.includes(c))) return getAsk(app, row.id);
  }
  return null;
}
