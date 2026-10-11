import { DatabaseSync } from "node:sqlite";
import type { App } from "./core/app.ts";
import { json } from "./core/util.ts";
import { upsertItem } from "./items/store.ts";
import { remember } from "./memory/store.ts";
import { upsertSource, type SourceKind } from "./sources/store.ts";

/**
 * One-time import of a v1 library (omem.db from the old ~/.omem). Brings over
 * the latest text of each captured source, active memories and open tasks.
 * Repository review material is skipped: re-create a repo space instead.
 */
export function importV1(app: App, dbPath: string, opts: { spaceId?: string; dryRun?: boolean } = {}) {
  const v1 = new DatabaseSync(dbPath, { readOnly: true });
  const spaceId = opts.spaceId ?? "personal";
  const report = { sources: 0, skippedSources: 0, memories: 0, items: 0 };
  const has = (t: string) => !!v1.prepare("select 1 from sqlite_master where type='table' and name=?").get(t);

  if (has("sources") && has("revisions")) {
    const rows = v1
      .prepare("select s.namespace, s.external_id, r.title, r.body, r.created_at from sources s join revisions r on r.id = s.head")
      .all() as { namespace: string; external_id: string; title: string; body: string; created_at: string }[];
    for (const r of rows) {
      if (/review|code|repo/i.test(r.namespace)) {
        report.skippedSources++;
        continue;
      }
      const body = json<{ parts?: { type: string; text?: string; url?: string; label?: string }[] }>(r.body, {});
      const text = (body.parts ?? [])
        .map((p) => (p.type === "text" ? p.text : p.type === "link" ? `[${p.label ?? p.url}](${p.url})` : `[图片] ${p.label ?? ""}`))
        .filter(Boolean)
        .join("\n\n");
      if (!text.trim()) {
        report.skippedSources++;
        continue;
      }
      const kind: SourceKind = /lark|chat|im|message/i.test(r.namespace) ? "chat" : /web|url/i.test(r.namespace) ? "web" : "note";
      if (!opts.dryRun) upsertSource(app, { spaceId, kind, uri: `v1:${r.namespace}:${r.external_id}`, title: r.title || r.external_id, text, meta: { importedFrom: "v1", capturedAt: r.created_at } });
      report.sources++;
    }
  }

  if (has("memories") && has("memory_revisions")) {
    const rows = v1
      .prepare("select m.kind, m.scope, r.body, r.valid_from, r.created_at from memories m join memory_revisions r on r.id = m.head_revision_id where m.status = 'active'")
      .all() as { kind: string; scope: string; body: string; valid_from: string | null; created_at: string }[];
    for (const r of rows) {
      const parsed = json<{ text?: string; statement?: string; content?: string; subject?: string }>(r.body, {});
      const content = parsed.text ?? parsed.statement ?? parsed.content ?? (r.body.startsWith("{") ? "" : r.body);
      if (!content) continue;
      if (!opts.dryRun)
        remember(app, { spaceId, kind: r.kind === "claim" ? "fact" : "experience", subject: parsed.subject ?? "", content, validFrom: r.valid_from ?? r.created_at, sourceRefs: ["v1"], createdBy: "user" });
      report.memories++;
    }
  }

  if (has("tasks")) {
    const rows = v1.prepare("select * from tasks where status = 'open'").all() as Record<string, string | null>[];
    for (const t of rows) {
      const follow = json<{ waiting_on?: string | null; next_check_at?: string | null; snoozed_until?: string | null }>(t.follow_up, {});
      if (!opts.dryRun)
        upsertItem(
          app,
          undefined,
          {
            spaceId,
            kind: follow.waiting_on ? "waiting" : follow.next_check_at ? "reminder" : "todo",
            title: t.title ?? "",
            detail: [t.detail, t.next_step ? `下一步：${t.next_step}` : ""].filter(Boolean).join("\n"),
            dueAt: t.due_at,
            remindAt: follow.next_check_at ?? follow.snoozed_until ?? null,
            waitingOn: follow.waiting_on ?? null,
            note: "从 v1 导入",
          },
          "user",
        );
      report.items++;
    }
  }
  v1.close();
  return report;
}
