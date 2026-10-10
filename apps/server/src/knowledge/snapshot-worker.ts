/** Dedicated reader connection: no Store constructor, migrations or retention
 * against the personal library. A SQLite read transaction fixes every table. */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { researchSnapshot } from "./research-snapshot.js";
import { materialFromRow } from "../retrieval/units.js";

const { database, materials, articles, file, visibleIds, includeUnanchoredState, includeGroupCatalog } = workerData;
const original = new DatabaseSync(database, {readOnly:true});
try {
  original.exec("PRAGMA query_only=ON; BEGIN");
  // Fix the read view before checking identity, then export from that same view.
  for (const m of materials) {
    const row = original.prepare("SELECT r.*,s.namespace,s.external_id,s.head FROM sources s JOIN revisions r ON r.id=s.head WHERE s.id=?").get(m.sourceId);
    const current = row && materialFromRow(original,row);
    if (!current || current.revisionId !== m.revisionId || current.digest !== m.digest)
      throw Error("KNOWLEDGE_INPUT_CHANGED: source changed before snapshot construction");
  }
  const visible = visibleIds ? new Set<string>(visibleIds) : undefined;
  const stages: Record<string,number> = {};
  const db = researchSnapshot({original,materials,articles,file,
    includeUnanchoredState,includeGroupCatalog,
    ...(visible ? {visible:(id:string)=>visible.has(id)} : {}),
    onTiming:(stage,ms)=>{stages[stage]=ms;}});
  db.close();
  parentPort!.postMessage({stages});
} catch (error) {
  parentPort!.postMessage({error:String(error)});
} finally {
  original.close();
}
