import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
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

/**
 * Reuse the owner's document permission across turns, including approvals made before scopes existed.
 * `tool` is whose approvals count: lark_doc_update for docs, lark_write for sheets, Base, tasks…
 */
export async function docEditDecision(app: App, userId: string, scope: DocEditScope, tool = "lark_doc_update"): Promise<Ask | null> {
  const rows = all<{ id: string; context: string; status: string; doc: string | null; command: string | null }>(app.db, `select id, context, status,
    json_extract(args, '$.doc') doc, json_extract(args, '$.command') command from asks where user_id = ?
    and kind = 'approval' and tool = ? and status != 'cancelled' order by created_at desc, rowid desc`, userId, tool);
  const decisions = new Map<string, Ask>();
  let pending: Ask | null = null;
  for (const row of rows) {
    let grant = (JSON.parse(row.context ?? "{}") as { docEditScope?: DocEditScope }).docEditScope;
    if (!grant && tool === "lark_doc_update" && row.doc && row.command) {
      const m = /\/(docx|docs)\/([A-Za-z0-9]+)/.exec(row.doc);
      let key = m ? `${m[1] === "docs" ? "doc" : "docx"}:${m[2]}` : null;
      if (!key) {
        try {
          const { docPlace } = await import("./lark-doc-write.ts");
          const place = await docPlace(app, row.doc);
          key = `${place.objType}:${place.objToken}`;
        } catch { continue; }
      }
      grant = { documents: [key], commands: row.command === "overwrite" ? ["append", "str_replace", "overwrite"] : ["append", "str_replace"] };
    }
    if (!grant || !scope.commands.every((c) => grant.commands.includes(c))) continue;
    const matches = scope.documents.filter((d) => grant.documents.includes(d));
    if (!matches.length) continue;
    if (row.status === "pending") {
      if (!pending && matches.length === scope.documents.length) pending = getAsk(app, row.id);
      continue;
    }
    const ask = getAsk(app, row.id);
    for (const doc of matches) if (!decisions.has(doc)) decisions.set(doc, ask);
    const refused = [...decisions.values()].find((a) => !a.approved);
    if (refused) return refused;
    if (decisions.size === scope.documents.length) return ask;
  }
  return pending;
}
