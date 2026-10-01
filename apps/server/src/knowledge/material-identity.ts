import type { DatabaseSync } from "node:sqlite";

/** Imported published knowledge may retain external keys. Aliases are explicit
 * persisted import data; the knowledge engine never interprets producer names. */
export function ensureMaterialAliases(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS knowledge_material_aliases(material_key TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id))");
}
export function sourceForMaterialKey(db: DatabaseSync, key: string): string | null {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_material_aliases'").get()) {
    const alias = db.prepare("SELECT source_id FROM knowledge_material_aliases WHERE material_key=?").get(key);
    if (alias) return String(alias.source_id);
  }
  const separator = key.indexOf(":"), namespace = key.slice(0, separator), external = key.slice(separator + 1);
  const source = db.prepare("SELECT id FROM sources WHERE namespace=? AND (external_id=? OR (external_id IS NULL AND id=?))").get(namespace, external, external);
  return source ? String(source.id) : null;
}
